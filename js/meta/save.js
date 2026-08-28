/* CardQuest メタ — セーブ（M6.6 WP3で移動モデルに改修・WP1で正式な初期化に変更）
 *
 * cq_meta … 永続の所持データ。M6.6 WP3から「本とデッキの移動モデル」：
 *   book:        {cardId: count}  本＝街に置いてある所持カード。上限なし
 *   deck:        {cardId: count}  持ち出し中のデッキ（1つだけ保存）。合計≤40・同種≤3（8番は無制限）
 *   known:       [cardId, ...]    一度でも入手した種類（記憶データ）。減らない
 *   openingSeen: boolean          目覚めの場面（WP1）を見た後は true。既存セーブは初回ロードで
 *                                 自動的に true 扱いにする（新規プレイヤーだけに見せる演出のため）
 *   gold / cleared / …           その他のメタ
 * cq_run … 中断中のランのオートセーブ（js/run/run.js の run オブジェクトそのもの）
 *
 * 旧形式（M6〜v0.16.2：deck＝多重集合のみ）はロード時に移行する：
 *   旧 deck を全部 book へ移し（空白180は捨てる）、known に種類を登録、deck は空、
 *   openingSeen は true（既存プレイヤーなので目覚めは見せない）。→『実装計画追補M6.6』§4 WP3。
 *
 * 新規初期化（M6.6 WP1・§2-2で正式仕様に確定）：defaultDeckIds（スターター8種28枚）を【本】へ、
 * デッキは空・Ｇは0・openingSeenはfalseで始める。WP4（デッキ編集画面）が入るまでは
 * 本のカードをデッキへ移す手段が無いため、実質プレイ不可の期間が生じるのは既知・想定どおり
 * （§0-9進捗ログ参照。それまではWP2の「最初からやり直す」で挙動を確認する）。
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

  /** 旧形式（deckのみ・bookなし）→ 移動モデルへ。旧deckは全部bookへ・deckは空・knownに種類を登録。
   * 既存プレイヤーのデータなので、目覚めの場面（WP1）は見せない＝openingSeen: true にする。 */
  function migrate(m) {
    const oldDeck = m.deck || {};
    m.book = {};
    Object.keys(oldDeck).forEach(function (k) {
      if (+k === BLANK || oldDeck[k] <= 0) return;
      m.book[k] = oldDeck[k];
    });
    m.known = typesOf(m.book);
    m.deck = {};
    m.openingSeen = true;
    return m;
  }

  /** 新規初期化：スターター（本人指定の8種28枚。呼び出し側＝js/run-ui.js の STARTER_BOOK）を
   * 本へ入れて始める（M6.6 §2-2・WP1で正式仕様に確定）。デッキは空・Ｇは0。 */
  function initialMeta(defaultDeckIds) {
    const book = {};
    const known = [];
    (defaultDeckIds || []).forEach(function (id) {
      if (+id === BLANK) return;
      book[id] = (book[id] || 0) + 1;
      if (known.indexOf(+id) < 0) known.push(+id);
    });
    return { book: book, deck: {}, known: known, gold: 0, cleared: [], openingSeen: false };
  }

  /** cq_meta を読む。無ければ defaultDeckIds（カードIDの配列・重複可）から初期状態を作る。
   * 旧形式はここで移行する（保存はしない＝次の saveMeta で新形式になる）。
   * 新形式だが openingSeen が無いセーブ（WP3時代に作られたもの）も、既存データがある以上は
   * 「見た」扱いにする（真に何も無い＝初回起動のときだけ目覚めを見せるため）。 */
  function loadMeta(storage, defaultDeckIds) {
    try {
      const raw = storage && storage.getItem(META_KEY);
      if (raw) {
        const m = JSON.parse(raw);
        if (m && m.book) {                                        /* 新形式 */
          CQCollection.ensure(m);
          if (m.openingSeen == null) m.openingSeen = true;
          return m;
        }
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
