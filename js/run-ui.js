/* CardQuest — ラン画面（M6）
 *
 * js/run/{areas,map,run}.js（DOM非依存のエンジン）と js/meta/save.js（永続化）を、
 * 「ラン」タブの中で実際に操作できるようにする描画・入力の層。ARTディレクトリや
 * カード絵の出し方は js/layout.js のバトル画面と同じ規約（ART_DIR・esc()・CARD_BY_ID）を
 * そのまま使う。戦闘そのものは js/layout.js の startRunBattle() でバトル画面へ橋渡しする。
 */
'use strict';

const RUN_STORAGE = (typeof localStorage !== 'undefined') ? localStorage : null;
/* スターターセット（実装計画追補M6.6 §2-2・2026-08-27確定。8種28枚）。cq_meta が無い
 * 最初の1回だけ、本（book）の初期値として使う（WP1）。世界観上は「本に残った前の持ち主の
 * 書き残しを受け継ぐ」として説明する（台本§5-1）。tests/run.js・tools/simulate-run.js にも
 * 同じ内容がある（意図的な重複。値を変えるときは3箇所とも直すこと）。 */
const STARTER_BOOK = [
  8, 8, 8, 8, 8, 8, 8, 8, 8, 8,        /* ピッグマン (U) ×10 */
  101, 101, 101,                       /* 憑依解除 (M) ×3 */
  108, 108,                            /* 強制開放 (M) ×2 */
  113, 113,                            /* 透視 (M) ×2 */
  153, 153, 153,                       /* 魔力の盾 (S) ×3 */
  165, 165,                            /* 孤高の戦士 (S) ×2 */
  193, 193, 193,                       /* 赤の聖霊陣 (S) ×3 */
  194, 194, 194                        /* 青の聖霊陣 (S) ×3 */
];

const RUI = {
  view: 'areaSelect', run: null, meta: null, nodeId: null, draft: null, flash: '',
  openingStep: 0, openingIntroDone: false, openingFadeOut: false,
  /* 霧払いを買った直後だけ true。次にマップを描いたときに溶ける演出を1度再生して戻す（M6.5b） */
  fogDissolving: false
};

function runRoot() { return document.getElementById('run-root'); }
function runSave() { if (RUI.run) CQSave.saveRun(RUN_STORAGE, RUI.run); }
function runFlash(msg) { RUI.flash = msg; }

function runInit() {
  RUI.meta = CQSave.loadMeta(RUN_STORAGE, STARTER_BOOK);
  const saved = CQSave.loadRun(RUN_STORAGE);
  if (saved && !saved.outcome) { RUI.run = saved; RUI.view = 'map'; }
  else if (!RUI.meta.openingSeen) {
    /* 初回起動のみ（M6.6 WP1）：目覚めの場面へ。§4 WP2「最初からやり直す」→リロード後もここを通る。 */
    RUI.run = null; RUI.view = 'opening';
    RUI.openingStep = 0; RUI.openingIntroDone = false; RUI.openingFadeOut = false;
  } else { RUI.run = null; RUI.view = 'areaSelect'; }
  runRender();
}

/* ================= 目覚めの場面（M6.6 WP1・初回起動のみ） =================
 *
 * 台本§5-1（本文の台本には未統合。M6.5c の lore.js ができるまではここに直書きする——
 * §0-9進捗ログに申し送り済み）。フロー：暗転→ assets/ui/awakening.png がゆっくりフェードイン
 * （.opening-scene の黒背景がそのまま「暗転」を兼ねる）→ 右側に amber_calm/down の肖像が
 * 少し遅れてフェードイン → 台本10個をタップ送り → 最後の後にフェードアウト → エリア選択へ。
 * 背景・肖像のフェードインは初回描画時だけ再生する（RUI.openingIntroDone で以後は
 * intro-done クラスにより即表示に切り替え、タップのたびに要素を作り直しても再生し直さない）。 */

