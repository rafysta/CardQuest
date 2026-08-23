/* CardQuest エンジン — シード付き乱数（mulberry32）
 * すべての乱数はここを通す。同じシードなら必ず同じ結果になる（バグ再現・リプレイ・テストのため）。
 * DOMには依存しない。ブラウザでは CQRng、Node では require で使う。
 */
'use strict';
(function (global) {

  function create(seed) {
    let s = (seed === undefined ? 0x9e3779b9 : seed) >>> 0;
    function next() {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return {
      /** [0,1) の一様乱数 */
      next,
      /** min〜max の整数（両端を含む） */
      int(min, max) { return min + Math.floor(next() * (max - min + 1)); },
      /** 配列から1つ選ぶ */
      pick(arr) { return arr[Math.floor(next() * arr.length)]; },
      /** 配列をその場でシャッフルして返す（Fisher–Yates） */
      shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
        return arr;
      },
      /** 現在の内部状態（セーブ用） */
      state() { return s >>> 0; },
      /** 内部状態を復元する（ロード用） */
      restore(v) { s = v >>> 0; }
    };
  }

  const api = { create };
  global.CQRng = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
