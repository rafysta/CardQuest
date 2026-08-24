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
/* 憑依で生まれるカース(91〜99)には専用の絵が無い。だが、カースはもともと
   「通常攻撃で倒されたユニットの霊が取り憑いたもの」で、カースID＝元ユニットID＋26 という
   1対1の対応があり、元ユニット（ヘルファイア65〜アースバウンド73）の絵は9枚とも揃っている。
   そこで専用イラストは用意せず、元ユニットの絵を流用し、CSSの img.curse-art で
   紫の心霊風に加工して「本体ではなく取り憑いた霊のほう」だと分かるようにする。 */
const CURSE_ART_OFFSET = 26;
function artSrcId(card) {
  return card.t === 'C' ? card.id - CURSE_ART_OFFSET : card.id;
}
function artInner(card, chars) {
  /* 絵が無いときの文字の代替。カースは「カース：」を外さないと9種とも「カース」になってしまう */
  const label = card.t === 'C' ? card.n.replace(/^カース[：:]\s*/, '') : card.n;
  const a = abbrev(label, chars || 3);
  /* draggable="false" は必須。付けないと、絵のあるカードをドラッグしたときに
     ブラウザ標準の画像ドラッグが始まってしまい、こちらのポインタ操作が途切れる */
  return `<img ${card.t === 'C' ? 'class="curse-art" ' : ''}src="${ART_DIR}${artSrcId(card)}.png"
     alt="" draggable="false"
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
/** いま人が戦闘のオープンフェイズを操作しているか（UI.mode に依存しない判定） */
function humanOpening() { return !!(M && M.combat && !M.winner && humanSide()); }
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
  UI.pending = null; UI.report = null;
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
    if (UI.mode !== 'battle') UI.mode = 'battle';
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
  /* 戦闘中に開ける階層か。UI.mode ではなくエンジンの状態から決める
     （情報を見るために UI.mode が 'info' になっても▶が消えないようにするため） */
  const open = humanOpening() && CQCombat.openerLane(M) === i
    && CQCombat.openableLayers(M).indexOf(k) >= 0;
  /* メインステップ：直接押してリバースできるか（裏なら押した瞬間に開く。
     表の技能は誤タップでの閉じ事故を防ぐため、押すと情報パネルに「閉じる」ボタンが出る） */
  const ln = M.board.lanes[i];
  const canFlipHere = !M.combat && !M.winner && humanSide() === M.active && M.phase === 'main'
    && CQState.controlSide(ln, i) === M.active && !ln.stiff
    && !(ln.acc && ln.acc.lock >= 1)
    && allowedLayers(i).indexOf(k) >= 0;
  const flip = canFlipHere && !ch.up;
  const closable = canFlipHere && ch.up;
  const attr = `data-lane="${i}" data-layer="${k}" data-card="${card.id}"
    data-own="${own ? 1 : 0}" data-known="${known ? 1 : 0}" data-st="${ch.st || ''}"
    ${closable ? 'data-closable="1"' : ''}`;
  /* 開けるカードは「左半分＝開く／右半分＝内容を見る」の2つのタップ領域に分ける。
     ▶（左）とⓘ（右）がその目印。境目には薄い縦線を出す（.card.ch.split の ::after） */
  const split = open || flip;
  const mark = split ? '<span class="cur">▶</span>' : '';
  const info = split ? '<span class="inf">ⓘ</span>' : '';
  const splitCls = split ? 'split' : '';
  if (!ch.up) {
    const nm = known ? `<span class="nm">${card.n}</span>` : '<span class="nm hid">？</span>';
    return `<div class="card ch back ${oc} ${open ? 'openable' : ''} ${flip ? 'flippable' : ''} ${splitCls}" ${attr} ${bottom}>
      <div class="strip">${mark}${nm}${badge}${info}</div></div>`;
  }
  return `<div class="card ch ${card.t} ${oc} ${pos ? 'possess' : ''} ${splitCls}" ${attr} ${bottom}>
    <div class="strip">${mark}<span class="nm">${card.n}</span>${badge}${info}</div>
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

/* --- 画面サイズは Galaxy Tab S11 横向き（1280×800）に固定する ---
 * レイアウトは常に 1280×800 の箱として組み、ウィンドウがそれより小さいときだけ
 * 全体を等倍で縮小する（拡大はしない）。これで、どの画面で開いても見えるものが同じになる。
 * 縮小は CSS の transform:scale なので、getBoundingClientRect も elementsFromPoint も
 * 変換後のビューポート座標を返す＝ドラッグ判定はそのままで正しく動く。 */
const APP_W = 1280, APP_H = 800;
function fitApp() {
  const s = Math.min(1, window.innerWidth / APP_W, window.innerHeight / APP_H);
  document.documentElement.style.setProperty('--app-scale', s);
}
window.addEventListener('resize', () => { fitApp(); fitBoard(); renderHand(); });
fitApp();

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
  paint('<div class="i-lead">手札は場までドラッグすると出せます。<br>'
    + '自分のモンスターを敵にドラッグすると攻撃、<br>'
    + '▶の付いた裏向きカードは押すと開きます。</div>'
    + (M.loot.length ? `<div class="i-loot">戦利品：${M.loot.map((id) => CARD_BY_ID[id].n).join('・')}</div>` : ''));
}

