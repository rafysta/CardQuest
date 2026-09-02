/* CardQuest ラン — 進行管理（M6）
 *
 * 『CardQuest マップ仕様書』の状態遷移をここに集約する。js/run/map.js が作った
 * マップ（全マス確定済み）の上を進み、各マスの解決（戦闘以外）・おまかせドラフト・
 * 換金／購入／休憩・霧払いを行う。戦闘そのものは既存のバトルエンジン（js/engine/）を
 * そのまま使う——ここでは「その戦闘に何のデッキ・戦場ルールで臨むか」を組み立て、
 * 終わったら結果（戦利品・LP）をランに反映するだけ。DOMには依存しない。
 */
'use strict';
(function (global) {

  function need(name) {
    return (typeof require === 'function' && typeof module !== 'undefined')
      ? require('./' + name) : null;
  }
  const CQAreas = need('areas.js') || global.CQAreas;
  const CQMap = need('map.js') || global.CQMap;
  const CQTurnRef = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('../engine/turn.js') : global.CQTurn;
  const CQCollection = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('../meta/collection.js') : global.CQCollection;
  const CQRng = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('../engine/rng.js') : global.CQRng;
  const DECK_SIZE = (CQTurnRef && CQTurnRef.DECK_SIZE) || 40;
  const BLANK = 180;
  /* おまかせドラフトの回数（マップ仕様書§1.2は3回だったが、実装計画追補M6.6 §2-4で
   * 最大2回に変更。1回目＝エリアの敵／2回目＝いま買える魔法・技能）。 */
  const DRAFT_ROUNDS = 2;
  /* M7 WP3.5（マップ仕様書§1.2・経済追補§4-5 の案B・2026-09-01本人確定）：
   * レンタルは「デッキ40枚の枠外」。ホームでデッキ編集ができるようになると本が40枚を超え、
   * デッキを常に40枚きっちり組めてしまう——旧仕様（レンタルは空白の枠を埋める＝40枚の内側）
   * のままだと、その瞬間おまかせドラフトが二度と発生しなくなり、買い取り所（WP8）が
   * 常に空振りになる構造上の欠陥があった（M7 WP2で発見）。
   * 案Bはこれを「レンタルは常に別枠」にすることで解消する：戦闘デッキは実質
   * 40枚（本人のデッキ）＋レンタル最大 RENTAL_MAX 枚＝最大42枚になる。
   * ラウンド数と上限が同じ概念なので RENTAL_MAX は DRAFT_ROUNDS をそのまま使う
   * （1ラウンドにつき増えるレンタルは最大1枚のため）。 */
  const RENTAL_MAX = DRAFT_ROUNDS;
  /* フリーユニット戦の敵デッキの組成（M6.6 WP6・§7-5）。敵は召還できないので支援中心にし、
   * ユニットはチャネル弾として少量だけ混ぜる。合計は DECK_SIZE（40枚）ちょうどにする。
   * 旧構成は「ユニット20＋支援シェル20」だったが、召還が封じられた以上ユニット20枚は
   * ほぼ死に札だった（引くだけ手が詰まる）ため、この比率に取り直した。 */
  const FIELD_DECK_UNITS = 6;                                  /* チャネル弾としてのユニット */
  const FIELD_DECK_SHELL = DECK_SIZE - FIELD_DECK_UNITS;       /* 残りは魔法・技能 */

  /* ---- デッキ組み立て ---------------------------------------------------- */

  /** 敵の戦闘マス用デッキ：花形ユニット(node.enemy)＋プールの残りで20枚のユニット枠を埋め、
   * 支援シェル20枚（js/run/areas.js）を足して DECK_SIZE にする。
   * マスター固有の実デッキ抽出は実装計画M8。それまでの簡略版（開発メモに明記）。 */
  /** 通常戦闘（フリーユニット戦）の敵デッキ。
   * M6.6 WP6（§7-5）で組み直した：**敵は手札から召還できない**ので、デッキにユニットを
   * たくさん積む意味が無くなった（ユニットの使い道はチャネル＝強化弾としてだけ）。
   * そこで支援シェル（魔法・技能）を主にし、ユニットは少量だけ混ぜる。
   * ※ 場に立つ敵そのものは node.enemy の編成として battleSetup の enemyBoard で渡す。 */
  function buildBattleDeck(cards, area, node) {
    const pool = CQAreas.enemyPool(cards, area.id);
    const featured = node.enemy;
    const shell = CQAreas.SUPPORT_SHELL;
    const deck = [];
    /* 支援シェルを繰り返し積んで大半を埋める（チャネルで場のユニットを強化していく形） */
    let i = 0, guard = 0;
    while (deck.length < FIELD_DECK_SHELL && shell.length && guard < 400) {
      deck.push(shell[i % shell.length]); i++; guard++;
    }
    /* チャネル弾としてのユニットを少量。花形が居ればそれを軸にする */
    const units = [];
    if (featured) units.push(featured.id);
    let k = 0; guard = 0;
    while (units.length < FIELD_DECK_UNITS && pool.length && guard < 400) {
      const c = pool[k % pool.length];
      if (units.indexOf(c.id) < 0) units.push(c.id);
      k++; guard++;
    }
    while (units.length < FIELD_DECK_UNITS) units.push(featured ? featured.id : 8);
    return deck.concat(units.slice(0, FIELD_DECK_UNITS));
  }

  /** ボスのデッキ：プール上位（価格上限area.bossPriceMax以下）を集めて組む */
  function buildBossDeck(cards, area) {
    const pool = CQAreas.enemyPool(cards, area.id).filter(function (e) { return e.price <= area.bossPriceMax; });
    const top = pool.slice(-8);   /* 上位8種を薄く混ぜる（1種に偏らせない。理由は buildBattleDeck 参照） */
    const units = [];
    let i = 0, guard = 0;
    while (units.length < 20 && top.length && guard < 400) { units.push(top[i % top.length].id); i++; guard++; }
    while (units.length < 20) units.push(pool.length ? pool[pool.length - 1].id : 8);
    return units.slice(0, 20).concat(CQAreas.SUPPORT_SHELL);
  }

  /** 所持デッキ（多重集合）＋このランのレンタルから、実戦闘に使う配列を作る。
   * M7 WP3.5（案B）：**レンタルはデッキ40枚の枠外**。本人のデッキは DECK_SIZE（40枚。
   * 足りなければ空白(180)で埋める・多ければ切り詰める＝デッキが大きく育った後の保険）に
   * 固定したうえで、レンタル（最大 RENTAL_MAX 枚）をその後ろに足す。戦闘エンジン
   * （js/engine/turn.js）はカードID配列の長さに制約が無い多重集合実装なので、
   * 40枚を超える配列（最大42枚）をそのまま渡してよい（山札切れ・再装填のロジックも
   * 「残り枚数」ベースで動くため影響しない）。 */
  function buildPlayerDeck(run) {
    const ids = [];
    Object.keys(run.deck).forEach(function (k) {
      const n = run.deck[k];
      for (let i = 0; i < n; i++) ids.push(+k);
    });
    while (ids.length < DECK_SIZE) ids.push(BLANK);
    const deck = ids.slice(0, DECK_SIZE);
    (run.rentals || []).forEach(function (id) { deck.push(id); });
    return deck;
  }

  /* ---- ラン開始 ------------------------------------------------------------ */

  /** cards: CARD_BY_ID / areaId / seed / meta: {book, deck, known, gold, cleared}（js/meta/save.js）
   * M6.6 WP3：run.deck は保存デッキ（持ち出し分）のコピー。ラン中の増減はランに閉じ、
   * 終了時に settle() でメタへ反映する。ラン中に「本」行きになったカードは run.bookAdd に
   * 貯めておく（中断・再開でも失われないよう run 自体に持たせる＝cq_run に保存される）。 */
  function start(cards, areaId, seed, meta) {
    const area = CQAreas.get(areaId);
    if (!area) throw new Error('unknown area: ' + areaId);
    /* ドラフトの「未入手優先」の基準は記憶データ（known）。旧形式のメタ（テスト・後方互換）では
     * 従来どおり deck の種類で代用する。 */
    const ownedIds = (meta.known && meta.known.length)
      ? meta.known.slice()
      : Object.keys(meta.deck).filter(function (k) { return meta.deck[k] > 0; }).map(Number);
    const map = CQMap.generate({ cards: cards, areaId: areaId, seed: seed, ownedIds: ownedIds });
    /* M7 WP2：ＬＰ初期値＝9＋マスターレベル（ゲーム仕様書§2.3・§6.2）。
     * 記憶データが増えるほど1点ずつ増える＝収集そのものが探索の余力になる。
     * 段階1では10で、M6.6までのハードコード値と同じ（新規プレイヤーの体験は変わらない）。
     * この値は startLp としてそのまま清算のひっ算と称号「無傷の一日」の基準になる。 */
    const level = CQCollection.masterLevel((meta.known || []).length);
    const lp0 = CQCollection.startLp(level);
    return {
      areaId: areaId, seed: seed, map: map,
      at: map.start,
      lp: lp0, maxLp: CQCollection.LP_CAP,
      gold: meta.gold,
      /* M6.6 WP11：清算のひっ算（持ち込み／今日の獲得／減額）と称号「無傷の一日」の判定に、
       * 出発時点の値が要る。run.gold は買い物で減りも増えもするので、後から復元できない。 */
      startGold: meta.gold, startLp: lp0,
      deck: Object.assign({}, meta.deck),
      bookAdd: {},
      rentals: [],
      gainedCards: [],
      lootPending: [],
      draftDone: 0, draftPending: null,
      log: [], outcome: null
    };
  }

  /** ラン中の入手（戦利品・宝箱・購入・？イベント）。デッキに空きがあればデッキへ、
   * 入らなければ（合計40・同種3枚制限）本行き＝run.bookAdd に貯める。どちらでも必ず貰える。
   * WP7で「その場でデッキ／本を選ぶ画面」に置き換わるまでの自動振り分け。
   * 戻り値は実際に入った先（'deck'|'book'）。
   * M7 WP3.5（案B）：レンタルはデッキ40枚の枠外になったので、空き枠の計算に**数えない**
   * （以前はレンタルが仮想の空白を埋めている扱いだったが、いまは別枠なので無関係）。 */
  function gainCard(run, id) {
    if (+id === BLANK) return null;
    if (!run.bookAdd) run.bookAdd = {};   /* 旧形式の cq_run（中断中のラン）を再開した場合の保険 */
    const hasSlot = CQCollection.countsTotal(run.deck) < DECK_SIZE;
    if (hasSlot && CQCollection.canAddToDeck(run.deck, id).ok) {
      run.deck[id] = (run.deck[id] || 0) + 1;
      run.gainedCards.push(id);
      return 'deck';
    }
    run.bookAdd[id] = (run.bookAdd[id] || 0) + 1;
    run.gainedCards.push(id);
    return 'book';
  }

  /* ---- おまかせドラフト（§1.2） -------------------------------------------- */

  /** おまかせドラフトで「変更しない」を選んだときに残る対象（＝レンタルを受け取らない場合）。
   * M7 WP3.5（案B）より前は「デッキが満杯なら実カードを1枚押し出す（定価の低い順）」だったが、
   * **案Bではレンタルがデッキ40枚の枠外になったため、実カードを押し出す必要が無くなった**。
   * つまり通常は常に BLANK（180＝「借りない」の意味の見張り値。draftKeepCardHTML が
   * 「変更しない」の絵として使う）を返す。唯一の例外は**旧セーブ互換**：M6.6 WP3の移動モデル
   * より前の cq_run を再開した場合、run.deck に実体の空白(180)がそのまま残っていることがあり、
   * その場合はそれ自体が対象になる（applyDraft側で自然に片付く。実質は同じ「空白」なので
   * 処理を分ける必要が無い）。 */
  function draftTarget(run) {
    if ((run.deck[BLANK] || 0) > 0) return BLANK;
    return BLANK;
  }

  /** レンタルをもう1枠借りられるか（＝おまかせドラフトが発生する条件。§2-4 WP4・
   * M7 WP3.5 案B）。**デッキ（本人の40枚）が満杯かどうかはもう関係ない**——
   * レンタルは40枚の枠外なので、上限はレンタルの本数そのもの（RENTAL_MAX＝DRAFT_ROUNDS）。
   * 旧セーブ互換：run.deck に実体の空白(180)が残っている場合はそちらを優先して埋める。 */
  function hasBlankSlot(run) {
    if ((run.deck[BLANK] || 0) > 0) return true;
    const rentals = run.rentals ? run.rentals.length : 0;
    return rentals < RENTAL_MAX;
  }

  /** 次のドラフトを始める。M6.6 WP4で **3回→最大2回**・**レンタルの空き枠がある時だけ発生**
   * に変更（M7 WP3.5・案Bでは「レンタルの空き枠」＝デッキの空白ではなくレンタル本数の余地）。
   * 空きが無ければ null を返す＝呼び出し側はドラフトを飛ばして出発する。
   * 「1枚だけ空きがある時：1回目で埋めたら2回目は発生しない／変更しなければ2回目が発生」という
   * §4 WP4 の要求は、毎回ここで空きを見直すことで自然に満たされる。 */
  function beginDraftRound(run, cards) {
    if (run.draftDone >= DRAFT_ROUNDS) return null;
    if (!hasBlankSlot(run)) return null;
    const idx = run.draftDone;
    const options = (run.map.draftPools[idx] || []).slice();
    if (!options.length) return null;         /* 候補が用意できなかった回は飛ばす */
    const targetId = draftTarget(run, cards);
    run.draftPending = { round: idx, options: options, targetId: targetId };
    return run.draftPending;
  }

  /** pickedId が targetId と同じ＝「変更しない」（＝そのレンタル枠を借りない）。それ以外は
   * レンタルとして追加する（§1.2「所持済みが候補でも扱いはレンタルで統一」＝おまかせドラフトの
   * 入手は常にレンタル）。M7 WP3.5（案B）：targetId は通常つねに BLANK（実カードを押し出す
   * 必要が無くなった）で、以下の「run.deck[dp.targetId] を1枚減らす」処理は**旧セーブ互換専用**
   * ——M6.6 WP3の移動モデルより前の cq_run に実体の空白(180)が残っていた場合だけ通り、
   * それを1枚消費する（実カードを押し出すケースはもう発生しない）。
   * cards はログ表示用（省略可・後方互換）：渡せばカード名で、渡さなければ従来どおりIDで出す。 */
  function applyDraft(run, pickedId, cards) {
    const dp = run.draftPending;
    if (!dp) return false;
    const name = function (id) { return cards && cards[id] ? cards[id].n : id; };
    if (pickedId !== dp.targetId) {
      if ((run.deck[dp.targetId] || 0) > 0) {
        run.deck[dp.targetId] -= 1;   /* 旧セーブ互換：実体の空白(180)を1枚消費するだけ */
      }
      run.rentals.push(pickedId);
      run.log.push('おまかせドラフト：' + name(dp.targetId) + ' → ' + name(pickedId) + '（レンタル）');
    } else {
      run.log.push('おまかせドラフト：変更しない（' + name(dp.targetId) + '）');
    }
    run.draftDone += 1;
    run.draftPending = null;
    return true;
  }

  /** 3回のドラフトを終え、開始マスから最初の分岐へ出発する。
   * 開始マスの「解決」は案内・ドラフトの時点で既に済んでいるので、ここで cleared にする
   * （さもないと choices()/advance() が「まだ解決していない」として先へ進めなくなる） */
  function depart(run) {
    run.map.nodes[run.map.start].cleared = true;
    run.at = run.map.start;
  }

  /* ---- 進行・分岐選択 -------------------------------------------------------- */

  function node(run, id) { return run.map.nodes[id || run.at]; }
  function currentNode(run) { return node(run, run.at); }

  /** いま選べる次のマス（現在のマスが解決済みのときだけ意味を持つ） */
  function choices(run) {
    const n = currentNode(run);
    if (!n || !n.cleared) return [];
    return n.connectsTo.map(function (id) { return run.map.nodes[id]; });
  }

  function advance(run, nextId) {
    const n = currentNode(run);
    if (!n || !n.cleared) return { ok: false, reason: 'このマスはまだ解決していません' };
    if (n.connectsTo.indexOf(nextId) < 0) return { ok: false, reason: 'そこへは進めません' };
    run.at = nextId;
    return { ok: true };
  }

  /* ---- 戦闘マス ------------------------------------------------------------ */

  /** run.seed とマスidから、その戦闘専用の決定的な乱数シードを作る（同じランは常に同じ結果になる）。
   *
   * M6.6 WP12：**挑戦回数（n.attempts）も種に混ぜる。** 逃走はマスを cleared にしない
   * （追補§8-3 案A）ので同じ相手に入り直せるが、種がマスidだけだと**まったく同じ戦闘が
   * そのまま再生される**（同じ手札・同じ先攻・同じ相手の動き）＝逃げる意味が無くなる。
   * 挑戦回数を混ぜることで、入り直すたびに別の引きになり、本人の言う「延命ではなく
   * 仕切り直し」が実際に成立する。決定性は保たれる（同じラン・同じマス・同じ挑戦回数なら
   * 常に同じ戦闘。attempts は run に入るのでセーブ・再開でも揺れない）。 */
  function battleSeed(run, n) {
    let h = (run.seed >>> 0) ^ 0x9e3779b9;
    const s = String(n.id) + '#' + (n.attempts || 0);
    for (let i = 0; i < s.length; i++) h = (Math.imul(h ^ s.charCodeAt(i), 16777619)) >>> 0;
    return h >>> 0;
  }

  /** 先攻／後攻（M6.6 WP5・追補§4）。従来はここが常に 'self' 固定だったため、ラン中の
   * 戦闘は必ずプレイヤーが先攻という有利が付いたままだった。戦闘シードから battleSeed() と
   * 別の乱数列を1回引くだけの、決定的な50%抽選にする——同じランの同じマスなら常に同じ結果
   * （タイトルの「先攻ルーレット」演出は、この確定済みの結果を見せるだけで乱数は使わない。
   *  見た目のブレ角±10°などは演出側でMath.randomを使ってよい＝結果には影響しない）。
   * battleSetup() の seed（=戦闘本編のRNG）とは別インスタンスから1回 next() を引くだけなので、
   * 本編の乱数列（手札・引きなど）を消費せず、抽選結果にも影響しない。 */
  function firstTurnOf(run, n) {
    const r = CQRng.create(battleSeed(run, n) ^ 0x51ed270b);
    return r.next() < 0.5 ? 'self' : 'enemy';
  }

  /** CQTurn.createMatch にそのまま渡せる引数を作る（rng/hooksは呼び出し側＝layout.jsが足す） */
  /** そのマスの敵編成を、実際に場へ立てる並びにする（M6.6 WP6）。
   * マップは「代表1体＋体数」で持っているので、体数ぶん同じユニットを並べる（最大3体＝敵レーン数）。 */
  function enemyBoardOf(n) {
    if (!n.enemy) return [];
    const out = [];
    for (let i = 0; i < Math.min(3, n.enemy.count || 1); i++) out.push(n.enemy.id);
    return out;
  }

  function battleSetup(run, cards, n) {
    const area = CQAreas.get(run.areaId);
    const isBoss = n.type === 'boss';
    return {
      cards: cards,
      selfDeck: buildPlayerDeck(run),
      enemyDeck: isBoss ? buildBossDeck(cards, area) : buildBattleDeck(cards, area, n),
      first: firstTurnOf(run, n),
      opponentId: 900 + (n.seg == null ? 90 : n.seg * 10) + (n.slot || 0),
      fieldRules: n.fieldRules || [],
      selfOpts: { lp: run.lp, maxLp: run.maxLp },
      enemyOpts: isBoss ? { lp: area.bossLp, maxLp: area.bossLp } : undefined,
      /* M6.6 WP6：通常戦闘はフリーユニット戦（敵は配置済み・召還不可・場が空になれば勝ち）。
       * マスター戦（ボス）だけは従来どおりのＬＰ勝負なので mode を付けない（§2-6）。 */
      mode: isBoss ? undefined : 'field',
      enemyBoard: isBoss ? undefined : enemyBoardOf(n),
      seed: battleSeed(run, n)
    };
  }

  /** 逃走してマップへ戻ったときの反映（M6.6 WP12・追補§4 WP12）。
   * 戦利品もＧも得ない。持ち越すのは**ＬＰの減少だけ**。
   * **そのマスは cleared にしない**（追補§8-3 で本人が案Aを採用）＝プレイヤーはそのマスに
   * 留まり、もう一度入り直せる。こうすることで「逃げる」は延命ではなく仕切り直しになり、
   * マップ仕様書§1の「通常戦闘3回＋ボス1回」という構造も保たれる（戦闘を避けて
   * ボスへ直行することができない）。
   * 逃走失敗のＬＰ−1でＬＰが0になった場合だけは、その場でランが終わる。 */
  function reportFlee(run, n, M) {
    run.lp = Math.max(0, M.players.self.lp);
    /* 挑戦回数を進める＝次に入り直したときは別の引きの戦闘になる（battleSeed 参照）。
     * これをやらないと、逃げても寸分違わず同じ戦闘が始まるだけで意味が無い。 */
    n.attempts = (n.attempts || 0) + 1;
    if (run.lp <= 0) {
      run.outcome = 'lose';
      run.log.push('逃げきれずに力尽きた');
      return { fled: true, dead: true };
    }
    run.log.push('戦いから離脱した（このマスはまだ残っている）');
    return { fled: true, dead: false };
  }

  /** 戦闘終了後（M.winner が確定した後）に呼ぶ。戦利品・Ｇ・ＬＰをランに反映する。
   * M6.6 WP6（§2-6）で報酬を変更した：
   *   通常戦闘（フリーユニット戦）＝**Ｇは出ない**。敵ユニットは金を落とさず、戦利品のカードだけ。
   *   マスター戦（ボス）＝**ファイトマネーは原作準拠**（areas.js の fightMoney。草原・森はＣ級500G）。
   *                       すでにクリア済みのエリアを周回しているときは50%。
   * ラン中の主収入は宝箱に寄る（マップ仕様書§7・追補§7-1の想定どおり）。
   * M6.6 WP7：戦利品はここでは自動でデッキ／本へ振り分けない。`run.lootPending` に積むだけにして、
   * どちらに送るかはプレイヤーが振り分け画面（resolveLootPick）で選ぶ。ただし「入手した」事実
   * （NEWバッジ・記憶データ登録の元になる gainedCards）はここで確定させる——カードは必ず
   * 手に入る（§2-7）ので、置き先が未定でも「入手済み」扱いにしてよい。 */
  function reportBattle(run, n, M, meta) {
    n.cleared = true;
    if (M.winner === 'self') {
      const loot = (M.loot || []).slice();
      if (!run.lootPending) run.lootPending = [];
      loot.forEach(function (id) {
        run.gainedCards.push(id);
        run.lootPending.push(id);
      });
      const area = CQAreas.get(run.areaId);
      let gold = 0;
      if (n.type === 'boss') {
        const repeat = !!(meta && meta.cleared && meta.cleared.indexOf(run.areaId) >= 0);
        gold = Math.round((area.fightMoney || 0) * (repeat ? 0.5 : 1));
      }
      run.gold += gold;
      run.lp = M.players.self.lp;
      run.log.push((n.type === 'boss' ? 'ボス' : '戦闘') + 'に勝利（'
        + (gold ? 'Ｇ+' + gold + '・' : '') + '戦利品' + loot.length + '枚）');
      return { win: true, loot: loot, gold: gold };
    }
    run.lp = 0;
    run.outcome = 'lose';
    run.log.push((n.type === 'boss' ? 'ボス' : '戦闘') + 'に敗北');
    return { win: false };
  }

  /* ---- 戦利品の振り分け（M6.6 WP7） ---------------------------------------- */

  /** そのカードを今すぐ「デッキに加える」が選べるか（合計40未満・同種上限内）。
   * M7 WP3.5（案B）：レンタルはデッキ40枚の枠外なので、gainCard と同じ理由で
   * 空き枠の計算に**数えない**（以前は数えていた）。 */
  function canAssignToDeck(run, id) {
    const hasSlot = CQCollection.countsTotal(run.deck) < DECK_SIZE;
    return hasSlot && CQCollection.canAddToDeck(run.deck, id).ok;
  }

  /** 戦利品カード1枚を「デッキ」か「本」へ確定する（§4 WP7）。run.lootPending から
   * 該当の1枚を取り除く（同じIDが複数あるときはどれを消しても結果は同じなので先頭を消す）。
   * 「本に送る」は常に成功（本は上限なし＝必ず貰える）。「デッキに加える」は空きが無ければ
   * 失敗を返す（画面側は無効化しておくのが基本だが、二重タップ等の保険として弾く）。
   * cards はログ表示用（省略可・applyDraft と同じ規約）。 */
  function resolveLootPick(run, id, dest, cards) {
    if (!run.lootPending) run.lootPending = [];
    const idx = run.lootPending.indexOf(+id);
    if (idx < 0) return { ok: false, reason: '対象のカードが見つかりません' };
    if (dest === 'deck') {
      if (!canAssignToDeck(run, id)) return { ok: false, reason: 'デッキに空きがありません' };
      run.deck[id] = (run.deck[id] || 0) + 1;
    } else {
      if (!run.bookAdd) run.bookAdd = {};
      run.bookAdd[id] = (run.bookAdd[id] || 0) + 1;
    }
    run.lootPending.splice(idx, 1);
    const name = cards && cards[id] ? cards[id].n : id;
    run.log.push('戦利品：' + name + '→' + (dest === 'deck' ? 'デッキ' : '本'));
    return { ok: true, dest: dest };
  }

  /* ---- 宝箱・休憩・ショップ・換金・？イベント ------------------------------------- */

  function openChest(run, n) {
    if (n.opened) return { gold: 0, cardId: null };
    n.opened = true; n.cleared = true;
    run.gold += n.gold;
    if (n.cardId != null) gainCard(run, n.cardId);
    run.log.push('宝箱：Ｇ+' + n.gold + (n.cardId != null ? '・カード獲得' : ''));
    return { gold: n.gold, cardId: n.cardId };
  }

  /* M6.6 WP8：休憩の回復量は+5（本人確定・実装計画追補§2-5）。ショップの有料回復も
   * 同じ量に揃える（追補が推奨。値が2箇所に分かれないよう定数を1つにまとめた）。 */
  const REST_HEAL_AMOUNT = 5;

  function rest(run, n) {
    n.cleared = true;
    const before = run.lp;
    run.lp = Math.min(run.maxLp, run.lp + REST_HEAL_AMOUNT);
    const healed = run.lp - before;
    run.log.push('休憩：ＬＰ ' + before + '→' + run.lp);
    return { lp: run.lp, healed: healed };
  }

  const SHOP_RATE = 0.5;   /* ラン中ショップの割引率（初期値。ログショップ本体はM7） */
  function shopPrice(cards, cardId) {
    const c = cards[cardId];
    return c ? Math.max(50, Math.round(c.p * SHOP_RATE)) : 0;
  }
  function shopBuy(run, cards, n, cardId) {
    if (n.stock.indexOf(cardId) < 0) return { ok: false, reason: '品揃えにありません' };
    const cost = shopPrice(cards, cardId);
    if (run.gold < cost) return { ok: false, reason: 'Ｇが足りません' };
    run.gold -= cost;
    gainCard(run, cardId);
    n.stock.splice(n.stock.indexOf(cardId), 1);
    run.log.push('購入：' + (cards[cardId] ? cards[cardId].n : cardId) + '（-' + cost + 'Ｇ）');
    return { ok: true, cost: cost };
  }
  function shopHeal(run, n) {
    if (run.gold < n.healCost) return { ok: false, reason: 'Ｇが足りません' };
    run.gold -= n.healCost;
    const before = run.lp;
    run.lp = Math.min(run.maxLp, run.lp + REST_HEAL_AMOUNT);
    run.log.push('ショップでＬＰ回復：' + before + '→' + run.lp + '（-' + n.healCost + 'Ｇ）');
    return { ok: true, lp: run.lp };
  }
  function shopClearFog(run, n) {
    if (!n.hasFogClear || run.map.fog.cleared) return { ok: false, reason: '霧払いはできません' };
    if (run.gold < n.fogClearCost) return { ok: false, reason: 'Ｇが足りません' };
    run.gold -= n.fogClearCost;
    run.map.fog.cleared = true;
    run.log.push('霧払い（-' + n.fogClearCost + 'Ｇ）');
    return { ok: true };
  }
  function shopLeave(run, n) { n.cleared = true; }

  /* 売却率。表示側（js/run-ui.js）も同じ式を使えるよう sellPrice() として公開する
   * ——以前は画面側で率を再計算しており、変えるときに2箇所直す必要があった。
   * M6.6 WP9：40%→50%（実装計画追補§4 WP9-b）。
   * **M7 WP7：50%→25%**（経済追補§4-2・ゲーム仕様書§7に実装を合わせた）。
   * 売却の場所がラン中の換金所からホームのログショップへ移り、ラン中の換金所は
   * 買い取り所（WP8）になるので、レート差で棲み分ける必要がもう無い。
   * **ホームの売却・一括換金もこの関数を通す**（CQCollection.bulkSellPlan に渡す）。 */
  const SELL_RATE = 0.25;
  function sellPrice(cards, cardId) {
    const c = cards[cardId];
    return c ? Math.max(10, Math.round(c.p * SELL_RATE)) : 0;
  }
  function sell(run, cards, cardId) {
    if ((run.deck[cardId] || 0) <= 0) return { ok: false, reason: '所持していません' };
    if (cardId === BLANK) return { ok: false, reason: '空白は売れません' };
    const gold = sellPrice(cards, cardId);
    run.deck[cardId] -= 1;
    run.gold += gold;
    run.log.push('換金：' + (cards[cardId] ? cards[cardId].n : cardId) + '（+' + gold + 'Ｇ）');
    return { ok: true, gold: gold };
  }
  function exchangeLeave(run, n) { n.cleared = true; }

  function resolveQuestion(run, n) {
    if (n.resolved) return null;
    n.resolved = true; n.cleared = true;
    const ev = n.event, eff = ev.effect || {};
    const res = { text: ev.text };
    if (eff.lp) { run.lp = Math.max(0, Math.min(run.maxLp, run.lp + eff.lp)); res.lp = eff.lp; }
    if (eff.gold) { run.gold = Math.max(0, run.gold + eff.gold); res.gold = eff.gold; }
    if (eff.draftCard && n.cardId != null) {
      gainCard(run, n.cardId);
      res.cardId = n.cardId;
    }
    run.log.push('？：' + ev.text);
    if (run.lp <= 0) run.outcome = 'lose';
    return res;
  }

  /* ---- 終了 ------------------------------------------------------------ */

  function retire(run) { run.outcome = 'retire'; }

  /* ---- M6.6 WP11：清算の減額と称号 -------------------------------------- */

  /** 終わり方ごとの減額率（追補§4 WP11-3）。**減るのは「今日の獲得ぶん」だけ**で、
   * 出発時に持って出たＧ（startGold）は終わり方に関わらず減らない——だから
   * 「リタイヤは獲得額−50%」という書き方になっている。マスター撃破は減額なし。 */
  const SETTLE_CUT = { win: 0, retire: 0.5, lose: 0.75 };

  /** 清算のひっ算に出す内訳を計算する（副作用なし）。UIの段階表示と settle() が
   * **同じ関数**を見るようにしてある——表示と実額がズレる事故は、換金所の売値で一度
   * やっているので繰り返さない（§4 WP9-b の sellPrice と同じ理由）。
   *   carried … 出発時に持って出たＧ（減らない）
   *   earned  … 今日の獲得ぶん。買い物で持ち出しぶんまで食い込んだ場合は 0
   *             （マイナスの獲得に減額を掛けて“損したぶんが返ってくる”のを防ぐ）
   *   cut     … earned に rate を掛けた減額（10Ｇ単位に丸める。宝箱・売値と同じ刻み）
   *   final   … 清算後の所持Ｇ＝run.gold − cut */
  function settleGold(run) {
    const rate = SETTLE_CUT[run.outcome] || 0;
    const carried = run.startGold != null ? run.startGold : run.gold;
    const earned = Math.max(0, run.gold - carried);
    const cut = Math.round(earned * rate / 10) * 10;
    return { carried: carried, earned: earned, rate: rate, cut: cut, final: run.gold - cut };
  }

  /** 称号の初期セット4つ（追補§4 WP11-5）。cond(run, meta) が true なら獲得。
   * meta を見てよいのは「初めて」を判定するため（cleared は settle() より前の状態を見る）。 */
  const TITLES = [
    { key: 'firstReturn', name: '初めての帰還', desc: '初めてランを終えた',
      cond: function () { return true; } },                       /* 終わり方は問わない */
    { key: 'clearGrassland', name: '草原の踏破者', desc: '草原のマスターを初めて撃破',
      cond: function (run) { return run.outcome === 'win' && run.areaId === 'grassland'; } },
    { key: 'clearForest', name: '森の踏破者', desc: '森のマスターを初めて撃破',
      cond: function (run) { return run.outcome === 'win' && run.areaId === 'forest'; } },
    /* 「無傷の一日」＝クリア時のＬＰが出発時（10）以上（2026-08-29 本人確定）。
     * 追補の原文は「ＬＰ満タンのまま」だが、ランは 10／15 で始まる＝満タンではないため、
     * 文字どおりだと回復してからクリアしないと取れない称号になってしまう。
     * 途中で削られても休憩などで取り返してあればよい、という条件に確定した。 */
    { key: 'flawless', name: '無傷の一日', desc: 'ＬＰを出発時まで保ったままクリア',
      cond: function (run) {
        return run.outcome === 'win' && run.lp >= (run.startLp != null ? run.startLp : run.lp);
      } }
  ];

  /** このランで**新しく**得た称号（既に持っているものは返さない）。副作用なし。 */
  function earnedTitles(run, meta) {
    const had = (meta && meta.titles) || [];
    return TITLES.filter(function (t) {
      return had.indexOf(t.key) < 0 && t.cond(run, meta);
    });
  }

  /** 日誌に1行足す（M6.6 WP11・台本§7.2）。文面の組み立ては js/lore.js の仕事なので、
   * ここは受け取った文字列を積むだけにしてある（エンジンが台本に依存しないように）。 */
  const JOURNAL_MAX = 200;
  function pushJournal(meta, line) {
    CQCollection.ensure(meta);
    if (!line) return meta.journal;
    meta.journal.push(line);
    if (meta.journal.length > JOURNAL_MAX) meta.journal = meta.journal.slice(-JOURNAL_MAX);
    return meta.journal;
  }

  /** ランを終えて meta（永続所持データ）に反映する（M6.6 WP3：移動モデル）。
   *   deck   … run.deck の複製が保存デッキになる（次のランへそのまま持ち越し）。
   *            ラン中の売却で減った分は本に戻らない＝カードが世界から消える（§2-8）。
   *            旧セーブ由来の実体の空白(180)はここで捨てる（空白は実体で持たない）。
   *   book   … ラン中に本行きになった分（run.bookAdd）を加算。
   *   known  … ラン中に入手した種類（run.gainedCards）を登録。
   *            レンタル（run.rentals）は登録しない＝返却されて記憶にも残らない。
   *   gold   … M6.6 WP11：終わり方に応じて**今日の獲得ぶんだけ**減らして書く（settleGold）。
   *   titles / journal / day … 同じくWP11。内訳は run.settled にも残し、
   *            結果画面が「いま何が起きたか」を再計算せずに描けるようにする。
   *
   * **2回呼ばないこと。** 2度目は称号がもう meta にあるので新規ゼロになり、Ｇはさらに
   * 減額される。呼び出しは advanceAfterBattle と retire の2箇所だけ＝ランにつき1回。
   * 事故（二重タップ等）に備えて run.settled で番をしてある。 */
  function settle(run, meta) {
    CQCollection.ensure(meta);
    if (run.settled) return meta;                     /* 二重清算の防止（上のコメント参照） */
    meta.deck = Object.assign({}, run.deck);
    delete meta.deck[BLANK];
    Object.keys(meta.deck).forEach(function (k) { if (meta.deck[k] <= 0) delete meta.deck[k]; });
    Object.keys(run.bookAdd || {}).forEach(function (k) {
      if (run.bookAdd[k] > 0) meta.book[k] = (meta.book[k] || 0) + run.bookAdd[k];
    });
    (run.gainedCards || []).forEach(function (id) { CQCollection.registerKnown(meta, id); });
    const gold = settleGold(run);
    meta.gold = gold.final;
    /* 称号は cleared を更新する**前**に判定する（「初めて撃破」が cleared 由来ではなく
     * meta.titles 由来なので実害は無いが、判定材料の並びを素直に保つ）。 */
    const titles = earnedTitles(run, meta);
    titles.forEach(function (t) { meta.titles.push(t.key); });
    meta.day = (meta.day || 0) + 1;
    if (run.outcome === 'win' && meta.cleared.indexOf(run.areaId) < 0) meta.cleared.push(run.areaId);
    run.settled = { gold: gold, titles: titles, day: meta.day };
    return meta;
  }

  const api = {
    DECK_SIZE, BLANK, DRAFT_ROUNDS, RENTAL_MAX, buildBattleDeck, buildBossDeck, buildPlayerDeck,
    start, gainCard, beginDraftRound, applyDraft, draftTarget, hasBlankSlot, depart,
    node, currentNode, choices, advance,
    battleSeed, firstTurnOf, battleSetup, reportBattle, reportFlee,
    canAssignToDeck, resolveLootPick,
    openChest, rest, shopPrice, shopBuy, shopHeal, shopClearFog, shopLeave,
    sell, sellPrice, exchangeLeave, resolveQuestion, retire, settle,
    SETTLE_CUT, settleGold, TITLES, earnedTitles, pushJournal
  };
  global.CQRun = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
