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
  fogDissolving: false,
  /* 開始マスの段階（M6.6 WP4）：'guide'（案内）→'carry'（持ち出し）→'draft'（ドラフト）。
   * guide/carry の作業用の状態もここに持つ（cq_run には保存しない＝再開時は組み直す）。 */
  startStage: null, guide: null, guideStep: 0,
  /* 持ち出し画面の表の状態（タブ・並べ替え・絞り込み・表示列・選択中のカード）。
   * 表示列は screen-deck と同じくグループ（U／MS）ごとに持つ。 */
  carryTab: 'U', carryOnly: false, carrySel: null,
  carrySort: { key: 'p', asc: true },
  carryFilters: {},
  carryShown: { U: {}, MS: {} },
  /* 出発の明転を1度だけ再生するためのフラグ（§4 WP4「暗転→明転のtransition」） */
  mapFadeIn: false,
  /* 戦闘導入カットイン（M6.6 WP5）：「たたかう／挑む」を押してから実際にバトル画面へ
   * 切り替わるまでの一瞬だけ使う作業用の状態。cq_run には保存しない（保存中に途切れても
   * 単に演出が飛ぶだけで、再開時は素直にマップへ戻る）。 */
  battleIntroNodeId: null, battleIntroLeaving: false,
  /* 休憩・宝箱のカットイン（M6.6 WP8）用。battleIntro系と同じ役割の作業用の状態。
   * eventIntroResult は「効果を1回だけ確定させる」ためのガード（CQRun.openChest/rest の
   * 呼び出しをこの演出の最初の描画だけに限定する）。 */
  eventIntroNodeId: null, eventIntroLeaving: false, eventIntroKind: null, eventIntroResult: null,
  /* デバッグメニューの「戦闘開始シーンを再生」中だけ入る。入っていると、カットインが
   * 終わっても実戦闘へは進まず、元の画面（battleIntroBackTo）に戻ってコールバックを呼ぶ。 */
  battleIntroPreview: null, battleIntroBackTo: null,
  /* デバッグメニューの「目覚めの場面を見返す」中だけ入る（2026-08-29）。入っていると、
   * 台本を最後まで見る／スキップしたときに openingSeen を書き換えず、元の画面
   * （openingBackTo）に戻ってコールバックを呼ぶ。previewBattleIntro と同じ形。 */
  openingPreview: null, openingBackTo: null
};

function runRoot() { return document.getElementById('run-root'); }
function runSave() { if (RUI.run) CQSave.saveRun(RUN_STORAGE, RUI.run); }
/** 短いお知らせを画面に出す。js/layout.js の flash()（#flash のトースト）をそのまま使う。
 * 2026-08-29 修正：以前は RUI.flash に文字列を入れるだけで、どこも描画していなかったため
 * 「本にありません」「デッキは40枚までです」等のメッセージが一切出ていなかった。 */
function runFlash(msg) {
  RUI.flash = msg;
  if (typeof flash === 'function') flash(msg);
}

/** 開始マスに入る（または中断からそこへ戻る）ときの段階を決める（M6.6 WP4）。
 * fresh＝ラン開始直後なら案内から。再開のときは、案内は見た後なので持ち出しから
 * （ドラフトが始まっていればドラフトから）再開する。 */
/** 持ち出し画面の表の状態を初期化する（表示列は各列定義の def どおりに戻す）。 */
function carryResetTable() {
  RUI.carryTab = 'U';
  RUI.carryOnly = false;
  RUI.carrySel = null;
  RUI.carrySort = { key: 'p', asc: true };
  RUI.carryFilters = {};
  RUI.carryShown = { U: {}, MS: {} };
  Object.keys(CARRY_COLS).forEach(function (g) {
    CARRY_COLS[g].forEach(function (c) { RUI.carryShown[g][c.k] = c.def; });
  });
}

function enterStartNode(fresh) {
  const run = RUI.run;
  RUI.guideStep = 0;
  carryResetTable();
  if (fresh) {
    RUI.guide = buildGuideBefore(run, RUI.meta);
    RUI.startStage = RUI.guide.length ? 'guide' : 'carry';
  } else {
    RUI.guide = null;
    RUI.startStage = (run.draftDone > 0 || run.draftPending) ? 'draft' : 'carry';
  }
}