function panelInfo() {
  /* 戦闘のオープンフェイズ中に内容を見ているときは、フェイズを終えるボタンを必ず残す
     （情報を見たせいで手が止まらないようにするため） */
  if (humanOpening()) {
    return paint(infoCardHTML(CARD_BY_ID[UI.info.card], UI.info)
      + '<p class="i-t dim">※ 開くときは、カードの<b>左半分（▶側）</b>を押します。</p>',
      `<button class="btn ng" data-act="open-end">開かずに終える</button>`, true);
  }
  /* 表になっている技能カード（自分が操作するレーン・メインステップ）は、ここから閉じられる。
   * 場のカードを押した瞬間に閉じてしまう誤操作を防ぐため、ワンクッション置いている */
  const foot = UI.info.closable
    ? `<button class="btn ng" data-act="close-ch" data-lane="${UI.info.lane}"
        data-layer="${UI.info.layer}">この技能を閉じる（リバース）</button>`
    : '';
  paint(infoCardHTML(CARD_BY_ID[UI.info.card], UI.info), foot, !!foot);
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
  if (targets.length) btns += `<button class="act-row" data-act="attack">アタック<span class="sub">このモンスターを敵にドラッグしても攻撃できます</span></button>`;
  else if (atk.ok) btns += `<div class="act-row off">アタック：狙える相手が居ません</div>`;
  else btns += `<div class="act-row off">アタック：${atk.reason}</div>`;
  if (deck.ok) btns += `<button class="act-row" data-act="deck-attack">デッキ攻撃<span class="sub">相手のＬＰ −1 と山札1枚を破壊</span></button>`;
  if (rev.ok) btns += `<div class="act-row off">リバース：▶の付いた裏向きカードを直接押すと開きます</div>`;
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

/* --- 戦闘：オープンフェイズ ---
 * 開く操作は場の▶付きカードを直接押す（選択ＵＩはパネルに置かない。2026-08-24 本人の指定）。
 * パネルは対戦カード・いまどちらのフェイズか・「開かずに終える」ボタンだけを出す */
function panelBattle() {
  const c = M.combat;
  const A = M.board.lanes[c.attacker], D = M.board.lanes[c.defender];
  const role = c.opener === 'attacker' ? '攻撃側' : '防御側';
  const head = `<div class="vs">
      <span class="vs-a">攻 ${CARD_BY_ID[A.unit] ? CARD_BY_ID[A.unit].n : '—'} <b>${A.atk}</b></span>
      <span class="vs-x">▶</span>
      <span class="vs-d">防 ${CARD_BY_ID[D.unit] ? CARD_BY_ID[D.unit].n : '—'} <b>${D.def}</b></span>
    </div>`;
  return paint(head + askHTML(`${jpSide(CQCombat.openerSide(M))}の${role}オープンフェイズ`,
    `▶の付いたカードの<b>左半分（▶側）を押すと開き</b>、<b>右半分（ⓘ側）を押すと中身を確認</b>できます。<br>
     下から上への一方通行です（開いた階層より下の▶は消えます）。クローズはできません。`, 'warn')
    + (UI.report ? reportHTML(UI.report) : ''),
    `<button class="btn ng" data-act="open-end">開かずに終える</button>`, true);
}

/* ================= 確認 ================= */

function paintNG(card, ng) {
  UI.mode = 'confirm'; UI.pending = null;
  paint(miniCardHTML(card) + askHTML('この場所には置けません', ng, 'ng'),
    ngBtn('閉じる'), true);
}

/** 手札のカードをレーンに落としたとき（確認なしで即実行。誤操作の抑止はドラッグという
 * 動作そのものと、置ける場所だけを光らせる表示で行う）。
 * pushLayer … チャネルが一杯のレーンで、特定の階層のカードに重ねて離した場合の階層番号 */
function doDrop(handIdx, laneIdx, pushLayer) {
  const side = M.active;
  const card = CARD_BY_ID[M.players[side].hand[handIdx]];
  const ln = M.board.lanes[laneIdx];
  const mine = S_lanesOf(side).indexOf(laneIdx) >= 0;

  if (ln.unit == null) {
    if (!mine) return paintNG(card, 'モンスターを相手の場に直接召還することはできません。相手の場に関われるのは、相手のユニットへのチャネルだけです。');
    if (card.t !== 'U') return paintNG(card, 'ここは空き枠です。魔法と技能はモンスターの上にしか置けません。');
    markLog();
    const r = CQTurn.summon(M, laneIdx, handIdx);
    if (!r.ok) {
      if (/召還レベル/.test(r.reason || '')) {
        return paintNG(card, `召還Ｌｖ${card.lv}のモンスターは手札から直接は出せません。ユニットにチャネルして、${card.lv}階層目以上で開くと出てきます（リバース召還）。場に光臨(199)があれば直接も出せます。`);
      }
      return paintNG(card, r.reason || 'その操作はできません');
    }
    return step();
  }

  const host = CARD_BY_ID[ln.unit];
  const full = ln.count >= ln.cap;
  if (full && !ln.channels.length) {
    return paintNG(card, `${host.n} はチャネルできる枠がありません（ＣＨ数 ${ln.cap}）。`);
  }
  if (full && M.phase !== 'placement') return paintNG(card, 'チャネルが一杯です。押し込みができるのは配置ステップだけです。');
  if (full && pushLayer == null) {
    return paintNG(card, `${host.n} のチャネルは一杯です。押し込むときは、<b>入れ替えたい階層のカードに直接重ねて</b>離してください。その階層のカードを捨てて入れ替えます。`);
  }
  markLog();
  const r = CQTurn.channel(M, laneIdx, handIdx, full ? { layer: pushLayer } : undefined);
  if (!r.ok) return paintNG(card, r.reason || 'その操作はできません');
  step();
}
function S_lanesOf(side) { return CQState.lanesOf(side); }

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

/* ================= 操作の実行 ================= */

/** アタックを即実行する（確認なし。狙える相手だけが光っているので誤爆しにくい） */
function doAttack(atkLane, defLane) {
  markLog();
  const r = CQCombat.declareAttack(M, atkLane, defLane);
  UI.mode = 'idle'; UI.lane = null; UI.targets = null; UI.report = null;
  if (!r.ok) { flash(r.reason || 'その操作はできません'); renderAll(); return; }
  step();
}

/** 場のカードを1階層だけリバースする（直接クリック用。原作の SW583「行動継続中」に対応：
 * 同じレーンなら続けて上の階層も開け、別の行動を始めるか最上段まで開くと確定して硬直する） */
function doFlip(laneIdx, layer) {
  markLog();
  const r = CQTurn.reverseAction(M, laneIdx, [layer], { cont: true });
  UI.report = null;
  if (UI.mode === 'info') UI.mode = 'idle';   /* 内容を見たあとに開いたら、結果の表示に戻す */
  if (!r.ok) { flash(r.reason || 'その操作はできません'); renderAll(); return; }
  step();
}

function doPending() {
  markLog();
  const p = UI.pending;
  UI.pending = null;
  if (!p) return;
  let r = { ok: true };
  if (p.kind === 'change') r = CQTurn.change(M);
  else if (p.kind === 'discard') r = CQTurn.discardCard(M, p.handIdx);
  else if (p.kind === 'deck-attack') r = CQCombat.deckAttack(M, p.lane);
  UI.mode = 'idle'; UI.lane = null; UI.layers = []; UI.report = null;
  if (!r.ok) { flash(r.reason || 'その操作はできません'); renderAll(); return; }
  step();
}

function panelAct(act, data) {
  switch (act) {
    case 'ok': return doPending();
    case 'cancel':
      UI.pending = null; UI.mode = 'idle'; UI.lane = null; UI.layers = [];
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
    case 'close-ch':                                  /* 表の技能を閉じる（情報パネルのボタン） */
      return doFlip(+data.lane, +data.layer);
    case 'open-end':
      markLog();
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

document.getElementById('info-fix').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b || b.disabled) return;
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
    lane: d.lane === undefined ? null : +d.lane,
    layer: d.layer === undefined ? null : +d.layer,
    closable: d.closable === '1'
  };
  renderPanel();
}

