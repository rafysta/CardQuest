/* CardQuest — デバッグメニュー（開発用の道具箱・2026-08-29）
 *
 * 使われていなかった「エンジン検証」「この案について」タブを外し、代わりに開発中に本当に
 * 使う検証用コマンドをここへ集約した（本人指定）。右上の 🛠 を押すとメニューが開く。
 *
 *   ⚔ バトルをスキップ … いま戦っている戦闘を「勝利」で即終了させる。マップ側の流れ
 *                        （戦利品の振り分け→マップ復帰→次のマス）を検証するためのもの。
 *   📐 ルーラー         … 画面に80px方眼の点線と番号を重ねる。「x:3, y:5 から縦3・横5」の
 *                        ような位置指定ができるようになる。もう一度押すと消える。
 *
 * ★2026-09-06（本人指定）：「📮 盤面を報告」と「🔄 最新版のチェック」は、遊ぶ人が
 *   いつでも使えるべきものなので **⚙ メニュー（js/menu.js）へ移した**。友人が遊んでいて
 *   おかしいと思ったときの報告手段が、開発者モードの中にあっては届かないため。
 *   🎬 目覚めの場面     … 冒頭、アンバーと初めて出会って話す場面だけを最初から見返して
 *                        元の画面に戻る（2026-08-29・本人指定。プレイヤーが後で振り返りたい
 *                        ときのためのメニュー。cq_meta.openingSeen やランの状態には触れない）。
 *
 *   🙈 デバッグメニューを隠す … 人に見せるときのために 🛠 ごと消す（2026-09-05・本人指定）。
 *
 * 2026-09-05：友人に遊んでもらうことにしたので、**🛠 は既定で隠す**ようにした。
 * 出し入れの仕組みは js/devmode.js（バージョン表記の7回連打／URLの ?dev=1）。
 * このファイルは「開発者モードのときに何ができるか」だけを持ち、モードの状態は持たない。
 * DOM前提のコードなのでNode（tests/・tools/）からは読み込まれない。
 */
'use strict';

const CQDebug = (function () {

  /* ---- メニューの開閉 ------------------------------------------------------ */

  let panel = null;

  const ITEMS = [
    { icon: '🗡', label: 'フリーバトル', hint: '好きな相手・先攻後攻を選んで戦う', run: openFreeBattle },
    { icon: '🃏', label: 'デッキ編集', hint: '全169種から自由に組む（フリーバトル用）', run: openDeckEdit },
    { icon: '🧪', label: '盤面をセットして戦う', hint: 'レーン・ＣＨ・手札を指定して戦闘を始める', run: openBoardSetupScreen },
    { icon: '⚔', label: 'バトルをスキップ（勝利）', hint: 'いまの戦闘を勝ちで終わらせる', run: skipBattle },
    { icon: '📐', label: 'ルーラーの表示', hint: '80px方眼と座標を重ねる（再度押すと消える）', run: toggleRuler },
    { icon: '🎬', label: '目覚めの場面を見返す', hint: 'アンバーと初めて出会う場面を最初から再生', run: playOpeningScene },
    { icon: '🙈', label: 'デバッグメニューを隠す', hint: '人に見せるとき用。バージョン表記の7回連打で戻る', run: hideDevMode }
  ];

  /* 🙈 デバッグメニューを隠す（2026-09-05）。開発者モードを落として 🛠 を消す。
   * 開発用の画面を開いたまま隠すと戻り道が無くなるので、先にラン画面へ戻しておく。
   * 出し直しは js/devmode.js（バージョン表記を7回連打／URLに ?dev=1）。 */
  function hideDevMode() {
    close();
    if (typeof showScreen === 'function') showScreen('screen-run');
    if (typeof CQDev !== 'undefined') CQDev.set(false);
  }

  /* ---- 🗡 フリーバトル ／ 🃏 デッキ編集 -------------------------------------
   * どちらも 2026-08-29 にタブから移してきた開発用の画面。ストーリー（ラン）中に
   * 開いてもランの状態は壊れない——ラン画面は `RUI` が持っている状態から毎回描き直すので、
   * 戻ってくれば元の続きが出る。ただしフリーバトルは `M`（対戦の状態）を作り直すため、
   * **ラン中の戦闘の最中に開くとその戦闘は失われる**ので、そのときだけ確認を挟む。 */
  function leaveRunBattleConfirmed(then) {
    const inRunBattle = (typeof RUN_ACTIVE !== 'undefined') && RUN_ACTIVE
      && typeof M !== 'undefined' && M && !M.winner && !M.fled;
    if (!inRunBattle) return then();
    showConfirm('探索中の戦闘があります。\n開発用の画面へ移ると、この戦闘は失われます。\nよろしいですか？',
      then, '移る');
  }

  function openFreeBattle() {
    close();
    leaveRunBattleConfirmed(function () {
      if (typeof RUN_ACTIVE !== 'undefined') { RUN_ACTIVE = false; runOverHook = null; }
      renderFreeSetup();
      showScreen('screen-free');
    });
  }

  function openDeckEdit() {
    close();
    showScreen('screen-deck');
  }

  /* 🧪 盤面をセットして戦う（2026-08-30）。フリーバトルと同じくランの戦闘を捨てるので、
   * 同じ確認を挟む。中身は js/layout.js の openBoardSetup()。 */
  function openBoardSetupScreen() {
    close();
    leaveRunBattleConfirmed(function () {
      if (typeof RUN_ACTIVE !== 'undefined') { RUN_ACTIVE = false; runOverHook = null; }
      openBoardSetup();
    });
  }

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

  /* ---- 🎬 目覚めの場面を見返す ----------------------------------------------
   * 2026-08-29：以前あった「戦闘開始シーンを再生」を削除し、代わりに置いた。
   * プレイヤーが後でアンバーとの出会いを振り返りたいときのためのメニュー。 */

  /** 冒頭の目覚めの場面（アンバーと初めて出会って話す場面）だけを最初から再生し、
   * 終わったら元いた画面へ戻る。cq_meta.openingSeen やラン（RUI.run）の状態には
   * 一切触れないので、何度でも見返せる。画面はいったんラン画面（#screen-run）へ
   * 切り替える必要があるので、戻り先の画面を覚えておいて終了後に復元する。 */
  let openingReturnScreen = null;
  function playOpeningScene() {
    if (typeof previewOpening !== 'function') return out('ラン画面が読み込まれていません。');
    const cur = document.querySelector('.screen.on');
    openingReturnScreen = cur ? cur.id : 'screen-run';
    const r = previewOpening(function () {
      if (openingReturnScreen && typeof showScreen === 'function') showScreen(openingReturnScreen);
      openingReturnScreen = null;
    });
    if (!r.ok) return out(r.reason);
    if (typeof showScreen === 'function') showScreen('screen-run');
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

  return { toggle, close, skipBattle, toggleRuler, playOpeningScene };
})();
