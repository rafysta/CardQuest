/* CardQuest — ⚙ メニュー（遊ぶ人がいつでも開ける道具箱・2026-09-06・本人指定）
 *
 * 🛠 デバッグメニュー（js/debug.js）は開発者モードのときだけ出る開発用の道具箱。
 * こちらは**通常モードでも常に出ている**、遊ぶ人のためのメニュー。画面右上の ⚙ から、
 * ランの途中でも・戦闘の最中でも開ける（トップバーはどの画面でも出ているため）。
 *
 *   ▸ 演出の速さ          … ゆっくり／ふつう／速い。押した瞬間から次の演出に効く
 *   ▸ 相手の手番の進め方  … 自動で進める／タップで1手ずつ
 *      この2つは以前ホームの「設定」にしか無く、ランに出てしまうと変えられなかった
 *      （2026-09-06 本人指定でこちらへ一本化。ホームの設定からは外した）。
 *   ▸ 📮 盤面を報告       … 以前は 🛠 の中にあったが、友人が遊んでいて「おかしい」と
 *      思ったときの報告手段なので、通常モードでも常に押せる場所へ移した（本人指定）。
 *   ▸ ℹ バージョン情報    … いまの版・更新履歴（CHANGELOG）・最新版のチェック。
 *      「最新版のチェック」も 🛠 から移してきた（古い版のまま遊んでいないかを
 *      遊ぶ人自身が確かめられるようにするため）。
 *
 * 設定の実体は localStorage の `cq_fx`。読み書きは js/run-ui.js の
 * fxSpeedSetting()／fxStepSetting()／fxSave() をそのまま使う（設定の置き場所を二重に
 * 持たないため）。演出側（js/layout.js の fxMs／tapMode）は毎回 localStorage を読むので、
 * 戦闘の最中に変えても次の停止から効く。
 *
 * DOM前提のコードなのでNode（tests/・tools/）からは読み込まれない。
 */
'use strict';

