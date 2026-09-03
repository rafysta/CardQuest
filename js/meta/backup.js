/* CardQuest メタ — セーブのバックアップ（書き出し／読み込み）（M7 WP11）
 *
 * ゲーム仕様書§9「confquest の backup.js 方式でエクスポート／インポート（機種変更・事故対策）」。
 * localStorage の **`cq_` で始まるキー全部**を1つのJSONにまとめ、そのまま書き戻せるようにする。
 *
 * ★設計の要は「**読み込みで既存のセーブを壊さない**」こと（受け入れ基準）。そのために：
 *   1. まず `validate()` で**中身を全部検査**する（この間 storage には一切触らない）
 *   2. 検査を通ったときだけ書き込む
 *   3. 書き込みの途中で失敗したら、控えておいた元の内容に**全部戻す**
 * 壊れたファイル・別のゲームのファイル・空ファイルは、すべて2の手前で弾かれる。
 *
 * ★`cq_run`（中断中のラン）も含める。「含めるか要判断」と作業パッケージにあったが、
 * **含めないほうが危険**——メタだけ書き戻すと、いま中断中のランが「持っていないカードで
 * 進行中」という食い違った状態になる。書き出したときの状態にまるごと戻すのが筋。
 *
 * DOM非依存・storage非依存（引数で受け取る）。js/meta/save.js と同じ規約で Node からも読める。
 */
'use strict';
(function (global) {

  const PREFIX = 'cq_';
  const APP = 'CardQuest';
  const FORMAT = 1;              /* このファイルの形式の版。将来変えるときの目印 */

  /** storage から cq_ で始まるキーを全部集める。
   * localStorage の key(i)/length を使う（テストのモックもこの2つを実装すればよい）。 */
  function collectKeys(storage) {
    const keys = [];
    if (!storage) return keys;
    const n = typeof storage.length === 'number' ? storage.length : 0;
    for (let i = 0; i < n; i++) {
      const k = typeof storage.key === 'function' ? storage.key(i) : null;
      if (k && k.indexOf(PREFIX) === 0) keys.push(k);
    }
    return keys.sort();
  }

  /** 書き出す中身（オブジェクト）。値は localStorage に入っている**文字列のまま**持つ
   * ——ここで JSON.parse して持ち直すと、読み込み時に「元と1バイト違う」状態が起きうる。 */
  function exportData(storage, opts) {
    const o = opts || {};
    const data = {};
    collectKeys(storage).forEach(function (k) {
      const v = storage.getItem(k);
      if (typeof v === 'string') data[k] = v;
    });
    return {
      app: APP,
      format: FORMAT,
      version: o.version || '',          /* 書き出した時点のアプリの版（参考情報） */
      savedAt: o.now || new Date().toISOString(),
      data: data
    };
  }

  function serialize(storage, opts) {
    return JSON.stringify(exportData(storage, opts), null, 2);
  }

  /** 書き出したファイル名（日付入り）。画面側はこれを使う。 */
  function fileName(now) {
    const d = now || new Date();
    const p = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'cardquest-backup-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
      + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
  }

  /** 読み込む前の検査。**storage には一切触らない。**
   * 返り値 { ok, data, keys, reason }。ok が false のときの reason はそのまま画面に出せる文。 */
  function validate(text) {
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, reason: 'ファイルが空です。' };
    }
    let obj;
    try { obj = JSON.parse(text); }
    catch (e) { return { ok: false, reason: 'バックアップのファイルではありません（読めませんでした）。' }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, reason: 'バックアップのファイルではありません。' };
    }
    if (obj.app !== APP) {
      return { ok: false, reason: 'CardQuest のバックアップではありません。' };
    }
    if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) {
      return { ok: false, reason: 'バックアップの中身が壊れています。' };
    }
    const keys = Object.keys(obj.data);
    if (!keys.length) return { ok: false, reason: 'バックアップに中身がありません。' };
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.indexOf(PREFIX) !== 0) {
        return { ok: false, reason: 'バックアップに知らないデータが混ざっています（' + k + '）。' };
      }
      if (typeof obj.data[k] !== 'string') {
        return { ok: false, reason: 'バックアップの中身が壊れています（' + k + '）。' };
      }
      /* 値そのものも JSON として読めるか確かめる（読み込んだ直後にゲームが落ちるのを防ぐ） */
      try { JSON.parse(obj.data[k]); }
      catch (e) { return { ok: false, reason: 'バックアップの中身が壊れています（' + k + '）。' }; }
    }
    /* 肝心のセーブ（cq_meta）が入っていて、形が合っているか */
    if (!obj.data.cq_meta) {
      return { ok: false, reason: 'セーブデータ（cq_meta）が入っていません。' };
    }
    const meta = JSON.parse(obj.data.cq_meta);
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)
      || typeof meta.book !== 'object' || typeof meta.deck !== 'object'
      || !Array.isArray(meta.known)) {
      return { ok: false, reason: 'セーブデータの形が違います。' };
    }
    return { ok: true, data: obj.data, keys: keys, savedAt: obj.savedAt || '', version: obj.version || '' };
  }

  /** 読み込み（復元）。検査を通ったときだけ storage を書き換える。
   *
   * **バックアップに無い cq_ キーは消す**——「書き出したときの状態に戻る」（受け入れ基準）
   * のは、余計なものが残っていない状態のこと。とくに `cq_run`（中断中のラン）が残ると、
   * 復元したメタと食い違ったランが動き出してしまう。
   *
   * 途中で失敗したら控えから全部戻す（storage が満杯のときなどに起こりうる）。 */
  function importData(storage, text) {
    const chk = validate(text);
    if (!chk.ok) return chk;
    const before = {};
    collectKeys(storage).forEach(function (k) { before[k] = storage.getItem(k); });
    try {
      Object.keys(before).forEach(function (k) {
        if (!Object.prototype.hasOwnProperty.call(chk.data, k)) storage.removeItem(k);
      });
      chk.keys.forEach(function (k) { storage.setItem(k, chk.data[k]); });
    } catch (e) {
      /* 巻き戻し：いま書いたものを消して、控えを書き戻す */
      try {
        collectKeys(storage).forEach(function (k) { storage.removeItem(k); });
        Object.keys(before).forEach(function (k) { storage.setItem(k, before[k]); });
      } catch (e2) { /* ここまで来たら storage 自体が使えない。元の失敗を返す */ }
      return { ok: false, reason: '読み込みに失敗しました（元のセーブは元のままです）。' };
    }
    return { ok: true, keys: chk.keys, savedAt: chk.savedAt, version: chk.version };
  }

  const api = { PREFIX, APP, FORMAT, collectKeys, exportData, serialize, fileName, validate, importData };
  global.CQBackup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
