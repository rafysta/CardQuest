/* CardQuest v0.1 — レイアウト確認用のモックアップ
 * ここではゲームロジックは動かさず、画面の見た目・大きさ・情報量だけを確認します。
 */
'use strict';

/* ---------- カードの絵 ----------
 * assets/cards/<id>.png（または .webp）を置くと、その絵が使われます。
 * 画像が無いカードは、種別ごとの記号で表示されます。
 */
const ART_DIR = 'assets/cards/';
const TYPE_GLYPH = { U: '⚔', M: '✦', S: '✚' };
const TYPE_MARK  = { U: 'Ｕ', M: 'Ｍ', S: 'Ｓ' };
const TYPE_NAME = { U: 'モンスター', M: '魔法', S: '技能' };

function artHTML(card, cls) {
  const g = TYPE_GLYPH[card.t];
  return `<div class="art ${cls || ''}">
    <img src="${ART_DIR}${card.id}.png" alt=""
         onerror="this.replaceWith(document.createTextNode('${g}'))">
  </div>`;
}

/* 効果文を場に置ける長さへ短くする */
function shortEffect(card) {
  const s = card.e || '';
  return s.length > 22 ? s.slice(0, 21) + '…' : s;
}

/* ---------- 画面切り替え ---------- */
document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
    document.querySelectorAll('.screen').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    document.getElementById(b.dataset.screen).classList.add('on');
  });
});

/* ================= バトル画面のサンプル配置 ================= */
const SAMPLE = {
  enemy: [
    { cid: 10, chs: [{ cid: 153, own: 'e', up: true }, { cid: 117, own: 'e', up: false },
                     { cid: 101, own: 'm', up: false }] },
    null,
    { cid: 30, chs: [{ cid: 168, own: 'e', up: true }] }
  ],
  mine: [
    { cid: 1, chs: [{ cid: 153, own: 'm', up: true }, { cid: 193, own: 'm', up: true }] },
    { cid: 40, chs: [] },
    null
  ]
};

function chRow(ch, i) {
  const c = CARD_BY_ID[ch.cid];
  const cls = c.t.toLowerCase();
  if (!ch.up && ch.own === 'e') {
    return `<div class="ch ${cls} face-down">
      <span class="idx">${i + 1}</span><span class="nm">？？？</span>
      <span class="ef">まだ開いていない</span><span class="st">裏</span></div>`;
  }
  return `<div class="ch ${cls}">
    <span class="idx">${i + 1}</span>
    <span class="nm">${c.n}</span>
    <span class="ef">${shortEffect(c)}</span>
    <span class="st">${ch.up ? '開' : '裏'}</span>
  </div>`;
}

function cellHTML(slot, laneNo, side) {
  if (!slot) {
    return `<div class="cell empty">
      <span class="lane-no">${laneNo}</span>
      <span class="empty-label">空き</span></div>`;
  }
  const c = CARD_BY_ID[slot.cid];
  const max = c.ch || 6;
  let rows = slot.chs.map((x, i) => chRow(x, i)).join('');
  for (let i = slot.chs.length; i < 6; i++) {
    rows += `<div class="ch slot">${i < max ? '空きＣＨ' : '－'}</div>`;
  }
  return `<div class="cell">
    <span class="lane-no">${laneNo}</span>
    <div class="chs">${rows}</div>
    <div class="unit ${side === 'm' && laneNo === '２' ? 'sel' : ''}">
      ${artHTML(c)}
      <div class="info">
        <div class="uname">${c.n}</div>
        <div class="uskill">${c.e || '（特殊能力なし）'}</div>
        <div class="ustat">
          <span>Ａ ${c.a}</span><span>Ｄ ${c.d}</span>
          <span>ＣＨ ${slot.chs.length}／${max}</span>
        </div>
      </div>
    </div>
  </div>`;
}

const LANE_LABEL = ['１', '２', '３'];
document.getElementById('field-enemy').innerHTML =
  SAMPLE.enemy.map((s, i) => cellHTML(s, LANE_LABEL[i], 'e')).join('');
