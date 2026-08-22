/* CardQuest v0.4 — レイアウト確認用のモックアップ
 * バトルのルールはまだ動きませんが、カードを出す操作（ドラッグ＋確認）は試せます。
 */
'use strict';

const ART_DIR = 'assets/cards/';
const TYPE_MARK = { U: 'Ｕ', M: 'Ｍ', S: 'Ｓ' };
const TYPE_NAME = { U: 'モンスター', M: '魔法', S: '技能' };
const LAYERS = 6;                    /* チャネリングの最大階層 */

function abbrev(name, n) {
  const base = name.replace(/[『』「」\sの・]/g, '');
  let s = base.slice(0, n || 3);
  if (/[ッャュョゥィぁぃぅぇぉっゃゅょー]$/.test(s) && s.length > 1) s = base.slice(0, s.length + 1);
  return s;
}
function artInner(card, chars) {
  const a = abbrev(card.n, chars || 3);
  return `<img src="${ART_DIR}${card.id}.png" alt=""
     onerror="this.replaceWith(document.createTextNode('${a}'))">`;
}

document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
    document.querySelectorAll('.screen').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    document.getElementById(b.dataset.screen).classList.add('on');
  });
});

/* ================= バトル画面 ================= */
const G = {
  turn: 4,
  enemyHand: 5,
  enemy: [
    { cid: 10, chs: [{ cid: 153, up: true }, { cid: 117, up: false }, { cid: 101, up: false }] },
    null,
    { cid: 30, chs: [{ cid: 168, up: true }] }
  ],
  mine: [
    { cid: 1, chs: [{ cid: 153, up: true }, { cid: 193, up: true }, { cid: 135, up: false }] },
    { cid: 40, chs: [] },
    null
  ],
  hand: [5, 108, 165, 22, 135, 57, 183, 12]
};

/* --- 場のユニット（アイコンのみ。名前とＡ／Ｄは絵の上） --- */
function unitHTML(card) {
  return `<div class="card unit ${card.t}" data-card="${card.id}">
    <div class="art">${artInner(card)}</div>
    <div class="topline"><span class="nm">${card.n}</span>
      <span class="tm">${TYPE_MARK[card.t]}</span></div>
    <div class="botline"><span class="ad">Ａ${card.a} Ｄ${card.d}</span></div>
  </div>`;
}

/* --- チャネリングカード。ユニットの「下」に重なるので、上端の帯だけが見える --- */
function chHTML(card, back, k) {
  const bottom = `style="bottom:calc(${k} * var(--vstep));z-index:${100 - k}"`;
  if (back) {
    return `<div class="card ch back" data-card="${card.id}" ${bottom}>
      <div class="strip"><span class="ico back">？</span><span class="nm">裏向き</span></div>
      <div class="art">？</div></div>`;
  }
  return `<div class="card ch ${card.t}" data-card="${card.id}" ${bottom}>
    <div class="strip"><span class="ico ${card.t}">${abbrev(card.n, 2)}</span>
      <span class="nm">${card.n}</span></div>
    <div class="art">${artInner(card)}</div></div>`;
}

/* --- 1レーン --- */
function laneHTML(slot, side, i) {
  let inner = '';
  let cap = '';
  if (slot) {
    const c = CARD_BY_ID[slot.cid];
    const max = c.ch || LAYERS;
    cap = `<div class="cap-box" style="height:calc(${max} * var(--vstep))"></div>`;
    slot.chs.slice(0, max).forEach((ch, idx) => {
      inner += chHTML(CARD_BY_ID[ch.cid], !ch.up, idx + 1);
    });
    inner += unitHTML(c);
  } else {
    inner = `<div class="card empty-unit">空き</div>`;
  }
  return `<div class="lane" data-side="${side}" data-i="${i}">${cap}${inner}</div>`;
}

function renderBoard() {
  const e = G.enemy.map((s, i) => laneHTML(s, 'e', i)).join('');
  const m = G.mine.map((s, i) => laneHTML(s, 'm', i)).join('');
  let grid = '';
  for (let k = LAYERS; k >= 1; k--) grid += `<div class="gband"><span>${k}</span></div>`;
  document.getElementById('board').innerHTML =
    `<div class="bhalf enemy" id="half-e"><div class="layer-grid">${grid}</div>
       <div class="lanes">${e}</div></div>
     <div class="bhalf mine" id="half-m"><div class="layer-grid">${grid}</div>
       <div class="lanes">${m}</div></div>`;
}

