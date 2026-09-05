/* CardQuest — 開発者モード（デバッグメニューの隠し切り替え・2026-09-05・本人指定）
 *
 * 友人に遊んでもらうとき、右上の 🛠 デバッグメニューが見えていると
 * 「押していいのか」と迷わせるので、**既定では隠す**ことにした。
 * 自分が必要なときだけ、次のどちらかで出す：
 *
 *   ① 画面右上のバージョン表記（v0.16.x）を **3秒以内に7回** 続けて押す
 *      （Android の「ビルド番号を7回タップで開発者向けオプション」と同じ作法）。
 *      4回目からは「あと n 回でデバッグメニューが出ます」と出るので、
 *      偶然たどり着くことはまず無いが、自分は迷わない。
 *   ② URL に `?dev=1` を付けて開く（PCでの検証・Playwright 用）。
 *      `?dev=0` で消す。`#dev` でも出る。
 *
 * どちらの入口も **localStorage の `cq_dev` を立てるだけ**にしてある。
 * 状態はこの1か所に集約し、見た目は CSS（`<html class="cq-dev">`）で切り替える
 * ——JSが動く前に一瞬だけ 🛠 が見える、という事故を避けるため、
 * `.dbg-btn` は CSS で **既定 display:none**、`.cq-dev` のときだけ出す。
 *
 * 消すのはデバッグメニューの中の「🙈 デバッグメニューを隠す」から。
 *
 * ※ これは「見えなくする」だけで、開発者ツールを開けば分かる。
 *   友人に遊んでもらう用途では十分という判断（2026-09-05 本人確認済み）。
 *   本気で隠す必要が出てきたら、配布用ビルドで debug.js ごと落とすことになる。
 *
 * DOM前提のコードなのでNode（tests/・tools/）からは読み込まれない。
 */
'use strict';

const CQDev = (function () {

  const KEY  = 'cq_dev';   /* localStorage。'1' のときだけ開発者モード */
  const NEED = 7;          /* バージョン表記を連打する回数 */
  const SPAN = 3000;       /* その連打を収める時間(ms)。外れたら数え直し */
  const HINT = 4;          /* 何回目から「あと n 回」を出すか */

  let taps = [];
  let on   = read();

  function read() {
    try { return localStorage.getItem(KEY) === '1'; } catch (_) { return false; }
  }
  function write(v) {
    try { v ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY); } catch (_) { /* 拒否されても動きは変えない */ }
  }
  function say(msg) {
    if (typeof flash === 'function') flash(msg);   /* layout.js。読み込み順の都合で呼ぶ時点に見る */
  }

  /** 見た目の反映はここだけ。`<html class="cq-dev">` の付け外しで CSS に任せる。 */
  function apply() {
    const r = document.documentElement;
    if (r) r.classList.toggle('cq-dev', on);
  }

  function isOn() { return on; }

  /** 開発者モードを切り替える。quiet=true なら画面に何も出さない（起動時の反映用）。 */
  function set(v, quiet) {
    const was = on;
    on = !!v;
    write(on);
    apply();
    if (!quiet && was !== on) {
      say(on ? '🛠 デバッグメニューを表示しました。'
             : 'デバッグメニューを隠しました。バージョン表記を' + NEED + '回続けて押すと戻ります。');
    }
    return on;
  }

  /* ---- ① バージョン表記の連打 ---------------------------------------------- */

  function onTap() {
    if (on) return;                       /* 出ている間は数えない。消すのはメニューから */
    const now = Date.now();
    taps = taps.filter(function (t) { return now - t < SPAN; });
    taps.push(now);
    const left = NEED - taps.length;
    if (left <= 0) { taps = []; return set(true); }
    if (taps.length >= HINT) say('あと' + left + '回でデバッグメニューが出ます。');
  }

  /* ---- ② URL の ?dev= ------------------------------------------------------- */

  /** URLの指定を読む。指定が無ければ null（＝localStorage の記憶をそのまま使う）。 */
  function fromUrl() {
    try {
      const q = new URLSearchParams(location.search).get('dev');
      if (q !== null) return !(q === '0' || q === 'off' || q === 'false');
      if (/^#dev$/i.test(location.hash)) return true;
    } catch (_) { /* 古い環境では URLSearchParams が無いことがある */ }
    return null;
  }

  /* ---- 起動 ---------------------------------------------------------------- */

  function boot() {
    const u = fromUrl();
    if (u !== null) set(u, true); else apply();
    const el = document.getElementById('ver-label');
    if (el && !el.dataset.bound) {
      el.dataset.bound = '1';
      el.addEventListener('click', onTap);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return { isOn, set, NEED, KEY };
})();
