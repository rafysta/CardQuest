/* CardQuest — バトル画面（エンジン駆動 / v0.11.1）
 *
 * 画面はエンジン（js/engine/）の match オブジェクト M ひとつだけを見て描く。
 * 画面側に「盤面の状態」は持たない。操作は必ずエンジンのAPIを通し、
 * 返ってきた reason をそのまま理由表示に使う。
 *
 *   左＝相手の場（レーン3〜5） / 右＝自分の場（レーン0〜2）
 *   相手の手番は「自動（js/engine/ai.js のランダム方策。M5で本物のＡＩに差し替え）」か
 *   「手動（同じ端末で交互に操作）」を選べる。
 */
'use strict';

const ART_DIR = 'assets/cards/';
const TYPE_MARK = { U: 'Ｕ', M: 'Ｍ', S: 'Ｓ', C: 'Ｃ' };
const TYPE_NAME = { U: 'モンスター', M: '魔法', S: '技能', C: 'カース' };
const LAYERS = 6;                    /* チャネリングの最大階層 */

function abbrev(name, n) {
  const base = name.replace(/[『』「」\sの・]/g, '');
  let s = base.slice(0, n || 3);
  if (/[ッャュョゥィぁぃぅぇぉっゃゅょー]$/.test(s) && s.length > 1) s = base.slice(0, s.length + 1);
  return s;
}
function artInner(card, chars) {
  const a = abbrev(card.n, chars || 3);
  /* draggable="false" は必須。付けないと、絵のあるカードをドラッグしたときに
     ブラウザ標準の画像ドラッグが始まってしまい、こちらのポインタ操作が途切れる */
  return `<img src="${ART_DIR}${card.id}.png" alt="" draggable="false"
     onerror="this.replaceWith(document.createTextNode('${a}'))">`;
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
    document.querySelectorAll('.screen').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    document.getElementById(b.dataset.screen).classList.add('on');
    if (b.dataset.screen === 'screen-battle') fitBoard();
  });
});

/* ================= 対戦の状態 ================= */

/* 見本デッキ（50枚）。M7でデッキ編集画面と繋ぐまでは両陣営ともこれを使う。
 * 能力値に効く技能と、フラグ型の魔法（爆殺・障壁・遮蔽・偽装・鏡身）を中心にしつつ、
 * v0.12（実装計画M4）で発動処理を追加した 167/169/181/184/186/199、
 * v0.13で発動処理を追加した魔法カードの一部も混ぜてある。 */
const SAMPLE_DECK = [
  /* ユニット25枚（10 ヨルムンガンドと17 アバドーンは召還Ｌｖが高いので、
     チャネルして上の階層で開く＝リバース召還でしか出せない。ただし場に199光臨があれば
     手札から直接も出せる） */
  8, 8, 1, 1, 2, 5, 7, 7, 19, 20, 22, 26, 28, 46, 47, 58, 61, 63, 65, 66, 67, 71, 73, 10, 17,
  /* 技能16枚 */
  151, 152, 157, 158, 165, 167, 169, 171, 172, 173, 177, 178, 179, 181, 183, 199,
  /* 魔法9枚（v0.13で発動処理を実装。101憑依解除・110閉門・113透視・130漂着は瞬間発動、
     104/117/136/143/145はフラグ型で継続効果） */
  101, 104, 110, 113, 117, 130, 136, 143, 145
];

let M = null;                 /* エンジンの対戦状態。これが唯一の真実 */
let foeAuto = true;           /* 相手を自動で動かすか */
const UI = {
  mode: 'idle',   /* idle | info | confirm | unit | attack | reverse | battle | over */
  info: null,     /* 表示中のカード */
  lane: null,     /* 選択中のレーン（アタック元・リバース対象） */
  layers: [],     /* リバースで選んだ階層 */
  chip: null,     /* オープンフェイズで選んでいる階層 */
  pending: null,  /* 確認待ちの操作 */
  report: null    /* 直前に起きたこと（相手の手番・戦闘の経過） */
};

function otherSide(s) { return s === 'self' ? 'enemy' : 'self'; }
function jpSide(s) { return s === 'self' ? 'あなた' : '相手'; }
/** その側を機械が動かすか */
function isAuto(side) { return side === 'enemy' && foeAuto; }
/** いま人が操作すべき側（誰も操作待ちでなければ null） */
function humanSide() {
  if (!M || M.winner) return null;
  if (M.combat) {
    const s = CQCombat.openerSide(M);
    return isAuto(s) ? null : s;
  }
  return isAuto(M.active) ? null : M.active;
}
/** 手札を下段に出す側 */
function handSide() { return humanSide() || 'self'; }
function laneSide(i) { return i < 3 ? 'self' : 'enemy'; }
/** そのレーンのユニットの持ち主（傀儡で反転していることがある） */
function unitOwner(i) {
  const ln = M.board.lanes[i];
  return ln.flipped ? otherSide(laneSide(i)) : laneSide(i);
}
/** 中身が見えるか（表・公開済み・自分が置いたカード） */
function chKnown(ch) {
  const v = handSide();
  return ch.up || ch.revealed || (ch.mine === (v === 'self'));
}