let drag = null;

document.getElementById('screen-battle').addEventListener('pointerdown', (ev) => {
  /* 前のドラッグが何らかの理由で残っていたら、まず片付ける（保険） */
  if (drag) { clearDragVisuals(drag); drag = null; }
  const el = ev.target.closest('.card');
  if (!el) return;
  if (el.id === 'change-card') { if (canChange()) showChangeConfirm(); return; }

  /* 開けるカード（▶が付いている）は左右で操作を分ける。
     左半分＝開く／右半分＝中身を確認する。開く前に内容を見たい、という要望への対応
     （2026-08-24 本人の指定）。カードは正方形なので、見えている帯の中央で左右に割る */
  /* 縮小表示中でも正しく効くよう、必ず getBoundingClientRect（変換後の座標）で判定する */
  const splitCard = el.classList.contains('split');
  let wantInfo = false;
  if (splitCard) {
    const r = el.getBoundingClientRect();
    wantInfo = ev.clientX > r.left + r.width / 2;
  }

  /* 戦闘中：▶付きのカードの左半分を押したら、その階層をそのまま開く */
  if (humanOpening() && el.classList.contains('openable') && !wantInfo) {
    markLog();
    const r = CQCombat.open(M, +el.dataset.layer);
    if (!r.ok) flash(r.reason);
    return step();
  }
  /* 攻撃対象を選んでいる最中（行動メニュー経由）：対象を押したら即攻撃 */
  if (UI.mode === 'attack' && el.dataset.lane !== undefined) {
    const i = +el.dataset.lane;
    if (UI.targets.indexOf(i) >= 0) return doAttack(UI.lane, i);
  }
  /* メインステップ：▶の付いた裏向きカードの左半分を押したら、その階層を直接開く */
  if (el.classList.contains('flippable') && !wantInfo) {
    return doFlip(+el.dataset.lane, +el.dataset.layer);
  }
  if (el.classList.contains('empty-unit')) return;

  if (el.classList.contains('hand-card')) {
    if (humanSide() !== M.active || M.combat) { showCardInfo(el); return; }
    if (M.phase === 'discard') { showDiscardConfirm(+el.dataset.hand); return; }
    ev.preventDefault();                       /* 画像ドラッグ・テキスト選択を止める */
    drag = { kind: 'hand', el, id: +el.dataset.card, idx: +el.dataset.hand,
             x0: ev.clientX, y0: ev.clientY, moved: false, ghost: null };
    try { el.setPointerCapture(ev.pointerId); } catch (e) { /* 無視 */ }
    return;
  }
  /* 自分が操作するユニット：ドラッグで攻撃、タップで行動メニュー（傀儡で奪ったユニットも含む） */
  if (el.classList.contains('unit') && !M.combat && humanSide() === M.active
      && M.phase === 'main'
      && CQState.controlledLanesOf(M.board.lanes, M.active).indexOf(+el.dataset.lane) >= 0) {
    ev.preventDefault();
    drag = { kind: 'unit', el, lane: +el.dataset.lane,
             x0: ev.clientX, y0: ev.clientY, moved: false, ghost: null, targets: null };
    try { el.setPointerCapture(ev.pointerId); } catch (e) { /* 無視 */ }
    return;
  }
  showCardInfo(el);
});