const OPENING_SCRIPT = [
  { tag: 'calm', text: '起きたか。' },
  { tag: 'calm', text: '名も、来し方も、覚えていない。\nそういう顔をしている。' },
  { tag: 'calm', text: '私はアンバー。\nこの本に憑いている。' },
  { tag: 'calm', text: 'ここはソウルゲート。\n渡れなかった魂が溜まる島だ。' },
  { tag: 'calm', text: '島の魂は、鎮めて書き留めれば呼べる。\nそれをする者を、記録者と呼ぶ。' },
  { tag: 'down', text: '……お前も、しばらくは出られん。' },
  { tag: 'calm', text: '自分が誰だったか知りたければ、\nまずは書け。' },
  { tag: 'down', text: '白紙ばかりだが、書き残しが少しある。\n……前の持ち主の分だ。' },
  { tag: 'calm', text: '受け継いでおけ。\n最初は、それで足りる。' },
  { tag: 'calm', text: '行くぞ。今日の巡り先を選べ。' }
];

function renderOpening() {
  const step = Math.min(RUI.openingStep || 0, OPENING_SCRIPT.length - 1);
  const entry = OPENING_SCRIPT[step];
  const portrait = entry.tag === 'down' ? 'assets/chars/amber_down.png' : 'assets/chars/amber_calm.png';
  const lines = String(entry.text).split('\n').map(esc).join('<br>');
  const cls = 'opening-scene' + (RUI.openingIntroDone ? ' intro-done' : '') + (RUI.openingFadeOut ? ' fade-out' : '');
  runRoot().innerHTML = `
    <div class="${cls}">
      <img class="opening-bg" src="assets/ui/awakening.png" alt="" draggable="false"
        onerror="this.style.display='none'">
      <button class="opening-skip" data-act="opening-skip">スキップ</button>
      <img class="opening-portrait" src="${portrait}" alt="" draggable="false" onerror="this.remove()">
      <div class="opening-bubble-wrap" data-act="opening-next">
        <div class="bubble opening-bubble">${lines}</div>
        <div class="opening-tap-hint">タップして進む</div>
      </div>
    </div>`;
}

/** 目覚めの場面を終える（最後まで見た／スキップした、どちらもここに来る）。
 * openingSeen を立てて保存し、以後は起動しても出ない。 */
function finishOpening() {
  RUI.meta.openingSeen = true;
  CQSave.saveMeta(RUN_STORAGE, RUI.meta);
  RUI.view = 'areaSelect';
  RUI.openingStep = 0; RUI.openingIntroDone = false; RUI.openingFadeOut = false;
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
    <div class="area-grid">${tiles}</div>
    <button class="area-reset-btn" data-act="reset-progress">最初からやり直す</button>`;
}

/* ================= 開始マス（案内・おまかせドラフト） ================= */

function draftCardMini(id, isRental) {
  const c = CARD_BY_ID[id];
  return `<div class="draft-card" data-act="pick-draft" data-id="${id}">
    <div class="dc-art">${artInner(c, 4)}${isRental ? '<span class="rental-badge">借</span>' : ''}</div>
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
  const opts = dp.options.map(function (id) { return draftCardMini(id, true); }).join('');
  runRoot().innerHTML = `
    <div class="run-hud"><div class="run-hud-g">所持Ｇ：<b>${run.gold}</b></div></div>
    <div class="bubble">${esc(area.name)}へようこそ。${area.fog.chance > 0 ? 'この土地は霧が出ることがある。ショップで払える。' : ''}
      道中で使える「おまかせドラフト」で、まだ持っていないカードをレンタルできる（${dp.round + 1}／3回目）。</div>
    <div class="draft-row">
      ${opts}
      ${draftCardMini(dp.targetId, false)}
    </div>
    <p class="draft-note">入れ替え対象：<b>${esc(target.n)}</b>（自動選択。空白がなければいちばん安いカードから）。
      いちばん右の「${esc(target.n)}」を選べば変更しません。選んだカードはこのラン限定のレンタルです。</p>`;
}

/* ================= マップ画面 ================= */

const NODE_ICON = { chest: '🎁', shop: '🛒', rest: '☕', exchange: '💰', question: '❓', start: '🏠', boss: '👑' };
const NODE_LABEL = { chest: '宝箱', shop: 'ショップ', rest: '休憩', exchange: '換金', question: '？', start: '開始', boss: 'ボス' };
/* マップ演出仕様（2026-08-26確定・マップ仕様書§4.1〜4.2）：戦闘マス／ボスは枠付きカード絵ではなく
 * 背景除去済みの切り抜き（tools/make-cutouts.py で事前生成・assets/cutouts/・assets/masters/*_cut.png）を
 * 台座タイルの上に立たせる。切り抜きが無いカード／エリア追加直後は自動でフォールバックする。 */
