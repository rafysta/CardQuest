/* CardQuest エンジン — ユニット固有能力ディスパッチャ（実装計画 M4 v0.14）
 *
 * 『SOULGATE カードバトル仕様書』§10・カード一覧の一行効果テキストから実装する。
 * 詳細仕様書（07_unit_abilities.md、1031行）はプロジェクトに存在しないため、v0.13の魔法
 * カード実装と同じ方針（一行効果テキスト＋仕様書§10の一般原則から再構成し、根拠が薄い
 * 箇所はコメントに明記する）を踏襲する。
 *
 * ユニット固有能力は3系統に分かれる（§10）。A型（自己付加型）は既に stats.js の
 * accInnate() で実装済み。ここで扱うのは残り2系統：
 *
 *   B.「開：」型（10体）… そのユニットがチャネルとして開かれた（＝リバース召還される）
 *     瞬間に発動する。§10.2「『開：』型の解決はリバース召還より前に行われる」
 *     「開：型は無効・抑制で止められない」に従い、combat.js の onOpen() から
 *     リバース召還処理（reverseSummon）より前に、無効化チェックを経由せず呼ばれる。
 *
 *   C.「特：」型（14体）… メインステップの4つ目の主行動（リバース／アタック／チャネルと同格）
 *     として、js/engine/turn.js の specialAction() から呼ばれる。§10.1「対象が居なくても
 *     行動は消費される」に従い、実行後は呼び出し側（turn.js）が必ず硬直させる。
 *
 * 対象選択は v0.13の魔法カードと同じ方針で、合法な対象から m.rng が自動選択する
 * （対話的な選択ＵＩは対象外。101憑依解除のみ v0.13.6 で対応済み）。
 */