document.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
  if (!drag.moved && Math.hypot(dx, dy) < 10) return;
  if (!drag.moved) {
    drag.moved = true;
    if (drag.kind === 'unit') {
      /* ユニットのドラッグ＝アタック。狙える相手をここで確定して光らせる */
      const atk = CQCombat.canAttack(M, drag.lane);
      const targets = atk.ok ? CQCombat.attackTargets(M, drag.lane) : [];
      if (!targets.length) {
        flash(atk.ok ? 'アタック：狙える相手が居ません' : 'アタック：' + atk.reason);
        drag = null;
        return;
      }
      drag.targets = targets;
      const c = CARD_BY_ID[M.board.lanes[drag.lane].unit];
      const g = document.createElement('div');
      g.className = 'ghost card ' + c.t;
      g.innerHTML = `<div class="art">${artInner(c)}</div>
        <div class="topline"><span class="nm">${c.n}</span></div>`;
      document.body.appendChild(g);
      drag.ghost = g;
      drag.el.classList.add('dragging');
      targets.forEach((i) => {
        const l = document.querySelector(`.lane[data-lane="${i}"]`);
        if (l) l.classList.add('target');
      });
    } else {
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
        const full = ln.unit != null && ln.count >= ln.cap;
        const ok = ln.unit != null
          ? (full ? (M.phase === 'placement' && ln.channels.length > 0)
                  : (M.phase === 'placement' || !ln.stiff))
          : (mine && c.t === 'U' && M.phase === 'placement');
        if (ok) l.classList.add('droppable');
      });
    }
  }
  drag.ghost.style.left = ev.clientX + 'px';
  drag.ghost.style.top = ev.clientY + 'px';
  const lane = laneUnder(ev.clientX, ev.clientY);
  document.querySelectorAll('.lane.over').forEach((l) => l.classList.remove('over'));
  document.querySelectorAll('.card.ch.push-over').forEach((c) => c.classList.remove('push-over'));
  if (!lane) return;
  if (drag.kind === 'unit') {
    if (drag.targets.indexOf(+lane.dataset.lane) >= 0) lane.classList.add('over');
    return;
  }
  if (!lane.classList.contains('droppable')) return;
  lane.classList.add('over');
  /* チャネルが一杯のレーン：ポインタの下の階層カードを光らせる（そこに押し込む） */
  const i = +lane.dataset.lane, ln = M.board.lanes[i];
  if (ln.unit != null && ln.count >= ln.cap && M.phase === 'placement') {
    const chEl = chUnder(ev.clientX, ev.clientY, i);
    if (chEl) chEl.classList.add('push-over');
  }
});