const NODE_ICON_IMG = {
  chest: 'assets/map/icon_chest.png', shop: 'assets/map/icon_shop.png',
  rest: 'assets/map/icon_rest.png', exchange: 'assets/map/icon_cash.png'
};

function nodeVisible(n, run) { return !n.fog || run.map.fog.cleared; }

/** 切り抜き画像が404のとき（未生成のカード・開発中のエリア追加直後）、
 * 従来の枠付きカード絵にその場でフォールバックする。 */
function nodeArtFallback(img, cardId) {
  const c = CARD_BY_ID[cardId];
  const div = document.createElement('div');
  div.className = 'node-art-fallback';
  div.innerHTML = artInner(c, 4);
  img.replaceWith(div);
}
if (typeof window !== 'undefined') window.nodeArtFallback = nodeArtFallback;

/** ボス切り抜きが404のとき→通常の肖像（グラデ背景つき）→それも無ければ👑絵文字、の二段フォールバック。 */
function masterCutoutFallback(img, origSrc) {
  img.onerror = function () { img.replaceWith(document.createTextNode('👑')); };
  img.src = origSrc;
  img.classList.remove('node-master-cutout');
  img.classList.add('node-art-fallback-img');
}
if (typeof window !== 'undefined') window.masterCutoutFallback = masterCutoutFallback;

/** マスの中身（台座タイルの上に立つもの）。バッジ・体数ピップも同じ figure 内に置く
 * （figure を position:relative にしてバッジを追従させるため）。 */
function nodeFigureHTML(n, run) {
  /* 開始マスにはアイコンを何も置かない（2026-08-26 本人指定）。台座タイルだけが残る。 */
  if (n.type === 'start') return '';
  const hiddenHere = !nodeVisible(n, run);
  if (n.type === 'battle') {
    /* 霧の中の戦闘マスは「敵の形は見えるが正体は分からない」＝切り抜きをそのまま
     * シルエット加工して出す（マップ仕様書§5。以前は一律「？」で、何がいるのか
     * まったく伝わらなかった）。体数ピップは霧では出さない（同§5）。 */
    const badge = n.strength === 'elite' ? '<span class="node-badge elite">⭐</span>' : '';
    const pip = (n.enemy && !hiddenHere) ? `<span class="node-pip">×${n.enemy.count}</span>` : '';
    if (!n.enemy) return hiddenHere ? '<div class="node-silhouette">？</div>' : '';
    return `<img src="assets/cutouts/${n.enemy.id}.png" class="node-cutout${hiddenHere ? ' silhouette' : ''}"
      alt="" draggable="false" onerror="nodeArtFallback(this, ${n.enemy.id})">${hiddenHere ? '' : badge}${pip}`;
  }
  if (n.type === 'boss') {
    const area = CQAreas.get(run.areaId);
    return `<img src="assets/masters/m_${run.areaId}_cut.png"
      class="node-master-cutout${hiddenHere ? ' silhouette' : ''}" alt="" draggable="false"
      onerror="masterCutoutFallback(this, '${area.master}')">`;
  }
  /* 霧の中の非戦闘マスは「？」（マップ仕様書§5）。何のマスかは入るまで分からない。 */
  if (hiddenHere) return '<div class="node-silhouette">？</div>';
  const imgSrc = NODE_ICON_IMG[n.type];
  if (imgSrc) {
    return `<img src="${imgSrc}" class="node-icon-img" alt="" draggable="false"
      onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'node-icon',textContent:'${NODE_ICON[n.type]}'}))">`;
  }
  return `<div class="node-icon">${NODE_ICON[n.type]}</div>`;
}

/** 道を1本描く（ゆるいベジェで直線を避ける。マップ仕様書§4）。
 * state は '' ／ 'done'（通ってきた道）／ 'pick'（いま選べる道）／ 'dim'（選ばなかった枝）。
 * 2026-08-28 本人指定：縁取りと中央の踏み跡（点線）は無しにして、路面1本だけで描く。 */