const CQMenu = (function () {

  const RAW_VERSION_URL = 'https://raw.githubusercontent.com/rafysta/CardQuest/main/version.json';

  let panel = null;
  let view = 'main';          /* 'main' | 'version' */

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function ver() { return (typeof APP_VERSION === 'string') ? APP_VERSION : '?'; }
  function build() { return (typeof APP_BUILD === 'string') ? APP_BUILD : ''; }

  /* ---- 開閉 ---------------------------------------------------------------- */

  function close() { if (panel) { panel.remove(); panel = null; } view = 'main'; }

  function toggle() {
    if (panel) return close();
    panel = document.createElement('div');
    panel.className = 'app-menu';
    /* #app の中に入れる（#app の transform:scale と一緒に縮む。dbg-menu と同じ理由） */
    (document.getElementById('app') || document.body).appendChild(panel);
    panel.addEventListener('click', onClick);
    render();
  }

  function render() {
    if (!panel) return;
    panel.innerHTML = (view === 'version') ? versionHTML() : mainHTML();
  }

  /* ---- 本体（設定と入口） --------------------------------------------------- */

  /** 設定の現在値。js/run-ui.js の関数をそのまま使う（読み込み順の都合で毎回見る）。 */
  function speedNow() { return (typeof fxSpeedSetting === 'function') ? fxSpeedSetting() : 'slow'; }
  function stepNow() { return (typeof fxStepSetting === 'function') ? fxStepSetting() : 'auto'; }

  function pickRow(act, now, opts) {
    return '<div class="am-pick">' + opts.map(function (o) {
      return '<button class="am-btn' + (now === o[0] ? ' on' : '') + '" data-act="' + act +
        '" data-v="' + o[0] + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }

  function mainHTML() {
    return '<div class="am-h">メニュー<span class="am-v">v' + esc(ver()) + '</span></div>' +
      '<section class="am-sec">' +
        '<h5>演出の速さ</h5>' +
        '<p class="am-note">攻撃の宣言・判定の数字・ＬＰの減少を、止まって見せる時間。</p>' +
        pickRow('fx-speed', speedNow(), [['slow', 'ゆっくり'], ['normal', 'ふつう'], ['fast', '速い']]) +
      '</section>' +
      '<section class="am-sec">' +
        '<h5>相手の手番の進め方</h5>' +
        '<p class="am-note">「タップで1手ずつ」にすると、相手の手番は節目ごとに止まります。</p>' +
        pickRow('fx-step', stepNow(), [['auto', '自動で進める'], ['tap', 'タップで1手ずつ']]) +
      '</section>' +
      '<button class="am-item" data-act="report">' +
        '<span class="am-item-ic">📮</span>' +
        '<span class="am-item-t"><b>盤面を報告</b>' +
        '<small>気になった場面を、直前5手ぶんの動きごとメールで送る</small></span></button>' +
      '<button class="am-item" data-act="version">' +
        '<span class="am-item-ic">ℹ️</span>' +
        '<span class="am-item-t"><b>バージョン情報</b>' +
        '<small>いまの版・更新履歴・最新版のチェック</small></span></button>';
  }

  /* ---- バージョン情報 ------------------------------------------------------- */

  const TYPE_MARK = { new: '✨', fix: '🔧', change: '🔁' };

  function versionHTML() {
    const log = (typeof CHANGELOG !== 'undefined' && Array.isArray(CHANGELOG)) ? CHANGELOG : [];
    return '<div class="am-h"><button class="am-back" data-act="back">← 戻る</button>バージョン情報</div>' +
      '<div class="am-ver">' +
        '<div class="am-row"><span>いま遊んでいる版</span><b>v' + esc(ver()) +
          (build() ? '<small>（' + esc(build()) + '）</small>' : '') + '</b></div>' +
        '<button class="am-btn wide" data-act="check">最新版のチェック</button>' +
        '<div class="am-out" id="am-out"></div>' +
      '</div>' +
      '<h5 class="am-log-h">更新履歴</h5>' +
      '<div class="am-log">' + log.map(function (e) {
        return '<div class="am-log-e"><div class="am-log-v">v' + esc(e.version) +
          '<small>' + esc(e.date || '') + '</small></div>' +
          (e.items || []).map(function (it) {
            /* text は自分たちで書いた <b> 入りの文章なのでそのまま出す（外から来ない） */
            /* 印と本文を1つずつの入れ物に入れる（本文の <b> が flex の列に割れないように） */
            return '<p class="am-log-i"><span>' + (TYPE_MARK[it.type] || '・') + '</span>' +
              '<span class="am-log-t">' + it.text + '</span></p>';
          }).join('') + '</div>';
      }).join('') + '</div>';
  }

  function out(html) {
    const el = panel && panel.querySelector('#am-out');
    if (el) el.innerHTML = html;
  }

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

  /** いま動いている版を、①公開中のサイト、②GitHubのmain と見比べる（🛠 から移設）。 */
  async function checkVersion() {
    const mine = ver();
    out('確認しています…');
    const pair = await Promise.all([
      fetchVersionAt('version.json', 4000),
      fetchVersionAt(RAW_VERSION_URL, 4000)
    ]);
    const served = pair[0], github = pair[1];
    const rows = [row('公開中のサイト', served, mine), row('GitHub（main）', github, mine)];
    let verdict;
    if (served && served !== mine) {
      verdict = '<b class="am-warn">古い版で遊んでいます。</b>画面上部の「更新」ボタンで新しくなります。';
    } else if (github && served && github !== served) {
      verdict = '<b class="am-warn">公開の反映待ちです。</b>GitHubのほうが新しい版になっています。';
    } else if (served && github) {
      verdict = '<b class="am-ok">最新版です。</b>';
    } else {
      verdict = '一部を取得できませんでした（オフラインか、通信が遮られています）。';
    }
    out(rows.join('') + '<div class="am-verdict">' + verdict + '</div>');

    function row(name, v, mineV) {
      if (!v) return '<div class="am-row"><span>' + name + '</span><b class="am-dim">取得できず</b></div>';
      const same = v === mineV;
      return '<div class="am-row"><span>' + name + '</span><b class="' +
        (same ? 'am-ok' : 'am-warn') + '">v' + esc(v) + (same ? '（同じ）' : '（違う）') + '</b></div>';
    }
  }

  /* ---- 押されたとき --------------------------------------------------------- */

  function onClick(ev) {
    const b = ev.target.closest('[data-act]');
    if (!b || !panel.contains(b)) return;
    const act = b.dataset.act, v = b.dataset.v;
    switch (act) {
      /* 設定はメニューを開いたまま切り替える（何度か試して好みを決められるように） */
      case 'fx-speed':
        if (typeof fxSave === 'function') fxSave({ speed: v });
        return render();
      case 'fx-step':
        if (typeof fxSave === 'function') fxSave({ step: v });
        return render();
      case 'report':
        close();
        if (typeof CQReport === 'undefined' || !CQReport.open) return;
        return CQReport.open();
      case 'version':
        view = 'version';
        return render();
      case 'back':
        view = 'main';
        return render();
      case 'check':
        return checkVersion();
      default:
    }
  }

  /* ---- 起動 ---------------------------------------------------------------- */

  function boot() {
    const btn = document.getElementById('menu-btn');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', toggle);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return { toggle, close, checkVersion };
})();
