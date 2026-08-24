/* CardQuest エンジン — ターン進行
 *
 * 『SOULGATE 状態モデル（変数マップ）』§2, §4, §8 を移植する。
 *   ・山札は「カードIDごとの残り枚数」の多重集合。ドローは原作の抽選アルゴリズムを再現
 *     （ID昇順に rand(1,50) <= 残り枚数 で判定。低IDほど出やすい原作特有の偏りをそのまま持つ）
 *   ・初回ドローは6枚、以降は毎ターン1枚（原作 V226 のロジック）
 *   ・手札上限7枚。超えたら強制的に1枚捨てる
 *   ・配置ステップ：召還（召還Lv<=1のみ・手札から直接）／チャネル（自陣・敵陣どちらも対象、押し込み可）
 *   ・メインステップ：リバース（自陣のみ・下から上へ一方通行）／チャネル（押し込み不可）
 *     ※アタックは js/engine/combat.js（M3）。特殊行動は M4 で追加する（原作の実装順序どおり）
 *   ・ターン終了：表向き魔法カードの消滅（停滞があるレーンは除く）・未行動かつ手札5枚以下なら1枚補充・
 *     ＬＰクランプ・当該陣営の硬直とリバースポインタの解除
 *
 * このエンジンは「1回の呼び出し＝1つの確定した行動」として扱う（カーソル操作による
 * 「行動継続中」の途中状態は持たない）。UIはカーソル操作をこの単位のAPI呼び出しに変換する。
 * DOMには依存しない。
 */