function roadSeg(x1, y1, x2, y2, state) {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const bow = Math.min(26, len * 0.09);   /* M6.5b：直線に見えないよう反りを強めた */
  const cx = mx + nx * bow, cy = my + ny * bow;
  const d = `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`;
  return `<path d="${d}" class="road-fill ${state || ''}"/>`;
}

/** そのマスに「もう居た」か（踏破済み、または今まさに立っている）。道の状態判定の土台。 */
function roadVisited(run, n) { return !!(n && (n.cleared || n.id === run.at)); }

/** 辺 a→b の見え方を決める（マップ仕様書§4「通過済みは色を変える・選べる辺はハイライト・
 * 選ばなかった枝は減光」。M6.5bで3状態に整理した）。
 * 判定の要：両端とも「居たことがある」なら実際に歩いた道。合流点があるので、
 * 片方の枝だけ踏んだ場合に反対側の枝が通過済みに見えないよう、両端を見るのが効く。 */
function roadState(run, a, b, pickable) {
  if (roadVisited(run, a) && roadVisited(run, b)) return 'done';
  if (a && a.id === run.at && b && pickable.indexOf(b.id) >= 0) return 'pick';
  if (roadVisited(run, a)) return 'dim';
  return '';
}

/** 経路の描画。セグメント境界（各枝の出口2つ→次の入口2つ、同一のconnectsTo）は
 * 中間の合流点を経由して描くことで、単純な4本の直線が交差して見える問題（旧v0.16.0）を解消する。
 * ロジック（connectsTo）自体には一切手を入れない。純粋に描画だけの処理。 */
function pathSvg(run) {
  const nodes = run.map.nodes;
  const pickable = runChoiceIds(run);
  const bySig = {};
  Object.values(nodes).forEach(function (n) {
    if (n.connectsTo.length === 2) {
      const sig = n.connectsTo.slice().sort().join(',');
      (bySig[sig] = bySig[sig] || []).push(n);
    }
  });
  const segs = [];
  const joints = [];
  const mergedSig = {};
  Object.keys(bySig).forEach(function (sig) {
    const group = bySig[sig];
    if (group.length !== 2) return;
    const ids = sig.split(',');
    const targetA = nodes[ids[0]], targetB = nodes[ids[1]];
    const midX = (group[0].x + group[1].x) / 2 + (targetA.x + targetB.x - group[0].x - group[1].x) / 4;
    const midY = (targetA.y + targetB.y) / 2;
    /* 合流点で切れるので、辺の状態は「入り口側（src→辻）」と「出口側（辻→次のマス）」で別々に見る。
     * 入り口側はそのsrcを通ったか、出口側はその行き先へ進んだかで決まる。 */
    group.forEach(function (src) {
      const st = (roadVisited(run, src) && (roadVisited(run, targetA) || roadVisited(run, targetB))) ? 'done'
        : (src.id === run.at && (pickable.indexOf(targetA.id) >= 0 || pickable.indexOf(targetB.id) >= 0)) ? 'pick'
          : roadVisited(run, src) ? 'dim' : '';
      segs.push(roadSeg(src.x, src.y, midX, midY, st));
    });
    [targetA, targetB].forEach(function (t) {
      const st = roadVisited(run, t) ? 'done'
        : (group.some(function (s) { return s.id === run.at; }) && pickable.indexOf(t.id) >= 0) ? 'pick'
          : group.some(function (s) { return roadVisited(run, s); }) ? 'dim' : '';
      segs.push(roadSeg(midX, midY, t.x, t.y, st));
    });
    /* 合流点そのものを「土の辻」として描く（M6.5b）。
     * 2本入って2本出る接合部は、線を引くだけだと幾何学的にどうしてもＸの交差にしか見えない。
     * 中心に道と同じ色を敷くことで「ここで道が一度1つに集まっている」と読めるようにする。
     * 2026-08-28 本人指定：縁取り無し・楕円ではなく真円・大きさは半分。 */
    joints.push(`<circle cx="${midX}" cy="${midY}" r="15" class="road-joint"/>`);
    mergedSig[sig] = true;
  });
  Object.values(nodes).forEach(function (n) {
    const sig = n.connectsTo.length === 2 ? n.connectsTo.slice().sort().join(',') : null;
    if (sig && mergedSig[sig]) return;
    n.connectsTo.forEach(function (toId) {
      const t = nodes[toId];
      segs.push(roadSeg(n.x, n.y, t.x, t.y, roadState(run, n, t, pickable)));
    });
  });
  /* 辻は道より後に描いて上に載せる（道の端を隠して1つの広場に見せるため） */
  return `<svg class="run-paths" viewBox="0 0 1280 800" preserveAspectRatio="none">${segs.join('')}${joints.join('')}</svg>`;
}