function runInit() {
  RUI.meta = CQSave.loadMeta(RUN_STORAGE, STARTER_BOOK);
  const saved = CQSave.loadRun(RUN_STORAGE);
  /* M6.6 WP7：ボス撃破は勝利確定と同時に run.outcome='win' が立つが、戦利品の振り分け
   * （lootPending）が残っているうちは settle() 前＝まだ「進行中のラン」として扱う
   * （さもないと結果画面に飛ばされずこの run 自体を見失う）。 */
  if (saved && (!saved.outcome || (saved.lootPending && saved.lootPending.length))) {
    RUI.run = saved;
    /* 出発済みかどうかで戻り先を変える（M6.6 WP4）。開始マスは案内＋持ち出し＋ドラフトと
     * 長くなったので、その途中で再読み込みしてもマップへ飛ばされないようにする
     * （depart() が開始マスを cleared にするので、それが出発済みの印になる）。 */
    if (saved.lootPending && saved.lootPending.length) { RUI.view = 'loot'; }
    else if (saved.map.nodes[saved.map.start].cleared) { RUI.view = 'map'; }
    else { RUI.view = 'start'; enterStartNode(false); }
  } else if (!RUI.meta.openingSeen) {
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
 * openingSeen を立てて保存し、以後は起動しても出ない。
 * ただしデバッグメニューからの見返し中（RUI.openingPreview）は、既に見た場面を
 * もう一度見せているだけなので openingSeen には触れず、元いた画面へ戻ってコールバックを呼ぶ。 */
function finishOpening() {
  if (RUI.openingPreview) {
    const cb = RUI.openingPreview;
    RUI.openingPreview = null;
    RUI.view = RUI.openingBackTo || 'areaSelect';
    RUI.openingBackTo = null;
    RUI.openingStep = 0; RUI.openingIntroDone = false; RUI.openingFadeOut = false;
    runRender();
    cb();
    return;
  }
  RUI.meta.openingSeen = true;
  CQSave.saveMeta(RUN_STORAGE, RUI.meta);
  RUI.view = 'areaSelect';
  RUI.openingStep = 0; RUI.openingIntroDone = false; RUI.openingFadeOut = false;
  runRender();
}

/** デバッグメニュー用：冒頭の目覚めの場面（アンバーと初めて出会って話す場面）だけを
 * 最初から再生し、終わったら元の画面に戻って onDone() を呼ぶ。cq_meta.openingSeen や
 * ラン（RUI.run）の状態には一切触れない＝「後で振り返りたい」ときに何度でも見返せる。
 * js/debug.js から呼ぶ。 */
function previewOpening(onDone) {
  RUI.openingBackTo = RUI.view;
  RUI.openingPreview = onDone || function () {};
  RUI.openingStep = 0; RUI.openingIntroDone = false; RUI.openingFadeOut = false;
  RUI.view = 'opening';
  runRender();
  return { ok: true };
}
if (typeof window !== 'undefined') window.previewOpening = previewOpening;

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

/* ================= 開始マス（M6.6 WP4） =================
 *
 * 『実装計画追補M6.6』§4 WP4 の新フロー：
 *   ① アンバーの案内（吹き出し・タップ送り・スキップ可）
 *   ② 持ち出し＝デッキ編集（本→デッキへ移す。ここが唯一の編集機会）
 *   ③ おまかせドラフト（最大2回・空白がある時だけ）
 *   ④ 出発ボタンは置かず、暗転→明転でそのままマップへ
 * 段階は RUI.startStage（'guide'|'carry'|'draft'）で持つ。 */

/* ---- ① アンバーの案内 ---- */

/** 初回訪問か（cq_meta.visits はラン開始時に加算済みなので、1なら今回が初回）。 */
function firstVisitHere(run, meta) { return CQSave.visitCount(meta, run.areaId) <= 1; }

/** ①持ち出しの前に出す案内（2026-08-28 本人指定）。
 * エリア導入（台本§3.1/§4.1・§3.2/§4.2）→ 今日の状況（霧＝§4.3／戦場ルール＝追補§5-2）
 * → 持ち出しの説明（§5-3・初回だけ）。デッキを組む判断に要る話をここに集めている。 */
function buildGuideBefore(run, meta) {
  const L = CQLore.LORE;
  const area = L.areas[run.areaId];
  if (!area) return [];
  let out = firstVisitHere(run, meta) ? area.first.slice() : CQLore.pickOne(area.repeat).slice();
  /* 霧の日は追加で1つ（台本§4.3） */
  if (run.map.fog.active && !run.map.fog.cleared && area.fog) out = out.concat(area.fog);
  /* 戦場ルールが付いている日も追加で1つ。おじゃま虫の日は専用の文に差し替える（追補§5-2） */
  const rules = [];
  Object.values(run.map.nodes).forEach(function (n) {
    (n.fieldRules || []).forEach(function (r) { rules.push(r.id); });
  });
  if (rules.length) {
    out = out.concat(rules.indexOf('pestCard') >= 0 ? L.common.pest : L.common.fieldRule);
  }
  /* 持ち出しの説明は一度だけ（§5-3）。この直後がデッキ編集なので最後に置く */
  if (!CQSave.hintSeen(meta, 'carryOut')) out = out.concat(L.hints.carryOut);
  return out;
}

/** ②出発の直前に出す案内（2026-08-28 本人指定）。
 * マスター紹介（追補§5-2）→ 送り出し（台本§3.1-3／§4.1-3）。どちらも初回のみ。
 * 2回目以降は空になり、そのまま出発する（台本§3.2/§4.2の短縮版は①で言い切っているため）。 */
function buildGuideAfter(run, meta) {
  const area = CQLore.LORE.areas[run.areaId];
  if (!area || !firstVisitHere(run, meta)) return [];
  return (area.masterIntro || []).concat(area.depart || []);
}

/** アンバーの吹き出し1つ（肖像＋本文＋タップ送り）。マップの上に重ねる前提の部品。
 * 2026-08-28 本人指定：暗転ではなく**マップを出したまま、上部に半透明の吹き出し**を出す。
 * 「道は二つに分かれる」といった案内が、その場の実際のマップを見ながら読める。
 * ※ マップ仕様書§4.3の「吹き出しは共通部品」に沿った作り。M6.5cで❓イベント・敵/NPCの
 *   一言にも同じものを使えるよう、face（calm/down）とタップ送りだけを引数にしてある。 */
function amberBubbleHTML(bubble, opts) {
  const o = opts || {};
  const portrait = bubble.face === 'down' ? 'assets/chars/amber_down.png' : 'assets/chars/amber_calm.png';
  const lines = bubble.lines.map(esc).join('<br>');
  return `<div class="amber-overlay" ${o.nextAct ? `data-act="${o.nextAct}"` : ''}>
    ${o.skipAct ? `<button class="amber-skip" data-act="${o.skipAct}">スキップ</button>` : ''}
    <div class="amber-row">
      <img class="amber-face" src="${portrait}" alt="" draggable="false" onerror="this.remove()">
      <div class="amber-bubble">
        <div class="amber-lines">${lines}</div>
        ${o.nextAct ? '<div class="amber-tap-hint">タップして進む</div>' : ''}
      </div>
    </div>
  </div>`;
}

function renderStartGuide() {
  const script = RUI.guide || [];
  const b = script[Math.min(RUI.guideStep || 0, script.length - 1)];
  if (!b) return finishStartGuide();
  /* 案内中のマップは「見せるだけ」＝マスは押せない（まだ出発していないので選べない）。 */
  runRoot().innerHTML = mapHudHTML(RUI.run, false)
    + mapBoardHTML(RUI.run, false, amberBubbleHTML(b, { nextAct: 'guide-next', skipAct: 'guide-skip' }));
}

/** 案内の1つ分を終える。①のあとは持ち出しへ、②のあとは出発する。
 * 持ち出しのヒントは見せた時点で既読にする（二度と出さない・台本§5）。 */
function finishStartGuide() {
  RUI.guide = null; RUI.guideStep = 0;
  if (RUI.startStage === 'guide2') return departToMap();
  CQSave.markHint(RUI.meta, 'carryOut');
  CQSave.saveMeta(RUN_STORAGE, RUI.meta);
  RUI.startStage = 'carry';
  runRender();
}

/** ドラフトまで終わったので、出発前の②を出す（無ければそのまま出発）。 */
function enterGuideAfter() {
  const script = buildGuideAfter(RUI.run, RUI.meta);
  if (!script.length) return departToMap();
  RUI.guide = script; RUI.guideStep = 0;
  RUI.startStage = 'guide2';
  return runRender();
}

function startHudHTML(run) {
  return `<div class="run-hud"><div class="run-hud-g">所持Ｇ：<b>${run.gold}</b></div>
    <div class="run-hud-lp">♥ ${run.lp}／${run.maxLp}</div></div>`;
}

/* ---- ② 持ち出し（デッキ編集） ----
 *
 * §4 WP4-2。既存のデッキ編集画面（screen-deck）は独立した開発用の画面で、独自の deck 変数を
 * 持っている。ここで必要なのは「本↔デッキの移動」という別のデータモデルなので、
 * あちらのロジックは触らず、**見た目の作り（表・タイプタブ・詳細ペイン）だけ流用**して
 * ラン画面の中に作る。移動そのものは js/meta/collection.js（WP3で新設）に任せる。
 *
 * 表示の規則：
 *   - 既知（known）のカードだけを出す。**所持0でも出す**（売り切った／全部デッキに出した
 *     カードが一覧から消えないように）。未入手カードは出さない
 *   - 「本」＝持ち出せる残り、「デッキ」＝持ち出し済み、の2値を同時に見せる
 *   - 同種3枚まで（ピッグマン(8)だけ無制限）・合計40枚まで。上限は＋ボタンの活殺で示す
 */

const CARRY_TABS = [
  { t: 'U', label: '⚔ モンスター' },
  { t: 'M', label: '✦ 魔法' },
  { t: 'S', label: '✚ 技能' }
];

/* 列の定義（デッキ編集画面 screen-deck の ALL_COLS と同じ考え方）。
 *   fixed … 消せない列（カード名・本・移動・デッキ）
 *   def   … 既定で表示する
 *   type  … text＝含む文字で絞る／range＝≧≦で絞る／move＝◀▶ボタン（並べ替え・絞り込みなし）
 * モンスターと魔法・技能で持っている項目が違うので、2つのグループに分ける。 */
const CARRY_COLS = {
  U: [
    { k: 'n', label: 'カード名', w: 200, type: 'text', fixed: true, def: true },
    { k: 'a', label: '攻撃力', w: 84, type: 'range', def: true },
    { k: 'd', label: '防御力', w: 84, type: 'range', def: true },
    { k: 'ch', label: 'ＣＨ数', w: 78, type: 'range', def: false },
    { k: 'lv', label: '召還Ｌｖ', w: 84, type: 'range', def: false },
    { k: 'e', label: '特殊能力', w: 0, type: 'text', def: true },
    { k: 'p', label: '価格', w: 88, type: 'range', def: false },
    { k: 'book', label: '本', w: 62, type: 'range', fixed: true, def: true },
    { k: 'move', label: '', w: 96, type: 'move', fixed: true, def: true },
    { k: 'deck', label: 'デッキ', w: 70, type: 'range', fixed: true, def: true }
  ],
  MS: [
    { k: 'n', label: 'カード名', w: 200, type: 'text', fixed: true, def: true },
    { k: 'e', label: '効果', w: 0, type: 'text', def: true },
    { k: 'p', label: '価格', w: 96, type: 'range', def: false },
    { k: 'book', label: '本', w: 62, type: 'range', fixed: true, def: true },
    { k: 'move', label: '', w: 96, type: 'move', fixed: true, def: true },
    { k: 'deck', label: 'デッキ', w: 70, type: 'range', fixed: true, def: true }
  ]
};

function carryGrp() { return (RUI.carryTab === 'U') ? 'U' : 'MS'; }
function carryCols() {
  const g = carryGrp();
  return CARRY_COLS[g].filter(function (c) { return RUI.carryShown[g][c.k]; });
}

/** 表に出す行。既知のカードだけ・所持0でも出す（§4 WP4-2）。
 * 本/デッキの枚数は行ごとの派生値なので、絞り込み・並べ替えのためにここで載せておく。 */
function carryRows() {
  const meta = RUI.meta;
  const g = carryGrp();
  const f = RUI.carryFilters;
  const rows = (meta.known || [])
    .map(function (id) { return CARD_BY_ID[id]; })
    .filter(function (c) { return c && c.t === (RUI.carryTab || 'U'); })
    .map(function (c) {
      const o = Object.create(c);
      o.book = meta.book[c.id] || 0;
      o.deck = meta.deck[c.id] || 0;
      return o;
    })
    .filter(function (c) {
      if (RUI.carryOnly && c.deck <= 0) return false;
      for (let i = 0; i < CARRY_COLS[g].length; i++) {
        const col = CARRY_COLS[g][i];
        if (col.type === 'text' && f[col.k]) {
          if (String(c[col.k] || '').indexOf(f[col.k]) < 0) return false;
        }
        if (col.type === 'range') {
          const mn = parseFloat(f[col.k + '_min']), mx = parseFloat(f[col.k + '_max']);
          const v = Number(c[col.k]);
          if (!isNaN(mn) && !(v >= mn)) return false;
          if (!isNaN(mx) && !(v <= mx)) return false;
        }
      }
      return true;
    });
  const key = RUI.carrySort.key, asc = RUI.carrySort.asc;
  rows.sort(function (x, y) {
    const a = x[key], b = y[key];
    const r = (typeof a === 'number' && typeof b === 'number')
      ? a - b : String(a == null ? '' : a).localeCompare(String(b == null ? '' : b), 'ja');
    return (asc ? r : -r) || (x.id - y.id);
  });
  return rows;
}

/** 1行分のセル。◀＝デッキ→本（置いていく）／▶＝本→デッキ（持ち出す）。
 * 2026-08-28 本人指定：−＋ではなく三角にし、本とデッキの数字の**あいだ**に置いて
 * 「どちらへ動くか」が向きで分かるようにする。 */
function carryRowHTML(c, cols) {
  const meta = RUI.meta;
  const canAdd = c.book > 0 && CQCollection.canAddToDeck(meta.deck, c.id).ok;
  const cells = cols.map(function (col) {
    if (col.k === 'move') {
      return `<td class="carry-move"><div class="carry-arrows">
        <button class="carry-arrow" data-act="carry-to-book" data-id="${c.id}" ${c.deck === 0 ? 'disabled' : ''}
          title="デッキから本へ戻す">◀</button>
        <button class="carry-arrow" data-act="carry-to-deck" data-id="${c.id}" ${canAdd ? '' : 'disabled'}
          title="本からデッキへ持ち出す">▶</button>
      </div></td>`;
    }
    if (col.k === 'book') return `<td class="num carry-book ${c.book === 0 ? 'zero' : ''}">${c.book}</td>`;
    if (col.k === 'deck') return `<td class="num carry-deck ${c.deck > 0 ? 'has' : ''}">${c.deck}</td>`;
    if (col.k === 'n') return `<td class="nm"><span class="chip ${c.t}">${TYPE_MARK[c.t]}</span>${esc(c.n)}</td>`;
    if (col.k === 'e') return `<td class="ef-cell">${esc(c.e || '')}</td>`;
    if (col.type === 'range') return `<td class="num">${c[col.k] == null ? '' : c[col.k]}</td>`;
    return `<td>${esc(String(c[col.k] == null ? '' : c[col.k]))}</td>`;
  }).join('');
  return `<tr class="${c.deck > 0 ? 'in-deck' : ''} ${c.id === RUI.carrySel ? 'on' : ''}"
    data-act="carry-pick" data-id="${c.id}">${cells}</tr>`;
}

/** 右の詳細ペイン（screen-deck の .detail と同じ体裁）。イラストと全項目を出す。 */
function carryDetailHTML() {
  const c = CARD_BY_ID[RUI.carrySel];
  if (!c) return '<div class="carry-detail-empty">カードを選ぶと、ここに絵と詳細が出ます。</div>';
  const meta = RUI.meta;
  const stat = c.t === 'U'
    ? `<span>攻撃力 ${c.a}</span><span>防御力 ${c.d}</span>
       <span>ＣＨ ${c.ch}</span><span>召還Ｌｖ ${c.lv}</span><span>${c.p} G</span>`
    : `<span>${TYPE_NAME[c.t]}</span><span>${c.p} G</span>`;
  return `
    <div class="big ${c.t}">
      <div class="bigart">${artInner(c)}</div>
      <div class="bn">${esc(c.n)}</div>
      <div class="bstat">${stat}</div>
      <div class="btext">${esc(c.e || '')}</div>
    </div>
    <div class="carry-detail-counts">
      <span>本 <b>${meta.book[c.id] || 0}</b></span>
      <span>デッキ <b>${meta.deck[c.id] || 0}</b></span>
      ${+c.id === CQCollection.PIG ? '<span class="carry-detail-note">枚数制限なし</span>'
      : `<span class="carry-detail-note">同じカードは${CQCollection.KIND_MAX}枚まで</span>`}
    </div>
    <div class="obt"><h4>入手方法</h4>
      <div class="obtain">${esc(c.g || '')}</div></div>`;
}

/** 表の中身（行・件数・詳細）だけを描き直す。絞り込みの入力欄が再描画で
 * フォーカスを失わないよう、入力のたびに全画面を作り直さないための入口。 */
function carryRefreshBody() {
  const root = runRoot();
  const tb = root.querySelector('.carry-table tbody');
  const detail = root.querySelector('.carry-detail');
  const counts = root.querySelector('.carry-counts');
  if (!tb) return renderCarryOut();
  const cols = carryCols();
  const rows = carryRows();
  tb.innerHTML = rows.length
    ? rows.map(function (c) { return carryRowHTML(c, cols); }).join('')
    : `<tr><td colspan="${cols.length}" class="carry-empty">条件に合うカードがありません。</td></tr>`;
  if (detail) detail.innerHTML = carryDetailHTML();
  if (counts) {
    counts.innerHTML = `<span>${rows.length} 種を表示</span>
      <span>デッキ <b>${CQCollection.deckTotal(RUI.meta)}</b>／${CQCollection.DECK_MAX}</span>
      <span class="carry-blank">空白カード <b>${CQCollection.blankCount(RUI.meta)}</b>枚</span>`;
  }
}

function renderCarryOut() {
  const meta = RUI.meta;
  const g = carryGrp();
  const cols = carryCols();
  const rows = carryRows();
  const tabs = CARRY_TABS.map(function (t) {
    return `<button class="dtab ${t.t} ${RUI.carryTab === t.t ? 'on' : ''}"
      data-act="carry-tab" data-id="${t.t}">${t.label}</button>`;
  }).join('');
  /* 表示する列の切り替え（screen-deck の colbar と同じ操作感） */
  const colbar = '<span class="cap">表示する列</span>' + CARRY_COLS[g].map(function (c) {
    if (!c.label) return '';
    return `<button class="colchip ${RUI.carryShown[g][c.k] ? 'on' : ''} ${c.fixed ? 'fixed' : ''}"
      ${c.fixed ? 'disabled' : `data-act="carry-col" data-id="${c.k}"`}>${c.label}</button>`;
  }).join('');
  /* 見出し（クリックで並べ替え）と、その下の絞り込み行 */
  const head = cols.map(function (c) {
    const arrow = RUI.carrySort.key === c.k ? `<span class="arrow">${RUI.carrySort.asc ? '▲' : '▼'}</span>` : '';
    const w = c.w ? ` style="width:${c.w}px"` : '';
    const numish = (c.type === 'range') ? ' num' : '';
    if (c.type === 'move') return `<th class="carry-move"${w}></th>`;
    return `<th class="sortable${numish}"${w} data-act="carry-sort" data-id="${c.k}">${c.label}${arrow}</th>`;
  }).join('');
  const filterRow = cols.map(function (c) {
    if (c.type === 'text') {
      return `<th><input class="carry-f" data-f="${c.k}" placeholder="含む文字"
        value="${esc(RUI.carryFilters[c.k] || '')}"></th>`;
    }
    if (c.type === 'range') {
      return `<th><div class="rng">
        <input class="carry-f" data-f="${c.k}_min" placeholder="≧" value="${esc(RUI.carryFilters[c.k + '_min'] || '')}">
        <input class="carry-f" data-f="${c.k}_max" placeholder="≦" value="${esc(RUI.carryFilters[c.k + '_max'] || '')}">
      </div></th>`;
    }
    return '<th class="carry-move"></th>';
  }).join('');
  const body = rows.length
    ? rows.map(function (c) { return carryRowHTML(c, cols); }).join('')
    : `<tr><td colspan="${cols.length}" class="carry-empty">条件に合うカードがありません。</td></tr>`;

  runRoot().innerHTML = `
    <div class="carry-head">
      <div class="carry-title">持ち出すカードを選ぶ</div>
      <div class="carry-counts">
        <span>${rows.length} 種を表示</span>
        <span>デッキ <b>${CQCollection.deckTotal(meta)}</b>／${CQCollection.DECK_MAX}</span>
        <span class="carry-blank">空白カード <b>${CQCollection.blankCount(meta)}</b>枚</span>
      </div>
      <button class="carry-auto" data-act="carry-auto">おまかせで選ぶ</button>
      <button class="btn ok carry-done" data-act="carry-done">デッキの編集を終える</button>
    </div>
    <div class="carry-wrap">
      <div class="carry-main">
        <div class="carry-tabs">
          ${tabs}
          <button class="only-btn ${RUI.carryOnly ? 'on' : ''}" data-act="carry-only">デッキ入りのみ</button>
          <span class="carry-hint">「本」＝街に置いてある残り。▶で持ち出し、◀で置いていく。</span>
        </div>
        <div class="colbar carry-colbar">${colbar}</div>
        <div class="carry-scroll">
          <table class="carry-table">
            <thead><tr>${head}</tr><tr class="filters">${filterRow}</tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>
      <div class="detail carry-detail">${carryDetailHTML()}</div>
    </div>`;
}

/* おまかせで選ぶ（2026-08-29 本人指定）。スターターだけで28枚あり、1枚ずつ▶を押すのは手間なので、
 * 本から自動でデッキを組む。**38枚まで**にするのがポイントで、残り2枠は空白として置いておく——
 * おまかせドラフト（最大2回）は「デッキに空白があるときだけ」発生するので、満杯にすると
 * レンタルが1回も引けなくなる（M6.6 §2-4）。本が38枚未満のときは全部持ち出す。 */
const CARRY_AUTO_MAX = 38;
/* 種類の配分。原作のスターター（ピッグマン10＋魔法7＋技能11）に近い比率を既定にしてある。
 * 実際には本の中身に偏りがあるので、足りない種類の枠は他の種類に回す。 */
const CARRY_AUTO_MIX = { U: 0.40, M: 0.25, S: 0.35 };

/** 本にあるカードを種類ごとに、安い順で並べた配列にする（同じカードは所持枚数ぶん並ぶ）。 */
function carryAutoPool(meta, type) {
  const out = [];
  Object.keys(meta.book).forEach(function (k) {
    const c = CARD_BY_ID[+k];
    if (!c || c.t !== type) return;
    for (let i = 0; i < meta.book[k]; i++) out.push(c);
  });
  /* 高いカードほど強い、という原作の価格設計に乗って「良いものから持つ」 */
  return out.sort(function (a, b) { return (b.p || 0) - (a.p || 0) || a.id - b.id; });
}

/** 本→デッキへ、種類の割合を整えながら自動で持ち出す。 */
function carryAutoFill() {
  const meta = RUI.meta;
  const room = Math.max(0, CARRY_AUTO_MAX - CQCollection.deckTotal(meta));
  if (room <= 0) { runFlash('もう持ち出せません（' + CARRY_AUTO_MAX + '枚に達しています）'); return runRender(); }
  const pools = { U: carryAutoPool(meta, 'U'), M: carryAutoPool(meta, 'M'), S: carryAutoPool(meta, 'S') };
  /* まず割合ぶんの目標枚数を決め、足りない種類は後で他へ回す */
  const want = { U: Math.round(room * CARRY_AUTO_MIX.U), M: Math.round(room * CARRY_AUTO_MIX.M) };
  want.S = room - want.U - want.M;
  let moved = 0;
  const take = function (type, n) {
    let got = 0;
    const pool = pools[type];
    while (got < n && pool.length) {
      const c = pool.shift();
      /* 同種3枚・ピッグマン無制限・合計40枚の制限は collection.js が見る。
       * 入らなかった札は捨てて次へ（同じカードが続くだけなので詰まらない）。 */
      if (CQCollection.moveToDeck(meta, c.id, 1).ok) { got++; moved++; }
    }
    return got;
  };
  ['U', 'M', 'S'].forEach(function (t) { take(t, want[t]); });
  /* 割合どおりに取れなかった分（その種類を持っていない等）を、残っている種類で埋める */
  let guard = 0;
  while (moved < room && guard++ < 200) {
    const before = moved;
    ['U', 'M', 'S'].forEach(function (t) { if (moved < room) take(t, 1); });
    if (moved === before) break;                 /* もう本に入れられる札が無い */
  }
  const total = CQCollection.deckTotal(meta);
  runFlash(moved > 0
    ? 'おまかせで' + moved + '枚を持ち出しました（デッキ' + total + '枚・空白'
      + CQCollection.blankCount(meta) + '枚）'
    : '持ち出せるカードが本にありません');
  runRender();
}

/** 持ち出しを終えてドラフトへ。ここで run.deck を meta.deck に同期するのが要点：
 * run.deck は CQRun.start() の時点で meta.deck を複製したものなので、そのあと編集した分を
 * 反映しないとランが古いデッキで始まってしまう（ラン中の増減はランに閉じ、
 * 最後に settle() が run.deck をメタへ書き戻す、という流れは従来どおり）。 */
function finishCarryOut() {
  RUI.run.deck = Object.assign({}, RUI.meta.deck);
  CQSave.saveMeta(RUN_STORAGE, RUI.meta);
  RUI.startStage = 'draft';
  runSave();
  runRender();
}

/* ---- ③ おまかせドラフト ---- */

/** ドラフトの候補カード1枚。§4 WP4「モンスターはA/D/CH・召還Lv・効果まで全情報を出す」ため、
 * バトル画面のカード描画ではなく専用の大きめカードで描く。
 * 2026-08-28 本人指定：**価格は出さない**。おまかせドラフトは無料のレンタルなのに、
 * Ｇが書いてあると「借りるのに金が要る」と読めてしまうため（本文§4 WP4の「価格まで」は
 * 購入UIでの話として、ここでは外す）。 */
function draftCardBig(id, isRental) {
  const c = CARD_BY_ID[id];
  const stat = c.t === 'U'
    ? `<span>Ａ ${c.a}</span><span>Ｄ ${c.d}</span><span>ＣＨ ${c.ch}</span><span>Ｌｖ ${c.lv}</span>`
    : `<span>${TYPE_NAME[c.t]}</span>`;
  return `<div class="draft-card ${c.t}" data-act="pick-draft" data-id="${id}">
    <div class="dc-art">${artInner(c, 4)}${isRental ? '<span class="rental-badge">借</span>' : ''}</div>
    <div class="dc-n">${esc(c.n)}</div>
    <div class="dc-stat">${stat}</div>
    <div class="dc-e">${esc(c.e || '')}</div>
  </div>`;
}

/** 「変更しない」＝空白のまま残す枠。候補3枚と視覚的に区別する（§4 WP4）。 */
function draftKeepCardHTML(targetId) {
  const c = CARD_BY_ID[targetId];
  const isBlank = +targetId === CQRun.BLANK;
  return `<div class="draft-card keep" data-act="pick-draft" data-id="${targetId}">
    <div class="dc-art">${artInner(c, 4)}</div>
    <div class="dc-n">${isBlank ? '空白のまま' : esc(c.n) + ' を残す'}</div>
    <div class="dc-stat"><span>変更しない</span></div>
    <div class="dc-e">${isBlank ? '枠を埋めずにおく。' : esc(c.e || '')}</div>
  </div>`;
}

const DRAFT_ROUND_NOTE = [
  'この土地で狩れるモンスターだ。借りて試せる。',
  'いま街で手が届く魔法と技能だ。借りて試せる。'
];

function renderStartDraft() {
  const run = RUI.run;
  const dp = run.draftPending;
  if (!dp) return enterGuideAfter();      /* 空白が無い等でドラフトが発生しないときは出発前の案内へ */
  const opts = dp.options.map(function (id) { return draftCardBig(id, true); }).join('');
  runRoot().innerHTML = startHudHTML(run) + `
    <div class="draft-head">
      <b>おまかせドラフト</b>（${dp.round + 1}／${CQRun.DRAFT_ROUNDS}）
      <span class="draft-sub">${esc(DRAFT_ROUND_NOTE[dp.round] || '')}</span>
    </div>
    <div class="draft-row">${opts}${draftKeepCardHTML(dp.targetId)}</div>
    <p class="draft-note">選んだカードは<b>このラン限定のレンタル</b>です。無料で借りられますが、
      記憶データには入らず、探索が終わると返却されます。デッキの空白1枚と入れ替わります。
      <b>レンタルしたカードは売ることができません</b>（換金所には出せません）。</p>`;
}

/* ---- ④ 出発（暗転→明転） ---- */

/** ドラフトを終えた（または発生しなかった）ので、そのままマップへ。
 * 出発ボタンは置かない（§4 WP4）。黒オーバーレイのフェードでマップに繋ぐ。 */
function departToMap() {
  CQRun.depart(RUI.run);
  RUI.view = 'map';
  RUI.startStage = null;
  RUI.mapFadeIn = true;                   /* 次のマップ描画で明転を1度だけ再生する */
  runSave();
  runRender();
}

function renderStart() {
  const run = RUI.run;
  if (RUI.startStage === 'guide' || RUI.startStage === 'guide2') return renderStartGuide();
  if (RUI.startStage === 'carry') return renderCarryOut();
  /* 'draft'：次の回を用意する。空白が無ければ null が返り、出発前の案内②へ進む */
  if (!run.draftPending) {
    const dp = CQRun.beginDraftRound(run, CARD_BY_ID);
    if (!dp) return enterGuideAfter();
  }
  return renderStartDraft();
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
  /* 倒した敵はマップから消す（2026-08-29 本人指摘・M6.6 §4 WP10「撃破敵の消去」）。
   * 台座タイルと踏破の表示（.map-node.done）は残るので、通った跡としては読める。
   * ボスも撃破後は同じ扱い（マスターが最奥に立ったままだと決着した感じが出ない）。 */
  if ((n.type === 'battle' || n.type === 'boss') && n.cleared) return '';
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

/** マップの盤面（背景・道・マス・コマ・霧）。開始マスの案内でも同じ絵を敷くので部品にしてある。
 * interactive=false のときはマスに data-act を付けない（＝出発前は押せない）。 */
function mapBoardHTML(run, interactive, extra) {
  const area = CQAreas.get(run.areaId);
  const pickable = interactive ? runChoiceIds(run) : [];
  const nodesHTML = run.map.order.map(function (id) {
    const n = run.map.nodes[id];
    const can = interactive && pickable.indexOf(id) >= 0 && !n.cleared;
    const done = n.cleared;
    const delay = ((id.charCodeAt(1) * 37) % 900) / 1000;
    return `<div class="map-node ${n.type} ${n.strength || ''} ${can ? 'pickable' : ''} ${done ? 'done' : ''} ${n.fog && !run.map.fog.cleared ? 'foggy' : ''}"
        style="left:${(n.x / 1280 * 100).toFixed(2)}%; top:${(n.y / 800 * 100).toFixed(2)}%; animation-delay:${delay}s"
        ${interactive ? `data-act="node" data-id="${id}"` : ''}>
      <div class="node-figure">${nodeFigureHTML(n, run)}</div>
      <div class="node-tile"></div>
    </div>`;
  }).join('');
  return `<div class="run-map" style="background-image:url('${area.bg}')">
      ${pathSvg(run)}
      ${nodesHTML}
      ${playerTokenHTML(run, false)}
      ${fogLayerHTML(run)}
      ${extra || ''}
    </div>`;
}

/** マップ画面のHUD（マップ仕様書§4「上部はHUD（エリア名・ＬＰ・Ｇ・リタイヤ）約70px」）。
 * 開始マスの案内でも同じ帯を出す（リタイヤは出発前なので隠す）。 */
function mapHudHTML(run, withRetire) {
  const area = CQAreas.get(run.areaId);
  const inFog = run.map.fog.active && !run.map.fog.cleared;
  const lpPct = Math.max(0, Math.min(100, run.lp / run.maxLp * 100));
  const lpLow = run.lp <= Math.max(1, Math.round(run.maxLp * 0.3));
  return `<div class="map-hud">
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
      ${withRetire ? '<button class="map-hud-retire" data-act="retire">リタイヤ</button>' : ''}
    </div>`;
}

function renderMap() {
  const run = RUI.run;
  /* HUD（マップ仕様書§4「上部はHUD（エリア名・ＬＰ・Ｇ・リタイヤ）約70px」）。
   * エリア名を主役に置き、ＬＰは残量が一目で分かるゲージ付き、Ｇは数字を大きく。
   * 霧が出ている日は名前の右に印を出す（霧払いを買うと消える）。 */
  runRoot().innerHTML = mapHudHTML(run, true)
    + mapBoardHTML(run, true, RUI.mapFadeIn ? '<div class="map-fade-in"></div>' : '')
    + `<div class="run-log">${(run.log.slice(-3).map(function (l) { return '<div>・' + esc(l) + '</div>'; })).join('')}</div>`;
  /* 溶ける演出は1度だけ。アニメが終わる頃にフラグを下ろす（以後の描画では霧そのものを出さない）。
   * ここで再描画はしない——CSSが opacity:0 まで持っていって forwards で止まるため、
   * 消えた見た目のまま次の操作（マスを選ぶ等）の描画で自然に居なくなる。 */
  if (RUI.fogDissolving) setTimeout(function () { RUI.fogDissolving = false; }, 1500);
  /* 出発の明転も1度だけ（§4 WP4）。黒を被せた状態から opacity を0まで落とす */
  if (RUI.mapFadeIn) setTimeout(function () { RUI.mapFadeIn = false; }, 900);
}

/** ノードidから盤面座標（%）を得る（歩行アニメの起点・終点計算用） */
function nodePct(run, id) {
  const n = run.map.nodes[id];
  return { x: (n.x / 1280 * 100), y: (n.y / 800 * 100) };
}

/** fromId → toId の辺が、画面上「辻」（道の交差点）を経由して描かれているかどうかを判定し、
 * 経由するならその辻の座標（%）を返す（M6.6 WP10・本人指定）。
 *
 * pathSvg() は、同じ2つの行き先（connectsTo）へ枝分かれする2つの手前のマスがあるとき、
 * 単純に4本の直線を引くとXに交差して見えてしまう問題を避けるため、間に中間の辻を1つ置いて
 * 「手前→辻→行き先」の形で描いている（合流点・マップ仕様書§4）。歩行のときも見えている
 * 道と同じ経路を通らせるため、pathSvg と**まったく同じ条件・同じ座標の求め方**でここを判定する
 * （ロジックが2箇所に分かれるので、pathSvg 側の合流条件を変えたときはここも直すこと）。
 * 経由しない（辻の無い直線区間）なら null。 */
function roadJointBetween(run, fromId, toId) {
  const nodes = run.map.nodes;
  const from = nodes[fromId];
  if (!from || from.connectsTo.length !== 2 || from.connectsTo.indexOf(toId) < 0) return null;
  const sig = from.connectsTo.slice().sort().join(',');
  const group = Object.keys(nodes)
    .map(function (id) { return nodes[id]; })
    .filter(function (n) { return n.connectsTo.length === 2 && n.connectsTo.slice().sort().join(',') === sig; });
  if (group.length !== 2) return null;                 /* 枝分かれ元が1つだけ＝直線でよい */
  const ids = sig.split(',');
  const targetA = nodes[ids[0]], targetB = nodes[ids[1]];
  const midX = (group[0].x + group[1].x) / 2 + (targetA.x + targetB.x - group[0].x - group[1].x) / 4;
  const midY = (targetA.y + targetB.y) / 2;
  return { x: midX / 1280 * 100, y: midY / 800 * 100 };
}

/** クリックしたマスへ、コマが上下に跳ねながら歩いて移動する演出。終わったら done() を呼ぶ。
 * マップ画面が実際にDOM上にあるとき（＝マップから分岐先をクリックした瞬間）だけ再生し、
 * それ以外（開始マスからの出発など、マップがまだ無い場面）は演出をスキップして即座に進む。
 *
 * 2026-08-29 本人指定（M6.6 WP10）：道が交差しているマスへ移動するときは、一直線ではなく
 * **辻（roadJointBetween）を経由して**折れながら進む。辻が無い区間は従来どおり直線で1回。 */
function playerWalk(run, fromId, toId, done) {
  const mapEl = runRoot().querySelector('.run-map');
  if (!mapEl || fromId === toId) { done(); return; }
  const tok = document.createElement('div');
  const from = nodePct(run, fromId), to = nodePct(run, toId);
  const joint = roadJointBetween(run, fromId, toId);
  const waypoints = joint ? [from, joint, to] : [from, to];
  tok.className = 'player-token walking';
  tok.style.left = from.x + '%'; tok.style.top = from.y + '%';
  tok.innerHTML = '<img src="assets/map/player.png" alt="" draggable="false" onerror="this.remove()">';
  const existing = mapEl.querySelector('.player-token');
  if (existing) existing.remove();
  mapEl.appendChild(tok);
  void tok.offsetWidth;
  /* 1区間の所要時間はCSS（.player-token.walking の transition）と合わせて460ms。
   * 辻を経由する区間は単純に2区間ぶん（920ms）かかる——距離が伸びるぶん自然に長くなる形。 */
  const LEG_MS = 460;
  let leg = 1;
  function nextLeg() {
    if (leg >= waypoints.length) { done(); return; }
    const p = waypoints[leg];
    requestAnimationFrame(function () { tok.style.left = p.x + '%'; tok.style.top = p.y + '%'; });
    leg++;
    setTimeout(nextLeg, LEG_MS);
  }
  nextLeg();
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
  /* 2026-08-29 本人指定：敵のマスでは「たたかう」の確認パネルを出さず、触れた時点で
   * そのまま戦闘導入アニメーションへ入る。ここで振り分けているので、マスを選んだ直後の
   * 描画だけでなく、戦闘マスに立ったまま中断・再開した場合も同じ経路に乗る。 */
  if (n.type === 'battle' || n.type === 'boss') {
    RUI.battleIntroNodeId = RUI.nodeId;
    RUI.battleIntroLeaving = false;
    RUI.view = 'battle-intro';
    return renderBattleIntro();
  }
  /* M6.6 WP8：宝箱・休憩も、敵のマスと同じように「触れた時点で」自動的に演出へ入る
   * （「開ける」「休む」のクリックは無くした）。効果の確定と自動でマップへ戻る処理は
   * renderEventIntro() 側で行う。 */
  if (n.type === 'chest' || n.type === 'rest') {
    RUI.eventIntroNodeId = RUI.nodeId;
    RUI.eventIntroLeaving = false;
    RUI.eventIntroKind = n.type;
    RUI.eventIntroResult = null;
    RUI.view = 'event-intro';
    return renderEventIntro();
  }
  if (n.type === 'shop') return renderShopNode(run, n);
  if (n.type === 'exchange') return renderExchangeNode(run, n);
  if (n.type === 'question') return renderQuestionNode(run, n);
}

/* ================= 戦闘導入カットイン（M6.6 WP5） =================
 * 敵のマスに入った瞬間（「たたかう」の確認パネルは挟まない。2026-08-29 本人指定）、
 * **マップ画面の上に重ねて**再生する演出。画面のおよそ40%の黒い四角を中央に描き、
 * その上に敵（ボスは m_*_cut.png）を立たせる。四角の後ろにはマップが見えたままにする
 * ——なので背景は敷かず、マップをそのまま描いた上に絶対配置で重ねる（2026-08-29 改訂）。
 * 自分のコマが左から上下に揺れながらゆっくり走り込み、敵にぶつかって暗転→バトル画面へ。
 * タップで即スキップ可。乱数は使わない——先攻／後攻はすでに CQRun.battleSetup() が
 * 戦闘シードから決定的に決めている（js/run/run.js の firstTurnOf）。
 *
 * 戦場ルールの表示について：確認パネルを廃止したことで、従来そこに出していた
 * 「今日の戦場ルール」の説明の置き場所が無くなる。M6の戦場ルールは『戦闘前に必ず見える』
 * ことが設計の前提（実装計画追補M6・台本のヒント `fieldRule`）なので、黒四角の下部に
 * 同じ内容を出してこの前提を保つ。 */
/* カットインの尺。内訳は css の `.battle-intro` のコメントどおりで、
 * 「動き（約2.3秒）＋**静止して見せる約2秒**＋暗転（0.4秒）」。
 * 静止の2秒は 2026-08-29 の本人指定——マスター戦で相手の名前や戦場ルールを読む時間が
 * 欲しい、との指摘による。値を変えるときは css の animation の秒数も一緒に直すこと。 */
const BATTLE_INTRO_MS = 4300;

function renderBattleIntro() {
  const run = RUI.run, n = run.map.nodes[RUI.battleIntroNodeId];
  const area = CQAreas.get(run.areaId);
  const isBoss = n.type === 'boss';
  const figure = isBoss
    ? `<img class="battle-intro-foe" src="assets/masters/m_${run.areaId}_cut.png" alt="" draggable="false"
         onerror="masterCutoutFallback(this, '${area.master}')">`
    : (n.enemy
        ? `<img class="battle-intro-foe" src="assets/cutouts/${n.enemy.id}.png" alt="" draggable="false"
             onerror="nodeArtFallback(this, ${n.enemy.id})">`
        : '');
  const title = isBoss ? area.bossName
    : (n.strength === 'elite' ? '精鋭' : n.strength === 'strong' ? '強敵' : '')
      + (n.enemy ? (n.strength === 'normal' ? '' : '　') + CARD_BY_ID[n.enemy.id].n + ' ×' + n.enemy.count : '');
  /* マップを下に敷いてから、その上にカットインを重ねる（四角の後ろにマップが見える）。
   * HUDやログまで含めた通常のマップ描画をそのまま使うので、演出中も現在地が読める。 */
  renderMap();
  const ov = document.createElement('div');
  ov.className = 'battle-intro';
  ov.dataset.act = 'battle-intro-skip';
  ov.innerHTML = `
    <div class="battle-intro-cut">
      <div class="battle-intro-title">${esc(title)}</div>
      ${fieldRuleInfoHTML(n.fieldRules)}
    </div>
    <div class="battle-intro-stage">
      ${figure}
      <div class="battle-intro-hero"><img src="assets/map/player.png" alt="" draggable="false" onerror="this.remove()"></div>
    </div>`;
  runRoot().appendChild(ov);
  /* この画面に来て初めての描画のときだけ、実際の切り替えタイマーを仕掛ける（タップでの
   * 早送りと二重に走らないよう battleIntroLeaving で一度きりにする） */
  setTimeout(leaveBattleIntro, BATTLE_INTRO_MS);
}

/** カットインを終えて実際の戦闘へ進む。タイマー経由・タップスキップ経由のどちらから
 * 呼ばれても一度しか進まないよう battleIntroLeaving で防ぐ。
 * プレビュー再生中（デバッグメニューの「戦闘開始シーンを再生」）は戦闘へは進まず、
 * 元の画面に戻してコールバックを呼ぶだけにする。 */
function leaveBattleIntro() {
  if (RUI.battleIntroLeaving || RUI.view !== 'battle-intro') return;
  RUI.battleIntroLeaving = true;
  if (RUI.battleIntroPreview) {
    const cb = RUI.battleIntroPreview;
    RUI.battleIntroPreview = null;
    RUI.battleIntroNodeId = null;
    RUI.view = RUI.battleIntroBackTo || 'map';
    runRender();
    cb();
    return;
  }
  const run = RUI.run, n = run.map.nodes[RUI.battleIntroNodeId];
  const setup = CQRun.battleSetup(run, CARD_BY_ID, n);
  RUI.battleIntroNodeId = null;
  startRunBattle(setup, onRunBattleOver);
}

/** デバッグメニュー用：戦闘導入カットインだけを再生し、終わったら元の画面に戻って
 * onDone() を呼ぶ（実戦闘には入らない＝ランの状態を一切変えない）。js/debug.js から呼ぶ。
 * 対象は「いま見ているマス（戦闘マスなら）」→ 無ければマップ内の最初の戦闘マス。 */
function previewBattleIntro(onDone) {
  const run = RUI.run;
  if (!run || !run.map) return { ok: false, reason: 'ランが始まっていません。まずエリアを選んで出発してください。' };
  const here = run.map.nodes[RUI.nodeId];
  const node = (here && (here.type === 'battle' || here.type === 'boss')) ? here
    : Object.values(run.map.nodes).find(function (x) { return x.type === 'battle' || x.type === 'boss'; });
  if (!node) return { ok: false, reason: 'このマップに戦闘マスがありません。' };
  RUI.battleIntroBackTo = (RUI.view === 'battle-intro') ? 'map' : RUI.view;
  RUI.battleIntroPreview = onDone || function () {};
  RUI.battleIntroNodeId = node.id;
  RUI.battleIntroLeaving = false;
  RUI.view = 'battle-intro';
  renderBattleIntro();
  return { ok: true };
}
if (typeof window !== 'undefined') window.previewBattleIntro = previewBattleIntro;

/* ================= 休憩・宝箱の演出カットイン（M6.6 WP8） =================
 * 戦闘導入（WP5）とまったく同じ形——マップの上に画面の一部だけを覆う黒い四角を重ね、
 * その後ろにマップを見せたまま四角の内側だけでアニメーションを完結させる——を流用する。
 * 戦闘導入と違う点は2つ：①演出がすべて四角の内側で終わる（外へ走り出すものが無い）、
 * ②プレイヤー操作を一切必要としない（コマが着いた瞬間に自動で始まり、終わったら
 * 自動でマップへ戻る。従来の「開ける」「休む」「進む」のクリックは全部無くした）。
 *
 * 効果（Ｇ獲得／ＬＰ回復）は、この演出に入って最初にここへ描画が来たときに1回だけ
 * 確定させる（RUI.eventIntroResult に結果を持たせるガード）。タップでの早送りと
 * 二重に走らないようにするだけなら leaveEventIntro 側のガードで足りるが、演出そのものを
 * 再描画したときに CQRun.openChest/rest を2回呼んでしまわないよう、効果の確定は
 * こちら側でも別にガードしてある。 */
const EVENT_INTRO_MS = 4000;   /* 内訳：開く.4s → 演出（ハート/金貨）～1.5s → 読む～2s → 閉じる.4s */

function renderEventIntro() {
  const run = RUI.run, n = run.map.nodes[RUI.eventIntroNodeId];
  const kind = RUI.eventIntroKind;
  if (!RUI.eventIntroResult) {
    RUI.eventIntroResult = kind === 'chest' ? CQRun.openChest(run, n) : CQRun.rest(run, n);
    runSave();
  }
  const r = RUI.eventIntroResult;
  /* マップを下に敷いてから、その上にカットインを重ねる（四角の後ろにマップが見える。WP5と同じ） */
  renderMap();
  const ov = document.createElement('div');
  ov.className = 'event-intro';
  ov.dataset.act = 'event-intro-skip';
  const title = kind === 'chest' ? (n.rare ? '大きな宝箱' : '宝箱') : '休憩';
  const stageHTML = kind === 'chest' ? chestIntroStageHTML() : restIntroStageHTML();
  /* 2026-08-29 本人指定：獲得量の数字は一目で分かるよう大きく強調する。 */
  const msg = kind === 'chest'
    ? `<span class="event-intro-amount event-intro-amount-gold">${r.gold}Ｇ</span>を取得した。`
      + (r.cardId != null ? `<br>${esc(CARD_BY_ID[r.cardId].n)}を入手した。` : '')
    : (r.healed > 0
        ? `ＬＰが<span class="event-intro-amount event-intro-amount-lp">${r.healed}</span>回復した。`
        : 'ＬＰはすでに満タンだった。');
  ov.innerHTML = `
    <div class="event-intro-cut">
      <div class="event-intro-title">${esc(title)}</div>
      <div class="event-intro-stage">${stageHTML}</div>
      <div class="event-intro-msg">${msg}</div>
    </div>`;
  runRoot().appendChild(ov);
  setTimeout(function () {
    const cut = ov.querySelector('.event-intro-cut');
    if (cut) cut.classList.add('closing');
  }, EVENT_INTRO_MS - 400);
  setTimeout(leaveEventIntro, EVENT_INTRO_MS);
}

/** 休憩の演出：中央に立つ自分のコマ（戦闘導入の.battle-intro-heroと同じ大きさ）へ、
 * 左上・右上から弧を描いてハートが飛び込んでくる（回復を表す。2026-08-29 本人指定：
 * ハートは2倍の大きさ・直線に落とすのではなく弧を描かせる・コマは戦闘導入と同じ大きさに）。 */
function restIntroStageHTML() {
  const hearts = [
    { side: 'l', delay: 0 },
    { side: 'r', delay: .12 },
    { side: 'l', delay: .55 },
    { side: 'r', delay: .67 }
  ].map(function (h) {
    return `<span class="event-rest-heart event-rest-heart-${h.side}" style="animation-delay:${h.delay}s">♥</span>`;
  }).join('');
  return `<div class="event-rest-hero">
      <img src="assets/map/player.png" alt="" draggable="false" onerror="this.remove()">
    </div>${hearts}`;
}

/** 宝箱の演出：マップのマスと同じ宝箱の絵（`assets/map/icon_chest.png`。マップ上より1.5倍の
 * 大きさ）から、金貨（Ｇ）が大量にはじけて派手に舞い上がる（2026-08-29 本人指定）。
 * マップ側が画像読み込み失敗時に絵文字へフォールバックするのと同じやり方に揃えてある。 */
function chestIntroStageHTML() {
  const coins = [
    { cx: -70, cy: -104, cr: -30, delay: 0,   size: 20 },
    { cx: -46, cy: -132, cr: 18,  delay: .05, size: 24 },
    { cx: -20, cy: -148, cr: -14, delay: .10, size: 18 },
    { cx: 4,   cy: -156, cr: 8,   delay: .04, size: 26 },
    { cx: 28,  cy: -146, cr: -20, delay: .14, size: 20 },
    { cx: 54,  cy: -128, cr: 26,  delay: .08, size: 22 },
    { cx: 76,  cy: -100, cr: -10, delay: .18, size: 18 },
    { cx: -84, cy: -60,  cr: 34,  delay: .22, size: 16 },
    { cx: 84,  cy: -58,  cr: -28, delay: .24, size: 16 },
    { cx: -10, cy: -180, cr: 12,  delay: .12, size: 22 },
    { cx: 40,  cy: -170, cr: -18, delay: .20, size: 18 },
    { cx: -40, cy: -168, cr: 22,  delay: .16, size: 18 }
  ].map(function (c) {
    return `<span class="event-chest-coin" style="animation-delay:${c.delay}s;font-size:${c.size}px;--cx:${c.cx}px;--cy:${c.cy}px;--cr:${c.cr}deg">Ｇ</span>`;
  }).join('');
  return `<div class="event-chest-box">
      <img src="assets/map/icon_chest.png" alt="" draggable="false"
        onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'event-chest-box-fallback',textContent:'🎁'}))">
    </div>${coins}`;
}

/** カットインを終えて自動でマップへ戻る。タイマー経由・タップスキップ経由のどちらから
 * 呼ばれても一度しか進まないよう eventIntroLeaving で防ぐ（leaveBattleIntro と同じ形）。
 * 効果はすでに renderEventIntro() の最初の呼び出しで確定・保存済みなので、ここでは
 * 演出用の状態を片付けてマップへ戻すだけでよい。 */
function leaveEventIntro() {
  if (RUI.eventIntroLeaving || RUI.view !== 'event-intro') return;
  RUI.eventIntroLeaving = true;
  RUI.eventIntroNodeId = null;
  RUI.eventIntroKind = null;
  RUI.eventIntroResult = null;
  RUI.view = 'map';
  runRender();
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

/* ================= 戦利品の振り分け（M6.6 WP7） ================= */

/** 勝利直後、マップに戻る前に出す画面。得た戦利品を全部並べ、1枚ずつ「デッキに加える」
 * 「本に送る」を選ばせる（§4 WP7）。確定ボタンは無く、全部選び終えたら自動で次へ進む
 * （runAct の 'loot-deck'／'loot-book' が空になったタイミングで進める）。 */
function renderLoot() {
  const run = RUI.run;
  const pending = run.lootPending || [];
  const remain = Math.max(0, CQRun.DECK_SIZE - CQCollection.countsTotal(run.deck)
    - (run.rentals ? run.rentals.length : 0));
  const items = pending.map(function (id) {
    const c = CARD_BY_ID[id];
    const canDeck = CQRun.canAssignToDeck(run, id);
    return `<div class="loot-item">
      <div class="dc-art">${artInner(c, 4)}</div>
      <div class="shop-item-n">${esc(c.n)}</div>
      <div class="loot-btns">
        <button class="loot-btn deck" data-act="loot-deck" data-id="${id}" ${canDeck ? '' : 'disabled'}>デッキに加える</button>
        <button class="loot-btn book" data-act="loot-book" data-id="${id}">本に送る</button>
      </div>
    </div>`;
  }).join('');
  runRoot().innerHTML = `
    <div class="node-panel wide">
      <h3>戦利品</h3>
      <p>デッキの空き：${remain}枚</p>
      <div class="shop-row">${items}</div>
      <p class="node-note">「本に送る」を選んだカードは<b>このランでは使えません</b>
        （次のランから持ち出せます）。どちらを選んでもカードは必ず手に入ります。</p>
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
  /* M6.6 WP7：戦利品の振り分けが残っているうちは、勝敗が確定していても結果画面より先に
   * この画面を見せる（settle() もまだ済んでいない）。 */
  const lootWaiting = !!(RUI.run && RUI.run.lootPending && RUI.run.lootPending.length);
  /* デバッグメニューの「目覚めの場面を見返す」中は、結果画面がまだ残っていても
   * それより優先して opening を出し続ける（さもないと毎回の再描画でここに戻されてしまう）。 */
  if (!RUI.openingPreview) {
    if (RUI.run && RUI.run.outcome && !lootWaiting) RUI.view = 'result';
    else if (lootWaiting) RUI.view = 'loot';
  }
  if (RUI.view === 'opening') renderOpening();
  else if (RUI.view === 'areaSelect') renderAreaSelect();
  else if (RUI.view === 'start') renderStart();
  else if (RUI.view === 'map') renderMap();
  else if (RUI.view === 'node') renderNode();
  else if (RUI.view === 'battle-intro') renderBattleIntro();
  else if (RUI.view === 'event-intro') renderEventIntro();
  else if (RUI.view === 'loot') renderLoot();
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

/** 戦利品の振り分けが終わった（または最初から無かった）ときに、続きへ進める（M6.6 WP7）。
 * lootPending が残っていれば振り分け画面のまま。無ければ、勝敗が確定済みなら結果画面へ
 * 清算して進み（従来 onRunBattleOver が直接やっていた処理）、未確定ならマップへ戻る。 */
function advanceAfterBattle() {
  const run = RUI.run;
  if (run.lootPending && run.lootPending.length) { RUI.view = 'loot'; runSave(); return; }
  if (run.outcome) {
    CQRun.settle(run, RUI.meta);
    CQSave.saveMeta(RUN_STORAGE, RUI.meta);
    CQSave.clearRun(RUN_STORAGE);
    RUI.view = 'result';
  } else {
    RUI.view = 'map';
    runSave();
  }
}

function onRunBattleOver(M) {
  const run = RUI.run, n = run.map.nodes[RUI.nodeId];
  /* M6.6 WP12：逃走で終わった戦闘は勝敗が付いていない。戦利品もＧも無く、ＬＰだけ持ち越し、
   * **そのマスは cleared にしない**（追補§8-3 案A）＝マップに戻ると自分はまだそのマスに
   * 立っていて、同じ相手にもう一度挑める（runChoiceIds が未解決の現在地を選択可能にする）。 */
  if (M.fled) {
    const r = CQRun.reportFlee(run, n, M);
    if (r.dead) {
      advanceAfterBattle();                      /* 逃走失敗のＬＰ0＝そのままゲームオーバー */
    } else {
      RUI.view = 'map';
      runSave();
    }
    showScreen('screen-run');
    runRender();
    return;
  }
  CQRun.reportBattle(run, n, M, RUI.meta);
  if (n.type === 'boss' && M.winner === 'self') run.outcome = 'win';
  advanceAfterBattle();
  showScreen('screen-run');
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
      /* 訪問回数を先に加算してからランを作る。案内の「初回3つ／2回目以降1つ」の
       * 判定に使う（加算後の値が1なら初回。中断・再開しても揺れない）。 */
      CQSave.markVisit(RUI.meta, id);
      CQSave.saveMeta(RUN_STORAGE, RUI.meta);
      RUI.run = CQRun.start(CARD_BY_ID, id, seed, RUI.meta);
      RUI.view = 'start';
      enterStartNode(true);
      runSave();
      return runRender();
    }
    case 'guide-next': {
      const next = (RUI.guideStep || 0) + 1;
      if (next >= (RUI.guide || []).length) return finishStartGuide();
      RUI.guideStep = next;
      return runRender();
    }
    case 'guide-skip':
      return finishStartGuide();
    case 'carry-tab': {
      if (RUI.carryTab === id) return;
      RUI.carryTab = id;
      /* タブでカードの種類が変わると列の顔ぶれも変わるので、並べ替えの基準を安全な既定へ戻す
       * （モンスターで「攻撃力」に並べたまま魔法タブへ行くと、その列が無くて意味を失うため）。 */
      const cols = CARRY_COLS[carryGrp()];
      if (!cols.some(function (c) { return c.k === RUI.carrySort.key; })) {
        RUI.carrySort = { key: 'p', asc: true };
      }
      RUI.carrySel = null;
      return runRender();
    }
    case 'carry-only':
      RUI.carryOnly = !RUI.carryOnly;
      return runRender();
    case 'carry-col':
      RUI.carryShown[carryGrp()][id] = !RUI.carryShown[carryGrp()][id];
      return runRender();
    case 'carry-sort':
      if (RUI.carrySort.key === id) RUI.carrySort.asc = !RUI.carrySort.asc;
      else RUI.carrySort = { key: id, asc: true };
      return runRender();
    case 'carry-pick':
      RUI.carrySel = +id;
      return carryRefreshBody();
    case 'carry-to-deck': {
      const r = CQCollection.moveToDeck(RUI.meta, +id, 1);
      if (!r.ok) runFlash(r.reason);
      RUI.carrySel = +id;
      return carryRefreshBody();
    }
    case 'carry-to-book': {
      const r = CQCollection.moveToBook(RUI.meta, +id, 1);
      if (!r.ok) runFlash(r.reason);
      RUI.carrySel = +id;
      return carryRefreshBody();
    }
    case 'carry-auto':
      return carryAutoFill();
    case 'carry-done':
      return finishCarryOut();
    case 'pick-draft':
      CQRun.applyDraft(run, +id, CARD_BY_ID);
      runSave();
      return runRender();
    case 'node': {
      const n = run.map.nodes[id];
      if (n.fog && !run.map.fog.cleared) { runFlash('霧の中は入ってみないと分かりません'); }
      /* M6.6 WP12：いま立っているマスがまだ解決していない（＝逃げてきた戦闘マス）なら、
       * 歩かず・advance もせずにそのまま入り直す。advance() は「現在地が解決済み」を
       * 前提にしているので通せない（runChoiceIds も、未解決の現在地は選べる扱いにしている）。 */
      if (id === run.at && !n.cleared) {
        RUI.nodeId = id; RUI.view = 'node';
        runSave();
        return runRender();
      }
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
    /* 'battle-go'（「たたかう／挑む」ボタン）は 2026-08-29 に廃止した。敵のマスに触れた
     * 時点で renderNode() が直接カットインへ振り分ける。 */
    case 'battle-intro-skip':
      return leaveBattleIntro();
    case 'event-intro-skip':
      return leaveEventIntro();
    case 'loot-deck': {
      const r = CQRun.resolveLootPick(run, +id, 'deck', CARD_BY_ID);
      if (!r.ok) { runFlash(r.reason); return runRender(); }
      advanceAfterBattle();
      return runRender();
    }
    case 'loot-book': {
      const r = CQRun.resolveLootPick(run, +id, 'book', CARD_BY_ID);
      if (!r.ok) { runFlash(r.reason); return runRender(); }
      advanceAfterBattle();
      return runRender();
    }
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

/** 持ち出し画面の絞り込み欄の入力を拾う。
 * ここだけ全画面の再描画（runRender）を使わず表の中身だけ差し替えるのが要点——
 * 1文字打つたびに innerHTML を作り直すと入力欄が消えてフォーカスが飛ぶため。
 * 日本語入力の変換中（composition中）は確定するまで絞り込まない。 */
function bindCarryFilters(el) {
  let composing = false;
  el.addEventListener('compositionstart', function (ev) {
    if (ev.target.classList && ev.target.classList.contains('carry-f')) composing = true;
  });
  el.addEventListener('compositionend', function (ev) {
    const t = ev.target;
    if (!t.classList || !t.classList.contains('carry-f')) return;
    composing = false;
    RUI.carryFilters[t.dataset.f] = t.value;
    carryRefreshBody();
  });
  el.addEventListener('input', function (ev) {
    const t = ev.target;
    if (!t.classList || !t.classList.contains('carry-f')) return;
    if (composing) return;
    RUI.carryFilters[t.dataset.f] = t.value;
    carryRefreshBody();
  });
}

/** ラン画面の入力を配線して起動する。DOMContentLoaded と「もう発火済み」の両方から
 * 呼ばれるので、dataset.bound で一度きりにしてある
 * （以前は2か所に同じ配線をコピーしていて、絞り込み欄の配線を片方に足し忘れると
 *   実際に走るほうに入らない、という取りこぼしが起きた）。 */
function bootRunUI() {
  const el = runRoot();
  if (!el || el.dataset.bound) return;
  el.dataset.bound = '1';
  el.addEventListener('click', function (ev) {
    const t = ev.target.closest('[data-act]');
    if (!t) return;
    runAct(t.dataset.act, t.dataset.id);
  });
  bindCarryFilters(el);
  runInit();
}

document.addEventListener('DOMContentLoaded', function () {
  bootRunUI();
});
/* DOMContentLoaded がすでに発火済みだった場合の保険。
 * （このスクリプトはbody末尾に置いてあるので、実際には readyState はまだ 'loading' で、
 *   通常は上の DOMContentLoaded 側が走る。dataset.bound で二重登録を防いでいる。） */
if (document.readyState !== 'loading') bootRunUI();
