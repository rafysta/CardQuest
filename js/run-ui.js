/* CardQuest — ラン画面（M6）
 *
 * js/run/{areas,map,run}.js（DOM非依存のエンジン）と js/meta/save.js（永続化）を、
 * 「ラン」タブの中で実際に操作できるようにする描画・入力の層。ARTディレクトリや
 * カード絵の出し方は js/layout.js のバトル画面と同じ規約（ART_DIR・esc()・CARD_BY_ID）を
 * そのまま使う。戦闘そのものは js/layout.js の startRunBattle() でバトル画面へ橋渡しする。
 */
'use strict';

const RUN_STORAGE = (typeof localStorage !== 'undefined') ? localStorage : null;
/* 見本デッキ（js/layout.js の SAMPLE_DECK と同じ）。cq_meta が無い最初の1回だけ、
 * 所持デッキの初期値として使う。 */
const RUN_STARTER_DECK = [
  8, 1, 3, 2, 5, 7, 9, 19, 20, 22, 31, 70, 58, 65, 66, 67, 71, 73, 10, 17,
  151, 158, 167, 169, 171, 172, 173, 177, 178, 179, 181, 183, 199,
  101, 104, 113, 117, 136, 143, 145
];

const RUI = { view: 'areaSelect', run: null, meta: null, nodeId: null, draft: null, flash: '' };

function runRoot() { return document.getElementById('run-root'); }
function runSave() { if (RUI.run) CQSave.saveRun(RUN_STORAGE, RUI.run); }
function runFlash(msg) { RUI.flash = msg; }

function runInit() {
  RUI.meta = CQSave.loadMeta(RUN_STORAGE, RUN_STARTER_DECK);
  const saved = CQSave.loadRun(RUN_STORAGE);
  if (saved && !saved.outcome) { RUI.run = saved; RUI.view = 'map'; }
  else { RUI.run = null; RUI.view = 'areaSelect'; }
  runRender();
}

/* ================= エリア選択 ================= */

function renderAreaSelect() {
  const cleared = RUI.meta.cleared || [];
  const tiles = CQAreas.list().map(function (a) {
    const unlocked = CQAreas.isUnlocked(a.id, cleared);
    const done = cleared.indexOf(a.id) >= 0;
    return `<div class="area-tile ${unlocked ? '' : 'locked'}" data-act="${unlocked ? 'go-start' : ''}" data-id="${a.id}"
        style="background-image:url('${a.bg}')">
      <div class="area-tile-fade"></div>
      <div class="area-tile-name">${esc(a.name)}${done ? '<span class="area-clear">クリア済</span>' : ''}</div>
      ${unlocked ? '' : `<div class="area-tile-lock">🔒 ${esc(CQAreas.get(a.unlock).name)}をクリアすると解放</div>`}
    </div>`;
  }).join('');
  runRoot().innerHTML = `
    <div class="run-hud">
      <div class="run-hud-g">所持Ｇ：<b>${RUI.meta.gold}</b></div>
    </div>
    <h2 class="run-h2">冒険に出る</h2>
    <div class="area-grid">${tiles}</div>`;
}

/* ================= 開始マス（案内・おまかせドラフト） ================= */

function draftCardMini(id) {
  const c = CARD_BY_ID[id];
  return `<div class="draft-card" data-act="pick-draft" data-id="${id}">
    <div class="dc-art">${artInner(c, 4)}</div>
    <div class="dc-n">${esc(c.n)}</div>
    <div class="dc-e">${esc(c.e || '')}</div>
  </div>`;
}

function renderStart() {
  const run = RUI.run, area = CQAreas.get(run.areaId);
  if (run.draftDone >= 3) {
    runRoot().innerHTML = `
      <div class="run-hud"><div class="run-hud-g">所持Ｇ：<b>${run.gold}</b>　ＬＰ：<b>${run.lp}</b></div></div>
      <div class="bubble">これで準備は整った。${esc(area.name)}へ出発しよう。</div>
      <button class="btn ok run-depart" data-act="depart">出発する</button>`;
    return;
  }
  if (!run.draftPending) RUI.draft = CQRun.beginDraftRound(run, CARD_BY_ID);
  const dp = run.draftPending;
  const target = CARD_BY_ID[dp.targetId];
  const opts = dp.options.map(draftCardMini).join('');
  runRoot().innerHTML = `
    <div class="run-hud"><div class="run-hud-g">所持Ｇ：<b>${run.gold}</b></div></div>
    <div class="bubble">${esc(area.name)}へようこそ。${area.fog.chance > 0 ? 'この土地は霧が出ることがある。ショップで払える。' : ''}
      道中で使える「おまかせドラフト」で、まだ持っていないカードをレンタルできる（${dp.round + 1}／3回目）。</div>
    <div class="draft-row">
      ${opts}
      ${draftCardMini(dp.targetId)}
    </div>
    <p class="draft-note">入れ替え対象：<b>${esc(target.n)}</b>（自動選択。空白がなければいちばん安いカードから）。
      いちばん右の「${esc(target.n)}」を選べば変更しません。選んだカードはこのラン限定のレンタルです。</p>`;
}

