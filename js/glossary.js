/* CardQuest — 索引（用語辞典・M8.5 WP3）
 *
 * 世界観§6.5「常設ヘルプ＝索引」／『実装計画追補 M8.5』§2.6。
 * 入口は2つ（本人確定⑥）：⚙メニューの「📖 索引」と、バトル画面の上段の「?」。
 *
 * 中身は js/lore.js（LORE.glossary）が持ち、ここは並べて見せるだけ。
 * **一度出した段階的開示ヒントがそのまま蓄積される**ので、索引のために別の文を書かない
 * （項目の hint が指す LORE.hints の文を、アンバーの言葉として引用の体裁で並べる）。
 *
 * まだ出会っていない項目は、見出しだけ「──」で伏せる（情報量で圧倒しない・世界観§6.5）。
 * 既読の判定は cq_meta.seenHints。読むだけで書き換えない。
 */
'use strict';
const CQGlossary = (function () {

  let panel = null;
  let sel = 0;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function lore() { return (typeof CQLore !== 'undefined' && CQLore.LORE) ? CQLore.LORE : null; }
  function items() { const o = lore(); return (o && o.glossary) ? o.glossary : []; }

  /** その項目を読めるか。key が null なら常時。 */
  function known(it) {
    if (!it.key) return true;
    if (typeof CQSave === 'undefined' || typeof RUI === 'undefined' || !RUI || !RUI.meta) return false;
    return CQSave.hintSeen(RUI.meta, it.key);
  }

  function listHTML() {
    return items().map(function (it, i) {
      const ok = known(it);
      const label = ok ? esc(it.term) : '──';
      return '<button class="gl-row' + (i === sel ? ' on' : '') + (ok ? '' : ' locked') + '"'
        + ' data-gl="' + i + '"' + (ok ? '' : ' disabled') + '>' + label + '</button>';
    }).join('');
  }

  function detailHTML() {
    const list = items();
    const it = list[sel];
    if (!it || !known(it)) {
      return '<div class="gl-empty">まだ出会っていない項目です。<br>'
        + '冒険の中でその場面に来ると、ここに書き足されます。</div>';
    }
    const ui = (it.ui || []).map(function (line) { return '<li>' + esc(line) + '</li>'; }).join('');
    let quote = '';
    const o = lore();
    const bubbles = (it.hint && o && o.hints) ? o.hints[it.hint] : null;
    if (bubbles && bubbles.length) {
      quote = '<div class="gl-quote">'
        + bubbles.map(function (b) {
          return '<p>' + (b.lines || []).map(esc).join('<br>') + '</p>';
        }).join('')
        + '</div>';
    }
    return '<h4 class="gl-term">' + esc(it.term) + '</h4>'
      + '<ul class="gl-ui">' + ui + '</ul>' + quote;
  }

  function render() {
    if (!panel) return;
    panel.innerHTML =
      '<div class="gl-head">📖 索引<button class="gl-close" data-gl-close="1">閉じる</button></div>'
      + '<div class="gl-body">'
      + '<div class="gl-list">' + listHTML() + '</div>'
      + '<div class="gl-detail">' + detailHTML() + '</div>'
      + '</div>';
  }

  function open() {
    if (panel) return close();
    /* 最初に選ぶのは「読める最初の項目」（伏せた項目を選んだ状態で開かない）。 */
    const list = items();
    sel = 0;
    for (let i = 0; i < list.length; i++) { if (known(list[i])) { sel = i; break; } }
    panel = document.createElement('div');
    panel.className = 'cq-glossary';
    render();
    /* #app の中に入れる（#app の transform:scale と一緒に縮む。デバッグメニューと同じ理由） */
    (document.getElementById('app') || document.body).appendChild(panel);
    panel.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-gl-close]')) return close();
      const row = ev.target.closest('[data-gl]');
      if (row) { sel = +row.dataset.gl; return render(); }
    });
  }

  function close() {
    if (panel) { panel.remove(); panel = null; }
  }

  return { open, close, isOpen: function () { return !!panel; } };
})();
