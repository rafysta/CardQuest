/* CardQuest — デバッグメニュー（開発用の道具箱・2026-08-29）
 *
 * 使われていなかった「エンジン検証」「この案について」タブを外し、代わりに開発中に本当に
 * 使う検証用コマンドをここへ集約した（本人指定）。右上の 🛠 を押すとメニューが開く。
 *
 *   ⚔ バトルをスキップ … いま戦っている戦闘を「勝利」で即終了させる。マップ側の流れ
 *                        （戦利品の振り分け→マップ復帰→次のマス）を検証するためのもの。
 *   🔄 最新版のチェック … いま読み込まれている版が、公開中のもの・GitHubのものと同じかを見る。
 *   📐 ルーラー         … 画面に80px方眼の点線と番号を重ねる。「x:3, y:5 から縦3・横5」の
 *                        ような位置指定ができるようになる。もう一度押すと消える。
 *   🎬 戦闘開始シーン   … 戦闘導入カットイン→先攻ルーレットだけを再生して元の画面に戻る。
 *                        アニメーションの調整を、実際に戦闘へ入らずに何度も確認するためのもの。
 *
 * 製品には害が無い（押さなければ何も起きない）ので、当面は常設のままにしておく。
 * DOM前提のコードなのでNode（tests/・tools/）からは読み込まれない。
 */
'use strict';