document.getElementById('field-mine').innerHTML =
  SAMPLE.mine.map((s, i) => cellHTML(s, LANE_LABEL[i], 'm')).join('');

/* 手札 */
const HAND = [5, 108, 165, 22, 135, 57, 183, 12];
document.getElementById('hand').innerHTML = HAND.map((id, i) => {
  const c = CARD_BY_ID[id];
  const stat = c.t === 'U' ? `Ａ${c.a}　Ｄ${c.d}　ＣＨ${c.ch}` : `${TYPE_GLYPH[c.t]} ${TYPE_NAME[c.t]}`;
  return `<button class="hcard ${c.t} ${i === 0 ? 'sel' : ''}" data-i="${i}">
    <span class="ht">${TYPE_MARK[c.t]}</span>
    <span class="hn">${c.n}</span>
    <span class="he">${c.e || ''}</span>
    <span class="hs">${stat}</span>
  </button>`;
}).join('');

/* 選択中のカードをもう一度押したら選択解除 */
document.getElementById('hand').addEventListener('click', (ev) => {
  const b = ev.target.closest('.hcard');
  if (!b) return;
  const wasSelected = b.classList.contains('sel');
  document.querySelectorAll('.hcard.sel').forEach((x) => x.classList.remove('sel'));
  if (!wasSelected) b.classList.add('sel');
});

/* ================= デッキ編集画面 ================= */
const COLS = {
  U: [
    { k: 'n',    label: 'カード名',  w: 200, type: 'text' },
    { k: 'a',    label: '攻撃力',    w: 84,  type: 'range' },
    { k: 'd',    label: '防御力',    w: 84,  type: 'range' },
    { k: 'ch',   label: 'ＣＨ数',    w: 74,  type: 'range' },
    { k: 'lv',   label: '召還Ｌｖ',  w: 80,  type: 'range' },
    { k: 'e',    label: '特殊能力',  w: 0,   type: 'text' },
    { k: 'p',    label: '価格',      w: 88,  type: 'range' },
    { k: 'cnt',  label: '採用',      w: 122, type: 'count' }
  ],
  MS: [
    { k: 'n',    label: 'カード名',  w: 210, type: 'text' },
    { k: 'e',    label: '効果',      w: 0,   type: 'text' },
    { k: 'p',    label: '価格',      w: 96,  type: 'range' },
    { k: 'cnt',  label: '採用',      w: 122, type: 'count' }
  ]
};

const deck = {};           // id -> 枚数
[1, 1, 8, 40, 101, 108, 153, 193].forEach((id) => { deck[id] = (deck[id] || 0) + 1; });

let dType = 'U';
let sortKey = 'id';
let sortAsc = true;
let filters = {};
let selectedId = 1;

function cols() { return dType === 'U' ? COLS.U : COLS.MS; }