/* ================= マップ画面 ================= */

const NODE_ICON = { chest: '🎁', shop: '🛒', rest: '☕', exchange: '💰', question: '❓', start: '🏠', boss: '👑' };
const NODE_LABEL = { chest: '宝箱', shop: 'ショップ', rest: '休憩', exchange: '換金', question: '？', start: '開始', boss: 'ボス' };

function nodeVisible(n, run) { return !n.fog || run.map.fog.cleared; }

function nodeIconHTML(n, run) {
  if (n.type === 'battle') {
    const hidden = !nodeVisible(n, run);
    const badge = n.strength === 'elite' ? '<span class="node-badge elite">⭐</span>' : '';
    const pip = (!hidden && n.enemy) ? `<span class="node-pip">×${n.enemy.count}</span>` : '';
    const inner = hidden ? '<div class="node-silhouette">？</div>' : artInner(CARD_BY_ID[n.enemy.id], 4);
    return `<div class="node-art ${n.strength}">${inner}</div>${badge}${pip}`;
  }
  if (n.type === 'boss') {
    return `<div class="node-art boss"><img src="${CQAreas.get(run.areaId).master}" alt=""
      draggable="false" onerror="this.replaceWith(document.createTextNode('👑'))"></div>`;
  }
  const hidden = !nodeVisible(n, run);
  return `<div class="node-icon">${hidden ? '？' : NODE_ICON[n.type]}</div>`;
}

function pathSvg(run) {
  const segs = [];
  Object.values(run.map.nodes).forEach(function (n) {
    n.connectsTo.forEach(function (toId) {
      const t = run.map.nodes[toId];
      const cleared = n.cleared;
      segs.push(`<line x1="${n.x}" y1="${n.y}" x2="${t.x}" y2="${t.y}" class="path-line ${cleared ? 'done' : ''}"/>`);
    });
  });
  return `<svg class="run-paths" viewBox="0 0 1280 800" preserveAspectRatio="none">${segs.join('')}</svg>`;
}

function runChoiceIds(run) {
  const cur = CQRun.currentNode(run);
  if (!cur.cleared) return [cur.id];
  return cur.connectsTo;
}

function renderMap() {
  const run = RUI.run, area = CQAreas.get(run.areaId);
  const pickable = runChoiceIds(run);
  const nodesHTML = run.map.order.map(function (id) {
    const n = run.map.nodes[id];
    const can = pickable.indexOf(id) >= 0 && !n.cleared;
    const done = n.cleared;
    const delay = ((id.charCodeAt(1) * 37) % 900) / 1000;
    return `<div class="map-node ${n.type} ${can ? 'pickable' : ''} ${done ? 'done' : ''} ${n.fog && !run.map.fog.cleared ? 'foggy' : ''}"
        style="left:${(n.x / 1280 * 100).toFixed(2)}%; top:${(n.y / 800 * 100).toFixed(2)}%; animation-delay:${delay}s"
        data-act="node" data-id="${id}">
      ${nodeIconHTML(n, run)}
    </div>`;
  }).join('');
  runRoot().innerHTML = `
    <div class="run-hud">
      <div class="run-hud-g">Ｇ：<b>${run.gold}</b></div>
      <div class="run-hud-lp">♥ ${run.lp}／${run.maxLp}</div>
      <div class="run-hud-area">${esc(area.name)}${run.map.fog.active && !run.map.fog.cleared ? '　🌫 霧の中' : ''}</div>
      <button class="tiny run-retire" data-act="retire">リタイヤ</button>
    </div>
    <div class="run-map" style="background-image:url('${area.bg}')">
      ${pathSvg(run)}
      ${nodesHTML}
    </div>
    <div class="run-log">${(run.log.slice(-3).map(function (l) { return '<div>・' + esc(l) + '</div>'; })).join('')}</div>`;
}