function newMatch() {
  const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
  M = CQTurn.createMatch({
    cards: CARD_BY_ID,
    rng: CQRng.create(seed),
    selfDeck: SAMPLE_DECK.slice(),
    enemyDeck: SAMPLE_DECK.slice(),
    first: 'self',
    opponentId: 101,                /* フリーユニット戦扱い＝戦利品が記録される */
    hooks: { onMagicOpen: CQMagic.onMagicOpen }   /* M4 v0.13：魔法48種の発動処理 */
  });
  UI.mode = 'idle'; UI.info = null; UI.lane = null; UI.layers = [];
  UI.chip = null; UI.pending = null; UI.report = null;
  step();
}

/** 操作を始める前にログの位置を覚えておく（そのあと起きたことを右パネルに出すため） */
let logMark = null;
function markLog() { if (logMark === null) logMark = M.log.length; }

/** 人の入力が要るところまで進める。UIの操作は必ず最後にこれを呼ぶ */
function step() {
  const mark = logMark === null ? M.log.length : logMark;
  logMark = null;
  let guard = 0;
  while (M && !M.winner && guard++ < 500) {
    if (M.combat) {                                   /* 戦闘中のオープンフェイズ */
      if (!isAuto(CQCombat.openerSide(M))) break;
      CQAi.openStep(M);
      continue;
    }
    if (isAuto(M.active)) {                           /* 相手の手番（自動） */
      if (M.phase === 'draw') { CQTurn.beginTurn(M); continue; }
      if (M.phase === 'discard') { CQAi.discardStep(M); continue; }
      if (M.phase === 'placement') { CQAi.playPlacement(M); CQTurn.endPlacement(M); continue; }
      if (M.phase === 'main') { if (CQAi.mainStep(M)) continue; CQTurn.endTurn(M); continue; }
      break;
    }
    if (M.phase === 'draw') { CQTurn.beginTurn(M); continue; }   /* 人の手番：ドローは自動 */
    break;
  }
  const lines = M.log.slice(mark);
  if (lines.length) UI.report = lines;
  if (M.winner) UI.mode = 'over';
  else if (M.combat && !isAuto(CQCombat.openerSide(M))) {
    if (UI.mode !== 'battle') { UI.mode = 'battle'; UI.chip = null; }
  } else if (UI.mode === 'battle' || UI.mode === 'over') UI.mode = 'idle';
  renderAll();
}

/* ================= 描画 ================= */

function renderAll() { renderStatus(); renderBoard(); renderHand(); renderPanel(); }

function renderStatus() {
  const me = M.players.self, foe = M.players.enemy;
  const top = handSide() === 'self' ? foe : me;          /* 上段は「いま操作していない側」 */
  document.getElementById('foe-name').textContent = handSide() === 'self' ? '相手' : 'あなた';
  document.getElementById('foe-lp').textContent = '♥ ' + Math.max(0, (handSide() === 'self' ? foe : me).lp);
  document.getElementById('foe-deck').textContent = top.deckCount;
  document.getElementById('my-lp').textContent = '♥ ' + Math.max(0, (handSide() === 'self' ? me : foe).lp);
  document.getElementById('my-deck').textContent = (handSide() === 'self' ? me : foe).deckCount;
  document.getElementById('my-name').textContent = handSide() === 'self' ? 'あなた' : '相手';

  let h = '';
  for (let i = 0; i < top.hand.length; i++) h += `<span class="mini" style="z-index:${20 - i}"></span>`;
  document.getElementById('ehand').innerHTML = h + `<b>${top.hand.length}</b>`;

  document.getElementById('turnbox').innerHTML =
    `<span class="tn">第 ${M.turn} ターン</span>
     <span class="tw">${phaseLabel()}</span>
     <button class="tiny" data-act="mode">相手：${foeAuto ? '自動' : '手動'}</button>
     <button class="tiny" data-act="new">新しい対戦</button>`;
}

function phaseLabel() {
  if (M.winner) return M.winner === 'self' ? 'あなたの勝ち' : 'あなたの負け';
  if (M.combat) {
    const s = CQCombat.openerSide(M);
    const role = M.combat.opener === 'attacker' ? '攻撃側オープン' : '防御側オープン';
    return `${jpSide(s)}：${role}`;
  }
  const who = jpSide(M.active);
  if (M.phase === 'discard') return `${who}：手札を捨てる`;
  if (M.phase === 'placement') return `${who}：配置ステップ`;
  if (M.phase === 'main') return `${who}：メインステップ`;
  return `${who}の手番`;
}

/* --- 場のユニット --- */
function unitHTML(i) {
  const ln = M.board.lanes[i];
  const card = CARD_BY_ID[ln.unit];
  const own = unitOwner(i) === 'self';
  const pup = unitOwner(i) !== laneSide(i);
  const cls = (v, base) => (v !== base ? (v > base ? ' up' : ' dn') : '');
  const tags = [];
  if (ln.stiff && !ln.extraAttack) tags.push('<div class="st-tag">行動済</div>');
  if (ln.extraAttack) tags.push('<div class="st-tag go">連続</div>');
  return `<div class="card unit ${card.t} ${own ? 'own' : 'foe'} ${pup ? 'pup' : ''}"
      data-lane="${i}" data-card="${card.id}" data-own="${own ? 1 : 0}" data-pup="${pup ? 1 : 0}">
    <div class="art">${artInner(card)}</div>
    ${pup ? '<div class="pup-tag">傀儡</div>' : ''}${tags.join('')}
    <div class="topline"><span class="nm">${card.n}</span>
      <span class="ow">${own ? '自' : '敵'}</span></div>
    <div class="botline"><span class="ad">Ａ<b class="v${cls(ln.atk, card.a)}">${ln.atk}</b>
      Ｄ<b class="v${cls(ln.def, card.d)}">${ln.def}</b></span></div>
  </div>`;
}