/** 霧のレイヤー（マップ仕様書§5）。範囲は第2セグメント以降＝霧のかかったマスのうち
 * いちばん左のものの手前から右端まで。左端はグラデーションで自然に薄れさせる。
 * 2枚を別々の速さで漂わせて奥行きを出す。霧払いを買った直後は dissolving を付けて溶かす。 */
function fogLayerHTML(run) {
  const fog = run.map.fog;
  if (!fog.active) return '';
  if (fog.cleared && !RUI.fogDissolving) return '';
  const foggyX = Object.values(run.map.nodes).filter(function (n) { return n.fog; }).map(function (n) { return n.x; });
  if (!foggyX.length) return '';
  /* いちばん左の霧マスの少し手前から霧が立ちこめている、という見え方にする */
  const startPct = Math.max(0, (Math.min.apply(null, foggyX) - 150) / 1280 * 100);
  return `<div class="fog-layer${RUI.fogDissolving ? ' dissolving' : ''}"
      style="--fog-start:${startPct.toFixed(1)}%">
    <div class="fog-band fog-band-a"></div>
    <div class="fog-band fog-band-b"></div>
  </div>`;
}

function runChoiceIds(run) {
  const cur = CQRun.currentNode(run);
  if (!cur.cleared) return [cur.id];
  return cur.connectsTo;
}

/** 現在地に立つプレイヤーのコマ。常時アイドルで小さく揺れる（マップ仕様書§4.2）。 */
function playerTokenHTML(run, walking) {
  const n = run.map.nodes[run.at];
  return `<div class="player-token ${walking ? 'walking' : 'idle'}"
      style="left:${(n.x / 1280 * 100).toFixed(2)}%; top:${(n.y / 800 * 100).toFixed(2)}%">
    <img src="assets/map/player.png" alt="" draggable="false"
      onerror="this.replaceWith(document.createTextNode('🚶'))"></div>`;
}

function renderMap() {
  const run = RUI.run, area = CQAreas.get(run.areaId);
  const pickable = runChoiceIds(run);
  const nodesHTML = run.map.order.map(function (id) {
    const n = run.map.nodes[id];
    const can = pickable.indexOf(id) >= 0 && !n.cleared;
    const done = n.cleared;
    const delay = ((id.charCodeAt(1) * 37) % 900) / 1000;
    return `<div class="map-node ${n.type} ${n.strength || ''} ${can ? 'pickable' : ''} ${done ? 'done' : ''} ${n.fog && !run.map.fog.cleared ? 'foggy' : ''}"
        style="left:${(n.x / 1280 * 100).toFixed(2)}%; top:${(n.y / 800 * 100).toFixed(2)}%; animation-delay:${delay}s"
        data-act="node" data-id="${id}">
      <div class="node-figure">${nodeFigureHTML(n, run)}</div>
      <div class="node-tile"></div>
    </div>`;
  }).join('');
  /* HUD（マップ仕様書§4「上部はHUD（エリア名・ＬＰ・Ｇ・リタイヤ）約70px」）。
   * エリア名を主役に置き、ＬＰは残量が一目で分かるゲージ付き、Ｇは数字を大きく。
   * 霧が出ている日は名前の右に印を出す（霧払いを買うと消える）。 */
  const inFog = run.map.fog.active && !run.map.fog.cleared;
  const lpPct = Math.max(0, Math.min(100, run.lp / run.maxLp * 100));
  const lpLow = run.lp <= Math.max(1, Math.round(run.maxLp * 0.3));
  runRoot().innerHTML = `
    <div class="map-hud">
      <div class="map-hud-area">
        <span class="map-hud-area-name">${esc(area.name)}</span>
        ${inFog ? '<span class="map-hud-fog">霧の中</span>' : ''}
      </div>
      <div class="map-hud-stats">
        <div class="map-hud-lp ${lpLow ? 'low' : ''}">
          <span class="map-hud-lp-icon">♥</span>
          <span class="map-hud-lp-num"><b>${run.lp}</b><small>／${run.maxLp}</small></span>
          <span class="map-hud-lp-bar"><i style="width:${lpPct.toFixed(1)}%"></i></span>
        </div>
        <div class="map-hud-g"><span class="map-hud-g-icon">Ｇ</span><b>${run.gold}</b></div>
      </div>
      <button class="map-hud-retire" data-act="retire">リタイヤ</button>
    </div>
    <div class="run-map" style="background-image:url('${area.bg}')">
      ${pathSvg(run)}
      ${nodesHTML}
      ${playerTokenHTML(run, false)}
      ${fogLayerHTML(run)}
    </div>
    <div class="run-log">${(run.log.slice(-3).map(function (l) { return '<div>・' + esc(l) + '</div>'; })).join('')}</div>`;
  /* 溶ける演出は1度だけ。アニメが終わる頃にフラグを下ろす（以後の描画では霧そのものを出さない）。
   * ここで再描画はしない——CSSが opacity:0 まで持っていって forwards で止まるため、
   * 消えた見た目のまま次の操作（マスを選ぶ等）の描画で自然に居なくなる。 */
  if (RUI.fogDissolving) setTimeout(function () { RUI.fogDissolving = false; }, 1500);
}

