/* CardQuest — 戦闘中の割り込みヒント（M8.5 チュートリアル・WP1）
 *
 * 『実装計画追補 M8.5 チュートリアル』§2.4。台本 v0.1 §14.1 の8種のうち、
 * **バトル画面で出す7種**をここが担当する（残る firstRecord はラン画面なので js/run-ui.js）。
 *
 * この部品の仕事は3つだけ：
 *   ① 出す／出さないの判定（既読フラグは呼び出し側が持つ＝**cq_meta の形を知らない**）
 *   ② #screen-battle の上に覆いを重ねて、アンバーの吹き出し＋UIの一行を出す
 *   ③ 該当するＵＩ部品を光らせる（.tut-glow）
 *
 * **エンジンには一切触らない。** 読むのは渡された M / UI だけで、盤面も乱数も動かさない。
 * 文面は js/lore.js（LORE.hints / LORE.hintsUi）が持つ＝**推敲でコードを触らない**。
 *
 * 吹き出しの見た目は開始マスのアンバー（.amber-row / .amber-face / .amber-bubble）を
 * そのまま流用する。違うのは「マップではなくバトル画面の上に出る」ことと、
 * 吹き出しの下に**UIの一行**（操作の説明・世界観の言葉ではない）が付くこと。
 */
'use strict';
(function (global) {

  /* 呼び出し側（js/layout.js の startRunBattle）が渡す文脈。
   *   ctx.seen(key)  … 既読か（true なら出さない）
   *   ctx.mark(key)  … 既読にする（吹き出しを閉じ切った瞬間に呼ぶ）
   *   ctx.tutorial   … 1|2|0（固定戦闘の番号。0＝ふつうの戦闘）
   *   ctx.after()    … 閉じた後に呼ぶ（layout.js は renderPanel を渡す）
   * **ctx が null の間は何も出さない**（フリーバトル・盤面セットアップ・デバッグ再生）。 */
  var CTX = null;

  /* いま出ている吹き出し。{ key, script, step, ui, glow } */
  var OPEN = null;

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function lore() { return (typeof CQLore !== 'undefined' && CQLore.LORE) ? CQLore.LORE : null; }
  function screenEl() {
    return (typeof document !== 'undefined') ? document.getElementById('screen-battle') : null;
  }

  function begin(ctx) { close(); CTX = ctx || null; }
  function end() { close(); CTX = null; }

  function seen(key) { return !CTX || typeof CTX.seen !== 'function' || !!CTX.seen(key); }
  function mark(key) { if (CTX && typeof CTX.mark === 'function') CTX.mark(key); }
  function tut() { return (CTX && CTX.tutorial) ? CTX.tutorial : 0; }
  function isOpen() { return !!OPEN; }

  /* 第2戦だけ言い回しが変わるものは `<key>T2` を優先する（台本 v0.1 §14.1）。
   * 用意されていなければ共通の文にそのまま落ちる。 */
  function pick(table, key) {
    if (!table) return null;
    if (tut() === 2 && table[key + 'T2']) return table[key + 'T2'];
    return table[key] || null;
  }
  function scriptFor(key) { var o = lore(); return o ? pick(o.hints, key) : null; }
  function uiLineFor(key) { var o = lore(); return (o ? pick(o.hintsUi, key) : null) || ''; }

  /* ================= 判定 =================
   * 上から順に見て、**最初に条件を満たした1つだけ**を出す（同時に2つ出さない）。
   * 条件は M / UI を読むだけ。t2:true は第2戦（固定戦闘）専用。 */
  function selfLanes(M) { return [M.board.lanes[0], M.board.lanes[1], M.board.lanes[2]]; }
  function selfHasUnit(M) {
    return selfLanes(M).some(function (ln) { return ln && ln.unit != null; });
  }
  function selfHasChannel(M) {
    return selfLanes(M).some(function (ln) { return ln && ln.channels && ln.channels.length > 0; });
  }
  function handHas(M, id) {
    var h = M.players && M.players.self && M.players.self.hand;
    return !!(h && h.indexOf(id) >= 0);
  }
  /* 人の配置ステップ（戦闘中でなく、自分の手番で、まだ決着していない）。 */
  function myPlacement(M) {
    return !M.combat && !M.winner && M.active === 'self' && M.phase === 'placement';
  }

  var RULES = [
    { key: 'placement', pos: 'top',
      glow: ['#hand .hand-card.U', '#half-m .empty-unit'],
      when: function (M) { return myPlacement(M) && !selfHasUnit(M); } },

    /* 第2戦だけ。手札に華の2枚が揃っているときにしか出さない
     * （固定戦闘が何かの理由で適用されなかったとき、案内だけが浮くのを防ぐ）。 */
    { key: 'hidden', pos: 'top', t2: true,
      glow: ['#hand .hand-card[data-card="108"]', '#hand .hand-card[data-card="101"]'],
      when: function (M) { return myPlacement(M) && handHas(M, 108) && handHas(M, 101); } },

    { key: 'faceDown', pos: 'top',
      glow: ['#acts .act-btn'],
      when: function (M) { return myPlacement(M) && selfHasChannel(M); } },

    { key: 'loot', pos: 'bottom',
      glow: ['#board .lane.target'],
      when: function (M, UI) { return !M.winner && UI.mode === 'attack'; } },

    { key: 'open', pos: 'top',
      glow: ['#board .card.ch.openable', '#acts .act-btn'],
      when: function (M) {
        return !!M.combat && !M.winner && typeof CQCombat !== 'undefined'
          && CQCombat.openerSide(M) === 'self';
      } },

    { key: 'unpossess', pos: 'bottom',
      glow: ['#board .card.ch.pick'],
      when: function (M, UI) {
        return !M.winner && UI.mode === 'pick-target' && UI.pick && UI.pick.card === 101;
      } }
  ];

  /** 安全に出せる状態か（演出中・決着後・既に出ているときは出さない）。 */
  function ready(M, UI) {
    return !!(CTX && M && UI && !OPEN && M.board && M.players && screenEl());
  }

  function check(M, UI) {
    if (!ready(M, UI)) return false;
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      if (r.t2 && tut() !== 2) continue;
      if (seen(r.key)) continue;
      var ok = false;
      try { ok = !!r.when(M, UI); } catch (e) { ok = false; }
      if (ok) return open(r.key, r.pos, r.glow);
    }
    return false;
  }

  /** 条件判定を通さずに直接出す（強制開放の連鎖のように「演出が終わった瞬間」に出すもの）。
   * 既読なら何もしない＝呼び出し側は素直に呼んでよい。 */
  function show(key, opts) {
    var o = opts || {};
    if (!CTX || OPEN || !screenEl()) return false;
    if (o.t2 && tut() !== 2) return false;
    if (seen(key)) return false;
    return open(key, o.pos || 'bottom', o.glow || []);
  }

  /* ================= 描画 ================= */

  function bubbleHTML(b, uiLine, more) {
    var face = (b.face === 'down') ? 'amber_down' : 'amber_calm';
    var lines = (b.lines || []).map(esc).join('<br>');
    return '<div class="amber-row">'
      + '<img class="amber-face" src="assets/chars/' + face + '.png" alt="" draggable="false"'
      + ' onerror="this.remove()">'
      + '<div class="amber-bubble">'
      + '<div class="amber-lines">' + lines + '</div>'
      + (uiLine ? '<div class="hint-ui">' + esc(uiLine) + '</div>' : '')
      + '<div class="amber-tap-hint">' + (more ? 'タップして進む' : 'タップして閉じる') + '</div>'
      + '</div></div>';
  }

  function open(key, pos, glow) {
    var script = scriptFor(key);
    if (!script || !script.length) return false;
    OPEN = { key: key, script: script, step: 0, ui: uiLineFor(key), glow: glow || [], pos: pos || 'bottom' };
    paint();
    return true;
  }

  function paint() {
    var host = screenEl();
    if (!host || !OPEN) return;
    var el = host.querySelector('.battle-hint');
    if (!el) {
      el = document.createElement('div');
      el.className = 'battle-hint';
      el.addEventListener('click', next);
      host.appendChild(el);
    }
    el.className = 'battle-hint pos-' + OPEN.pos;
    var last = OPEN.step >= OPEN.script.length - 1;
    /* ＵＩの一行は**最後の吹き出しにだけ**添える（説明が先、操作が後）。 */
    el.innerHTML = bubbleHTML(OPEN.script[OPEN.step], last ? OPEN.ui : '', !last);
    applyGlow();
  }

  function next() {
    if (!OPEN) return;
    if (OPEN.step < OPEN.script.length - 1) { OPEN.step += 1; return paint(); }
    var key = OPEN.key;
    close();
    mark(key);                                  /* 見せ切ってから既読にする */
    if (CTX && typeof CTX.after === 'function') { try { CTX.after(); } catch (e) { /* 描き直しの失敗は無視 */ } }
  }

  function applyGlow() {
    clearGlow();
    if (!OPEN || !OPEN.glow.length) return;
    OPEN.glow.forEach(function (sel) {
      var list;
      try { list = document.querySelectorAll(sel); } catch (e) { return; }
      Array.prototype.forEach.call(list, function (n) { n.classList.add('tut-glow'); });
    });
  }
  function clearGlow() {
    if (typeof document === 'undefined') return;
    var list = document.querySelectorAll('.tut-glow');
    Array.prototype.forEach.call(list, function (n) { n.classList.remove('tut-glow'); });
  }

  function close() {
    var host = screenEl();
    var el = host && host.querySelector('.battle-hint');
    if (el) el.remove();
    clearGlow();
    OPEN = null;
  }

  var api = { begin: begin, end: end, check: check, show: show, close: close, isOpen: isOpen };
  global.CQBattleHint = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