/* --- チャネリングカード（ユニットの下に潜り込む） --- */
function chHTML(i, k) {
  const ch = M.board.lanes[i].channels[k - 1];
  const card = CARD_BY_ID[ch.card];
  const known = chKnown(ch);
  const own = !!ch.mine;
  const bottom = `style="bottom:calc(${k} * var(--vstep));z-index:${100 - k}"`;
  const oc = own ? 'own' : 'foe';
  const pos = ch.st === 'possess';
  const badge = `${pos ? '<span class="ow ps">憑</span>' : ''}<span class="ow">${own ? '自' : '敵'}</span>`;
  const open = UI.mode === 'battle' && CQCombat.openerLane(M) === i
    && CQCombat.openableLayers(M).indexOf(k) >= 0;
  const attr = `data-lane="${i}" data-layer="${k}" data-card="${card.id}"
    data-own="${own ? 1 : 0}" data-known="${known ? 1 : 0}" data-st="${ch.st || ''}"`;
  const mark = open ? '<span class="cur">▶</span>' : '';
  if (!ch.up) {
    const nm = known ? `<span class="nm">${card.n}</span>` : '<span class="nm hid">？</span>';
    return `<div class="card ch back ${oc} ${open ? 'openable' : ''}" ${attr} ${bottom}>
      <div class="strip">${mark}${nm}${badge}</div></div>`;
  }
  return `<div class="card ch ${card.t} ${oc} ${pos ? 'possess' : ''}" ${attr} ${bottom}>
    <div class="strip">${mark}<span class="nm">${card.n}</span>${badge}</div>
    <div class="art">${artInner(card)}</div></div>`;
}

/* --- 1レーン --- */
function laneHTML(i) {
  const ln = M.board.lanes[i];
  const cls = [];
  if (UI.lane === i) cls.push('sel');
  if (UI.mode === 'attack' && UI.targets && UI.targets.indexOf(i) >= 0) cls.push('target');
  if (M.combat && (M.combat.attacker === i || M.combat.defender === i)) cls.push('fighting');
  if (M.combat && CQCombat.openerLane(M) === i) cls.push('opening');
  let inner = '';
  if (ln.unit != null) {
    const max = Math.max(ln.cap, ln.channels.length);
    inner += `<div class="cap-box" style="height:calc(var(--chh) + ${max} * var(--vstep) + 8px)"></div>`;
    for (let k = 1; k <= Math.min(ln.channels.length, LAYERS); k++) inner += chHTML(i, k);
    inner += unitHTML(i);
  } else {
    inner = '<div class="card empty-unit" data-lane="' + i + '">空き</div>';
  }
  return `<div class="lane ${cls.join(' ')}" data-lane="${i}">${inner}</div>`;
}

function renderBoard() {
  let grid = '';
  for (let k = LAYERS; k >= 1; k--) grid += '<div class="gband"></div>';
  const e = [3, 4, 5].map(laneHTML).join('');
  const m = [0, 1, 2].map(laneHTML).join('');
  document.getElementById('board').innerHTML =
    `<div class="bhalf enemy" id="half-e"><div class="layer-grid">${grid}</div>
       <div class="lanes">${e}</div></div>
     <div class="bhalf mine" id="half-m"><div class="layer-grid">${grid}</div>
       <div class="lanes">${m}</div></div>`;
  fitBoard();
}

/* --- 場の高さを画面に合わせる（v0.6.0から変更なし） --- */
function fitBoard() {
  const half = document.querySelector('.bhalf');
  if (!half) return;
  const cs = getComputedStyle(half);
  const avail = half.clientHeight
    - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 8;
  if (!(avail > 0)) return;
  let chh = 126;
  let vstep = Math.floor((avail - chh) / LAYERS);
  if (vstep > 63) vstep = 63;
  if (vstep < 34) { vstep = 34; chh = Math.max(84, avail - LAYERS * vstep); }
  const root = document.documentElement.style;
  root.setProperty('--chh', chh + 'px');
  root.setProperty('--cw', chh + 'px');
  root.setProperty('--vstep', vstep + 'px');
}
window.addEventListener('resize', () => { fitBoard(); renderHand(); });

/* --- 手札 --- */
function handHTML(card, i) {
  const bot = card.t === 'U'
    ? `<div class="botline"><span class="ad">Ａ${card.a} Ｄ${card.d}</span></div>` : '';
  return `<div class="card hand-card ${card.t}" data-card="${card.id}" data-hand="${i}"
      style="z-index:${100 - i}">
    <div class="art">${artInner(card)}</div>
    <div class="topline"><span class="nm">${card.n}</span>
      <span class="tm">${TYPE_MARK[card.t]}</span></div>
    ${bot}
  </div>`;
}
function canChange() {
  return !!M && !M.winner && !M.combat && humanSide() === M.active
    && M.phase === 'placement' && M.players[M.active].turnsTaken === 1
    && !M.players[M.active].actedThisTurn && !M.players[M.active].hasChanged
    && M.players[M.active].lp > 1;
}
function renderHand() {
  const el = document.getElementById('hand');
  const hand = M.players[handSide()].hand;
  let h = hand.map((id, i) => handHTML(CARD_BY_ID[id], i)).join('');
  if (canChange()) {
    h += `<div class="card change-card" id="change-card">
      <div class="cc-i">🔁</div><div class="cc-n">チェンジ</div>
      <div class="cc-t">ＬＰ1で引き直す</div></div>`;
  }
  el.innerHTML = h;
  const CW = 126, RESERVE = canChange() ? 150 : 0;
  const W = (el.clientWidth || 900) - RESERVE, n = hand.length;
  const step2 = n > 1 ? Math.min(96, Math.floor((W - CW) / (n - 1))) : CW;
  el.style.setProperty('--hstep', Math.max(40, step2) + 'px');

  /* ステップを進めるボタン */
  const acts = document.getElementById('acts');
  let b = '';
  if (M.winner) b = '<button class="act-btn" data-act="new">もう一度<br>対戦する</button>';
  else if (M.combat) b = '';
  else if (humanSide() === M.active) {
    if (M.phase === 'placement') b = '<button class="act-btn" data-act="end-place">配置を<br>終える</button>';
    else if (M.phase === 'main') b = '<button class="act-btn" data-act="end-turn">ターンを<br>終了する</button>';
  }
  acts.innerHTML = b;
}

