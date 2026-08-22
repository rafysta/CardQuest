/* CardQuest v0.2 — レイアウト確認用のモックアップ
 * ゲームロジックはまだ動きません。画面の配置・大きさ・情報量だけを確認します。
 */
'use strict';

const ART_DIR = 'assets/cards/';
const TYPE_MARK = { U: 'Ｕ', M: 'Ｍ', S: 'Ｓ' };
const TYPE_NAME = { U: 'モンスター', M: '魔法', S: '技能' };

/* カード名の短縮（絵が用意できるまでの仮アイコン用）
 * ヨルムンガンド → ヨル / 赤の聖霊陣 → 赤の聖 のように先頭3文字。
 * 「の」「・」など切りの悪い文字で終わるときは1文字減らす。 */
function abbrev(name, n) {
  const base = name.replace(/[『』「」\sの・]/g, '');
  let s = base.slice(0, n || 3);
  if (/[ッャュョゥィぁぃぅぇぉっゃゅょー]$/.test(s) && s.length > 1) s = base.slice(0, s.length + 1);
  return s;
}

function artInner(card) {
  return `<img src="${ART_DIR}${card.id}.png" alt=""
     onerror="this.replaceWith(document.createTextNode('${abbrev(card.n)}'))">`;
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

/* ================= バトル画面 ================= */
const SAMPLE = {
  enemy: [
    { cid: 10, chs: [{ cid: 153, up: true }, { cid: 117, up: false }, { cid: 101, up: false }] },
    null,
    { cid: 30, chs: [{ cid: 168, up: true }] }
  ],
  mine: [
    { cid: 1, chs: [{ cid: 153, up: true }, { cid: 193, up: true }, { cid: 135, up: false }] },
    { cid: 40, chs: [] },
    null
  ]
};
const HAND = [5, 108, 165, 22, 135, 57, 183, 12, 30, 143];

/* カードアイコン1枚（場のユニット・手札用） */
function pcHTML(card, opt) {
  const o = opt || {};
  const sub = card.t === 'U'
    ? `<span class="pcstat">Ａ${card.a}　Ｄ${card.d}</span>`
    : `<span class="pcsub">${card.e || ''}</span>`;
  return `<button class="pc ${card.t} ${o.sel ? 'sel' : ''}" data-card="${card.id}"
      style="z-index:${o.z || 1}">
    <span class="mark">${TYPE_MARK[card.t]}</span>
    <span class="pcart">${artInner(card)}</span>
    <span class="pcname">${card.n}</span>
    ${sub}
  </button>`;
}

/* 重ねて置くチャネリングカード（見えている端に略称） */
function chCardHTML(card, o) {
  const side = o.side === 'e' ? 'right' : 'left';
  if (o.back) {
    return `<button class="pc stk back ${side}" data-card="${card.id}" style="z-index:${o.z}">
      <span class="edge"><span class="ab"><i>？</i></span></span>
      <span class="body"><span class="bn2">？？？</span>
        <span class="be2">まだ開かれていません</span></span></button>`;
  }
  return `<button class="pc stk ${card.t} ${side}" data-card="${card.id}" style="z-index:${o.z}">
    <span class="edge"><span class="ab">${abbrev(card.n, 2).split('').map((ch) => `<i>${ch}</i>`).join('')}</span></span>
    <span class="body"><span class="bn2">${card.n}</span>
      <span class="be2">${card.e || ''}</span></span></button>`;
}

/* 1レーン分 */
function laneHTML(slot, side, i) {
  const cls = side === 'e' ? 'enemy' : 'mine';
  const tag = `<span class="lane-tag">${side === 'e' ? '相手' : '自分'} ${'１２３'[i]}</span>`;
  if (!slot) {
    return `<div class="lane ${cls}">${tag}<div class="emptyslot big">ユニットなし</div></div>`;
  }
  const c = CARD_BY_ID[slot.cid];
  const max = c.ch || 6;
  let stack = '';
  slot.chs.slice(0, max).forEach((ch, i) => {
    stack += chCardHTML(CARD_BY_ID[ch.cid], { z: i + 1, back: !ch.up, side: side });
  });
  for (let i = slot.chs.length; i < max; i++) {
    stack += `<div class="emptyslot" style="z-index:${i + 1}">空</div>`;
  }
  const unit = pcHTML(c, { z: 40, sel: side === 'm' && slot.cid === 40 });
  const st = `<div class="chstack ${side === 'e' ? 'rev' : ''}">${stack}</div>`;
  return `<div class="lane ${cls}">${tag}${side === 'e' ? st + unit : unit + st}</div>`;
}

function renderBoard() {
  /* 並び順は 相手1,2,3 → 行番号1,2,3 → 自分1,2,3。
     配置はCSS側で指定するので、横向き・縦向きのどちらでもこの順で構いません。 */
  let h = '';
  for (let i = 0; i < 3; i++) h += laneHTML(SAMPLE.enemy[i], 'e', i);
  for (let i = 0; i < 3; i++) h += `<div class="lane-no"><span>${'１２３'[i]}</span></div>`;
  for (let i = 0; i < 3; i++) h += laneHTML(SAMPLE.mine[i], 'm', i);
  document.getElementById('board').innerHTML = h;
}
renderBoard();

document.getElementById('hand').innerHTML =
  HAND.map((id, i) => pcHTML(CARD_BY_ID[id], { sel: i === 0, z: 1 })).join('');

/* 手札：選択中をもう一度押したら解除。それ以外はカード詳細を出す */
document.getElementById('hand').addEventListener('click', (ev) => {
  const b = ev.target.closest('.pc');
  if (!b) return;
  const was = b.classList.contains('sel');
  document.querySelectorAll('.hand .pc.sel').forEach((x) => x.classList.remove('sel'));
  if (!was) b.classList.add('sel');
});

/* 場のカードを押したら詳細を出す */
document.getElementById('board').addEventListener('click', (ev) => {
  const b = ev.target.closest('.pc');
  if (!b) return;
  if (b.classList.contains('back')) return showPop(null);
  showPop(CARD_BY_ID[+b.dataset.card]);
});

function showPop(card) {
  const pop = document.getElementById('pop');
  const back = document.getElementById('pop-back');
  if (!card) {
    pop.innerHTML = `<div class="row">
      <div class="bigart" style="background:repeating-linear-gradient(135deg,#1a2540 0 9px,#141d33 9px 18px)">？</div>
      <div><h3>裏向きのカード</h3>
      <div class="txt">まだ開かれていないので、何のカードかは分かりません。</div></div></div>
      <button class="close" onclick="hidePop()">閉じる</button>`;
  } else {
    const kv = card.t === 'U'
      ? `<span>攻撃力 ${card.a}</span><span>防御力 ${card.d}</span>
         <span>ＣＨ ${card.ch}</span><span>召還Ｌｖ ${card.lv}</span>`
      : `<span>${TYPE_NAME[card.t]}</span>`;
    pop.innerHTML = `<div class="row">
        <div class="bigart ${card.t}">${artInner(card)}
          <span class="hint">assets/cards/${card.id}.png</span></div>
        <div style="min-width:0">
          <h3>${card.n}</h3>
          <div class="kv">${kv}</div>
          <div class="txt">${card.e || ''}</div>
        </div>
      </div>
      <button class="close" onclick="hidePop()">閉じる</button>`;
  }
  pop.classList.add('on'); back.classList.add('on');
}
function hidePop() {
  document.getElementById('pop').classList.remove('on');
  document.getElementById('pop-back').classList.remove('on');
}
document.getElementById('pop-back').addEventListener('click', hidePop);

/* ================= デッキ編集画面 ================= */
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

function renderTable() {
  const cs = cols();
  const head = cs.map((c) => {
    const arrow = sortKey === c.k ? `<span class="arrow">${sortAsc ? '▲' : '▼'}</span>` : '';
    const w = c.w ? ` style="width:${c.w}px"` : '';
    const sortable = c.type !== 'count';
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
    return `<th><button class="only-btn ${filters.only ? 'on' : ''}" id="only-btn">採用中のみ</button></th>`;
  }).join('');

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

  const body = rows.map((c) => {
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

  document.getElementById('tbl').innerHTML =
    `<thead><tr>${head}</tr><tr class="filters">${filterRow}</tr></thead><tbody>${body}</tbody>`;

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
  const g = grp();
  shown[g][b.dataset.col] = !shown[g][b.dataset.col];
  renderColbar(); renderTable();
});

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
    renderColbar(); renderTable(); renderDetail();
  });
});

renderColbar();
renderTable();
renderDetail();