/* --- 手札：左のカードが手前。右へ少しずつずらして重ねる --- */
function handHTML(card, i, sel) {
  const bot = card.t === 'U'
    ? `<div class="botline"><span class="ad">Ａ${card.a} Ｄ${card.d}</span></div>` : '';
  return `<div class="card hand-card ${card.t} ${sel ? 'sel' : ''}"
      data-card="${card.id}" data-hand="${i}" style="z-index:${100 - i}">
    <div class="art">${artInner(card)}</div>
    <div class="topline"><span class="nm">${card.n}</span>
      <span class="tm">${TYPE_MARK[card.t]}</span></div>
    ${bot}
  </div>`;
}
function renderHand() {
  const el = document.getElementById('hand');
  el.innerHTML = G.hand.map((id, i) => handHTML(CARD_BY_ID[id], i, false)).join('');
  /* 枚数が増えたら重なりを深くして、はみ出さないようにする */
  const CW = 168, W = el.clientWidth || 900, n = G.hand.length;
  const step = n > 1 ? Math.min(128, Math.floor((W - CW) / (n - 1))) : CW;
  el.style.setProperty('--hstep', Math.max(46, step) + 'px');
}

/* --- 相手の手札の枚数を、裏カードを並べて見せる --- */
function renderEnemyHand() {
  let h = '';
  for (let i = 0; i < G.enemyHand; i++) h += `<span class="mini" style="z-index:${20 - i}"></span>`;
  document.getElementById('ehand').innerHTML = h + `<b>${G.enemyHand}</b>`;
}
function renderTurn() {
  document.getElementById('turnbox').innerHTML =
    `<span class="tn">第 ${G.turn} ターン</span><span class="tw">あなたの番</span>`;
}

renderBoard(); renderHand(); renderEnemyHand(); renderTurn();

/* ================= 右の情報パネル ================= */
let pending = null;      /* 確認待ちの操作 */

function infoCardHTML(card, back) {
  if (back) {
    return `<div class="i-art back">？</div>
      <h3>裏向きのカード</h3>
      <p class="i-t">まだ開かれていないので、何のカードかは分かりません。</p>`;
  }
  const kv = card.t === 'U'
    ? `<span>攻撃力 ${card.a}</span><span>防御力 ${card.d}</span>
       <span>ＣＨ ${card.ch}</span><span>召還Ｌｖ ${card.lv}</span>`
    : `<span>${TYPE_NAME[card.t]}</span>`;
  return `<div class="i-art ${card.t}">${artInner(card)}</div>
    <div class="i-tag">${TYPE_NAME[card.t]}</div>
    <h3>${card.n}</h3>
    <div class="i-kv">${kv}</div>
    <p class="i-t">${card.e || '（特殊能力なし）'}</p>`;
}

function showCardInfo(el) {
  pending = null;
  const card = CARD_BY_ID[+el.dataset.card];
  const back = el.classList.contains('back');
  document.getElementById('info-fix').innerHTML =
    `<div class="i-body">${infoCardHTML(card, back)}</div>
     <div class="i-foot"><p class="i-hint">手札のカードを場までドラッグすると出せます</p></div>`;
}

function showConfirm(handIdx, side, lane) {
  const card = CARD_BY_ID[G.hand[handIdx]];
  const slot = G.mine[lane];
  let ng = '';
  let what = '';
  if (!slot) {
    if (card.t === 'U') what = `<b>${lane + 1}番目の枠</b> に出します`;
    else ng = 'ここは空き枠です。魔法と技能はユニットの上にしか置けません。';
  } else {
    const host = CARD_BY_ID[slot.cid];
    if (slot.chs.length >= (host.ch || LAYERS)) ng = `${host.n} のチャネルはもう空いていません。`;
    else if (card.t === 'U') ng = 'ここにはすでにユニットが居ます。';
    else what = `<b>${host.n}</b> の ${slot.chs.length + 1} 階層目にチャネリングします`;
  }
  const info = document.getElementById('info-fix');
  if (ng) {
    pending = null;
    info.innerHTML =
      `<div class="i-body">${infoCardHTML(card, false)}
        <div class="i-ask ng"><span class="q">この場所には置けません</span>${ng}</div></div>
       <div class="i-foot btns"><button class="btn ng" id="btn-ng">閉じる</button></div>`;
  } else {
    pending = { handIdx, lane };
    info.innerHTML =
      `<div class="i-body">${infoCardHTML(card, false)}
        <div class="i-ask"><span class="q">この操作でよろしいですか？</span>${what}</div></div>
       <div class="i-foot btns">
         <button class="btn ok" id="btn-ok">ＯＫ</button>
         <button class="btn ng" id="btn-ng">キャンセル</button>
       </div>`;
    document.getElementById('btn-ok').onclick = doPending;
  }
  document.getElementById('btn-ng').onclick = () => {
    pending = null;
    document.getElementById('info-fix').innerHTML =
      `<div class="i-body">${infoCardHTML(card, false)}</div>
       <div class="i-foot"><p class="i-hint">手札のカードを場までドラッグすると出せます</p></div>`;
  };
}