/* ================= 右の情報パネル ================= */

function paint(body, foot, btns) {
  document.getElementById('info-fix').innerHTML =
    `<div class="i-body">${body}</div>
     <div class="i-foot ${btns ? 'btns' : ''}">${foot || '<p class="i-hint">カードを押すと、その内容がここに出ます</p>'}</div>`;
}
const okBtn = (label) => `<button class="btn ok" data-act="ok">${label || 'ＯＫ'}</button>`;
const ngBtn = (label) => `<button class="btn ng" data-act="cancel">${label || 'キャンセル'}</button>`;

function ownTagHTML(own, unit) {
  const t = unit ? (own ? '自分のモンスター' : '相手のモンスター')
                 : (own ? '自分が置いたカード' : '相手が置いたカード');
  return `<span class="i-own ${own ? 'own' : 'foe'}">${t}</span>`;
}

function infoCardHTML(card, o) {
  const { back, own, unit, pup, st, lane } = o;
  if (back && !o.known) {
    return `<div class="i-art back">？</div>${ownTagHTML(false)}
      <h3>裏向きのカード</h3>
      <p class="i-t">相手が置いた裏向きのカードです。開くまで内容は分かりません。<br>
      開くこと自体は、チャネル先のユニットを操作している側ができます。</p>`;
  }
  const ln = lane != null ? M.board.lanes[lane] : null;
  const kv = card.t === 'U'
    ? `<span>攻撃力 ${card.a}</span><span>防御力 ${card.d}</span>
       <span>ＣＨ ${card.ch}</span><span>召還Ｌｖ ${card.lv}</span>`
    : `<span>${TYPE_NAME[card.t]}</span>`;
  const now = (unit && ln && ln.unit != null)
    ? `<div class="i-kv now"><span>いまの攻撃力 <b>${ln.atk}</b></span>
       <span>いまの防御力 <b>${ln.def}</b></span>
       <span>ＣＨ ${ln.count}／${ln.cap}</span>
       ${ln.stiff ? '<span class="warnkv">行動済み</span>' : ''}
       ${ln.extraAttack ? '<span class="okkv">連続攻撃の権利あり</span>' : ''}</div>` : '';
  let foot = '';
  if (back) foot = '<p class="i-t dim">※ いまは裏向きです。自分のカードなので内容が分かります（相手には見えません）。</p>';
  else if (st === 'possess') foot = '<p class="i-t pup">憑依：通常攻撃で倒されたユニットが、カースになって取り憑いています。クローズはできません。</p>';
  if (pup) {
    foot += own
      ? '<p class="i-t pup">傀儡：自分のモンスターですが、いまは<b>相手が操作しています</b>。</p>'
      : '<p class="i-t pup">傀儡：相手のモンスターですが、いまは<b>自分が操作できます</b>。</p>';
  }
  return `<div class="i-art ${card.t} ${back ? 'downed' : ''}">${artInner(card)}</div>
    <div class="i-tag">${TYPE_NAME[card.t]}</div>${own === undefined ? '' : ownTagHTML(own, unit)}
    <h3>${card.n}</h3>
    <div class="i-kv">${kv}</div>${now}
    <p class="i-t">${card.e || '（特殊能力なし）'}</p>${foot}`;
}

