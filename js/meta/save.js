/* CardQuest メタ — セーブ（M6先行の最小実装）
 *
 * 本格的なコレクション・マスターレベル・ログショップは実装計画M7の仕事。
 * M6はランを動かすために最低限必要な永続データだけをここに置く：
 *   cq_meta … 所持デッキ（複製込みの多重集合）・所持Ｇ・クリア済みエリア
 *   cq_run  … 中断中のランのオートセーブ（js/run/run.js の run オブジェクトそのもの）
 * storage は localStorage 互換（getItem/setItem/removeItem）を渡す。Nodeのテストでは
 * 単純なオブジェクトのモックを渡せる。DOMには依存しない。
 */
'use strict';
(function (global) {

  const META_KEY = 'cq_meta';
  const RUN_KEY = 'cq_run';

  function toDeckCounts(ids) {
    const counts = {};
    (ids || []).forEach(function (id) { counts[id] = (counts[id] || 0) + 1; });
    return counts;
  }

  /** cq_meta を読む。無ければ defaultDeckIds（カードIDの配列・重複可）から初期状態を作る */
  function loadMeta(storage, defaultDeckIds) {
    try {
      const raw = storage && storage.getItem(META_KEY);
      if (raw) {
        const m = JSON.parse(raw);
        if (m && m.deck) return m;
      }
    } catch (e) { /* 壊れたデータは初期化して復旧する */ }
    return { deck: toDeckCounts(defaultDeckIds), gold: 500, cleared: [] };
  }

  function saveMeta(storage, meta) {
    if (!storage) return;
    try { storage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* 保存できなくても続行 */ }
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

  const api = { loadMeta, saveMeta, loadRun, saveRun, clearRun, toDeckCounts };
  global.CQSave = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