/** ノードidから盤面座標（%）を得る（歩行アニメの起点・終点計算用） */
function nodePct(run, id) {
  const n = run.map.nodes[id];
  return { x: (n.x / 1280 * 100), y: (n.y / 800 * 100) };
}

/** クリックしたマスへ、コマが上下に跳ねながら歩いて移動する演出。終わったら done() を呼ぶ。
 * マップ画面が実際にDOM上にあるとき（＝マップから分岐先をクリックした瞬間）だけ再生し、
 * それ以外（開始マスからの出発など、マップがまだ無い場面）は演出をスキップして即座に進む。 */
function playerWalk(run, fromId, toId, done) {
  const mapEl = runRoot().querySelector('.run-map');
  if (!mapEl || fromId === toId) { done(); return; }
  const tok = document.createElement('div');
  const from = nodePct(run, fromId), to = nodePct(run, toId);
  tok.className = 'player-token walking';
  tok.style.left = from.x + '%'; tok.style.top = from.y + '%';
  tok.innerHTML = '<img src="assets/map/player.png" alt="" draggable="false" onerror="this.remove()">';
  const existing = mapEl.querySelector('.player-token');
  if (existing) existing.remove();
  mapEl.appendChild(tok);
  void tok.offsetWidth;
  requestAnimationFrame(function () { tok.style.left = to.x + '%'; tok.style.top = to.y + '%'; });
  setTimeout(done, 460);
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
  const returned = run.rentals.map(function (id) {
    return '<span class="rental-badge-inline">借</span>' + esc(CARD_BY_ID[id].n);
  });
  const gained = run.gainedCards.map(function (id) { return CARD_BY_ID[id].n; });
  runRoot().innerHTML = `
    <div class="node-panel">
      <h3 class="${win ? 'run-win' : 'run-lose'}">${title}</h3>
      <p>所持Ｇ：${run.gold}</p>
      ${gained.length ? `<p>獲得カード：${gained.map(esc).join('・')}</p>` : ''}
      ${returned.length ? `<p>返却（レンタル）：${returned.join('・')}</p>` : ''}
      <button class="btn ok" data-act="back-home">エリア選択へ</button>
    </div>`;
}

/* ================= 描画のふりわけ ================= */

function runRender() {
  const el = runRoot();
  if (!el) return;
  if (RUI.run && RUI.run.outcome) RUI.view = 'result';
  if (RUI.view === 'opening') renderOpening();
  else if (RUI.view === 'areaSelect') renderAreaSelect();
  else if (RUI.view === 'start') renderStart();
  else if (RUI.view === 'map') renderMap();
  else if (RUI.view === 'node') renderNode();
  else if (RUI.view === 'result') renderResult();
}

/** confirm() は他ブラウザ機能とバッティングしタブレットで不安定なため、
 * ゲーム内の簡易ダイアログに置き換える（M6.5a）。 */
