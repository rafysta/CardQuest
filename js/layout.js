/* CardQuest v0.3 — レイアウト確認用のモックアップ
 * ゲームロジックはまだ動きません。画面の配置・大きさ・操作感だけを確認します。
 */
'use strict';

const ART_DIR = 'assets/cards/';
const TYPE_MARK = { U: 'Ｕ', M: 'Ｍ', S: 'Ｓ' };
const TYPE_NAME = { U: 'モンスター', M: '魔法', S: '技能' };

/* 絵が用意できるまでの仮アイコン用。ヨルムンガンド → ヨル */
function abbrev(name, n) {
  const base = name.replace(/[『』「」\sの・]/g, '');
  let s = base.slice(0, n || 3);
  if (/[ッャュョゥィぁぃぅぇぉっゃゅょー]$/.test(s) && s.length > 1) s = base.slice(0, s.length + 1);
  return s;
}
/* assets/cards/<id>.png があればそれを、無ければ略称を出す */
function artInner(card, chars) {
  const a = abbrev(card.n, chars || 3);
  return `<img src="${ART_DIR}${card.id}.png" alt=""
     onerror="this.replaceWith(document.createTextNode('${a}'))">`;
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
const HAND = [5, 108, 165, 22, 135, 57, 183, 12];

/* --- 場のユニット（アイコンのみ。名前とＡ／Ｄを絵の中に重ねる） --- */
function unitHTML(card, sel) {
  return `<div class="card unit ${card.t} ${sel ? 'sel' : ''}" data-card="${card.id}">
    <div class="art">${artInner(card)}</div>
    <div class="topline"><span class="nm">${card.n}</span>
      <span class="tm">${TYPE_MARK[card.t]}</span></div>
    <div class="botline"><span class="ad">Ａ${card.a} Ｄ${card.d}</span></div>
  </div>`;
}

/* --- 手札（モンスターは名前＋Ａ／Ｄ、魔法と技能は名前のみ） --- */
function handHTML(card, sel) {
  const bot = card.t === 'U'
    ? `<div class="botline"><span class="ad">Ａ${card.a} Ｄ${card.d}</span></div>` : '';
  return `<div class="card hand-card ${card.t} ${sel ? 'sel' : ''}" data-card="${card.id}">
    <div class="art">${artInner(card)}</div>
    <div class="topline"><span class="nm">${card.n}</span>
      <span class="tm">${TYPE_MARK[card.t]}</span></div>
    ${bot}
  </div>`;
}

/* --- チャネリングカード。重なっても下端の帯（アイコン＋名前）が見える --- */
function chHTML(card, back) {
  if (back) {
    return `<div class="card ch back" data-card="${card.id}">
      <div class="art">？</div>
      <div class="strip"><span class="ico back">？</span><span class="nm">裏向き</span></div>
    </div>`;
  }
  return `<div class="card ch ${card.t}" data-card="${card.id}">
    <div class="art">${artInner(card)}</div>
    <div class="strip"><span class="ico ${card.t}">${abbrev(card.n, 2)}</span>
      <span class="nm">${card.n}</span></div>
  </div>`;
}

/* --- 1レーン：下にユニット、その上にチャネリングを積む --- */
function laneHTML(slot, side, i) {
  if (!slot) {
    return `<div class="lane" data-lane="${side}${i}">
      <div class="stack"></div>
      <div class="card empty-unit">ユニットなし</div></div>`;
  }
  const c = CARD_BY_ID[slot.cid];
  const max = c.ch || 6;
  const used = slot.chs.slice(0, max);
  /* .stack は column-reverse。DOMの先頭が画面のいちばん下（＝ユニットのすぐ上）。
     ＣＨ１→ＣＨn の順に置き、余った容量は空き枠で上に足す。 */
  let st = '';
  used.forEach((ch) => { st += chHTML(CARD_BY_ID[ch.cid], !ch.up); });
  for (let k = used.length; k < max; k++) st += `<div class="card slot"></div>`;
  return `<div class="lane" data-lane="${side}${i}">
    <div class="stack">${st}</div>
    ${unitHTML(c, side === 'm' && slot.cid === 40)}
  </div>`;
}

function renderBoard() {
  const e = SAMPLE.enemy.map((s, i) => laneHTML(s, 'e', i)).join('');
  const m = SAMPLE.mine.map((s, i) => laneHTML(s, 'm', i)).join('');
  const nums = '<div class="lanenums"><span>１</span><span>２</span><span>３</span></div>';
  document.getElementById('board').innerHTML = `
    <div class="bhalf enemy" id="half-e">
      <div class="lanes">${e}</div>${nums}
      <div class="info" id="info-e"></div>
    </div>
    <div class="bhalf mine" id="half-m">
      <div class="lanes">${m}</div>${nums}
      <div class="info" id="info-m"></div>
    </div>`;
}
renderBoard();

document.getElementById('hand').innerHTML =
  HAND.map((id, i) => handHTML(CARD_BY_ID[id], i === 0)).join('');

/* --- 選択：もう一度押すと解除 --- */
document.getElementById('hand').addEventListener('click', (ev) => {
  const b = ev.target.closest('.card');
  if (!b || longPressFired) return;
  const was = b.classList.contains('sel');
  document.querySelectorAll('.hand .card.sel').forEach((x) => x.classList.remove('sel'));
  if (!was) b.classList.add('sel');
});

/* ================= 長押しでカードの詳細 ================= */
const HOLD_MS = 380;
let holdTimer = null, longPressFired = false;

function infoHTML(card, back) {
  if (back) {
    return `<div class="info-inner">
      <div class="info-art back">？</div>
      <div class="info-body"><h3>裏向きのカード</h3>
        <p class="t">まだ開かれていないので、何のカードかは分かりません。</p></div></div>`;
  }
  const kv = card.t === 'U'
    ? `<span>攻撃力 ${card.a}</span><span>防御力 ${card.d}</span>
       <span>ＣＨ ${card.ch}</span><span>召還Ｌｖ ${card.lv}</span><span>${card.p} G</span>`
    : `<span>${TYPE_NAME[card.t]}</span><span>${card.p} G</span>`;
  return `<div class="info-inner">
    <div class="info-art ${card.t}">${artInner(card)}</div>
    <div class="info-body">
      <div class="tag">${TYPE_NAME[card.t]}</div>
      <h3>${card.n}</h3>
      <div class="kv">${kv}</div>
      <p class="t">${card.e || '（特殊能力なし）'}</p>
    </div></div>`;
}

function showInfo(el) {
  const card = CARD_BY_ID[+el.dataset.card];
  const back = el.classList.contains('back');
  const fixed = document.getElementById('app').classList.contains('info-fixed');
  if (fixed) {
    const p = document.getElementById('info-fix');
    p.innerHTML = infoHTML(card, back);
    p.classList.add('on');
    return;
  }
  /* 押した指と重ならないよう、反対側の場に出す */
  let target;
  if (el.closest('#half-e')) target = 'info-m';
  else if (el.closest('#half-m')) target = 'info-e';
  else target = (el.getBoundingClientRect().left + el.offsetWidth / 2) > window.innerWidth / 2
    ? 'info-e' : 'info-m';
  const p = document.getElementById(target);
  p.innerHTML = infoHTML(card, back);
  p.classList.add('on');
}
function hideInfo() {
  document.querySelectorAll('.info.on, #info-fix.on').forEach((x) => x.classList.remove('on'));
}

document.addEventListener('pointerdown', (ev) => {
  const el = ev.target.closest('.card');
  longPressFired = false;
  if (!el || el.classList.contains('slot') || el.classList.contains('empty-unit')) return;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => { longPressFired = true; showInfo(el); }, HOLD_MS);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((t) =>
  document.addEventListener(t, () => { clearTimeout(holdTimer); hideInfo(); }));
document.addEventListener('contextmenu', (ev) => { if (ev.target.closest('.card')) ev.preventDefault(); });

/* 情報の出し方の切り替え（長押し ／ 右端に常時表示） */
document.getElementById('mode-toggle').addEventListener('click', (ev) => {
  const app = document.getElementById('app');
  app.classList.toggle('info-fixed');
  ev.currentTarget.textContent = app.classList.contains('info-fixed')
    ? '情報：右端に常時' : '情報：長押し';
  hideInfo();
  if (app.classList.contains('info-fixed')) {
    const p = document.getElementById('info-fix');
    p.innerHTML = infoHTML(CARD_BY_ID[10], false);
    p.classList.add('on');
  }
});

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
let composing = false;                     /* 日本語入力の変換中はしぼり込みを止める */
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

/* 見出しと入力欄。並べ替え・列の変更のときだけ作り直す（入力中は触らない） */
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

/* 入力欄は作り直さないので、日本語入力（IME）が壊れない。
   変換の途中では絞り込みを走らせず、確定してから反映する。 */
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

renderColbar();
renderHead();
renderBody();
renderDetail();