function doPending() {
  if (!pending) return;
  const { handIdx, lane } = pending;
  const cid = G.hand[handIdx];
  const card = CARD_BY_ID[cid];
  if (!G.mine[lane]) G.mine[lane] = { cid, chs: [] };
  else G.mine[lane].chs.push({ cid, up: false });
  G.hand.splice(handIdx, 1);
  pending = null;
  renderBoard(); renderHand();
  document.getElementById('info-fix').innerHTML =
    `<div class="i-body"><div class="i-done">場に出しました</div></div>
     <div class="i-foot"><p class="i-hint">カードを押すと、その内容がここに出ます</p></div>`;
}
function flash(msg) {
  const b = document.getElementById('flash');
  b.textContent = msg; b.classList.add('on');
  setTimeout(() => b.classList.remove('on'), 1600);
}

/* 最初の表示 */
document.getElementById('info-fix').innerHTML =
  `<div class="i-body">${infoCardHTML(CARD_BY_ID[10], false)}</div>
   <div class="i-foot"><p class="i-hint">カードを押すと、その内容がここに出ます</p></div>`;

/* ================= 操作：タップで情報／ドラッグで場に出す ================= */
let drag = null;

document.getElementById('screen-battle').addEventListener('pointerdown', (ev) => {
  const el = ev.target.closest('.card');
  if (!el || el.classList.contains('empty-unit')) return;
  if (el.classList.contains('hand-card')) {
    drag = { el, id: +el.dataset.card, idx: +el.dataset.hand,
             x0: ev.clientX, y0: ev.clientY, moved: false, ghost: null };
    el.setPointerCapture(ev.pointerId);
  } else {
    showCardInfo(el);
  }
});

document.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
  if (!drag.moved && Math.hypot(dx, dy) < 10) return;
  if (!drag.moved) {
    drag.moved = true;
    const c = CARD_BY_ID[drag.id];
    const g = document.createElement('div');
    g.className = 'ghost card ' + c.t;
    g.innerHTML = `<div class="art">${artInner(c)}</div>
      <div class="topline"><span class="nm">${c.n}</span></div>`;
    document.body.appendChild(g);
    drag.ghost = g;
    drag.el.classList.add('dragging');
    document.querySelectorAll('#half-m .lane').forEach((l) => l.classList.add('droppable'));
  }
  drag.ghost.style.left = ev.clientX + 'px';
  drag.ghost.style.top = ev.clientY + 'px';
  const lane = laneUnder(ev.clientX, ev.clientY);
  document.querySelectorAll('.lane.over').forEach((l) => l.classList.remove('over'));
  if (lane) lane.classList.add('over');
});

function laneUnder(x, y) {
  const els = document.elementsFromPoint(x, y);
  for (const e of els) {
    const l = e.closest && e.closest('.lane');
    if (l && l.dataset.side === 'm') return l;
  }
  return null;
}

document.addEventListener('pointerup', (ev) => {
  if (!drag) return;
  const d = drag; drag = null;
  document.querySelectorAll('.lane.droppable,.lane.over').forEach((l) =>
    l.classList.remove('droppable', 'over'));
  if (d.ghost) d.ghost.remove();
  d.el.classList.remove('dragging');
  if (!d.moved) { showCardInfo(d.el); return; }
  const lane = laneUnder(ev.clientX, ev.clientY);
  if (lane) showConfirm(d.idx, 'm', +lane.dataset.i);
});

document.getElementById('btn-skip').addEventListener('click', () => {
  G.turn += 1; renderTurn(); flash('ターンを終了しました');
});

