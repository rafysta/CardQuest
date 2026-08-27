/* CardQuest メタ — セーブ（M6.6 WP3で移動モデルに改修）
 *
 * cq_meta … 永続の所持データ。M6.6 WP3から「本とデッキの移動モデル」：
 *   book:  {cardId: count}  本＝街に置いてある所持カード。上限なし
 *   deck:  {cardId: count}  持ち出し中のデッキ（1つだけ保存）。合計≤40・同種≤3（8番は無制限）
 *   known: [cardId, ...]    一度でも入手した種類（記憶データ）。減らない
 *   gold / cleared / …      その他のメタ（openingSeen 等は後続WPで追加）
 * cq_run … 中断中のランのオートセーブ（js/run/run.js の run オブジェクトそのもの）
 *
 * 旧形式（M6〜v0.16.2：deck＝多重集合のみ）はロード時に移行する：
 *   旧 deck を全部 book へ移し（空白180は捨てる）、known に種類を登録、deck は空。
 *   →『実装計画追補M6.6』§4 WP3。移行後はデッキが空なので、WP4のデッキ編集が入るまでは
 *     WP2のリセットで作り直すのが早い（移行は最小限でよい、の方針どおり）。
 *
 * 新規初期化は defaultDeckIds（40枚のスターター）を【デッキ】に入れて始める
 * （WP4のデッキ編集画面ができるまで、初期状態で今までどおり遊べるようにするため。
 *  WP1で「本に28枚・デッキ空・G0」の正式仕様に切り替える予定）。
 *
 * storage は localStorage 互換（getItem/setItem/removeItem）。DOMには依存しない。
 */
'use strict';
(function (global) {

  const CQCollection = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./collection.js') : global.CQCollection;

  const META_KEY = 'cq_meta';
  const RUN_KEY = 'cq_run';
  const BLANK = 180;

  function toDeckCounts(ids) {
    const counts = {};
    (ids || []).forEach(function (id) { counts[id] = (counts[id] || 0) + 1; });
    return counts;
  }

  function typesOf(counts) {
    return Object.keys(counts || {})
      .filter(function (k) { return counts[k] > 0 && +k !== BLANK; })
      .map(Number);
  }

  /** 旧形式（deckのみ・bookなし）→ 移動モデルへ。旧deckは全部bookへ・deckは空・knownに種類を登録 */
  function migrate(m) {
    const oldDeck = m.deck || {};
    m.book = {};
    Object.keys(oldDeck).forEach(function (k) {
      if (+k === BLANK || oldDeck[k] <= 0) return;
      m.book[k] = oldDeck[k];
    });
    m.known = typesOf(m.book);
    m.deck = {};
    return m;
  }

  /** 新規初期化：スターターをデッキに入れて始める（ヘッダの説明参照） */
  function initialMeta(defaultDeckIds) {
    const deck = {};
    const known = [];
    (defaultDeckIds || []).forEach(function (id) {
      if (+id === BLANK) return;
      deck[id] = (deck[id] || 0) + 1;
      if (known.indexOf(+id) < 0) known.push(+id);
    });
    return { book: {}, deck: deck, known: known, gold: 500, cleared: [] };
  }

  /** cq_meta を読む。無ければ defaultDeckIds（カードIDの配列・重複可）から初期状態を作る。
   * 旧形式はここで移行する（保存はしない＝次の saveMeta で新形式になる）。 */
  function loadMeta(storage, defaultDeckIds) {
    try {
      const raw = storage && storage.getItem(META_KEY);
      if (raw) {
        const m = JSON.parse(raw);
        if (m && m.book) return CQCollection.ensure(m);          /* 新形式 */
        if (m && m.deck) return migrate(m);                       /* 旧形式 → 移行 */
      }
    } catch (e) { /* 壊れたデータは初期化して復旧する */ }
    return initialMeta(defaultDeckIds);
  }

  function saveMeta(storage, meta) {
    if (!storage) return;
    try { storage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* 保存できなくても続行 */ }
  }

  /** cq_meta を削除する（M6.6 WP2：エリア選択画面の「最初からやり直す」）。
   * cq_run と合わせて呼べば、次回読み込み時に loadMeta が既定デッキから作り直す＝完全な初期化になる。 */
  function clearMeta(storage) {
    if (!storage) return;
    try { storage.removeItem(META_KEY); } catch (e) { /* noop */ }
  }

  function loadRun(storage) {
    try {
      const raw = storage && storage.getItem(RUN_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveRun(storage, run) {
    if (!storage) return;
    try { storage.setItem(RUN_KEY, JSON.stringify(run)); } catch (e) { /* 保存できなくても続行 */ }
  }

  function clearRun(storage) {
    if (!storage) return;
    try { storage.removeItem(RUN_KEY); } catch (e) { /* noop */ }
  }

  const api = { loadMeta, saveMeta, clearMeta, loadRun, saveRun, clearRun, toDeckCounts, migrate, initialMeta };
  global.CQSave = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
