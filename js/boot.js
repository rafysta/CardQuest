/* CardQuest — 起動時のローディング表示（2026-08-29 本人指定）
 *
 * 目的：起動直後や初めてマップを開くときに画面が固まったように見えないようにする。
 *
 * 仕組みは2段構え：
 *   ① **critical** … 最初に出る画面（エリア選択／初回だけ目覚めの場面）で必要な絵。
 *      これを読み終えるまでローディングを出し、進み具合をバーで見せる。
 *   ② **deferred** … マップで必要になる絵（背景・マスのアイコン・コマ・ボス切り抜き）。
 *      ①が終わったらローディングを消し、**裏で読み進める**。エリアを選ぶ頃には
 *      たいてい読み終わっているので、マップが白いまま出ることがない。
 *
 * ①だけを待つのが要点。全部を待つと起動が長くなり、裏読みだけだと初回のマップが遅い。
 *
 * ※ assets/map のアイコンは1枚1〜1.6MBある（表示は約90px角）。絵そのものを小さくすれば
 *   この待ち時間はほぼ無くなる——開発メモに申し送りしてある。
 */
'use strict';
(function (global) {

  /* 最初の画面に要る絵。エリア選択のタイルは各エリアの背景絵を縮小して使っている（仕様§6）。 */
  const CRITICAL = [
    'assets/map/bg_grassland.png',
    'assets/map/bg_forest.png'
  ];
  /* 初回起動だけ：目覚めの場面（M6.6 WP1）で使う絵。 */
  const OPENING = [
    'assets/ui/awakening.png',
    'assets/chars/amber_calm.png',
    'assets/chars/amber_down.png'
  ];
  /* マップを開いたときに要る絵。①のあと裏で読む。 */
  const DEFERRED = [
    'assets/map/player.png',
    'assets/map/icon_chest.png',
    'assets/map/icon_shop.png',
    'assets/map/icon_rest.png',
    'assets/map/icon_cash.png',
    'assets/masters/m_grassland_cut.png',
    'assets/masters/m_forest_cut.png'
  ];

  /** 目覚めの場面が出るか（＝まだ一度も見ていないか）。cq_meta を直接読む。
   * ここで localStorage が使えない環境（プライベートモード等）でも落ちないようにする。 */
  function openingWillPlay() {
    try {
      const raw = localStorage.getItem('cq_meta');
      if (!raw) return true;                       /* まっさらなら初回起動 */
      const m = JSON.parse(raw);
      return !(m && m.openingSeen);
    } catch (e) { return false; }
  }

  /** 1枚読む。失敗（404等）も「終わった」として数える——絵が1枚無いだけで
   * 起動が止まるのは困る（本体側は onerror でフォールバックする作りになっている）。 */
  function preload(src) {
    return new Promise(function (resolve) {
      const img = new Image();
      img.onload = img.onerror = function () { resolve(); };
      img.src = src;
    });
  }

  const el = function (id) { return document.getElementById(id); };

  function setProgress(done, total) {
    const bar = el('boot-bar');
    const pct = total ? Math.round(done / total * 100) : 100;
    if (bar) bar.style.width = pct + '%';
    const txt = el('boot-pct');
    if (txt) txt.textContent = pct + '%';
  }

  function hide() {
    const ov = el('boot');
    if (!ov || ov.dataset.done) return;
    ov.dataset.done = '1';
    ov.classList.add('gone');
    /* transition が終わってから DOM から外す（残しておくとタップを吸ってしまう） */
    setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 420);
  }

  /** 裏読み。進み具合は見せない（もうローディングは消えている）。 */
  function preloadDeferred() {
    DEFERRED.reduce(function (chain, src) {
      return chain.then(function () { return preload(src); });
    }, Promise.resolve());
  }

  function start() {
    const list = CRITICAL.concat(openingWillPlay() ? OPENING : []);
    let done = 0;
    setProgress(0, list.length);
    /* 安全弁：何かの理由で読み込みが返ってこなくても、8秒でローディングを畳んで先へ進む
     * （絵が無くても本体は動く。固まったまま何もできないほうが困る） */
    const failsafe = setTimeout(hide, 8000);
    Promise.all(list.map(function (src) {
      return preload(src).then(function () { done += 1; setProgress(done, list.length); });
    })).then(function () {
      clearTimeout(failsafe);
      hide();
      preloadDeferred();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  global.CQBoot = { hide: hide, preload: preload };
})(typeof window !== 'undefined' ? window : globalThis);