/* ================= ノード解決 ================= */

function fieldRuleInfoHTML(rules) {
  if (!rules || !rules.length) return '';
  return '<div class="node-rules">' + rules.map(function (r) {
    const d = CQField.describe(r);
    return `<div class="node-rule">${d.icon} <b>${esc(d.name)}</b>：${esc(d.text)}</div>`;
  }).join('') + '</div>';
}

function renderNode() {
  const run = RUI.run, n = run.map.nodes[RUI.nodeId];
  if (n.type === 'battle' || n.type === 'boss') return renderBattleNode(run, n);
  if (n.type === 'chest') return renderChestNode(run, n);
  if (n.type === 'rest') return renderRestNode(run, n);
  if (n.type === 'shop') return renderShopNode(run, n);
  if (n.type === 'exchange') return renderExchangeNode(run, n);
  if (n.type === 'question') return renderQuestionNode(run, n);
}

function renderBattleNode(run, n) {
  const area = CQAreas.get(run.areaId);
  const isBoss = n.type === 'boss';
  const enemy = n.enemy ? CARD_BY_ID[n.enemy.id] : null;
  runRoot().innerHTML = `
    <div class="node-panel">
      <h3>${isBoss ? area.bossName : (n.strength === 'elite' ? '精鋭' : n.strength === 'strong' ? '強敵' : '戦闘')}</h3>
      ${isBoss
        ? `<div class="node-art boss big"><img src="${area.master}" alt="" draggable="false"
             onerror="this.replaceWith(document.createTextNode('👑'))"></div>`
        : `<div class="node-art ${n.strength} big">${artInner(enemy, 5)}</div><p>${esc(enemy.n)} ×${n.enemy.count}</p>`}
      ${fieldRuleInfoHTML(n.fieldRules)}
      <button class="btn ok" data-act="battle-go">${isBoss ? '挑む' : 'たたかう'}</button>
    </div>`;
}

function renderChestNode(run, n) {
  if (!n.opened) {
    runRoot().innerHTML = `
      <div class="node-panel">
        <h3>${n.rare ? '大きな宝箱' : '宝箱'}</h3>
        <button class="btn ok" data-act="chest-open">開ける</button>
      </div>`;
    return;
  }
  const cardName = n.cardId != null ? CARD_BY_ID[n.cardId].n : null;
  runRoot().innerHTML = `
    <div class="node-panel">
      <h3>宝箱を開けた</h3>
      <p>Ｇ +${n.gold}${cardName ? '・' + esc(cardName) + ' を入手' : ''}</p>
      <button class="btn ok" data-act="node-done">進む</button>
    </div>`;
}

function renderRestNode(run, n) {
  if (!n.cleared) {
    runRoot().innerHTML = `
      <div class="node-panel">
        <h3>休憩</h3>
        <p>ＬＰ：${run.lp}／${run.maxLp}</p>
        <button class="btn ok" data-act="rest-go">休む（ＬＰ+3）</button>
        <p class="node-note">※デッキの調整はこのマスではまだできません（今後の版で追加予定）</p>
      </div>`;
    return;
  }
  runRoot().innerHTML = `
    <div class="node-panel"><h3>休憩を終えた</h3><p>ＬＰ：${run.lp}／${run.maxLp}</p>
      <button class="btn ok" data-act="node-done">進む</button></div>`;
}

function renderShopNode(run, n) {
  const stockHTML = n.stock.length ? n.stock.map(function (id) {
    const c = CARD_BY_ID[id], price = CQRun.shopPrice(CARD_BY_ID, id);
    return `<div class="shop-item">
      <div class="dc-art">${artInner(c, 4)}</div>
      <div class="shop-item-n">${esc(c.n)}</div>
      <button class="tiny" data-act="shop-buy" data-id="${id}" ${run.gold < price ? 'disabled' : ''}>Ｇ${price}で購入</button>
    </div>`;
  }).join('') : '<p>品切れです</p>';
  runRoot().innerHTML = `
    <div class="node-panel wide">
      <h3>ショップ</h3>
      <p>所持Ｇ：${run.gold}／ＬＰ：${run.lp}／${run.maxLp}</p>
      <div class="shop-row">${stockHTML}</div>
      <div class="shop-services">
        <button class="tiny" data-act="shop-heal" ${run.gold < n.healCost || run.lp >= run.maxLp ? 'disabled' : ''}>
          ＬＰ回復（Ｇ${n.healCost}）</button>
        ${n.hasFogClear && !run.map.fog.cleared
          ? `<button class="tiny" data-act="shop-fog" ${run.gold < n.fogClearCost ? 'disabled' : ''}>
              霧払い（Ｇ${n.fogClearCost}）</button>` : ''}
      </div>
      <button class="btn ok" data-act="shop-leave">立ち去る</button>
    </div>`;
}