'use strict';
(function (global) {

  const isNode = (typeof require === 'function' && typeof window === 'undefined');
  const S = isNode ? require('../state.js') : global.CQState;
  const Stats = isNode ? require('../stats.js') : global.CQStats;

  function other(side) { return side === 'self' ? 'enemy' : 'self'; }
  function jp(side) { return side === 'self' ? '自分' : '相手'; }
  function note(m, msg) { m.log.push(msg); }
  function nameOf(m, id) { const c = m.cards[id]; return c ? c.n : ('#' + id); }
  function combatApi() { return isNode ? require('../combat.js') : global.CQCombat; }
  function turnApi() { return isNode ? require('../turn.js') : global.CQTurn; }
  function recalc(m) {
    const combat = m.combat ? { attacker: m.combat.attacker, defender: m.combat.defender } : null;
    Stats.recalc(m.board, { cards: m.cards, combat: combat });
  }
  function damage(m, side, n) { if (!n) return; m.players[side].lp -= n; }
  function heal(m, side, n) {
    const p = m.players[side]; p.lp += n; if (p.lp > p.maxLp) p.lp = p.maxLp;
  }
  function pick(m, arr) { return arr.length ? arr[m.rng.int(0, arr.length - 1)] : null; }
  function allUnitLanes(m) {
    const res = []; for (let i = 0; i < 6; i++) if (m.board.lanes[i].unit != null) res.push(i);
    return res;
  }
  function sideLanes(m, side) { return allUnitLanes(m).filter(function (i) { return S.sideOf(i) === side; }); }
  function allChannels(m, filter) {
    const res = [];
    m.board.lanes.forEach(function (ln, i) {
      if (ln.unit == null) return;
      ln.channels.forEach(function (ch, j) { if (!filter || filter(ch, i, j)) res.push({ lane: i, idx: j }); });
    });
    return res;
  }
  function dropChannelAt(m, laneIndex, idx) {
    const ln = m.board.lanes[laneIndex];
    const removed = ln.channels[idx];
    ln.channels.splice(idx, 1);
    ln.count = ln.channels.length;
    return removed;
  }
  function pushChannel(m, laneIndex, entry) {
    const ln = m.board.lanes[laneIndex];
    ln.channels.push(entry);
    ln.count = ln.channels.length;
  }
  /** 手札上限7枚を超えたら超過分を捨てる（magic.js と同じ規約） */
  function capHand(m, side) {
    const p = m.players[side];
    while (p.hand.length > 7) {
      const id = p.hand.pop();
      note(m, jp(side) + 'は手札上限を超え ' + nameOf(m, id) + ' を捨てた');
    }
  }
  /** 対象レーン以外の「空きがあるユニットレーン」一覧 */
  function unitLanesWithRoom(m, exceptLane) {
    const res = [];
    for (let i = 0; i < 6; i++) {
      if (i === exceptLane) continue;
      const ln = m.board.lanes[i];
      if (ln.unit != null && ln.cap > ln.count) res.push(i);
    }
    return res;
  }

  /* ================= 共通ヘルパー（複数カードで同じ処理） ================= */

  /** クローズ×１：場のどこかの「クローズできる状態」のＣＨを1つ選んで閉じる。
   * 通常のクローズ規則（技能カードのみ・腐食は封印必須・固定/石化のレーンは不可）を流用する */
  function closableCandidates(m) {
    const res = [];
    m.board.lanes.forEach(function (ln, i) {
      if (ln.unit == null) return;
      if (ln.acc && ln.acc.lock >= 1) return;                     // 固定・石化はクローズ不可
      ln.channels.forEach(function (ch, j) {
        if (!ch.up || ch.card < 151) return;                      // クローズできるのは技能カードだけ
        if (ch.card === 167 && !(ln.acc && ln.acc.seal >= 1)) return;  // 腐食は封印が無いと不可
        res.push({ lane: i, idx: j });
      });
    });
    return res;
  }
  function closeOne(m, label) {
    const t = pick(m, closableCandidates(m));
    if (!t) { note(m, label + '：クローズできる対象が無い'); return; }
    const ch = m.board.lanes[t.lane].channels[t.idx];
    ch.up = false;
    recalc(m);
    note(m, label + '：' + nameOf(m, ch.card) + ' をクローズ');
  }

  /** ＣＨ×１確認：場のどこかの裏向き未確認ＣＨを1つ見る */
  function peekOne(m, label) {
    const pool = allChannels(m, function (ch) { return !ch.up && !ch.revealed; });
    const t = pick(m, pool);
    if (!t) { note(m, label + '：対象が無い'); return; }
    m.board.lanes[t.lane].channels[t.idx].revealed = true;
    note(m, label + '：裏向きのＣＨを1枚確認した');
  }

  /** Ａ550の特殊攻撃：防御力550以下の敵ユニット1体を無条件で破壊する（135雷撃と同型） */
  function lightning550(m, side, label) {
    recalc(m);
    const enemy = other(side);
    const pool = sideLanes(m, enemy).filter(function (i) { return m.board.lanes[i].def <= 550; });
    const t = pick(m, pool);
    if (t == null) { note(m, label + '：対象が無い'); return; }
    const name = nameOf(m, m.board.lanes[t].unit);
    combatApi().destroy(m, t, { normalAttack: false });
    note(m, label + '：' + name + ' を破壊');
  }

  /** 「石化」「疫障」「腐食」を敵ユニット1体に付加する（105/45系の特殊行動で共通） */
  function attachCurseSkill(m, side, skillId, label) {
    const enemy = other(side);
    const targets = sideLanes(m, enemy).filter(function (i) { return m.board.lanes[i].cap > m.board.lanes[i].count; });
    const t = pick(m, targets);
    if (t == null) { note(m, label + '：付加できる対象が無い'); return; }
    pushChannel(m, t, { card: skillId, up: true, mine: side === 'self', revealed: true });
    recalc(m);
    note(m, label + '：' + nameOf(m, m.board.lanes[t].unit) + ' に付加した');
  }

  /* ================= B.「開：」型（10体） ================= */

  function h1(m, ctx) { closeOne(m, 'クローズ'); }                 // ミルファイター：クローズ×１
  function h27(m, ctx) { closeOne(m, 'クローズ'); }                // メガゾエア：クローズ×１

  function h16(m, ctx) {                                        // レッドレックス：Ａ６００火弾
    recalc(m);
    const enemy = other(ctx.caster);
    const pool = sideLanes(m, enemy).filter(function (i) { return m.board.lanes[i].def <= 600; });
    const t = pick(m, pool);
    if (t == null) { note(m, 'Ａ６００火弾：対象が無い'); return; }
    const name = nameOf(m, m.board.lanes[t].unit);
    combatApi().destroy(m, t, { normalAttack: false });
    note(m, 'Ａ６００火弾：' + name + ' を破壊');
  }

  function h23(m, ctx) {                                        // アンフィビアス：手札２枚入手
    const p = m.players[ctx.caster], Turn = turnApi();
    let n = 0;
    for (let i = 0; i < 2; i++) { if (Turn.draw(m.rng, p, m) == null) break; n += 1; }
    capHand(m, ctx.caster);
    note(m, '手札２枚入手：' + n + '枚引いた');
  }

  function h24(m, ctx) {                                        // シニスターセラフ：ＣＨ×１破壊
    // 発動中の自分自身（まだこの階層のＣＨとして残っている）は対象から除く（101憑依解除と同じ理由）
    const pool = allChannels(m, function (ch, lane, idx) {
      return !(lane === ctx.laneIndex && idx === ctx.layer - 1);
    });
    const t = pick(m, pool);
    if (!t) { note(m, 'ＣＨ破壊：対象が無い'); return; }
    const removed = dropChannelAt(m, t.lane, t.idx);
    recalc(m);
    note(m, 'ＣＨ破壊：' + nameOf(m, removed.card) + ' を破壊');
  }

  /** スケープゴート「開：摩り替り」＝**チャネル先のユニットと位置を入れ替える**。
   * スケープゴートがユニット本体になり、元のユニットがスケープゴートの居たＣＨ階層に落ちる。
   * 名前どおりの「身代わり」で、狙われているユニットを庇う使い方ができる。
   *
   * ★M6.7 WP3（判断6）：原作解析 `07_unit_abilities.md` §ID25 で仕様が判明した。
   * v0.16.22までは「手札に分身を加える」という推測実装だったが、外れていた。
   * 原作は入れ替えたあとも `V284 == 25` のまま召還処理に進んでしまい
   * 「空きレーンがあるとスケープゴートが2体になり、元ユニットが消える」というバグがあるが、
   * **これは再現しない**（§0-1 の方針：面白さに寄与しない原作バグは直してよい）。
   *
   * 条件：そのチャンネルを置いたのが自分自身であること（原作 SW[442+idx] == OFF）。 */
  function h25(m, ctx) {
    const ln = m.board.lanes[ctx.laneIndex];
    const ch = ln && ln.channels[ctx.layer - 1];
    if (!ln || ln.unit == null || !ch) return;
    /* そのユニットの持ち主が自分で置いたチャンネルでなければ発動しない
     * （原作 SW[442+idx] == OFF）。相手に押し付けられた身代わりでは入れ替わらない。
     * ctx.caster はチャンネルを置いた側なので、ここでは**レーンの持ち主**と比べる。 */
    const ownerIsSelf = S.sideOf(ctx.laneIndex) === 'self';
    if (ch.mine !== ownerIsSelf) {
      note(m, '摩り替り：そのユニットの持ち主が置いたものではないので入れ替わらない');
      return;
    }
    const mine = ownerIsSelf;
    const host = ln.unit;
    /* ★スケープゴートにスケープゴートをチャネルしていると、入れ替えても盤面が変わらないのに
     * チャンネルが裏へ戻る＝オープンフェイズが永遠に終わらない（simulate.js seed 1855 で検出）。
     * 入れ替える意味が無いので何もしない。 */
    if (host === 25) { note(m, '摩り替り：入れ替える相手が同じスケープゴートなので何も起きない'); return; }
    ln.unit = 25;                                  /* スケープゴートがユニット本体になる */
    ln.channels[ctx.layer - 1] = {
      card: host, up: false, mine: mine, revealed: true   /* 元ユニットはそのＣＨ階層へ落ちる */
    };
    recalc(m);
    note(m, '摩り替り：' + nameOf(m, host) + ' と入れ替わって身代わりになった');
    /* 戻り値の2つの意味を使い分ける（M6.7 WP3で分離した）：
     *   consumed … この階層が**無くなった**。カーソルを1つ繰り上げる合図。
     *   handled  … 効果は済んだので**リバース召還はしない**。階層が残るかどうかとは別。
     * 摩り替りは「中身が別のカードに変わっただけ」なので handled だけを返す。
     * consumed を返すとカーソルがずれ、handled を返さないと開いた25がそのまま
     * 空きレーンへ召還されて**スケープゴートが2体になる**（原作のバグ）。 */
    return { handled: true };
  }

  function h29(m, ctx) {                                        // ステルスゴブリン：敵手札×１奪取
    const enemy = other(ctx.caster), p = m.players[enemy];
    if (!p.hand.length) { note(m, '敵手札奪取：相手の手札が無い'); return; }
    const id = p.hand.splice(m.rng.int(0, p.hand.length - 1), 1)[0];
    m.players[ctx.caster].hand.push(id);
    capHand(m, ctx.caster);
    note(m, '敵手札奪取：' + jp(enemy) + 'の手札から1枚奪った');
  }

  function h30(m, ctx) {                                        // イビルアイ：呪爆能力
    // 魔法カード133『呪爆』（このカードを開かせたユニットを破壊）と同じ挙動をユニット固有能力
    // として持つ、という解釈（名称・効果テキストが完全一致するため）
    const ln = m.board.lanes[ctx.laneIndex];
    const name = ln && ln.unit != null ? nameOf(m, ln.unit) : null;
    combatApi().destroy(m, ctx.laneIndex, { normalAttack: false });
    if (name) note(m, '呪爆能力：' + name + ' が破壊された');
    return { consumed: true };                                  // 自分ごとホストのレーンが消える
  }

  function h31(m, ctx) {                                        // ドライアード：ＬＰ＋１回復
    heal(m, ctx.caster, 1);
    note(m, 'ＬＰ回復：' + jp(ctx.caster) + ' のＬＰ +1');
  }

  function h40(m, ctx) { peekOne(m, 'ＣＨ確認'); }                // スピアバード：ＣＨ×１確認

  /* ================= C.「特：」型（14体） ================= */

  function s3(m, laneIndex, side) { attachCurseSkill(m, side, 168, '石化付加'); }        // ダーククラウド
  function s6(m, laneIndex, side) { attachCurseSkill(m, side, 155, '疫障付加'); }        // ヴェノムスピナー
  function s45(m, laneIndex, side) { attachCurseSkill(m, side, 167, '腐食付加'); }       // デザートニードル

  function s9(m, laneIndex, side) {                             // ディゾルバー：ＬＰ消費ＣＨ１破壊
    // 消費量がカードテキストに明記されていないため1点とする（簡略実装。要確認事項）
    damage(m, side, 1);
    note(m, 'ＬＰ消費：' + jp(side) + ' のＬＰ -1');
    const t = pick(m, allChannels(m));
    if (!t) { note(m, 'ＣＨ破壊：対象が無い'); return; }
    const removed = dropChannelAt(m, t.lane, t.idx);
    recalc(m);
    note(m, 'ＣＨ破壊：' + nameOf(m, removed.card) + ' を破壊');
  }

  function s10(m, laneIndex, side) { lightning550(m, side, 'Ａ５５０雷撃'); }             // ヨルムンガンド
  function s32(m, laneIndex, side) { lightning550(m, side, 'Ａ５５０雷撃'); }             // キャノンタートル
  function s36(m, laneIndex, side) { lightning550(m, side, 'Ａ５５０烈風'); }             // ヘルフライアー

  function s34(m, laneIndex, side) {                            // サイコダイバー：潜入能力
    // 魔法カード138『潜入』と同じ挙動（自分自身が他ユニットの裏向きＣＨとして潜行する）を
    // ユニット固有能力として持つ、という解釈
    const unitId = m.board.lanes[laneIndex].unit;
    const t = pick(m, unitLanesWithRoom(m, laneIndex));
    if (t == null) { note(m, '潜入能力：潜行先が無い'); return; }
    const destName = nameOf(m, m.board.lanes[t].unit);
    m.board.lanes[laneIndex] = S.emptyLane();
    pushChannel(m, t, { card: unitId, up: false, mine: side === 'self', revealed: false });
    recalc(m);
    note(m, '潜入能力：' + nameOf(m, unitId) + ' が ' + destName + ' へ潜行した');
  }

  function s35(m, laneIndex, side) {                            // ティンバータンク：自己ＣＨシャッフル
    const ln = m.board.lanes[laneIndex];
    if (!ln.channels.length) { note(m, '自己ＣＨシャッフル：ＣＨが無い'); return; }
    for (let i = ln.channels.length - 1; i > 0; i--) {
      const j = m.rng.int(0, i);
      const tmp = ln.channels[i]; ln.channels[i] = ln.channels[j]; ln.channels[j] = tmp;
    }
    recalc(m);
    note(m, '自己ＣＨシャッフル：ＣＨの並びをシャッフルした');
  }

  function s38(m, laneIndex, side) {                            // デモングローブ：手札＋１入手
    const p = m.players[side], Turn = turnApi();
    const id = Turn.draw(m.rng, p, m);
    capHand(m, side);
    note(m, '手札＋１入手：' + (id == null ? '山札が無い' : nameOf(m, id) + ' を引いた'));
  }

  function s44(m, laneIndex, side) { closeOne(m, 'クローズ'); }   // ブレインサッカー：クローズ×１
  function s48(m, laneIndex, side) { peekOne(m, 'ＣＨ確認'); }    // スカウター：ＣＨ×１確認
  function s49(m, laneIndex, side) { peekOne(m, 'ＣＨ確認'); }    // シャドウハンズ：ＣＨ×１確認

  function s70(m, laneIndex, side) {                            // ポルターガイスト：妄執・憑依：D-150
    // 「妄執」は魔法カード148と同じ自爆＋憑依の型。「憑依：D-150」は、このユニット自身が
    // 通常攻撃で倒されたときに残すカース96（防御力-150。カードバトル仕様書§9.2）と同じ効果を、
    // 自ら能動的に発動できる、という解釈（既存のカース96の集計処理をそのまま再利用できる）
    recalc(m);
    const dest = pick(m, unitLanesWithRoom(m, laneIndex));
    combatApi().destroy(m, laneIndex, { normalAttack: false });
    note(m, '妄執：自爆した');
    if (dest != null) {
      recalc(m);
      const ln = m.board.lanes[dest];
      if (ln && ln.unit != null && ln.cap > ln.count) {
        pushChannel(m, dest, { card: 96, up: true, mine: side === 'self', revealed: true, st: 'possess' });
        recalc(m);
        note(m, '憑依：' + nameOf(m, 96) + '（防御力-150）が ' + nameOf(m, ln.unit) + ' に取り憑いた');
      }
    }
  }

  /* ================= ディスパッチテーブル ================= */

  const B_HANDLERS = {
    1: h1, 16: h16, 23: h23, 24: h24, 25: h25,
    27: h27, 29: h29, 30: h30, 31: h31, 40: h40
  };
  const C_HANDLERS = {
    3: s3, 6: s6, 9: s9, 10: s10, 32: s32, 34: s34, 35: s35,
    36: s36, 38: s38, 44: s44, 45: s45, 48: s48, 49: s49, 70: s70
  };
  const B_TYPE = {}; Object.keys(B_HANDLERS).forEach(function (k) { B_TYPE[k] = true; });
  const C_TYPE = {}; Object.keys(C_HANDLERS).forEach(function (k) { C_TYPE[k] = true; });

  /** combat.js の onOpen() から、リバース召還より前に呼ばれる（§10.2）。
   * 無効(190)・抑制(120)のチェックは行わない（開：型はそれらを迂回する、という仕様のため）。
   * 戻り値 {consumed} … このカード自身のホストレーン自体が消滅した（30イビルアイ）ことを
   * 呼び出し元（combat.js/turn.js のオープンループ）へ知らせる */
  function onUnitOpen(m, laneIndex, layer, cardId) {
    const handler = B_HANDLERS[cardId];
    if (!handler) return { consumed: false, handled: false };
    const ln0 = m.board.lanes[laneIndex];
    const ch0 = ln0 && ln0.channels[layer - 1];
    const caster = ch0 ? (ch0.mine ? 'self' : 'enemy') : m.active;
    const opener = m.combat ? combatApi().openerSide(m) : m.active;
    const r = handler(m, { laneIndex: laneIndex, layer: layer, cardId: cardId, opener: opener, caster: caster }) || {};
    /* handled … 効果を処理したのでリバース召還はしない（階層が残っていても） */
    return { consumed: !!r.consumed, handled: !!r.consumed || !!r.handled };
  }

  /** turn.js の specialAction() から、メインステップの4つ目の主行動として呼ばれる（§10.1）。
   * 呼び出し側が「対象の有無に関わらず必ず硬直させる」処理を担当するので、ここでは純粋に
   * 効果の解決だけを行う */
  function doSpecialAction(m, laneIndex, side) {
    const cardId = m.board.lanes[laneIndex].unit;
    const handler = C_HANDLERS[cardId];
    if (!handler) return;
    handler(m, laneIndex, side);
  }

  const api = { onUnitOpen, doSpecialAction, B_TYPE, C_TYPE };
  global.CQUnits = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