'use strict';
(function (global) {

  const S = (typeof require === 'function' && typeof window === 'undefined')
    ? require('./state.js') : global.CQState;
  const Stats = (typeof require === 'function' && typeof window === 'undefined')
    ? require('./stats.js') : global.CQStats;

  const HAND_CAP = 7;
  const FIRST_DRAW = 6;

  /* ---- 山札 -------------------------------------------------------------- */

  /** カードIDの配列（重複可）から残枚数の多重集合を作る */
  function createDeck(cardIds) {
    const counts = {};
    (cardIds || []).forEach(function (id) { counts[id] = (counts[id] || 0) + 1; });
    return counts;
  }

  /** 原作のドロー抽選をそのまま再現する。
   * ID昇順に rand(1,50) <= 残り枚数 を判定するため、低いIDほど出やすい（原作の癖）。
   * 山札が尽きていれば null を返す。 */
  function draw(rng, player) {
    if (player.deckCount <= 0) return null;
    for (;;) {
      for (let id = 1; id <= 200; id++) {
        const n = player.deck[id] || 0;
        if (n > 0 && rng.int(1, 50) <= n) {
          player.deck[id] = n - 1;
          player.deckCount -= 1;
          player.hand.push(id);
          return id;
        }
      }
      // 原作どおり、誰も当たらなければ最初からやり直す（山札が残っている限りいつか当たる）
    }
  }

  /* ---- プレイヤー・盤面 ---------------------------------------------------- */

  /** 50枚のデッキ配列からプレイヤー状態を作る（不足分は呼び出し側で空白180を補うこと） */
  function createPlayer(deckCardIds, opts) {
    const o = opts || {};
    const deck = createDeck(deckCardIds);
    return {
      lp: o.lp === undefined ? 10 : o.lp,
      maxLp: o.maxLp === undefined ? 15 : o.maxLp,
      deck: deck,
      deckCount: (deckCardIds || []).length,
      hand: [],
      turnsTaken: 0,
      actedThisTurn: false,
      hasChanged: false,
      lost: false            // 山札切れによる敗北フラグ（LPが残っていても負け）
    };
  }

  /** 対戦（マッチ）を作る。first は 'self' | 'enemy'（先攻） */
  function createMatch(opts) {
    const cards = opts.cards;
    const lanes = []; for (let i = 0; i < S.LANES; i++) lanes.push(S.emptyLane());
    return {
      cards: cards,
      rng: opts.rng,
      board: S.makeBoard(lanes, 0, 0),
      players: { self: createPlayer(opts.selfDeck, opts.selfOpts), enemy: createPlayer(opts.enemyDeck, opts.enemyOpts) },
      active: opts.first || 'self',
      turn: 0,                 // 原作 V335 相当。自他どちらのターンでも +1 される
      phase: 'draw',           // 'draw' | 'discard' | 'placement' | 'main' | 'battle' | 'over'
      winner: null,
      opponentId: opts.opponentId === undefined ? 0 : opts.opponentId,  // 原作 V340。101以上＝フリーユニット＝戦利品あり
      combat: null,            // 戦闘中の状態（js/engine/combat.js が持つ）
      pendingCurse: null,      // 憑依の予約（戦闘終了時に付着する）
      loot: [],                // 戦利品（通常攻撃で倒した敵ユニットのID。最大7）
      lastBattle: null,        // 直前の戦闘結果
      hooks: opts.hooks || null,  // { onMagicOpen } … 魔法の発動（M4）
      log: []
    };
  }

  function other(side) { return side === 'self' ? 'enemy' : 'self'; }
  function jp(side) { return side === 'self' ? '自分' : '相手'; }
  function activePlayer(m) { return m.players[m.active]; }
  function syncHandCount(m) {
    m.board.hand.self = m.players.self.hand.length;
    m.board.hand.enemy = m.players.enemy.hand.length;
  }
  function recalc(m) {
    // 戦闘中は当事者以外のレーンの能力値を凍結する（原作 EV0171 page1 冒頭）
    const combat = m.combat ? { attacker: m.combat.attacker, defender: m.combat.defender } : null;
    Stats.recalc(m.board, { cards: m.cards, combat: combat });
  }
  /** 戦闘モジュール。循環参照を避けるため、読み込み時ではなく呼ぶ瞬間に解決する */
  function combatApi() {
    return (typeof require === 'function' && typeof window === 'undefined')
      ? require('./combat.js') : global.CQCombat;
  }
  function note(m, msg) { m.log.push(msg); }

  /** カードオブジェクトを引く（マスターズソウルは呼び出し側が opts.msEquip を渡すこと） */
  function cardOf(m, id) { return m.cards[id]; }

  /* ---- 勝敗判定 ------------------------------------------------------------ */

  /** null（継続）または勝者側 'self'|'enemy' を返す */
  function checkResult(m) {
    if (m.winner) return m.winner;
    if (m.players.self.lp <= 0 || m.players.self.lost) return finish(m, 'enemy');
    if (m.players.enemy.lp <= 0 || m.players.enemy.lost) return finish(m, 'self');
    return null;
  }
  function finish(m, winner) {
    m.winner = winner; m.phase = 'over';
    note(m, (winner === 'self' ? '自分' : '相手') + 'の勝利');
    return winner;
  }

  /* ---- ドローステップ -------------------------------------------------------- */

  /** ターン開始（ドローステップ）。表側の1ターン目は6枚、以降は1枚。
   * 手札が7枚を超えたら phase='discard' になり、discardCard() で捨てるまで次に進めない。 */
  function beginTurn(m) {
    if (m.winner) return m;
    m.turn += 1;                                    // 原作 V335：両者のターンで+1
    const side = m.active, p = activePlayer(m);
    p.actedThisTurn = false;
    const n = p.turnsTaken === 0 ? FIRST_DRAW : 1;
    for (let i = 0; i < n; i++) {
      const id = draw(m.rng, p);
      if (id == null) { p.lost = true; syncHandCount(m); checkResult(m); return m; }
    }
    p.turnsTaken += 1;
    syncHandCount(m);
    m.phase = p.hand.length > HAND_CAP ? 'discard' : 'placement';
    note(m, jp(side) + ' のドロー（' + n + '枚）');
    return m;
  }

  /** 手札7枚オーバー時、1枚を捨てる。7枚になるまで繰り返し呼ぶ */
  function discardCard(m, handIndex) {
    if (m.phase !== 'discard') return { ok: false, reason: '捨て札の場面ではありません' };
    const p = activePlayer(m);
    if (handIndex < 0 || handIndex >= p.hand.length) return { ok: false, reason: '手札の指定が不正です' };
    p.hand.splice(handIndex, 1);
    syncHandCount(m);
    if (p.hand.length <= HAND_CAP) m.phase = 'placement';
    return { ok: true };
  }

  /* ---- 配置ステップ ---------------------------------------------------------- */

  /** 場のどこかに光臨(199)／アッシュメイカー(55)固有能力があるか（陣営を問わない。
   * 『能力値計算とチャンネル』確定事項#11 の V821..V826 は6レーン全体を見ている） */
  function anyAdvent(m) {
    return m.board.lanes.some(function (ln) { return ln.unit != null && ln.acc && ln.acc.advent >= 1; });
  }

  /** 手札のユニットカードを自陣の空きレーンに召還する。召還Ｌｖ2以上は手札から直接出せない。
   * ただし光臨(199)があれば召還Ｌｖ3〜6のユニットに限り直接召還できる
   * （召還Ｌｖ2はテキストと違い光臨でも直接召還できない＝原作の食い違いのまま。魔道書はメインステップの
   * リバース召還にのみ効くため、この直接召還には効かない） */
  function summon(m, laneIndex, handIndex) {
    if (m.phase !== 'placement') return { ok: false, reason: '配置ステップではありません' };
    const side = m.active, p = activePlayer(m);
    const own = S.lanesOf(side);
    if (own.indexOf(laneIndex) < 0) return { ok: false, reason: '自陣のレーンではありません' };
    if (m.board.lanes[laneIndex].unit != null) return { ok: false, reason: 'そのレーンは空いていません' };
    const id = p.hand[handIndex];
    if (id == null) return { ok: false, reason: '手札の指定が不正です' };
    const card = cardOf(m, id);
    if (!card || card.t !== 'U') return { ok: false, reason: 'ユニットカードではありません' };
    const us = S.unitStats(card);
    recalc(m);
    const bypass = us.lv >= 3 && us.lv <= 6 && anyAdvent(m);
    if (us.lv > 1 && !bypass) return { ok: false, reason: '召還レベルが足りません（手札から直接召還できるのは召還Lv1のみ）' };
    p.hand.splice(handIndex, 1);
    m.board.lanes[laneIndex] = S.makeLane(id, [], m.cards);
    m.board.lanes[laneIndex].stiff = true;           // 召還したユニットは硬直
    p.actedThisTurn = true;
    syncHandCount(m);
    recalc(m);
    note(m, jp(side) + ' が ' + card.n + ' を召還');
    return { ok: true };
  }

  /** チャネル対象のレーンが受け入れ可能か調べる（内部用） */
  function laneAcceptsChannel(m, laneIndex) {
    const lane = m.board.lanes[laneIndex];
    if (lane.unit == null) return { ok: false, reason: 'ユニットが居ません' };
    recalc(m);
    return { ok: true, lane: lane, full: lane.count >= lane.cap };
  }

  /** 手札のカードをレーンに付加する（裏向き）。配置ステップは押し込み可、メインステップは不可。
   * meIsMine: このチャネルの所有者は誰か（呼び出し側の陣営）。原作は「置いた人」が所有者になる */
  function channel(m, laneIndex, handIndex, opts) {
    const o = opts || {};
    if (m.phase !== 'placement' && m.phase !== 'main') return { ok: false, reason: 'いまはチャネルできません' };
    const side = m.active, p = activePlayer(m);
    if (m.phase === 'main') {
      const own = S.lanesOf(side);
      // メインステップのチャネルは自陣・敵陣どちらのレーンも対象にできる（原作準拠）が、
      // 「1ユニット1ターン1行動」を対象レーン自身の硬直で管理する
    }
    const acc = laneAcceptsChannel(m, laneIndex);
    if (!acc.ok) return acc;
    const lane = acc.lane;
    if (m.phase === 'main' && lane.stiff) return { ok: false, reason: 'そのユニットは行動済みです' };
    // 閉鎖(184)・カース98：チャネリング自体ができなくなる（押し込みも不可）。
    // 遮蔽(136)は cap=count にする点は同じだが押し込みは禁止しない（非対称。原作の確定事項#8）
    if (lane.acc.closedSkill >= 1) return { ok: false, reason: '閉鎖：チャネリングできません' };
    const id = p.hand[handIndex];
    if (id == null) return { ok: false, reason: '手札の指定が不正です' };

    if (acc.full) {
      if (m.phase !== 'placement') return { ok: false, reason: '満杯です（押し込みは配置ステップのみ）' };
      const layer = o.layer;
      if (!(layer >= 1 && layer <= lane.channels.length)) return { ok: false, reason: '押し込む階層の指定が不正です' };
      p.hand.splice(handIndex, 1);
      const removed = lane.channels[layer - 1];
      lane.channels[layer - 1] = { card: id, up: false, mine: side === 'self', revealed: false };
      lane.stiff = true;
      lane.channeled = true;                          // 原作 SW583〜：このターンはアタックできない
      p.actedThisTurn = true;
      syncHandCount(m);
      recalc(m);
      note(m, jp(side) + ' が ' + layer + ' 階層目に押し込み（' + (removed ? removed.card : '?') + ' は消滅）');
      return { ok: true, pushedOut: removed };
    }

    p.hand.splice(handIndex, 1);
    lane.channels.push({ card: id, up: false, mine: side === 'self', revealed: false });
    lane.count += 1;
    lane.stiff = true;                                // 付加されたレーンのユニットは硬直（原作準拠）
    lane.channeled = true;                            // 原作 SW583〜：このターンはアタックできない
    p.actedThisTurn = true;
    syncHandCount(m);
    recalc(m);
    note(m, jp(side) + ' がチャネル');
    return { ok: true };
  }

  /** 配置ステップを終える（メインステップへ） */
  function endPlacement(m) {
    if (m.phase !== 'placement') return { ok: false, reason: '配置ステップではありません' };
    m.phase = 'main';
    return { ok: true };
  }

  /* ---- メインステップ：リバース ---------------------------------------------- */

  /** 1体のユニットについて、指定した階層を下から順に開閉する（1回の呼び出し＝1行動＝即硬直）。
   * layers は昇順の階層番号配列（例 [1,2]）。全部まとめて検証してから適用する。 */
  function reverseAction(m, laneIndex, layers) {
    if (m.phase !== 'main') return { ok: false, reason: 'メインステップではありません' };
    const side = m.active;
    if (laneIndex < 0 || laneIndex >= 6) return { ok: false, reason: '不正なレーンです' };
    const lane = m.board.lanes[laneIndex];
    if (lane.unit == null) return { ok: false, reason: 'ユニットが居ません' };
    recalc(m);                                              // flipped（傀儡）・acc を最新化してから判定
    // 傀儡(169)・カース92で操作権が反転していると、いまの操作側だけがリバースできる（M4）
    if (S.controlSide(lane, laneIndex) !== side) return { ok: false, reason: '自陣のユニットだけがリバースできます' };
    if (lane.stiff) return { ok: false, reason: 'そのユニットは行動済みです' };
    if (!layers || !layers.length) return { ok: false, reason: '階層の指定がありません' };
    if (lane.acc.lock >= 1) return { ok: false, reason: '固定／石化でリバースできません' };

    // 検証（全部通らなければ何も変更しない）
    let ptr = lane.reversePtr;
    for (let i = 0; i < layers.length; i++) {
      const n = layers[i];
      if (!(n >= 1 && n <= lane.channels.length)) return { ok: false, reason: '存在しない階層です' };
      if (!(ptr < n)) return { ok: false, reason: 'リバースは下から上への一方通行です' };
      const ch = lane.channels[n - 1];
      if (ch.up && ch.card < 151) return { ok: false, reason: 'クローズできるのは技能カードだけです' };
      if (ch.up && ch.card === 167 && lane.acc.seal === 0) return { ok: false, reason: '腐食は封印がないとクローズできません' };
      ptr = n;
    }
    // 適用
    layers.forEach(function (n) {
      const ch = lane.channels[n - 1];
      ch.up = !ch.up;
      if (ch.up) ch.revealed = true;                  // オープンした瞬間に内容が判明する（原作準拠）
      lane.reversePtr = n;
    });
    lane.stiff = true;
    activePlayer(m).actedThisTurn = true;
    recalc(m);
    note(m, jp(side) + ' がレーン' + laneIndex + 'を' + layers.join(',') + '階層リバース');
    return { ok: true };
  }

  /* ---- チェンジ（マリガン） --------------------------------------------------- */

  /** 手札をすべて捨てて同じ枚数を引き直す。実装計画の house rule：毎バトル1回・LP1消費・
   * 自分の最初のターンの配置ステップでのみ（原作のアイテム制は廃止し常設化） */
  function change(m) {
    if (m.phase !== 'placement') return { ok: false, reason: 'いまは使えません' };
    const side = m.active, p = activePlayer(m);
    if (p.turnsTaken !== 1) return { ok: false, reason: '自分の最初のターンでのみ使えます' };
    if (p.actedThisTurn) return { ok: false, reason: 'このターンに何か操作した後は使えません' };
    if (p.hasChanged) return { ok: false, reason: 'このバトルではもう使えません' };
    if (p.lp <= 1) return { ok: false, reason: 'ＬＰが足りません' };
    const n = p.hand.length;
    p.deckCount += n;
    p.hand.forEach(function (id) { p.deck[id] = (p.deck[id] || 0) + 1; });
    p.hand = [];
    for (let i = 0; i < n; i++) draw(m.rng, p);
    p.lp -= 1;
    p.hasChanged = true;
    p.actedThisTurn = true;
    syncHandCount(m);
    note(m, jp(side) + ' がチェンジ');
    return { ok: true, result: checkResult(m) };
  }

  /* ---- ターン終了 ------------------------------------------------------------ */

  /** メインステップを終える。表向き魔法カードの消滅・未行動時の補充・ＬＰクランプ・
   * 硬直とリバースポインタの解除を行い、手番を相手に渡す */
  function endTurn(m) {
    if (m.phase !== 'main') return { ok: false, reason: 'メインステップではありません' };
    const side = m.active, p = activePlayer(m);

    recalc(m);
    // 表向き魔法カード(101〜150)の消滅（＋爆殺の自爆・放出）。停滞(151)があるレーンは残る
    combatApi().expireMagic(m);

    // 腐食(167)・カース94/95（マッドシックル／デストレーダー由来）：付いているユニットの持ち主の
    // ターン終了時に自滅する（通常攻撃ではないので戦利品・憑依は発生しない。救済があれば無効化される）
    S.lanesOf(side).forEach(function (i) {
      const ln = m.board.lanes[i];
      if (ln.unit != null && (ln.acc.rot >= 1 || ln.acc.doom >= 1)) {
        note(m, jp(side) + ' の ' + (m.cards[ln.unit] ? m.cards[ln.unit].n : ('#' + ln.unit)) + ' がターン終了時に自滅');
        combatApi().destroy(m, i, { normalAttack: false });
      }
    });
    if (checkResult(m)) { syncHandCount(m); return { ok: true, result: m.winner }; }

    // 魂の門(181)：そのレーンにターン終了時、デッキから直に1枚をＣＨ付加する（空きがあれば）
    S.lanesOf(side).forEach(function (i) {
      const ln = m.board.lanes[i];
      if (!ln || ln.unit == null || ln.acc.soulGate < 1) return;
      recalc(m);
      if (ln.cap <= ln.count) return;                 // 空きが無ければ得られない
      const id = draw(m.rng, p);
      if (id == null) return;                         // 山札切れ（敗北判定はこの後のチェックで拾う）
      p.hand.pop();                                    // draw() は手札に積むので、そのまま外へ出す
      ln.channels.push({ card: id, up: false, mine: side === 'self', revealed: false });
      ln.count = ln.channels.length;
      note(m, jp(side) + ' の魂の門：デッキから1枚付加');
    });
    recalc(m);

    // 未行動かつ手札5枚以下なら1枚補充
    if (!p.actedThisTurn && p.hand.length <= 5) {
      const id = draw(m.rng, p);
      if (id == null) p.lost = true;
    }

    // ＬＰクランプ
    if (p.lp > p.maxLp) p.lp = p.maxLp;

    // 自陣の硬直・リバースポインタ・連続攻撃の権利を解除
    S.lanesOf(side).forEach(function (i) {
      m.board.lanes[i].stiff = false;
      m.board.lanes[i].reversePtr = 0;
      m.board.lanes[i].extraAttack = false;
    });
    // 「このターンにチャネリングされた」印は全レーンで解除する（原作 SW583〜588）
    m.board.lanes.forEach(function (lane) { lane.channeled = false; });

    syncHandCount(m);
    const result = checkResult(m);
    if (result) return { ok: true, result: result };

    m.active = other(side);
    m.phase = 'draw';
    note(m, jp(side) + ' のターン終了');
    return { ok: true, result: null };
  }

  const api = {
    HAND_CAP, FIRST_DRAW,
    createDeck, draw, createPlayer, createMatch,
    beginTurn, discardCard, summon, channel, endPlacement, reverseAction, change, endTurn,
    checkResult
  };
  global.CQTurn = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