function renderExchangeNode(run, n) {
  const items = Object.keys(run.deck).filter(function (k) { return run.deck[k] > 0 && +k !== CQRun.BLANK; });
  const rows = items.length ? items.map(function (k) {
    const id = +k, c = CARD_BY_ID[id];
    const gold = c ? Math.max(10, Math.round(c.p * 0.4)) : 0;
    return `<div class="shop-item">
      <div class="dc-art">${artInner(c, 4)}</div>
      <div class="shop-item-n">${esc(c.n)} ×${run.deck[k]}</div>
      <button class="tiny" data-act="sell" data-id="${id}">Ｇ${gold}で売る</button>
    </div>`;
  }).join('') : '<p>売れるカードがありません</p>';
  runRoot().innerHTML = `
    <div class="node-panel wide">
      <h3>換金</h3><p>所持Ｇ：${run.gold}</p>
      <div class="shop-row">${rows}</div>
      <button class="btn ok" data-act="exchange-leave">立ち去る</button>
    </div>`;
}

function renderQuestionNode(run, n) {
  if (!n.resolved) {
    CQRun.resolveQuestion(run, n);
    runSave();
  }
  const eff = n.event.effect || {};
  const parts = [];
  if (eff.lp) parts.push('ＬＰ ' + (eff.lp > 0 ? '+' : '') + eff.lp);
  if (eff.gold) parts.push('Ｇ ' + (eff.gold > 0 ? '+' : '') + eff.gold);
  if (eff.draftCard && n.cardId != null) parts.push(esc(CARD_BY_ID[n.cardId].n) + ' を入手');
  runRoot().innerHTML = `
    <div class="node-panel">
      <h3>？</h3>
      <div class="bubble">${esc(n.event.text)}</div>
      ${parts.length ? `<p>${parts.join('・')}</p>` : ''}
      <button class="btn ok" data-act="node-done">進む</button>
    </div>`;
}

/* ================= 結果画面 ================= */

function renderResult() {
  const run = RUI.run;
  const win = run.outcome === 'win';
  const title = win ? 'クリア！' : run.outcome === 'retire' ? 'リタイヤ' : 'ゲームオーバー';
  const returned = run.rentals.map(function (id) { return CARD_BY_ID[id].n; });
  const gained = run.gainedCards.map(function (id) { return CARD_BY_ID[id].n; });
  runRoot().innerHTML = `
    <div class="node-panel">
      <h3 class="${win ? 'run-win' : 'run-lose'}">${title}</h3>
      <p>所持Ｇ：${run.gold}</p>
      ${gained.length ? `<p>獲得カード：${gained.map(esc).join('・')}</p>` : ''}
      ${returned.length ? `<p>返却（レンタル）：${returned.map(esc).join('・')}</p>` : ''}
      <button class="btn ok" data-act="back-home">エリア選択へ</button>
    </div>`;
}

/* ================= 描画のふりわけ ================= */

function runRender() {
  const el = runRoot();
  if (!el) return;
  if (RUI.run && RUI.run.outcome) RUI.view = 'result';
  if (RUI.view === 'areaSelect') renderAreaSelect();
  else if (RUI.view === 'start') renderStart();
  else if (RUI.view === 'map') renderMap();
  else if (RUI.view === 'node') renderNode();
  else if (RUI.view === 'result') renderResult();
}

/* ================= 操作 ================= */

function onRunBattleOver(M) {
  const run = RUI.run, n = run.map.nodes[RUI.nodeId];
  CQRun.reportBattle(run, n, M);
  if (n.type === 'boss' && M.winner === 'self') run.outcome = 'win';
  if (run.outcome) { CQRun.settle(run, RUI.meta); CQSave.saveMeta(RUN_STORAGE, RUI.meta); CQSave.clearRun(RUN_STORAGE); }
  else runSave();
  RUI.view = run.outcome ? 'result' : 'map';
  const tab = document.querySelector('.tab[data-screen="screen-run"]');
  if (tab) tab.click();
  runRender();
}
if (typeof window !== 'undefined') window.onRunBattleOver = onRunBattleOver;