function showConfirm(message, onYes, yesLabel) {
  const ov = document.createElement('div');
  ov.className = 'cq-confirm-overlay';
  const lines = String(message).split('\n').map(esc).join('<br>');
  ov.innerHTML = `<div class="cq-confirm-box">
    <p>${lines}</p>
    <div class="cq-confirm-btns">
      <button class="tiny" data-act="cq-confirm-no">やめる</button>
      <button class="btn ok" data-act="cq-confirm-yes">${esc(yesLabel || 'はい')}</button>
    </div>
  </div>`;
  /* #app の外（document.body直下）に position:fixed で置くと、画面が小さくて
   * #app ごと縮小表示されているとき（--app-scale）だけこのダイアログが縮尺に従わず
   * 実寸のまま出てしまい、周りに対して大きすぎる／画面をはみ出す（2026-08-26 本人指摘）。
   * #flash と同じ理由・同じ直し方：#app の中に position:absolute で入れ、#app の
   * transform:scale と一緒に縮む/動くようにする。 */
  (document.getElementById('app') || document.body).appendChild(ov);
  ov.addEventListener('click', function (ev) {
    const t = ev.target.closest('[data-act]');
    if (!t) return;
    if (t.dataset.act === 'cq-confirm-yes') { ov.remove(); onYes(); }
    else if (t.dataset.act === 'cq-confirm-no') ov.remove();
  });
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
    case 'opening-next': {
      RUI.openingIntroDone = true;
      const next = (RUI.openingStep || 0) + 1;
      if (next >= OPENING_SCRIPT.length) {
        /* 最後の吹き出しの後はフェードアウトしてからエリア選択へ（§4 WP1のフロー） */
        RUI.openingFadeOut = true;
        runRender();
        setTimeout(finishOpening, 620);
        return;
      }
      RUI.openingStep = next;
      return runRender();
    }
    case 'opening-skip':
      /* 「押したら即マップ選択へ」（§4 WP1）。タップ送り終了時のフェードアウトは挟まない */
      return finishOpening();
    case 'go-start': {
      const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
      RUI.run = CQRun.start(CARD_BY_ID, id, seed, RUI.meta);
      RUI.view = 'start';
      runSave();
      return runRender();
    }
    case 'pick-draft':
      CQRun.applyDraft(run, +id, CARD_BY_ID);
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
      const fromId = run.at;
      return playerWalk(run, fromId, id, function () {
        /* そのマスへ実際に進む（＝現在地を更新する）。これをしないと「解決はしたが
         * 分岐を選んでいない」状態のまま両方の選択肢を同時に取れてしまう（2択の意味が崩れる） */
        const adv = CQRun.advance(run, id);
        if (!adv.ok) { runFlash(adv.reason); return runRender(); }
        RUI.nodeId = id; RUI.view = 'node';
        runSave();
        runRender();
      });
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
      /* 霧が晴れる瞬間はマップを見ていない（ショップの画面にいる）ので、次にマップへ戻ったとき
       * 1度だけ溶ける演出を再生する（マップ仕様書§5「opacityで溶ける演出」）。 */
      if (r.ok) RUI.fogDissolving = true;
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
      return showConfirm('ここでリタイヤしますか？\nここまでの所持Ｇ・カードは持ち帰れます。', function () {
        CQRun.retire(run);
        CQRun.settle(run, RUI.meta);
        CQSave.saveMeta(RUN_STORAGE, RUI.meta);
        CQSave.clearRun(RUN_STORAGE);
        RUI.view = 'result';
        runRender();
      }, 'リタイヤする');
    case 'back-home':
      RUI.run = null; RUI.view = 'areaSelect';
      return runRender();
    /* M6.6 WP2：確認用の開発機能（エリア選択画面右下）。誤爆防止のため確認ダイアログを1段挟む。
     * 記録を消したら必ずリロードする（cq_meta が無い状態から runInit → loadMeta が既定デッキで
     * 作り直すのに任せる。中途半端に RUI を作り替えるより確実）。 */
    case 'reset-progress':
      return showConfirm(
        'すべての記録を消して最初から始めます。よろしいですか？',
        function () {
          CQSave.clearMeta(RUN_STORAGE);
          CQSave.clearRun(RUN_STORAGE);
          location.reload();
        },
        'はい'
      );
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