/* ================= デッキ編集画面（v0.3から変更なし） ================= */
const ALL_COLS = {
  U: [
    { k: 'n',   label: 'カード名',  w: 210, type: 'text',  fixed: true,  def: true },
    { k: 'a',   label: '攻撃力',    w: 90,  type: 'range', def: true },
    { k: 'd',   label: '防御力',    w: 90,  type: 'range', def: true },
    { k: 'ch',  label: 'ＣＨ数',    w: 84,  type: 'range', def: false },
    { k: 'lv',  label: '召還Ｌｖ',  w: 90,  type: 'range', def: false },
    { k: 'e',   label: '特殊能力',  w: 0,   type: 'text',  def: true },
    { k: 'p',   label: '価格',      w: 92,  type: 'range', def: false },
    { k: 'cnt', label: '採用',      w: 122, type: 'count', fixed: true,  def: true }
  ],
  MS: [
    { k: 'n',   label: 'カード名',  w: 220, type: 'text',  fixed: true, def: true },
    { k: 'e',   label: '効果',      w: 0,   type: 'text',  def: true },
    { k: 'p',   label: '価格',      w: 100, type: 'range', def: false },
    { k: 'cnt', label: '採用',      w: 122, type: 'count', fixed: true, def: true }
  ]
};
const shown = { U: {}, MS: {} };
Object.keys(ALL_COLS).forEach((g) => ALL_COLS[g].forEach((c) => { shown[g][c.k] = c.def; }));

const deck = {};
[1, 1, 8, 40, 101, 108, 153, 193].forEach((id) => { deck[id] = (deck[id] || 0) + 1; });

let dType = 'U', sortKey = 'id', sortAsc = true, filters = {}, selectedId = 1;
let composing = false;
const grp = () => (dType === 'U' ? 'U' : 'MS');
const cols = () => ALL_COLS[grp()].filter((c) => shown[grp()][c.k]);

function renderColbar() {
  const g = grp();
  document.getElementById('colbar').innerHTML =
    '<span class="cap">表示する列</span>' +
    ALL_COLS[g].map((c) =>
      `<button class="colchip ${shown[g][c.k] ? 'on' : ''} ${c.fixed ? 'fixed' : ''}"
        data-col="${c.k}" ${c.fixed ? 'disabled' : ''}>${c.label}</button>`).join('');
}
function renderHead() {
  const cs = cols();
  const head = cs.map((c) => {
    const arrow = sortKey === c.k ? `<span class="arrow">${sortAsc ? '▲' : '▼'}</span>` : '';
    const w = c.w ? ` style="width:${c.w}px"` : '';
    return `<th${w} data-sort="${c.type !== 'count' ? c.k : ''}">${c.label}${arrow}</th>`;
  }).join('');
  const filterRow = cs.map((c) => {
    if (c.type === 'text') {
      return `<th><input data-f="${c.k}" placeholder="含む文字" value="${filters[c.k] || ''}"></th>`;
    }
    if (c.type === 'range') {
      return `<th><div class="rng">
        <input data-f="${c.k}_min" placeholder="≧" value="${filters[c.k + '_min'] || ''}">
        <input data-f="${c.k}_max" placeholder="≦" value="${filters[c.k + '_max'] || ''}">
      </div></th>`;
    }
    return `<th><button class="only-btn ${filters.only ? 'on' : ''}" id="only-btn">採用中のみ</button></th>`;
  }).join('');
  document.getElementById('thead').innerHTML =
    `<tr>${head}</tr><tr class="filters">${filterRow}</tr>`;
}
function renderBody() {
  const cs = cols();
  let rows = CARDS.filter((c) => c.t === dType);
  rows = rows.filter((c) => {
    for (const col of ALL_COLS[grp()]) {
      if (col.type === 'text' && filters[col.k]) {
        if (!String(c[col.k] || '').includes(filters[col.k])) return false;
      }
      if (col.type === 'range') {
        const mn = parseFloat(filters[col.k + '_min']), mx = parseFloat(filters[col.k + '_max']);
        const v = Number(c[col.k]);
        if (!isNaN(mn) && !(v >= mn)) return false;
        if (!isNaN(mx) && !(v <= mx)) return false;
      }
    }
    if (filters.only && !deck[c.id]) return false;
    return true;
  });
  rows.sort((x, y) => {
    const a = x[sortKey], b = y[sortKey];
    const r = (typeof a === 'number' && typeof b === 'number')
      ? a - b : String(a ?? '').localeCompare(String(b ?? ''), 'ja');
    return sortAsc ? r : -r;
  });
  document.getElementById('tbody').innerHTML = rows.map((c) => {
    const cells = cs.map((col) => {
      if (col.type === 'count') {
        const n = deck[c.id] || 0;
        return `<td><div class="cnt">
          <button data-minus="${c.id}" ${n === 0 ? 'disabled' : ''}>−</button>
          <span class="v">${n}</span>
          <button data-plus="${c.id}" ${n >= 3 ? 'disabled' : ''}>＋</button></div></td>`;
      }
      if (col.k === 'n') return `<td class="nm"><span class="chip ${c.t}">${TYPE_MARK[c.t]}</span>${c.n}</td>`;
      if (col.k === 'e') return `<td class="ef-cell">${c.e || ''}</td>`;
      if (col.type === 'range') return `<td class="num">${c[col.k] ?? ''}</td>`;
      return `<td>${c[col.k] ?? ''}</td>`;
    }).join('');
    return `<tr data-id="${c.id}" class="${c.id === selectedId ? 'on' : ''}">${cells}</tr>`;
  }).join('');
  const sum = (t) => Object.entries(deck).reduce((s, [id, n]) => s + (CARD_BY_ID[id].t === t ? n : 0), 0);
  const u = sum('U'), m = sum('M'), k = sum('S');
  document.getElementById('deck-count').innerHTML =
    `<span>${rows.length} 種を表示</span><span>モンスター <b>${u}</b></span>` +
    `<span>魔法 <b>${m}</b></span><span>技能 <b>${k}</b></span><span>合計 <b>${u + m + k}</b>／50</span>`;
}
function renderDetail() {
  const c = CARD_BY_ID[selectedId];
  const stat = c.t === 'U'
    ? `<span>攻撃力 ${c.a}</span><span>防御力 ${c.d}</span>
       <span>ＣＨ ${c.ch}</span><span>召還Ｌｖ ${c.lv}</span><span>${c.p} G</span>`
    : `<span>${TYPE_NAME[c.t]}</span><span>${c.p} G</span>`;
  document.getElementById('detail').innerHTML = `
    <div class="big ${c.t}">
      <div class="bigart">${artInner(c)}<span class="hint">assets/cards/${c.id}.png</span></div>
      <div class="bn">${c.n}</div>
      <div class="bstat">${stat}</div>
      <div class="btext">${c.e || ''}</div>
    </div>
    <div class="obt"><h4>入手方法</h4>
      <div class="obtain">${(c.g || '').replace(/</g, '&lt;')}</div></div>`;
}