function laneUnder(x, y) {
  const els = document.elementsFromPoint(x, y);
  for (const e of els) {
    const l = e.closest && e.closest('.lane');
    if (l) return l;
  }
  return null;
}
/** そのレーンのチャネリングカードのうち、ポインタの真下にあるもの（押し込み先の指定用） */
function chUnder(x, y, laneIdx) {
  const els = document.elementsFromPoint(x, y);
  for (const e of els) {
    const c = e.closest && e.closest('.card.ch');
    if (c && +c.dataset.lane === laneIdx) return c;
  }
  return null;
}

/** ドラッグの見た目をすべて片付ける（光っていたレーン・階層・浮いているカード）。
 * pointercancel（ＯＳにジェスチャを奪われた等）でも必ず呼ばれるので、
 * カードが浮いたまま残ることはない */
function clearDragVisuals(d) {
  document.querySelectorAll('.lane.droppable,.lane.over,.lane.target').forEach((l) =>
    l.classList.remove('droppable', 'over', 'target'));
  document.querySelectorAll('.card.ch.push-over').forEach((c) => c.classList.remove('push-over'));
  document.querySelectorAll('.ghost').forEach((g) => g.remove());   // 迷子のゴーストも含めて全部消す
  if (d && d.el) d.el.classList.remove('dragging');
}

document.addEventListener('pointercancel', () => {
  if (!drag) return;
  const d = drag; drag = null;
  clearDragVisuals(d);
});

document.addEventListener('pointerup', (ev) => {
  if (!drag) return;
  const d = drag; drag = null;
  clearDragVisuals(d);

  if (d.kind === 'unit') {
    if (!d.moved) {                            /* タップ＝行動メニュー */
      UI.lane = d.lane;
      UI.mode = 'unit';
      return renderAll();
    }
    const lane = laneUnder(ev.clientX, ev.clientY);
    if (lane && d.targets && d.targets.indexOf(+lane.dataset.lane) >= 0) {
      return doAttack(d.lane, +lane.dataset.lane);
    }
    return renderAll();                        /* 対象以外で離した＝キャンセル */
  }

  if (!d.moved) { showCardInfo(d.el); return; }
  const lane = laneUnder(ev.clientX, ev.clientY);
  if (!lane) return;
  const i = +lane.dataset.lane, ln = M.board.lanes[i];
  let pushLayer = null;
  if (ln.unit != null && ln.count >= ln.cap) {
    const chEl = chUnder(ev.clientX, ev.clientY, i);
    if (chEl) pushLayer = +chEl.dataset.layer;
  }
  doDrop(d.idx, i, pushLayer);
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
      <div class="bigart">${artInner(c)}</div>
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
