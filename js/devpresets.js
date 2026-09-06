/* CardQuest — 開発用：進行状態のプリセット／記憶データの加算／ボス戦への直行（2026-09-06）
 *
 * 全部を自分で通しプレイして確認するのが難しくなってきたため（本人指定）、デバッグメニューから
 * 「ゲームの進行を次の段階まで進めた状態」を作れるようにする道具。ここは**DOMに依存しない
 * 純粋な組み立て関数**だけを置く——Node（tests/run.js・tools/verify-run.js）から同じ関数を呼び、
 * 「このプリセットなら山地が解放され海辺はロック」のような検証とスクショに使うため。
 * 画面（メニューのフォーム・localStorage への保存・退避）は js/debug.js の仕事。
 *
 *   ① build(key, cards, opts)      … 5つのプリセットから cq_meta を丸ごと組み立てる
 *   ② addKnown(meta, cards, n)     … 未知のカードを安い順に n 種、記憶データと本へ足す
 *   ③ bossJumpRun(cards, meta, o)  … ランを作り、ボスマスの1つ手前まで進めた状態にする
 *
 * ゲームのルール（js/run/・js/meta/）には一切触らない。作るのは「ふつうに遊べば到達できる状態」
 * だけで、デッキの合法性（40枚・同種3枚・空白なし）や known ⊇ 所持カードの不変条件も守る
 * ——壊れた状態を作ると、そこから先で見つかる不具合が本物か道具のせいか分からなくなるため。
 */