function renderTable() {
  const cs = cols();
  const head = cs.map((c) => {
    const arrow = sortKey === c.k ? `<span class="arrow">${sortAsc ? '▲' : '▼'}</span>` : '';
    const w = c.w ? ` style="width:${c.w}px"` : '';
    const sortable = (c.type !== 'art' && c.type !== 'count');
    return `<th${w} data-sort="${sortable ? c.k : ''}">${c.label}${arrow}</th>`;
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
    if (c.type === 'count') {
      return `<th><button class="only-btn ${filters.only ? 'on' : ''}" id="only-btn">採用中のみ</button></th>`;
    }
    return '<th></th>';
  }).join('');

  let rows = CARDS.filter((c) => (dType === 'U' ? c.t === 'U' : c.t === dType));
  rows = rows.filter((c) => {
    for (const col of cs) {
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

  const body = rows.map((c) => {
    const cells = cs.map((col) => {
      if (col.type === 'count') {
        const n = deck[c.id] || 0;
        return `<td><div class="cnt">
          <button data-minus="${c.id}" ${n === 0 ? 'disabled' : ''}>−</button>
          <span class="v">${n}</span>
          <button data-plus="${c.id}" ${n >= 3 ? 'disabled' : ''}>＋</button>
        </div></td>`;
      }
      if (col.k === 'n') return `<td class="nm"><span class="chip ${c.t}">${TYPE_MARK[c.t]}</span>${c.n}</td>`;
      if (col.k === 'e') return `<td class="ef-cell">${c.e || ''}</td>`;
      if (col.type === 'range') return `<td class="num">${c[col.k] ?? ''}</td>`;
      return `<td>${c[col.k] ?? ''}</td>`;
    }).join('');
    return `<tr data-id="${c.id}" class="${c.id === selectedId ? 'on' : ''}">${cells}</tr>`;
  }).join('');

  document.getElementById('tbl').innerHTML =
    `<thead><tr>${head}</tr><tr class="filters">${filterRow}</tr></thead><tbody>${body}</tbody>`;

  const u = Object.entries(deck).reduce((s, [id, n]) => s + (CARD_BY_ID[id].t === 'U' ? n : 0), 0);
  const m = Object.entries(deck).reduce((s, [id, n]) => s + (CARD_BY_ID[id].t === 'M' ? n : 0), 0);
  const k = Object.entries(deck).reduce((s, [id, n]) => s + (CARD_BY_ID[id].t === 'S' ? n : 0), 0);
  document.getElementById('deck-count').innerHTML =
    `<span>モンスター <b>${u}</b></span><span>魔法 <b>${m}</b></span>` +
    `<span>技能 <b>${k}</b></span><span>合計 <b>${u + m + k}</b> ／ 50</span>`;
}

function renderDetail() {
  const c = CARD_BY_ID[selectedId];
  const stat = c.t === 'U'
    ? `<span>攻撃力 ${c.a}</span><span>防御力 ${c.d}</span>
       <span>ＣＨ ${c.ch}</span><span>召還Ｌｖ ${c.lv}</span><span>${c.p} G</span>`
    : `<span>${TYPE_NAME[c.t]}</span><span>${c.p} G</span>`;
  document.getElementById('detail').innerHTML = `
    <div class="big ${c.t}">
      <div class="bigart">${TYPE_GLYPH[c.t]}<span class="hint">assets/cards/${c.id}.png</span></div>
      <div class="tag">${TYPE_NAME[c.t]}</div>
      <div class="bn">${c.n}</div>
      <div class="bstat">${stat}</div>
      <div class="btext">${c.e || ''}</div>
    </div>
    <div class="scroll">
      <h4>入手方法</h4>
      <div class="obtain">${(c.g || '').replace(/</g, '&lt;')}</div>
    </div>`;
}

document.getElementById('tbl').addEventListener('click', (ev) => {
  const th = ev.target.closest('th[data-sort]');
  if (th && th.dataset.sort) {
    if (sortKey === th.dataset.sort) sortAsc = !sortAsc;
    else { sortKey = th.dataset.sort; sortAsc = true; }
    return renderTable();
  }
  if (ev.target.id === 'only-btn') { filters.only = filters.only ? '' : '1'; return renderTable(); }
  const plus = ev.target.closest('[data-plus]');
  if (plus) { const id = +plus.dataset.plus; deck[id] = Math.min(3, (deck[id] || 0) + 1); return renderTable(); }
  const minus = ev.target.closest('[data-minus]');
  if (minus) {
    const id = +minus.dataset.minus;
    deck[id] = (deck[id] || 0) - 1; if (deck[id] <= 0) delete deck[id];
    return renderTable();
  }
  const tr = ev.target.closest('tr[data-id]');
  if (tr) { selectedId = +tr.dataset.id; renderTable(); renderDetail(); }
});

document.getElementById('tbl').addEventListener('input', (ev) => {
  const f = ev.target.dataset.f;
  if (!f) return;
  filters[f] = ev.target.value;
  const pos = ev.target.selectionStart;
  renderTable();
  const again = document.querySelector(`[data-f="${f}"]`);
  if (again) { again.focus(); again.setSelectionRange(pos, pos); }
});

document.querySelectorAll('.dtab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.dtab').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    dType = b.dataset.t;
    filters = {}; sortKey = 'id'; sortAsc = true;
    selectedId = CARDS.find((c) => c.t === dType).id;
    renderTable(); renderDetail();
  });
});

renderTable();
renderDetail();