const CQDebug = (function () {

  /* ---- メニューの開閉 ------------------------------------------------------ */

  let panel = null;

  const ITEMS = [
    { icon: '⚔', label: 'バトルをスキップ（勝利）', hint: 'いまの戦闘を勝ちで終わらせる', run: skipBattle },
    { icon: '🔄', label: '最新版のチェック', hint: '公開中・GitHubの版と見比べる', run: checkVersion },
    { icon: '📐', label: 'ルーラーの表示', hint: '80px方眼と座標を重ねる（再度押すと消える）', run: toggleRuler },
    { icon: '🎬', label: '戦闘開始シーンを再生', hint: 'カットイン→ルーレットだけ再生', run: playBattleIntroScene }
  ];

  function close() { if (panel) { panel.remove(); panel = null; } }

  function toggle() {
    if (panel) return close();
    panel = document.createElement('div');
    panel.className = 'dbg-menu';
    panel.innerHTML =
      '<div class="dbg-menu-h">デバッグメニュー<span class="dbg-menu-v">v' +
        (typeof APP_VERSION === 'string' ? APP_VERSION : '?') + '</span></div>' +
      ITEMS.map(function (it, i) {
        return '<button class="dbg-item" data-i="' + i + '">' +
          '<span class="dbg-item-ic">' + it.icon + '</span>' +
          '<span class="dbg-item-t"><b>' + it.label + '</b><small>' + it.hint + '</small></span></button>';
      }).join('') +
      '<div class="dbg-out" id="dbg-out"></div>';
    /* #app の中に入れる（#app の transform:scale と一緒に縮む。cq-confirm-overlay と同じ理由） */
    (document.getElementById('app') || document.body).appendChild(panel);
    panel.addEventListener('click', function (ev) {
      const b = ev.target.closest('.dbg-item');
      if (!b) return;
      ITEMS[+b.dataset.i].run();
    });
  }

  /** メニュー内に結果を出す（メニューを開いたままにして続けて操作できるように） */
  function out(html) {
    const el = panel && panel.querySelector('#dbg-out');
    if (el) el.innerHTML = html;
  }

  /* ---- ⚔ バトルをスキップ -------------------------------------------------- */

  /** いまバトル画面で進行中の対戦を「自分の勝利」で即座に終わらせる。
   * 戦利品は、フリーユニット戦なら場に立っている敵を通常攻撃で倒したのと同じ扱いにして
   * 積んでおく（そうしないとWP7の振り分け画面を通らず、マップ側の流れを検証できない）。
   * エンジンには手を入れず、決着後の状態を直接作るだけ——`tools/verify-run.js` が
   * 実機検証で使っているのと同じ手口。 */
  function skipBattle() {
    if (typeof M === 'undefined' || !M) return out('<b>戦闘中ではありません。</b>まず戦闘に入ってください。');
    if (M.winner) return out('この戦闘はもう決着しています。');
    if (!M.loot || !M.loot.length) {
      /* 場に立っている敵ユニットを戦利品にする（通常攻撃で倒した場合と同じ内容） */
      const loot = [];
      (M.board && M.board.lanes ? M.board.lanes : []).forEach(function (ln, i) {
        if (i >= 3 && ln && ln.unit != null) loot.push(ln.unit);
      });
      M.loot = loot;
    }
    M.winner = 'self';
    M.phase = 'over';
    M.log.push('（デバッグ）勝利で終了');
    if (typeof UI !== 'undefined') { UI.mode = 'over'; UI.report = null; }
    try { busy = false; } catch (_) { /* busy は layout.js のローカル。無ければ無視 */ }
    if (typeof renderAll === 'function') renderAll();
    close();
  }

  /* ---- 🔄 最新版のチェック -------------------------------------------------- */

  const RAW_VERSION_URL = 'https://raw.githubusercontent.com/rafysta/CardQuest/main/version.json';

  /** いま動いている版（APP_VERSION）を、①公開中のサイトの version.json、
   * ②GitHubのmainブランチの version.json と見比べる。
   * ①と違えば「更新ボタンを押せば新しくなる」、①と②が違えば「pushはしたが公開が
   * まだ／pushしていない」ことが分かる。 */
  /** version.json を1つ取りに行く。**必ず時間切れで諦める**——GitHubへ出られない環境
   * （オフラインのタブレット、通信が絞られた検証環境）では fetch が延々と返らないことがあり、
   * 待ちっぱなしだと「確認しています…」のまま結果が出ない。 */
  async function fetchVersionAt(url, ms) {
    const ac = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = setTimeout(function () { if (ac) ac.abort(); }, ms || 4000);
    try {
      const r = await fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(),
        Object.assign({ cache: 'no-store' }, ac ? { signal: ac.signal } : {}));
      if (!r.ok) return null;
      return (await r.json()).version || null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkVersion() {
    const mine = (typeof APP_VERSION === 'string') ? APP_VERSION : '?';
    out('確認しています…');
    const rows = ['<div class="dbg-row"><span>いま読み込まれている版</span><b>v' + mine + '</b></div>'];
    /* 2つを同時に投げる（片方が時間切れでも全体は4秒ほどで返る） */
    const pair = await Promise.all([
      fetchVersionAt('version.json', 4000),
      fetchVersionAt(RAW_VERSION_URL, 4000)
    ]);
    const served = pair[0], github = pair[1];
    rows.push(row('公開中のサイト', served, mine));
    rows.push(row('GitHub（main）', github, mine));
    let verdict;
    if (served && served !== mine) {
      verdict = '<b class="dbg-warn">古い版を読み込んでいます。</b>画面上部の「更新」ボタンで新しくなります。';
    } else if (github && served && github !== served) {
      verdict = '<b class="dbg-warn">GitHubのほうが新しいです。</b>公開（GitHub Pages）の反映待ちの可能性があります。';
    } else if (served && github) {
      verdict = '<b class="dbg-ok">最新版です。</b>';
    } else {
      verdict = '一部を取得できませんでした（オフラインか、通信が遮られています）。';
    }
    out(rows.join('') + '<div class="dbg-verdict">' + verdict + '</div>');

    function row(name, v, mineV) {
      if (!v) return '<div class="dbg-row"><span>' + name + '</span><b class="dbg-dim">取得できず</b></div>';
      const same = v === mineV;
      return '<div class="dbg-row"><span>' + name + '</span><b class="' +
        (same ? 'dbg-ok' : 'dbg-warn') + '">v' + v + (same ? '（同じ）' : '（違う）') + '</b></div>';
    }
  }

  /* ---- 📐 ルーラー ---------------------------------------------------------- */

  /* #app は 1280×800 固定なので、80px の方眼をきっちり 16列×10行 で割り切れる。
   * 「x:3, y:5 の位置から縦3・横5」＝ 左から3マス目・上から5マス目を左上として、
   * 高さ3マス・幅5マス、という言い方ができるようにするための番号を振る。 */
  const RULER_CELL = 80;

  function toggleRuler() {
    const app = document.getElementById('app');
    if (!app) return;
    const cur = app.querySelector('.dbg-ruler');
    if (cur) { cur.remove(); return out('ルーラーを消しました。'); }
    const cols = Math.round(1280 / RULER_CELL), rows = Math.round(800 / RULER_CELL);
    let html = '';
    for (let x = 0; x < cols; x++) html += '<div class="dbg-ruler-x" style="left:' + (x * RULER_CELL) + 'px">' + x + '</div>';
    for (let y = 0; y < rows; y++) html += '<div class="dbg-ruler-y" style="top:' + (y * RULER_CELL) + 'px">' + y + '</div>';
    const el = document.createElement('div');
    el.className = 'dbg-ruler';
    el.innerHTML = html;
    app.appendChild(el);
    out('ルーラーを出しました（1マス' + RULER_CELL + 'px・' + cols + '×' + rows + '）。<br>' +
        '「x:3, y:5 から 縦3・横5」のように指示できます。');
  }

  /* ---- 🎬 戦闘開始シーンの再生 ---------------------------------------------- */

  /** カットイン→ルーレットだけを続けて再生し、終わったら元の画面へ戻る。
   * 実際の戦闘には入らない（CQRun.battleSetup も startRunBattle も呼ばない）ので、
   * ランの状態は一切変わらない＝何度でも繰り返し確認できる。 */
  function playBattleIntroScene() {
    if (typeof previewBattleIntro !== 'function') return out('ラン画面が読み込まれていません。');
    const r = previewBattleIntro(function () {
      /* カットインが終わった直後にルーレットを見せる（本番と同じ順番）。
       * 先攻／後攻は演出確認用に毎回ランダムでよい（本番の抽選には一切関係しない）。 */
      if (typeof showFirstTurnRoulette === 'function') showFirstTurnRoulette(Math.random() < 0.5 ? 'self' : 'enemy');
    });
    if (!r.ok) return out(r.reason);
    close();
  }

  /* ---- 起動 ---------------------------------------------------------------- */

  function boot() {
    const btn = document.getElementById('dbg-btn');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', toggle);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return { toggle, close, skipBattle, checkVersion, toggleRuler, playBattleIntroScene };
})();