function runAct(act, id) {
  const run = RUI.run;
  switch (act) {
    case 'go-start': {
      const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
      RUI.run = CQRun.start(CARD_BY_ID, id, seed, RUI.meta);
      RUI.view = 'start';
      runSave();
      return runRender();
    }
    case 'pick-draft':
      CQRun.applyDraft(run, +id);
      runSave();
      return runRender();
    case 'depart':
      CQRun.depart(run);
      RUI.view = 'map';
      runSave();
      return runRender();
    case 'node': {
      const n = run.map.nodes[id];
      if (n.fog && !run.map.fog.cleared) { runFlash('霧の中は入ってみないと分かりません'); }
      /* そのマスへ実際に進む（＝現在地を更新する）。これをしないと「解決はしたが
       * 分岐を選んでいない」状態のまま両方の選択肢を同時に取れてしまう（2択の意味が崩れる） */
      const adv = CQRun.advance(run, id);
      if (!adv.ok) { runFlash(adv.reason); return runRender(); }
      RUI.nodeId = id; RUI.view = 'node';
      runSave();
      return runRender();
    }
    case 'battle-go': {
      const n = run.map.nodes[RUI.nodeId];
      const setup = CQRun.battleSetup(run, CARD_BY_ID, n);
      return startRunBattle(setup, onRunBattleOver);
    }
    case 'chest-open':
      CQRun.openChest(run, run.map.nodes[RUI.nodeId]);
      runSave();
      return runRender();
    case 'rest-go':
      CQRun.rest(run, run.map.nodes[RUI.nodeId]);
      runSave();
      return runRender();
    case 'shop-buy': {
      const r = CQRun.shopBuy(run, CARD_BY_ID, run.map.nodes[RUI.nodeId], +id);
      if (!r.ok) runFlash(r.reason);
      runSave();
      return runRender();
    }
    case 'shop-heal': {
      const r = CQRun.shopHeal(run, run.map.nodes[RUI.nodeId]);
      if (!r.ok) runFlash(r.reason);
      runSave();
      return runRender();
    }
    case 'shop-fog': {
      const r = CQRun.shopClearFog(run, run.map.nodes[RUI.nodeId]);
      if (!r.ok) runFlash(r.reason);
      runSave();
      return runRender();
    }
    case 'shop-leave':
      CQRun.shopLeave(run, run.map.nodes[RUI.nodeId]);
      RUI.view = 'map'; runSave();
      return runRender();
    case 'sell': {
      const r = CQRun.sell(run, CARD_BY_ID, +id);
      if (!r.ok) runFlash(r.reason);
      runSave();
      return runRender();
    }
    case 'exchange-leave':
      CQRun.exchangeLeave(run, run.map.nodes[RUI.nodeId]);
      RUI.view = 'map'; runSave();
      return runRender();
    case 'node-done':
      RUI.view = 'map'; runSave();
      return runRender();
    case 'retire':
      if (!confirm('ここでリタイヤしますか？ ここまでの所持Ｇ・カードは持ち帰れます。')) return;
      CQRun.retire(run);
      CQRun.settle(run, RUI.meta);
      CQSave.saveMeta(RUN_STORAGE, RUI.meta);
      CQSave.clearRun(RUN_STORAGE);
      RUI.view = 'result';
      return runRender();
    case 'back-home':
      RUI.run = null; RUI.view = 'areaSelect';
      return runRender();
  }
}

document.addEventListener('DOMContentLoaded', function () {
  const el = runRoot();
  if (!el) return;
  el.addEventListener('click', function (ev) {
    const t = ev.target.closest('[data-act]');
    if (!t) return;
    runAct(t.dataset.act, t.dataset.id);
  });
  runInit();
});
/* DOMContentLoaded がすでに発火済み（scriptがbody末尾にあるため通常はここに来る）場合の保険 */
if (document.readyState !== 'loading') {
  const el = runRoot();
  if (el && !el.dataset.bound) {
    el.dataset.bound = '1';
    el.addEventListener('click', function (ev) {
      const t = ev.target.closest('[data-act]');
      if (!t) return;
      runAct(t.dataset.act, t.dataset.id);
    });
    runInit();
  }
}