'use strict';
(function (global) {

  function need(relPath) {
    return (typeof require === 'function' && typeof module !== 'undefined') ? require(relPath) : null;
  }
  const CQCollection = need('./meta/collection.js') || global.CQCollection;
  const CQAreas = need('./run/areas.js') || global.CQAreas;
  const CQOpponents = need('./opponents.js') || global.CQOpponents;
  const CQRun = need('./run/run.js') || global.CQRun;

  const BLANK = 180;
  const PIG = 8;
  const DECK_SIZE = 40;

  /* スターター（M6.6 §2-2・js/run-ui.js の STARTER_BOOK と同じ8種28枚）。
   * Lv1のプリセットでは、これに足りないぶんをピッグマン（同種制限なし）で埋めた40枚を
   * デッキにする＝「始めたばかりの人のデッキ」。値を変えたら run-ui.js・tests とも揃えること。 */
  const STARTER = [
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    101, 101, 101, 108, 108, 113, 113,
    153, 153, 153, 165, 165, 193, 193, 193, 194, 194, 194
  ];

  /* ---- ① プリセット --------------------------------------------------------------
   * cleared … 踏破済みのエリア（解放条件はこれと known の数から決まる）
   * known   … 記憶データの**最低**種類数（デッキ・本の種類がこれより多ければそちらが優先）。
   *           マスターレベルの境目：20種→Lv2・52種→Lv3（js/meta/collection.js STAGE_STEPS）
   * deck    … 'starter'＝スターター＋ピッグマン40枚／数字＝そのマスターの40枚デッキを借りる
   *           （js/opponents.js。Lv1帯はマスターデッキの種類数が19〜31あって20種を超えるので使えない）
   * gold    … 所持Ｇ */
  const PRESETS = [
    { key: 'p1', label: '草原クリア直後', hint: '森が解放。記憶データ12種（Lv1）',
      cleared: ['grassland'], known: 12, deck: 'starter', gold: 300 },
    { key: 'p2', label: '森クリア直後（山地解放）', hint: '記憶データ19種＝あと1種でLv2。品揃えと節目の境目',
      cleared: ['grassland', 'forest'], known: 19, deck: 'starter', gold: 800 },
    { key: 'p3', label: 'Lv2到達（海辺解放）', hint: '記憶データ20種以上。デッキはコルーニャの40枚',
      cleared: ['grassland', 'forest'], known: 24, deck: 11, gold: 1500 },
    { key: 'p4', label: '砂漠解放', hint: '山地まで踏破・Lv2。デッキはラリーの40枚',
      cleared: ['grassland', 'forest', 'mountain'], known: 34, deck: 3, gold: 3000 },
    { key: 'p5', label: '第一幕踏破', hint: '5エリア全部踏破・記憶データ52種＝Lv3ちょうど。デッキはペゼッタの40枚',
      cleared: ['grassland', 'forest', 'mountain', 'coast', 'desert'], known: 52, deck: 9, gold: 6000 }
  ];

  function list() { return PRESETS.slice(); }
  function get(key) { return PRESETS.filter(function (p) { return p.key === key; })[0] || null; }

  /** 全169種を安い順（同値はid順）に並べた配列。カース・空白・おじゃま虫は除く。 */
  function realCardsByPrice(cards) {
    return Object.keys(cards || {}).map(function (k) { return cards[k]; })
      .filter(function (c) { return c && (c.t === 'U' || c.t === 'M' || c.t === 'S') && c.id !== BLANK && c.id <= 199; })
      .sort(function (a, b) { return (a.p - b.p) || (a.id - b.id); });
  }

  /** デッキ（{id:count}）を作る。'starter' か マスターid。 */
  function buildDeck(spec, cards) {
    const deck = {};
    if (spec === 'starter') {
      STARTER.forEach(function (id) { deck[id] = (deck[id] || 0) + 1; });
      let total = STARTER.length;
      while (total < DECK_SIZE) { deck[PIG] = (deck[PIG] || 0) + 1; total++; }
      return deck;
    }
    const d = CQOpponents.deck40(spec, cards);
    if (!d) throw new Error('マスター' + spec + 'のデッキがありません');
    return Object.assign({}, d);
  }

  /** プリセットから cq_meta を丸ごと組み立てる。
   * opts.milestone（既定 true）… true なら homeSeenLevel／homeSeenAreas を**ひとつ前の状態**に
   *   しておく＝ホームに戻った瞬間に「レベルが上がった」「〇〇が解放された」の節目が出る。
   *   false なら今の値に合わせて、節目を出さない。 */
  function build(key, cards, opts) {
    const p = get(key);
    if (!p) throw new Error('unknown preset: ' + key);
    const o = opts || {};
    const meta = { book: {}, deck: buildDeck(p.deck, cards), known: [], gold: p.gold, cleared: p.cleared.slice() };
    CQCollection.ensure(meta);

    /* known ⊇ デッキの種類、から始めて安い順に埋める。埋めたぶんは本に1枚ずつ入れる
     * （記憶データにあるのに1枚も持っていない、という状態は売却でしか起きないので避ける）。 */
    Object.keys(meta.deck).forEach(function (k) { CQCollection.registerKnown(meta, +k); });
    const pool = realCardsByPrice(cards);
    for (let i = 0; i < pool.length && meta.known.length < p.known; i++) {
      const c = pool[i];
      if (meta.known.indexOf(c.id) >= 0) continue;
      CQCollection.addCard(meta, c.id, 'book');
    }

    /* 踏破の記録（js/run/run.js settle() が積むものと同じ形）。 */
    meta.openingSeen = true;
    meta.homeVisited = true;
    meta.visits = {}; meta.seenHints = {};
    meta.titles = ['firstReturn'];
    meta.bossWins = {}; meta.clears = {};
    p.cleared.forEach(function (areaId) {
      const area = CQAreas.get(areaId);
      meta.visits[areaId] = 1;
      meta.clears[areaId] = 1;
      if (area && area.bossId != null) meta.bossWins[area.bossId] = 1;
      meta.titles.push('clear' + areaId.charAt(0).toUpperCase() + areaId.slice(1));
    });
    meta.day = p.cleared.length;
    meta.stats = { win: p.cleared.length, retire: 0, lose: 0, boss: p.cleared.length, cards: meta.known.length };
    meta.journal = [];

    /* ホームの節目の基準値。 */
    const lvl = CQCollection.masterLevelOf(meta);
    const unlocked = CQAreas.list().filter(function (a) { return CQAreas.isUnlocked(a.id, meta); }).map(function (a) { return a.id; });
    if (o.milestone === false) {
      meta.homeSeenLevel = lvl;
      meta.homeSeenAreas = unlocked.slice();
    } else {
      meta.homeSeenLevel = Math.max(1, lvl - 1);
      /* 「解放済みだが踏破していない」エリアを新しく開いた扱いにする（複数あればその全部） */
      meta.homeSeenAreas = unlocked.filter(function (id) { return p.cleared.indexOf(id) >= 0; });
    }
    return meta;
  }

  /* ---- ② 記憶データを +n 種 --------------------------------------------------- */

  /** まだ知らないカードを安い順に n 種、記憶データに登録して本へ1枚ずつ入れる。
   * 戻り値は足した id の配列（足せる種類が無くなればそこまで）。 */
  function addKnown(meta, cards, n) {
    CQCollection.ensure(meta);
    const added = [];
    const pool = realCardsByPrice(cards);
    for (let i = 0; i < pool.length && added.length < n; i++) {
      const c = pool[i];
      if (meta.known.indexOf(c.id) >= 0) continue;
      CQCollection.addCard(meta, c.id, 'book');
      added.push(c.id);
    }
    return added;
  }

  /* ---- ③ ボス戦へ直行 ------------------------------------------------------------ */

  /** ボスマスのidと、その1つ手前（connectsTo にボスを含む）のマスのid。 */
  function bossNodeOf(run) {
    const nodes = run.map.nodes;
    let bossId = null;
    Object.keys(nodes).forEach(function (id) { if (nodes[id].type === 'boss') bossId = id; });
    let before = null;
    Object.keys(nodes).forEach(function (id) {
      if ((nodes[id].connectsTo || []).indexOf(bossId) >= 0 && before == null) before = id;
    });
    return { bossId: bossId, beforeId: before };
  }

  /** ランを作って、ボスマスの1つ手前まで進めた状態にする（ボス以外のマスは全部解決済み）。
   * 実際のマップ・戦闘導入・戦闘・戦利品振り分け・結果画面は**本物の流れ**を通る。
   *   o.areaId       … エリア（必須）
   *   o.seed         … 乱数種（省略時はランダム）
   *   o.lp           … 出発時ＬＰを上書き（startLp も揃える＝「無傷の一日」の基準）
   *   o.repeatVisit  … true なら周回扱い（ボスが組から抽選される）。省略時は meta.cleared から決まる
   *   o.masterId     … 顔／客分を指定（組に含まれるidだけ有効。run.bossMasterOverride）
   * meta 側の前提（meta.clears／bossWins の調整）は呼び出し側が先に済ませておくこと。 */
  function bossJumpRun(cards, meta, o) {
    const run = CQRun.start(cards, o.areaId, (o.seed != null ? o.seed : (Math.floor(Math.random() * 0x7fffffff) >>> 0)), meta);
    if (o.repeatVisit != null) run.repeatVisit = !!o.repeatVisit;
    if (o.masterId != null) run.bossMasterOverride = +o.masterId;
    CQRun.depart(run);
    const pos = bossNodeOf(run);
    Object.keys(run.map.nodes).forEach(function (id) {
      if (id !== pos.bossId) run.map.nodes[id].cleared = true;
    });
    run.at = pos.beforeId;
    if (o.lp != null) { run.lp = Math.min(run.maxLp, Math.max(1, +o.lp)); run.startLp = run.lp; }
    run.log.push('（デバッグ）ボスマスの手前へ直行');
    return run;
  }

  const api = { PRESETS, STARTER, list, get, build, addKnown, bossJumpRun, bossNodeOf, realCardsByPrice };
  global.CQDevPresets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