function miniCardHTML(card) {
  return `<div class="c-head">
    <div class="c-art ${card.t}">${artInner(card, 2)}</div>
    <div class="c-tx"><div class="c-nm">${card.n}</div>
      <div class="c-ef">${card.e || TYPE_NAME[card.t]}</div></div></div>`;
}
function askHTML(q, body, kind) {
  return `<div class="i-ask ${kind || ''}"><span class="q">${q}</span>${body}</div>`;
}
function reportHTML(lines) {
  return `<h3>ここまでの動き</h3>
    <ul class="rep">${lines.slice(-14).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
}

function renderPanel() {
  switch (UI.mode) {
    case 'over':      return panelOver();
    case 'battle':    return panelBattle();
    case 'unit':      return panelUnit();
    case 'attack':    return panelAttack();
    case 'reverse':   return panelReverse();
    case 'confirm':   return;                       /* 確認画面は出したまま */
    case 'info':      return panelInfo();
    default:          return panelIdle();
  }
}

function panelIdle() {
  if (M.phase === 'discard' && humanSide() === M.active) {
    return paint(askHTML('手札が上限を超えています',
      `手札は7枚までです。捨てるカードを1枚選んでください（下の手札を押します）。`, 'warn'));
  }
  if (UI.report) return paint(reportHTML(UI.report));
  paint('<div class="i-lead">カードを押すと内容が出ます。<br>手札は場までドラッグすると出せます。</div>'
    + (M.loot.length ? `<div class="i-loot">戦利品：${M.loot.map((id) => CARD_BY_ID[id].n).join('・')}</div>` : ''));
}

function panelInfo() {
  paint(infoCardHTML(CARD_BY_ID[UI.info.card], UI.info));
}

function panelOver() {
  const win = M.winner === 'self';
  const me = M.players.self, foe = M.players.enemy;
  const why = me.lost ? 'あなたの山札が尽きました'
    : foe.lost ? '相手の山札が尽きました'
    : (win ? '相手のＬＰが0になりました' : 'あなたのＬＰが0になりました');
  paint(`<div class="i-result ${win ? 'win' : 'lose'}">${win ? 'あなたの勝ち' : 'あなたの負け'}</div>
    <p class="i-t">${why}（第 ${M.turn} ターン）</p>
    ${M.loot.length ? `<div class="i-loot">戦利品：${M.loot.map((id) => CARD_BY_ID[id].n).join('・')}</div>` : ''}
    ${UI.report ? reportHTML(UI.report) : ''}`,
    `<button class="btn ok" data-act="new">もう一度</button>`, true);
}

/* --- メインステップ：ユニットを選んだときの行動メニュー --- */
function panelUnit() {
  const i = UI.lane, ln = M.board.lanes[i], card = CARD_BY_ID[ln.unit];
  const atk = CQCombat.canAttack(M, i);
  const targets = atk.ok ? CQCombat.attackTargets(M, i) : [];
  const deck = CQCombat.canDeckAttack(M, i);
  const rev = canReverse(i);
  let btns = '';
  if (targets.length) btns += `<button class="act-row" data-act="attack">アタック<span class="sub">${targets.length}体を狙えます</span></button>`;
  else if (atk.ok) btns += `<div class="act-row off">アタック：狙える相手が居ません</div>`;
  else btns += `<div class="act-row off">アタック：${atk.reason}</div>`;
  if (deck.ok) btns += `<button class="act-row" data-act="deck-attack">デッキ攻撃<span class="sub">相手のＬＰ −1 と山札1枚を破壊</span></button>`;
  if (rev.ok) btns += `<button class="act-row" data-act="reverse">リバース<span class="sub">チャネルを開け閉めする</span></button>`;
  else btns += `<div class="act-row off">リバース：${rev.reason}</div>`;
  return paint(miniCardHTML(card)
    + `<div class="i-kv now"><span>攻撃力 <b>${ln.atk}</b></span><span>防御力 <b>${ln.def}</b></span>
       <span>ＣＨ ${ln.count}／${ln.cap}</span></div>`
    + `<div class="acts-list">${btns}</div>`,
    ngBtn('やめる'), true);
}

function canReverse(i) {
  const ln = M.board.lanes[i];
  if (ln.stiff) return { ok: false, reason: 'そのユニットは行動済みです' };
  if (!ln.channels.length) return { ok: false, reason: 'チャネルがありません' };
  if (ln.acc && ln.acc.lock >= 1) return { ok: false, reason: '固定・石化で開閉できません' };
  if (!allowedLayers(i).length) return { ok: false, reason: 'このターンはもう開閉できません' };
  return { ok: true };
}
/** リバースできる階層（下から上への一方通行。クローズは技能カードだけ） */
function allowedLayers(i) {
  const ln = M.board.lanes[i], res = [];
  for (let k = ln.reversePtr + 1; k <= ln.channels.length; k++) {
    const ch = ln.channels[k - 1];
    if (ch.up && ch.card < 151) continue;                       /* クローズ不可 */
    if (ch.up && ch.card === 167 && (!ln.acc || ln.acc.seal === 0)) continue;
    res.push(k);
  }
  return res;
}

function panelAttack() {
  const i = UI.lane, ln = M.board.lanes[i];
  return paint(miniCardHTML(CARD_BY_ID[ln.unit])
    + askHTML('攻撃する相手を選んでください',
      `黄色い枠の付いた相手のモンスターを押します。<br>
       あなたの攻撃力 <b>${ln.atk}</b> が相手の防御力以上なら成功です（同値も成功）。`, 'warn'),
    ngBtn('やめる'), true);
}

function panelReverse() {
  const i = UI.lane, ln = M.board.lanes[i];
  const allow = allowedLayers(i);
  let chips = '<div class="lay-row">';
  for (let k = 1; k <= ln.channels.length; k++) {
    const ch = ln.channels[k - 1];
    const on = UI.layers.indexOf(k) >= 0;
    const ok = allow.indexOf(k) >= 0;
    chips += `<button class="lay-chip ${on ? 'on' : ''} ${ok ? '' : 'off'}"
       ${ok ? `data-act="layer" data-layer="${k}"` : 'disabled'}>${k}</button>`;
  }
  chips += '</div>';
  const list = ln.channels.map((ch, k) => {
    const nm = chKnown(ch) ? CARD_BY_ID[ch.card].n : '？（相手が置いた裏向き）';
    const mk = UI.layers.indexOf(k + 1) >= 0 ? (ch.up ? '→ 閉じる' : '→ 開く') : '';
    return `<li class="${UI.layers.indexOf(k + 1) >= 0 ? 'on' : ''}">
      <b>${k + 1}</b> ${nm}<span class="fu">${ch.up ? '表' : '裏'}</span>
      <span class="mk">${mk}</span></li>`;
  }).join('');
  return paint(miniCardHTML(CARD_BY_ID[ln.unit])
    + askHTML('開閉する階層を選んでください',
      `下から上への一方通行です（飛ばすのは可・戻るのは不可）。<br>
       クローズできるのは技能カードだけです。` + chips + `<ul class="ch-list">${list}</ul>`, 'warn'),
    (UI.layers.length ? okBtn('リバースする') : '') + ngBtn('やめる'), true);
}

/* --- 戦闘：オープンフェイズ --- */
function panelBattle() {
  const c = M.combat;
  const i = CQCombat.openerLane(M);
  const ln = M.board.lanes[i];
  const A = M.board.lanes[c.attacker], D = M.board.lanes[c.defender];
  const role = c.opener === 'attacker' ? '攻撃側' : '防御側';
  const layers = CQCombat.openableLayers(M);
  const head = `<div class="vs">
      <span class="vs-a">攻 ${CARD_BY_ID[A.unit] ? CARD_BY_ID[A.unit].n : '—'} <b>${A.atk}</b></span>
      <span class="vs-x">▶</span>
      <span class="vs-d">防 ${CARD_BY_ID[D.unit] ? CARD_BY_ID[D.unit].n : '—'} <b>${D.def}</b></span>
    </div>`;
  let chips = '<div class="lay-row">';
  for (let k = 1; k <= ln.channels.length; k++) {
    const ok = layers.indexOf(k) >= 0;
    chips += `<button class="lay-chip ${UI.chip === k ? 'on' : ''} ${ok ? '' : 'off'}"
      ${ok ? `data-act="chip" data-layer="${k}"` : 'disabled'}>${k}</button>`;
  }
  chips += '</div>';
  let detail = '<p class="i-t dim">開く階層を選んでください。クローズはできません。下から上への一方通行です。</p>';
  let ok = '';
  if (UI.chip) {
    const ch = ln.channels[UI.chip - 1];
    const known = chKnown(ch);
    detail = known
      ? miniCardHTML(CARD_BY_ID[ch.card])
      : `<p class="i-t">${UI.chip} 階層目：相手が置いた裏向きのカードです。開くまで内容は分かりません。</p>`;
    ok = `<button class="btn ok" data-act="open">${UI.chip} 階層目を開く</button>`;
  }
  return paint(head + askHTML(`${jpSide(CQCombat.openerSide(M))}の${role}オープンフェイズ`,
    `${chips}${detail}`, 'warn') + (UI.report ? reportHTML(UI.report) : ''),
    ok + `<button class="btn ng" data-act="open-end">開かずに終える</button>`, true);
}

/* ================= 確認 ================= */

function paintNG(card, ng) {
  UI.mode = 'confirm'; UI.pending = null;
  paint(miniCardHTML(card) + askHTML('この場所には置けません', ng, 'ng'),
    ngBtn('閉じる'), true);
}
function paintConfirm(card, what, extra, warn) {
  UI.mode = 'confirm';
  paint(miniCardHTML(card) + askHTML('この操作でよろしいですか？', what + (extra || ''), warn ? 'warn' : ''),
    okBtn() + ngBtn(), true);
}

/** 手札のカードをレーンに落としたとき */
function showDropConfirm(handIdx, laneIdx) {
  const side = M.active;
  const card = CARD_BY_ID[M.players[side].hand[handIdx]];
  const ln = M.board.lanes[laneIdx];
  const mine = S_lanesOf(side).indexOf(laneIdx) >= 0;

  if (ln.unit == null) {
    if (!mine) return paintNG(card, 'モンスターを相手の場に直接召還することはできません。相手の場に関われるのは、相手のユニットへのチャネルだけです。');
    if (card.t !== 'U') return paintNG(card, 'ここは空き枠です。魔法と技能はモンスターの上にしか置けません。');
    if (M.phase !== 'placement') return paintNG(card, '召還できるのは配置ステップだけです。');
    if (CQState.unitStats(card).lv > 1) return paintNG(card, `召還Ｌｖ${card.lv}のモンスターは手札から直接は出せません。ユニットにチャネルして、${card.lv}階層目以上で開くと出てきます（リバース召還）。`);
    UI.pending = { kind: 'summon', handIdx, lane: laneIdx };
    return paintConfirm(card, `<b>${laneIdx + 1}番目の枠</b> に召還します<span class="i-note">※ 召還したターンは行動できません（硬直）</span>`);
  }

  const host = CARD_BY_ID[ln.unit];
  const where = `${mine ? '自分の場' : '相手の場'}の <b>${host.n}</b>`;
  if (M.phase === 'main' && ln.stiff) return paintNG(card, 'そのモンスターはこのターンもう行動済みです。');
  if (M.phase !== 'placement' && M.phase !== 'main') return paintNG(card, 'いまはチャネルできません。');
  const note = card.t === 'U'
    ? `<span class="i-note">※ 表になると、置いた人の場の空きレーンへ召還されます（召還Ｌｖ${card.lv}以上の階層が必要。空き無しなら破壊）</span>`
    : '';
  if (ln.count < ln.cap) {
    const k = ln.count + 1;
    UI.pending = { kind: 'channel', handIdx, lane: laneIdx };
    return paintConfirm(card, `${where} の ${k} 階層目に裏向きでチャネルします${note}`);
  }
  if (!ln.channels.length) {
    return paintNG(card, `${host.n} はチャネルできる枠がありません（ＣＨ数 ${ln.cap}）。`);
  }
  if (M.phase !== 'placement') return paintNG(card, 'チャネルが一杯です。押し込みができるのは配置ステップだけです。');
  UI.pending = { kind: 'push', handIdx, lane: laneIdx, layer: 1 };
  paintConfirm(card, `${where} は一杯です。押し込む階層を選んでください。`,
    layerPickHTML(laneIdx, 1) + note, true);
}
function S_lanesOf(side) { return CQState.lanesOf(side); }

function layerName(laneIdx, k) {
  const ch = M.board.lanes[laneIdx].channels[k - 1];
  if (!chKnown(ch)) return '<span class="lc back">相手が置いた裏向きのカード</span>';
  return `<span class="lc">${ch.mine ? '自分の' : '相手の'}『${CARD_BY_ID[ch.card].n}』${ch.up ? '' : '（裏）'}</span>`;
}
function layerPickHTML(laneIdx, sel) {
  const n = M.board.lanes[laneIdx].channels.length;
  let h = '<div class="lay-row">';
  for (let k = 1; k <= n; k++) {
    h += `<button class="lay-chip ${k === sel ? 'on' : ''}" data-act="push-layer" data-layer="${k}">${k}</button>`;
  }
  return h + `</div><div class="lay-now" id="lay-now">
    <b>${sel}</b> 階層目の ${layerName(laneIdx, sel)} を捨てて入れ替えます</div>`;
}

function showChangeConfirm() {
  UI.pending = { kind: 'change' };
  UI.mode = 'confirm';
  const n = M.players[M.active].hand.length;
  paint(`<div class="c-head"><div class="c-art CHG">🔁</div>
      <div class="c-tx"><div class="c-nm">チェンジ</div>
      <div class="c-ef">手札をすべて捨てて、同じ枚数を引き直す</div></div></div>`
    + askHTML('この操作でよろしいですか？',
      `いまの手札 <b>${n} 枚</b> をすべて捨てて引き直します。ＬＰを1点払います。<br>元には戻せません。`, 'warn'),
    okBtn() + ngBtn(), true);
}

function showDiscardConfirm(handIdx) {
  const card = CARD_BY_ID[M.players[M.active].hand[handIdx]];
  UI.pending = { kind: 'discard', handIdx };
  UI.mode = 'confirm';
  paint(miniCardHTML(card) + askHTML('このカードを捨てますか？',
    '手札は7枚までです。捨てたカードは戻りません。', 'warn'), okBtn('捨てる') + ngBtn(), true);
}

function showAttackConfirm(defLane) {
  const A = M.board.lanes[UI.lane], D = M.board.lanes[defLane];
  UI.pending = { kind: 'attack', lane: UI.lane, target: defLane };
  UI.mode = 'confirm';
  const win = A.atk >= D.def;
  paint(`<div class="vs">
      <span class="vs-a">攻 ${CARD_BY_ID[A.unit].n} <b>${A.atk}</b></span>
      <span class="vs-x">▶</span>
      <span class="vs-d">防 ${CARD_BY_ID[D.unit].n} <b>${D.def}</b></span>
    </div>`
    + askHTML('この相手に攻撃しますか？',
      `いまの数値なら <b>${win ? '成功' : '失敗'}</b> です。<br>
       ただしこのあと、攻撃側→防御側の順にチャネルを開けるので数値は変わります。
       <span class="i-note">※ 攻撃したユニットはこのターン行動済みになります</span>`, 'warn'),
    okBtn('攻撃する') + ngBtn(), true);
}

/* ================= 操作の実行 ================= */

function doPending() {
  markLog();
  const p = UI.pending;
  UI.pending = null;
  if (!p) return;
  let r = { ok: true };
  if (p.kind === 'summon') r = CQTurn.summon(M, p.lane, p.handIdx);
  else if (p.kind === 'channel') r = CQTurn.channel(M, p.lane, p.handIdx);
  else if (p.kind === 'push') r = CQTurn.channel(M, p.lane, p.handIdx, { layer: p.layer });
  else if (p.kind === 'change') r = CQTurn.change(M);
  else if (p.kind === 'discard') r = CQTurn.discardCard(M, p.handIdx);
  else if (p.kind === 'reverse') r = CQTurn.reverseAction(M, p.lane, p.layers);
  else if (p.kind === 'attack') r = CQCombat.declareAttack(M, p.lane, p.target);
  else if (p.kind === 'deck-attack') r = CQCombat.deckAttack(M, p.lane);
  UI.mode = 'idle'; UI.lane = null; UI.layers = []; UI.report = null;
  if (!r.ok) { flash(r.reason || 'その操作はできません'); renderAll(); return; }
  step();
}

function panelAct(act, data) {
  switch (act) {
    case 'ok': return doPending();
    case 'cancel':
      UI.pending = null; UI.mode = 'idle'; UI.lane = null; UI.layers = []; UI.chip = null;
      return renderAll();
    case 'new': return newMatch();
    case 'mode':
      foeAuto = !foeAuto;
      flash(foeAuto ? '相手を自動で動かします' : '相手もあなたが操作します');
      return step();
    case 'attack':
      UI.mode = 'attack'; UI.targets = CQCombat.attackTargets(M, UI.lane);
      return renderAll();
    case 'deck-attack':
      UI.pending = { kind: 'deck-attack', lane: UI.lane };
      return doPending();
    case 'reverse':
      UI.mode = 'reverse'; UI.layers = [];
      return renderAll();
    case 'layer': {
      const k = +data.layer;
      const at = UI.layers.indexOf(k);
      if (at >= 0) UI.layers.splice(at, 1); else UI.layers.push(k);
      UI.layers.sort((a, b) => a - b);
      return renderPanel();
    }
    case 'push-layer': {
      if (!UI.pending) return;
      UI.pending.layer = +data.layer;
      const el = document.getElementById('info-fix');
      el.querySelectorAll('.lay-chip').forEach((x) => x.classList.remove('on'));
      el.querySelector(`.lay-chip[data-layer="${data.layer}"]`).classList.add('on');
      document.getElementById('lay-now').innerHTML =
        `<b>${UI.pending.layer}</b> 階層目の ${layerName(UI.pending.lane, UI.pending.layer)} を捨てて入れ替えます`;
      return;
    }
    case 'chip': UI.chip = +data.layer; return renderPanel();
    case 'open': {
      markLog();
      const r = CQCombat.open(M, UI.chip);
      UI.chip = null;
      if (!r.ok) flash(r.reason);
      return step();
    }
    case 'open-end':
      markLog();
      UI.chip = null;
      CQCombat.endOpen(M);
      return step();
    case 'end-place':
      markLog();
      CQTurn.endPlacement(M); UI.report = null;
      return step();
    case 'end-turn':
      markLog();
      CQTurn.endTurn(M); UI.report = null;
      return step();
    default:
  }
}

/* リバース確定は ok ボタン経由。層が選ばれた状態で押されたときだけ実行する */
function commitReverse() {
  UI.pending = { kind: 'reverse', lane: UI.lane, layers: UI.layers.slice() };
  doPending();
}

document.getElementById('info-fix').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b || b.disabled) return;
  if (b.dataset.act === 'ok' && UI.mode === 'reverse') return commitReverse();
  panelAct(b.dataset.act, b.dataset);
});
document.getElementById('turnbox').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-act]');
  if (b) panelAct(b.dataset.act, b.dataset);
});
document.getElementById('acts').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-act]');
  if (b) panelAct(b.dataset.act, b.dataset);
});

function flash(msg) {
  const b = document.getElementById('flash');
  b.textContent = msg; b.classList.add('on');
  setTimeout(() => b.classList.remove('on'), 1800);
}

/* ================= 盤面・手札のタップとドラッグ ================= */

function showCardInfo(el) {
  const d = el.dataset;
  UI.mode = 'info';
  UI.info = {
    card: +d.card,
    back: el.classList.contains('back'),
    known: d.known === undefined ? true : d.known === '1',
    own: d.own === undefined ? undefined : d.own === '1',
    unit: el.classList.contains('unit'),
    pup: d.pup === '1',
    st: d.st || '',
    lane: d.lane === undefined ? null : +d.lane
  };
  renderPanel();
}

let drag = null;

document.getElementById('screen-battle').addEventListener('pointerdown', (ev) => {
  const el = ev.target.closest('.card');
  if (!el) return;
  if (el.id === 'change-card') { if (canChange()) showChangeConfirm(); return; }

  /* 戦闘中：開ける階層を押したら、それを選ぶ */
  if (UI.mode === 'battle' && el.classList.contains('openable')) {
    UI.chip = +el.dataset.layer;
    return renderPanel();
  }
  /* 攻撃対象を選んでいる最中 */
  if (UI.mode === 'attack' && el.dataset.lane !== undefined) {
    const i = +el.dataset.lane;
    if (UI.targets.indexOf(i) >= 0) return showAttackConfirm(i);
  }
  if (el.classList.contains('empty-unit')) return;

  if (el.classList.contains('hand-card')) {
    if (humanSide() !== M.active || M.combat) { showCardInfo(el); return; }
    if (M.phase === 'discard') { showDiscardConfirm(+el.dataset.hand); return; }
    ev.preventDefault();                       /* 画像ドラッグ・テキスト選択を止める */
    drag = { el, id: +el.dataset.card, idx: +el.dataset.hand,
             x0: ev.clientX, y0: ev.clientY, moved: false, ghost: null };
    try { el.setPointerCapture(ev.pointerId); } catch (e) { /* 無視 */ }
    return;
  }
  /* 自陣のユニットを押したら、メインステップなら行動メニュー */
  if (el.classList.contains('unit') && !M.combat && humanSide() === M.active
      && M.phase === 'main' && CQState.lanesOf(M.active).indexOf(+el.dataset.lane) >= 0) {
    UI.lane = +el.dataset.lane;
    UI.mode = 'unit';
    return renderAll();
  }
  showCardInfo(el);
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
    /* 置ける場所だけを光らせる */
    document.querySelectorAll('.lane').forEach((l) => {
      const i = +l.dataset.lane, ln = M.board.lanes[i];
      const mine = CQState.lanesOf(M.active).indexOf(i) >= 0;
      const ok = ln.unit != null
        ? (M.phase === 'placement' || !ln.stiff)
        : (mine && c.t === 'U' && M.phase === 'placement' && CQState.unitStats(c).lv <= 1);
      if (ok) l.classList.add('droppable');
    });
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
    if (l) return l;
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
  if (lane) showDropConfirm(d.idx, +lane.dataset.lane);
});

/* 対戦開始 */
newMatch();

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