document.getElementById('colbar').addEventListener('click', (ev) => {
  const b = ev.target.closest('.colchip');
  if (!b || b.disabled) return;
  shown[grp()][b.dataset.col] = !shown[grp()][b.dataset.col];
  renderColbar(); renderHead(); renderBody();
});
document.getElementById('thead').addEventListener('click', (ev) => {
  const th = ev.target.closest('th[data-sort]');
  if (th && th.dataset.sort) {
    if (sortKey === th.dataset.sort) sortAsc = !sortAsc;
    else { sortKey = th.dataset.sort; sortAsc = true; }
    return (renderHead(), renderBody());
  }
  if (ev.target.id === 'only-btn') {
    filters.only = filters.only ? '' : '1';
    ev.target.classList.toggle('on', !!filters.only);
    return renderBody();
  }
});
const thead = document.getElementById('thead');
thead.addEventListener('compositionstart', () => { composing = true; });
thead.addEventListener('compositionend', (ev) => {
  composing = false;
  if (ev.target.dataset.f) { filters[ev.target.dataset.f] = ev.target.value; renderBody(); }
});
thead.addEventListener('input', (ev) => {
  const f = ev.target.dataset.f;
  if (!f || composing) return;
  filters[f] = ev.target.value;
  renderBody();
});
document.getElementById('tbody').addEventListener('click', (ev) => {
  const plus = ev.target.closest('[data-plus]');
  if (plus) { const id = +plus.dataset.plus; deck[id] = Math.min(3, (deck[id] || 0) + 1); return renderBody(); }
  const minus = ev.target.closest('[data-minus]');
  if (minus) {
    const id = +minus.dataset.minus;
    deck[id] = (deck[id] || 0) - 1; if (deck[id] <= 0) delete deck[id];
    return renderBody();
  }
  const tr = ev.target.closest('tr[data-id]');
  if (tr) {
    selectedId = +tr.dataset.id;
    document.querySelectorAll('#tbody tr.on').forEach((x) => x.classList.remove('on'));
    tr.classList.add('on');
    renderDetail();
  }
});
document.querySelectorAll('.dtab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.dtab').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    dType = b.dataset.t;
    filters = {}; sortKey = 'id'; sortAsc = true;
    selectedId = CARDS.find((c) => c.t === dType).id;
    renderColbar(); renderHead(); renderBody(); renderDetail();
  });
});
renderColbar(); renderHead(); renderBody(); renderDetail();
