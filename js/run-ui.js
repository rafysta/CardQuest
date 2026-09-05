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
  openingPreview: null, openingBackTo: null,
  /* ホーム画面（ジェイルタウン・M7 WP5）のアンバー吹き出し（初回／通常ランダム／節目）。
   * cq_run には保存しない＝再訪のたびに enterHome() が組み直す。 */
  homeGuide: null, homeGuideStep: 0,
  /* カードグリッド＋情報パネル（M6.6 WP9）の選択中カード。換金所・デッキ確認・ショップ・
   * 戦利品振り分けの4画面で共用する。gridCtx が変わった（＝違う画面に入った）ときだけ
   * gridSel をリセットする——同じ画面内での再描画（購入・売却のたび）では選択を保つため。
   * gridSelIdx は「押した1タイル」を指す表示専用の添字（本人指摘：同じカードが複数あると
   * 全部のタイルが黄色く光り、どの1枚を選んでいるか分からなかった。ゲーム内の判定は今まで
   * どおり gridSel（カードid）で行い、光らせる先だけ gridSelIdx に絞る）。 */
  gridSel: null, gridCtx: null, gridSelIdx: null,
  /* コレクション図鑑（M7 WP6）のタブ（U/M/S）。cq_runには保存しない＝画面を開くたび既定に戻る。 */
  colTab: 'U',
  /* ログショップ（M7 WP7）：タブ（buy/sell）・一括換金の確認中か・そこで除外したカードid。
   * どれも cq_meta には保存しない＝画面を開き直せば既定に戻る（在庫整理の途中状態を
   * セーブに持ち込まない）。 */
  shopTab: 'buy', shopBulk: false, bulkExclude: [],
  /* デッキ編集（M7 WP9）を初めて開いたときのアンバーの説明（台本§5-3・一度きり）。 */
  deckGuide: null, deckGuideStep: 0,
  /* 設定画面（M7 WP11）のバックアップの結果表示（{ok, msg}）。保存はしない。 */
  backupState: null,
  /* タブごとのスクロール位置（2026-09-02 本人指摘：カード選択で画面を描き直すたびに
   * スクロールが0へ戻っていた。tab名をキーに最後の位置を覚えておく）。 */
  colScroll: {}
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
    /* M7 WP9：持ち出し（デッキ編集）はホームへ移した。開始マスに残るのは
     * 案内・おまかせドラフト・出発の3つだけ（マップ仕様書§1.1）。 */
    RUI.startStage = RUI.guide.length ? 'guide' : 'draft';
  } else {
    RUI.guide = null;
    RUI.startStage = 'draft';
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
  } else { enterHome(); return; }
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
  RUI.openingStep = 0; RUI.openingIntroDone = false; RUI.openingFadeOut = false;
  /* §4 WP1のフロー末尾は「エリア選択」だったが、M7 WP5でホームが着地点になった
   * （受け入れ基準：初回起動＝オープニング→ホーム→エリア選択の順）。 */
  enterHome();
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

/* ================= ホーム画面（ジェイルタウン・M7 WP5） =================
 *
 * オープニング後・リザルトの「今回の探検を終える」後の着地点（『作業パッケージ』WP5）。
 * 施設は6つ。「冒険に出る」だけ機能する（→エリア選択）。残り5つ（ログショップ／コレクション／
 * デッキ編集／記録／設定）はWP6〜WP10がまだ無いので、押せない状態で淡く出す
 * （『世界観とプレイヤー案内』§6.2「初回だけ淡く表示」と同じ見た目の扱い）。
 *
 * ★開始マス（持ち出し画面）の扱い：WP5時点では外さない。台本§2.3も「実際に画面を外すのは
 * WP9（正式なデッキ編集）と同時でよい」としており、ホームの「デッキ編集」施設がまだ
 * 押せない今、開始マスの持ち出し画面を外すとデッキを組む手段が無くなってしまう。
 * よってWP9でホームのデッキ編集が機能化されるのと同時に外す——順序はここで決めた
 * （『作業パッケージ』WP5実施メモに記録）。
 *
 * アンバーの吹き出し（台本§2）は amberBubbleHTML を使い回す。マップの案内（RUI.guide）と
 * 同じ「タップ送り・スキップ可」の部品だが、状態は別に持つ（同時に両方使うことは無いが、
 * 混線を避けるため RUI.homeGuide として独立させてある）。 */

const HOME_FACILITIES = [
  { id: 'adventure', label: '冒険に出る', act: 'home-go-adventure', ready: true },
  { id: 'shop', label: 'ログショップ', act: 'home-shop', ready: true },
  { id: 'collection', label: 'コレクション', act: 'home-collection', ready: true },
  { id: 'deck', label: 'デッキ編集', act: 'home-deck', ready: true },
  { id: 'record', label: '記録', act: 'home-record', ready: true },
  { id: 'settings', label: '設定', act: 'home-settings', ready: true }
];

/** ホームへ入る（または戻る）。節目（マスターレベル上昇・エリア解放）を確認し、
 * 出すべき吹き出しを1つ組んでから描画する。優先順位：節目 ＞ 初回3つ ＞ 通常ランダム1つ
 * （節目は「見逃し不可」＝台本§2.3。同じ訪問で複数の節目が重なったら、その全部を続けて出す）。 */
function enterHome() {
  RUI.run = null;
  RUI.view = 'home';
  const meta = RUI.meta;
  let script = [];
  const lvl = CQCollection.masterLevelOf(meta);
  if (CQSave.checkLevelUp(meta, lvl)) {
    script = script.concat(CQLore.fill(CQLore.LORE.home.onLevelUp, { n: (meta.known || []).length }));
  }
  const unlockedIds = CQAreas.list()
    .filter(function (a) { return CQAreas.isUnlocked(a.id, meta.cleared || []); })
    .map(function (a) { return a.id; });
  CQSave.checkAreaOpen(meta, unlockedIds).forEach(function (id) {
    const area = CQAreas.get(id);
    script = script.concat(CQLore.fill(CQLore.LORE.home.onAreaOpen, { area: area ? area.name : id }));
  });
  const wasFirst = CQSave.markHomeVisited(meta);
  if (!script.length) {
    script = wasFirst ? CQLore.LORE.home.first.slice() : CQLore.pickOne(CQLore.LORE.home.idle).slice();
  }
  CQSave.saveMeta(RUN_STORAGE, meta);
  RUI.homeGuide = script; RUI.homeGuideStep = 0;
  runRender();
}

function finishHomeGuide() {
  RUI.homeGuide = null; RUI.homeGuideStep = 0;
  runRender();
}

function renderHome() {
  const meta = RUI.meta;
  const guiding = !!(RUI.homeGuide && RUI.homeGuide.length);
  /* デッキが40枚に足りないと出発できない（WP9）ので、ホームの時点で不足を見せておく
   * ——「冒険に出る」を押してから止められるより、押す前に分かるほうがよい。 */
  const dep = CQCollection.canDepart(meta);
  const tiles = HOME_FACILITIES.map(function (f) {
    const note = (dep.ok) ? ''
      : (f.id === 'deck') ? `<span class="home-tile-warn">あと${dep.fillable}枚入ります</span>`
      : (f.id === 'adventure') ? '<span class="home-tile-warn">デッキが未完成</span>'
      : '';
    return `<button class="home-tile${f.ready ? '' : ' home-tile-disabled'}"
        ${f.ready && !guiding ? `data-act="${f.act}"` : 'disabled'}>
      <span class="home-tile-label">${esc(f.label)}</span>
      ${f.ready ? note : '<span class="home-tile-soon">準備中</span>'}
    </button>`;
  }).join('');
  /* 2026-09-02 本人指摘：アンバーの位置はそのまま（左上）にし、代わりに「所持Ｇ」と
   * タイトルを右側へ寄せて避ける（CSS側 .home-scene .run-hud/.run-h2 を参照）。 */
  const overlay = guiding
    ? amberBubbleHTML(RUI.homeGuide[Math.min(RUI.homeGuideStep || 0, RUI.homeGuide.length - 1)],
        { nextAct: 'home-guide-next', skipAct: 'home-guide-skip' })
    : '';
  runRoot().innerHTML = `
    <div class="home-scene">
      <img class="home-bg" src="assets/ui/home_jailtown.png" alt="" draggable="false" onerror="this.style.display='none'">
      <div class="run-hud"><div class="run-hud-g">所持Ｇ：<b>${meta.gold}</b></div></div>
      <h2 class="run-h2">ジェイルタウン</h2>
      <div class="home-grid">${tiles}</div>
    </div>
    ${overlay}`;
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
    <button class="area-back-btn" data-act="go-home">← ホームへ</button>
    <h2 class="run-h2">冒険に出る</h2>
    <div class="area-grid">${tiles}</div>`;
  /* ★2026-09-05 本人指定：ここにあった「最初からやり直す」は削除した（誤爆が怖いうえ、
   * ホームの「設定」に同じものがバックアップの案内つきで置いてある）。 */
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
  /* M7 WP9：持ち出しの説明（§5-3）はここから外した——デッキ編集がホームへ移り、
   * この直後はもうデッキ編集ではないため。ホームのデッキ編集を初めて開いたときに出す。 */
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
  /* 2026-09-02 本人指摘：「スキップ」は画面右上（HUDの位置）ではなく、吹き出しの下に置く。
   * DOM順を row→skip にし、overlay側のflex-column（align-items:stretch）に任せて
   * 自然に下へ流す（絶対配置はやめた。以前は右上固定でホームのHUDと衝突していた）。 */
  return `<div class="amber-overlay" ${o.nextAct ? `data-act="${o.nextAct}"` : ''}>
    <div class="amber-row">
      <img class="amber-face" src="${portrait}" alt="" draggable="false" onerror="this.remove()">
      <div class="amber-bubble">
        <div class="amber-lines">${lines}</div>
        ${o.nextAct ? '<div class="amber-tap-hint">タップして進む</div>' : ''}
      </div>
    </div>
    ${o.skipAct ? `<button class="amber-skip" data-act="${o.skipAct}">スキップ</button>` : ''}
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
  RUI.startStage = 'draft';
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
    { k: 'lv', label: '召還Ｌｖ', w: 84, type: 'range', def: false },   /* 魔法では詠唱Ｌｖ（M6.7 WP2） */
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
    : `<span>${TYPE_NAME[c.t]}</span>${c.t === 'M' ? `<span>詠唱Ｌｖ ${c.lv}</span>` : ''}<span>${c.p} G</span>`;
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
  if (!tb) return renderDeckEdit();
  const cols = carryCols();
  const rows = carryRows();
  tb.innerHTML = rows.length
    ? rows.map(function (c) { return carryRowHTML(c, cols); }).join('')
    : `<tr><td colspan="${cols.length}" class="carry-empty">条件に合うカードがありません。</td></tr>`;
  if (detail) detail.innerHTML = carryDetailHTML();
  if (counts) {
    const dep = CQCollection.canDepart(RUI.meta);
    counts.innerHTML = `<span>${rows.length} 種を表示</span>
      <span>デッキ <b>${CQCollection.deckTotal(RUI.meta)}</b>／${CQCollection.DECK_MAX}</span>
      ${dep.ok
        ? `<span class="carry-ready">出発できます${dep.short ? `（残り${dep.short}枠は空白）` : ''}</span>`
        : `<span class="carry-short">本のカードがあと <b>${dep.fillable}</b>枚入ります（入れないと出発できません）</span>`}`;
  }
}

/* ================= デッキ編集（ホーム・M7 WP9） =================
 *
 * 『作業パッケージ』WP9。**開始マスの持ち出し画面（M6.6 WP4）をホームへ移したもの**で、
 * 表・絞り込み・並べ替え・◀▶・おまかせはそのまま流用している（作りが同じなので、
 * 変わったのは入口と出口・見出し・40枚のガードだけ）。
 *
 * ★デバッグ用のデッキ編集（`screen-deck`・M6.6 WP13）は**別物として残す**。あちらは
 * アンロックに関係なく全169種から組めるフリーバトル用で、`cq_debug_deck` に保存する。
 * こちらは本（`cq_meta.book`）にある実物だけを動かす正式版。
 *
 * ★複数デッキは作らない（2026-09-01 本人確認）。移動モデル（実体は本かデッキの一方）と
 * 両立しないため。デッキは1つだけ。 */
function renderDeckEdit() {
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

  /* 40枚に満たないと出発できない（下の home-go-adventure のガード）ので、
   * あと何枚要るのかをこの画面で常に見せておく。 */
  const dep = CQCollection.canDepart(meta);
  const guiding = !!(RUI.deckGuide && RUI.deckGuide.length);
  const overlay = guiding
    ? amberBubbleHTML(RUI.deckGuide[Math.min(RUI.deckGuideStep || 0, RUI.deckGuide.length - 1)],
        { nextAct: 'deck-guide-next', skipAct: 'deck-guide-skip' })
    : '';
  runRoot().innerHTML = `
    <div class="carry-head">
      <div class="carry-title">デッキ編集</div>
      <div class="carry-counts">
        <span>${rows.length} 種を表示</span>
        <span>デッキ <b>${CQCollection.deckTotal(meta)}</b>／${CQCollection.DECK_MAX}</span>
        ${dep.ok
          ? `<span class="carry-ready">出発できます${dep.short ? `（残り${dep.short}枠は空白）` : ''}</span>`
          : `<span class="carry-short">本のカードがあと <b>${dep.fillable}</b>枚入ります（入れないと出発できません）</span>`}
      </div>
      <button class="carry-auto" data-act="carry-auto">おまかせで選ぶ</button>
      <button class="btn ok carry-done" data-act="carry-done">ホームへ戻る</button>
    </div>
    <div class="carry-wrap">
      <div class="carry-main">
        <div class="carry-tabs">
          ${tabs}
          <button class="only-btn ${RUI.carryOnly ? 'on' : ''}" data-act="carry-only">デッキ入りのみ</button>
          <span class="carry-hint">「本」＝街に置いてある残り。▶でデッキへ、◀で本へ戻す。</span>
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
    </div>
    ${overlay}`;
}

/* おまかせで選ぶ（2026-08-29 本人指定）。スターターだけで28枚あり、1枚ずつ▶を押すのは手間なので、
 * 本から自動でデッキを組む。**40枚（満杯）まで**。
 * ★以前は38枚で止めて2枠を空白のまま残していた——おまかせドラフトが「デッキに空白がある
 * ときだけ」発生する仕様だったため（M6.6 §2-4）。**M7 WP3.5の案Bでレンタルがデッキ40枚の
 * 枠外になり、ドラフトはデッキの空きと無関係に発生する**ようになったので、この配慮は不要に
 * なった。むしろ38枚で止めると、40枚未満では出発できないガード（WP9）に引っかかる。 */
const CARRY_AUTO_MAX = CQCollection.DECK_MAX;
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

/** デッキ編集を終えてホームへ（M7 WP9）。
 * ラン中の同期はもう要らない——編集は出発前（ホーム）にしかできず、`CQRun.start()` が
 * そのときの meta.deck を複製するので、ランは必ず最新のデッキで始まる。 */
/** ホームからデッキ編集へ。初めて開いたときだけ、持ち出しの説明（台本§5-3）を出す。
 * ——この説明はM6.6 WP4で開始マスの案内の最後に出していたもので、デッキ編集がホームへ
 * 移ったので、実際に編集する場所へ一緒に引っ越してきた（`seenHints.carryOut` は同じキーを
 * 使い続ける＝すでに読んだ人には二度と出ない）。 */
function enterDeckEdit() {
  RUI.view = 'deckedit';
  carryResetTable();
  if (!CQSave.hintSeen(RUI.meta, 'carryOut')) {
    RUI.deckGuide = CQLore.LORE.hints.carryOut.slice();
    RUI.deckGuideStep = 0;
  } else {
    RUI.deckGuide = null;
  }
  runRender();
}

function finishDeckGuide() {
  RUI.deckGuide = null; RUI.deckGuideStep = 0;
  CQSave.markHint(RUI.meta, 'carryOut');
  CQSave.saveMeta(RUN_STORAGE, RUI.meta);
  runRender();
}

function finishDeckEdit() {
  CQSave.saveMeta(RUN_STORAGE, RUI.meta);
  return enterHome();
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
    : `<span>${TYPE_NAME[c.t]}</span>${c.t === 'M' ? `<span>詠唱Ｌｖ ${c.lv}</span>` : ''}`;
  return `<div class="draft-card ${c.t}" data-act="pick-draft" data-id="${id}">
    <div class="dc-art">${artInner(c, 4)}${isRental ? '<span class="rental-badge">借</span>' : ''}</div>
    <div class="dc-n">${esc(c.n)}</div>
    <div class="dc-stat">${stat}</div>
    <div class="dc-e">${esc(c.e || '')}</div>
  </div>`;
}

/** 「変更しない」＝このレンタル枠を借りない。候補3枚と視覚的に区別する（§4 WP4）。
 * M7 WP3.5（案B）：targetId は通常つねに BLANK（実カードの押し出しが無くなったため）。
 * isBlank===false になるのは旧セーブ互換の経路（draftTarget参照）だけ。 */
function draftKeepCardHTML(targetId) {
  const c = CARD_BY_ID[targetId];
  const isBlank = +targetId === CQRun.BLANK;
  return `<div class="draft-card keep" data-act="pick-draft" data-id="${targetId}">
    <div class="dc-art">${artInner(c, 4)}</div>
    <div class="dc-n">${isBlank ? '借りない' : esc(c.n) + ' を残す'}</div>
    <div class="dc-stat"><span>変更しない</span></div>
    <div class="dc-e">${isBlank ? 'このレンタル枠は使わずにおく。' : esc(c.e || '')}</div>
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
      記憶データには入らず、探索が終わると返却されます。<b>デッキ40枚とは別枠</b>で持てるので、
      デッキの中身は変わりません。使ってみて気に入ったら、道中の<b>💰買い取りのマス</b>で
      買い取れば、そのまま自分のものになります（記憶データにも残ります）。</p>`;
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
  /* 'draft'：次の回を用意する。空白が無ければ null が返り、出発前の案内②へ進む */
  if (!run.draftPending) {
    const dp = CQRun.beginDraftRound(run, CARD_BY_ID);
    if (!dp) return enterGuideAfter();
  }
  return renderStartDraft();
}

/* ================= マップ画面 ================= */

const NODE_ICON = { chest: '🎁', shop: '🛒', rest: '☕', exchange: '💰', question: '❓', start: '🏠', boss: '👑' };
const NODE_LABEL = { chest: '宝箱', shop: 'ショップ', rest: '休憩', exchange: '買い取り', question: '？', start: '開始', boss: 'ボス' };
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
      ${withRetire ? '<button class="map-hud-deck" data-act="deckview-open">デッキ</button>' : ''}
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
  /* ★2026-09-05 本人指定：？のマスも宝箱・休憩と同じ「黒い四角＋短い演出＋自動でマップへ」に
   * 揃えた（従来は文章と「進む」ボタンのパネルで、クリックを求めていた）。 */
  if (n.type === 'chest' || n.type === 'rest' || n.type === 'question') {
    RUI.eventIntroNodeId = RUI.nodeId;
    RUI.eventIntroLeaving = false;
    RUI.eventIntroKind = n.type;
    RUI.eventIntroResult = null;
    RUI.view = 'event-intro';
    return renderEventIntro();
  }
  if (n.type === 'shop') return renderShopNode(run, n);
  if (n.type === 'exchange') return renderBuyoutNode(run, n);   /* M7 WP8：中身は買い取り所（マスの型名は互換のため据え置き） */
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
    RUI.eventIntroResult = kind === 'chest' ? CQRun.openChest(run, n)
      : kind === 'question' ? (CQRun.resolveQuestion(run, n) || { text: n.event && n.event.text })
      : CQRun.rest(run, n);
    runSave();
  }
  const r = RUI.eventIntroResult;
  /* マップを下に敷いてから、その上にカットインを重ねる（四角の後ろにマップが見える。WP5と同じ） */
  renderMap();
  const ov = document.createElement('div');
  ov.className = 'event-intro';
  ov.dataset.act = 'event-intro-skip';
  const q = kind === 'question' ? questionIntroParts(n, r) : null;
  const title = kind === 'chest' ? (n.rare ? '大きな宝箱' : '宝箱')
    : kind === 'question' ? q.title : '休憩';
  const stageHTML = kind === 'chest' ? chestIntroStageHTML()
    : kind === 'question' ? q.stage : restIntroStageHTML();
  /* 2026-08-29 本人指定：獲得量の数字は一目で分かるよう大きく強調する。 */
  const msg = kind === 'chest'
    ? `<span class="event-intro-amount event-intro-amount-gold">${r.gold}Ｇ</span>を取得した。`
      + (r.cardId != null ? `<br>${esc(CARD_BY_ID[r.cardId].n)}を入手した。` : '')
    : kind === 'question' ? q.msg
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
  /* ★2026-09-05：この演出ごとの通し番号。前の演出のタイマーが後の演出を閉じてしまわないよう
   * （タップで早送りした直後に次のマスへ入ると、前の 4秒タイマーがまだ生きている）、
   * タイマーは自分が始めた演出のときだけ働かせる。 */
  const token = (RUI.eventIntroToken || 0) + 1;
  RUI.eventIntroToken = token;
  setTimeout(function () {
    if (RUI.eventIntroToken !== token) return;
    const cut = ov.querySelector('.event-intro-cut');
    if (cut) cut.classList.add('closing');
  }, EVENT_INTRO_MS - 400);
  setTimeout(function () {
    if (RUI.eventIntroToken !== token) return;
    leaveEventIntro();
  }, EVENT_INTRO_MS);
}

/* ---- ？のマスの演出（2026-09-05 本人指定） --------------------------------
 * ？で起きる5つの出来事に、それぞれ短い演出を割り当てる。宝箱・休憩と同じ四角の中で
 * 完結し、クリックは求めない（EVENT_INTRO_MS で自動的にマップへ戻る）。
 *
 *   spring 泉    ＬＰ+1   … 休憩と同じハートがコマへ飛び込む（回復＝同じ見え方に揃える）
 *   trap   落とし穴 ＬＰ-1 … コマが揺れ、割れたハートが落ちる（損失＝下向き・赤）
 *   coin   巾着   Ｇ+150  … **宝箱と同じ金貨の演出**（本人指定。巾着の絵からＧがはじける）
 *   toll   門番   Ｇ-100  … 金貨が財布から下へこぼれ落ちる（損失＝下向き・くすんだ色）
 *   stray  ログの欠片 カード … カードが1枚ふわりと現れて光る
 *
 * 中央に置く絵はマップの？アイコンではなく、出来事ごとの絵文字（大きく1つ）にしてある
 * ——？のままだと「何が起きたか」が絵から分からないため。 */
const QUESTION_FX = {
  spring: { title: '澄んだ泉', icon: '⛲' },
  /* 落とし穴の絵文字（🕳）は端末によって字形を持たず白い箱になるので使わない。
   * かわりに足元へＣＳＳで暗い穴を描く（questionIntroParts の trap を参照）。 */
  trap:   { title: '落とし穴', icon: '' },
  coin:   { title: '落とし物の巾着', icon: '👛' },
  toll:   { title: '怪しい門番', icon: '💂' },
  stray:  { title: 'ログの欠片', icon: '✨' }
};

/** ？のマスの題名・演出・結果メッセージを組み立てる。r は CQRun.resolveQuestion の戻り値
 * （再描画で null が返る場合に備え、呼び出し側が {text} だけの形に丸めて渡してくる）。 */
function questionIntroParts(n, r) {
  const ev = n.event || {}, eff = ev.effect || {};
  const fx = QUESTION_FX[ev.id] || { title: '？', icon: '❓' };
  /* コマと並べる出来事の絵は、コマの頭に重ならないよう小さく左上へ寄せる（.side） */
  const icon = function (side) {
    return fx.icon ? `<div class="event-q-icon${side ? ' side' : ''}">${fx.icon}</div>` : '';
  };
  let stage = icon(false), msg = esc(ev.text || '');
  if (eff.lp > 0) {                                   /* 泉：回復（休憩と同じハート） */
    stage = `<div class="event-rest-hero">
        <img src="assets/map/player.png" alt="" draggable="false" onerror="this.remove()">
      </div>${questionHeartsHTML()}${icon(true)}`;
    msg += `<br>ＬＰが<span class="event-intro-amount event-intro-amount-lp">${eff.lp}</span>回復した。`;
  } else if (eff.lp < 0) {                            /* 落とし穴：ＬＰが減る */
    stage = `<div class="event-q-hole"></div>
      <div class="event-rest-hero event-q-shake">
        <img src="assets/map/player.png" alt="" draggable="false" onerror="this.remove()">
      </div><span class="event-q-fall event-q-fall-heart" style="--qx:64px">💔</span>${icon(true)}`;
    msg += `<br>ＬＰが<span class="event-intro-amount event-intro-amount-lp">${-eff.lp}</span>減った。`;
  } else if (eff.gold > 0) {                          /* 巾着：宝箱と同じ金貨がはじける */
    stage = `<div class="event-q-purse">${fx.icon}</div>${chestCoinsHTML()}`;
    msg += `<br><span class="event-intro-amount event-intro-amount-gold">${eff.gold}Ｇ</span>を手に入れた。`;
  } else if (eff.gold < 0) {                          /* 門番：金貨がこぼれ落ちる */
    stage = `${icon(false)}${questionCoinsFallHTML()}`;
    msg += `<br><span class="event-intro-amount event-intro-amount-gold">${-eff.gold}Ｇ</span>を支払った。`;
  } else if (eff.draftCard && n.cardId != null) {     /* ログの欠片：カードが現れる */
    stage = `<div class="event-q-card">${cardArtHTML(n.cardId)}</div>${questionSparklesHTML()}`;
    msg += `<br>${esc(CARD_BY_ID[n.cardId].n)}を入手した。`;
  }
  void r;
  return { title: fx.title, stage: stage, msg: msg };
}

/** 泉のハート（休憩の飛び込みを2つだけ使う。回復量が1なので控えめにする） */
function questionHeartsHTML() {
  return [{ side: 'l', delay: 0 }, { side: 'r', delay: .18 }].map(function (h) {
    return `<span class="event-rest-heart event-rest-heart-${h.side}" style="animation-delay:${h.delay}s">♥</span>`;
  }).join('');
}

/** 門番：金貨が下へこぼれ落ちる（獲得のはじけ飛びと逆向き・くすんだ色） */
function questionCoinsFallHTML() {
  return [{ x: -46, d: 0 }, { x: 8, d: .18 }, { x: 52, d: .33 }, { x: -14, d: .48 }].map(function (c) {
    return `<span class="event-q-fall event-q-fall-coin" style="animation-delay:${c.d}s;--qx:${c.x}px">Ｇ</span>`;
  }).join('');
}

/** ログの欠片：カードの周りにきらめきが散る */
function questionSparklesHTML() {
  return [{ x: -78, y: -20, d: 0 }, { x: 74, y: -46, d: .2 }, { x: -58, y: -70, d: .38 },
          { x: 62, y: 12, d: .52 }].map(function (k) {
    return `<span class="event-q-spark" style="animation-delay:${k.d}s;--qx:${k.x}px;--qy:${k.y}px">✦</span>`;
  }).join('');
}

/** ？で手に入れたカードの絵（バトル画面と同じ ART_DIR／artSrcId の規約に揃える。
 * 絵が無ければ札の絵文字にフォールバックする） */
function cardArtHTML(cardId) {
  const c = CARD_BY_ID[cardId];
  return `<img src="${ART_DIR}${artSrcId(c)}${ART_EXT}" alt="" draggable="false"
      onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'event-q-card-fallback',textContent:'🎴'}))">
    <span class="event-q-card-name">${esc(c ? c.n : '')}</span>`;
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
  return `<div class="event-chest-box">
      <img src="assets/map/icon_chest.png" alt="" draggable="false"
        onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'event-chest-box-fallback',textContent:'🎁'}))">
    </div>${chestCoinsHTML()}`;
}

/** はじけ飛ぶ金貨（宝箱と、？の「落とし物の巾着」が共有する。2026-09-05 本人指定：
 * ？でＧを拾ったときも宝箱と同じ演出にする） */
function chestCoinsHTML() {
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
  return coins;
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

/* ================= カードグリッド＋情報パネル（M6.6 WP9・共通部品） =================
 *
 * 実装計画追補§4 WP9-a。換金所・デッキ確認・ショップ・戦利品振り分けの4画面は、
 * 見た目も操作感もすべて「左〜中央にカードのイラストを敷き詰め、右300pxの情報パネルに
 * 選択中のカードの詳細を出す」という同じ部品でできている。違うのは①並べる対象
 * （デッキ／在庫／戦利品）と②情報パネル下部のボタン（売る／購入／デッキに加える・本に送る／
 * 無し）の2点だけなので、共通部分をここにまとめ、呼び出し側は items（並べる1枚1枚）と
 * actionsHTML（選択中カードに対するボタン）だけを渡す。
 *
 * カードは「本/デッキの合計40枚」を前提に、枚数ぶんタイルを並べる（例：同じカードを3枚
 * 持っていればタイルも3枚）。§7-3の寸法（940×620・8列×5行）はスクロールが要らない前提の
 * 目安で、実際の格子は CSS の grid で可変（fr）にしてあるので画面の余白に合わせて伸縮する。 */

/** スクロールする一覧のための位置保存（2026-09-02 本人指摘・M7 WP6で判明）。
 *
 * この画面群はカードを1枚選ぶたびに `runRoot().innerHTML` を丸ごと作り直すので、
 * 何もしなければ `.cg-grid` のスクロール位置が毎回0へ戻る＝下の方のカードを選んだ瞬間に
 * 一覧が先頭へ飛んでしまう。**描き直す直前に save、直後に restore** の2行を置くだけで済むよう
 * 部品にしてある。key は画面＋タブごとに分ける（別のタブへ移ったときは0から始まってよい）。 */
function keepScrollSave(key) {
  const el = runRoot() && runRoot().querySelector('.cg-grid');
  if (el) RUI.colScroll[key] = el.scrollTop;
}
function keepScrollRestore(key) {
  const el = runRoot() && runRoot().querySelector('.cg-grid');
  if (el) el.scrollTop = RUI.colScroll[key] || 0;
}

/** 画面が切り替わった（＝別のgridCtx）ときだけ選択中カードをリセットする。
 * 同じ画面内での再描画（購入・売却のたび）では選択を保つ——さもないと1枚ずつしか
 * 連続購入・連続売却できない。 */
function gridEnter(ctx) {
  if (RUI.gridCtx !== ctx) { RUI.gridCtx = ctx; RUI.gridSel = null; RUI.gridSelIdx = null; }
}

/** グリッドのタイル1枚（イラストのみ・9-a「カードをイラストのみで敷き詰める」）。
 * 第2引数はバッジ：`true` なら「借」（レンタル。換金所・デッキ確認）、文字列ならその字を出す
 * （M7 WP7 のログショップが「限」＝貴重の限定枠・「複」＝複製に使う）。 */
function cgTileHTML(id, badge, idx) {
  const c = CARD_BY_ID[id];
  const label = badge === true ? '借' : badge;
  return `<div class="cg-tile ${RUI.gridSelIdx === idx ? 'on' : ''}" data-act="grid-pick" data-id="${id}" data-idx="${idx}">
      <div class="cg-tile-art">${artInner(c, 3)}</div>
      ${label ? `<span class="cg-badge">${esc(label)}</span>` : ''}
    </div>`;
}

function cgGridHTML(items, emptyMsg) {
  if (!items.length) return `<div class="cg-empty">${esc(emptyMsg || 'カードがありません')}</div>`;
  return `<div class="cg-grid">${items.map(function (it, idx) { return cgTileHTML(it.id, it.rental, idx); }).join('')}</div>`;
}

/** タイルの直下に、そのカード専用のボタン（購入・売る・振り分け等）を添えたカード
 * （2026-08-29 本人指摘：ボタンを情報パネル側に置くと、選んだカードから離れていて見にくい。
 * ショップ・換金所・戦利品振り分けの3画面で共用。btnsFn(item, idx) がそのカードのボタン欄の
 * HTMLを返す——空文字なら見た目はcgGridHTMLのタイルと同じになる）。 */
function cgCardHTML(item, idx, btnsHTML) {
  return `<div class="cg-card">
      ${cgTileHTML(item.id, item.badge != null ? item.badge : item.rental, idx)}
      ${btnsHTML ? `<div class="cg-card-btns">${btnsHTML}</div>` : ''}
    </div>`;
}

function cgCardGridHTML(items, emptyMsg, btnsFn) {
  if (!items.length) return `<div class="cg-empty">${esc(emptyMsg || 'カードがありません')}</div>`;
  return `<div class="cg-grid cg-grid-btn">${items.map(function (it, idx) {
    return cgCardHTML(it, idx, btnsFn(it, idx));
  }).join('')}</div>`;
}

/** 右の情報パネル（screen-deck・持ち出し画面の .detail .big と同じ体裁を流用）。
 * actionsHTML は画面ごとに差し替える下部のボタン（9-a）。 */
function cgDetailHTML(actionsHTML) {
  const c = CARD_BY_ID[RUI.gridSel];
  if (!c) return '<div class="carry-detail-empty">カードを選ぶと、ここに絵と詳細が出ます。</div>';
  const stat = c.t === 'U'
    ? `<span>攻撃力 ${c.a}</span><span>防御力 ${c.d}</span>
       <span>ＣＨ ${c.ch}</span><span>召還Ｌｖ ${c.lv}</span><span>${c.p} G</span>`
    : `<span>${TYPE_NAME[c.t]}</span>${c.t === 'M' ? `<span>詠唱Ｌｖ ${c.lv}</span>` : ''}<span>${c.p} G</span>`;
  return `
    <div class="big ${c.t}">
      <div class="bigart">${artInner(c)}</div>
      <div class="bn">${esc(c.n)}</div>
      <div class="bstat">${stat}</div>
      <div class="btext">${esc(c.e || '')}</div>
    </div>
    <div class="cg-actions">${actionsHTML || ''}</div>`;
}

/** ラン中に「持ち出している」全部（9-b・9-c で共用）：デッキのカードを枚数ぶん展開し、
 * レンタルを個別に足す。空白(180)は実体が無いので含めない。 */
function runCarryItems(run) {
  const items = [];
  Object.keys(run.deck).forEach(function (k) {
    const id = +k;
    if (id === CQRun.BLANK) return;
    for (let i = 0; i < run.deck[k]; i++) items.push({ id: id, rental: false });
  });
  (run.rentals || []).forEach(function (id) { items.push({ id: id, rental: true }); });
  return items;
}

function renderShopNode(run, n) {
  gridEnter('shop:' + RUI.nodeId);
  const items = n.stock.map(function (id) { return { id: id, rental: false }; });
  const showFog = n.hasFogClear && !run.map.fog.cleared;
  runRoot().innerHTML = `
    <div class="cg-head">
      <div class="cg-title">ショップ</div>
      <div class="cg-stats">
        <span>所持Ｇ <b>${run.gold}</b></span>
        <span>ＬＰ <b>${run.lp}</b>／${run.maxLp}</span>
      </div>
      <div class="cg-head-actions">
        <button class="tiny" data-act="shop-heal" ${run.gold < n.healCost || run.lp >= run.maxLp ? 'disabled' : ''}>
          ＬＰ回復（Ｇ${n.healCost}）</button>
        ${showFog ? `<button class="tiny" data-act="shop-fog" ${run.gold < n.fogClearCost ? 'disabled' : ''}>
          霧払い（Ｇ${n.fogClearCost}）</button>` : ''}
        <button class="btn ok cg-done" data-act="shop-leave">立ち去る</button>
      </div>
    </div>
    <div class="cg-wrap">
      <div class="cg-main">${cgCardGridHTML(items, '品切れです', function (it) {
        const price = CQRun.shopPrice(CARD_BY_ID, it.id);
        return `<button class="tiny" data-act="shop-buy" data-id="${it.id}" ${run.gold < price ? 'disabled' : ''}>Ｇ${price}で購入</button>`;
      })}</div>
      <div class="detail cg-detail">${cgDetailHTML('')}</div>
    </div>`;
}

/* ================= 買い取り所（M7 WP8） =================
 *
 * 旧・換金所（売却）を置き換えた画面。経済追補§4-3〜§4-6。
 * **いま借りているレンタルカードをＧで買い取る**＝レンタル属性が外れて自分のものになり、
 * 記憶データに登録され、ラン終了後も手元に残る（どの終わり方でも失わない）。
 *
 * ショップが「抽選された品揃えから選ぶ＝運」なのに対し、ここは「使ってみて良いと分かって
 * いるものを狙って買う＝確定」で、開始マスのドラフトがラン後半の判断に繋がる（§4-3）。
 * 売る機能はもう無い（ダブり札の売却はホームのログショップ＝WP7へ移った）。
 *
 * ボタンはタイルの直下に置く（ショップと同じ流儀）。旧・換金所だけは「一覧＋情報パネルに
 * ボタン」という別の形にしていたが、それは**持ち出した40枚が全部並んで縦に長かった**ため。
 * 買い取り所に並ぶのはレンタルの最大2枚だけなので、その理由はもう当てはまらない。 */
function renderBuyoutNode(run, n) {
  gridEnter('buyout:' + RUI.nodeId);
  const items = (run.rentals || []).map(function (id) { return { id: id, rental: true }; });
  runRoot().innerHTML = `
    <div class="cg-head">
      <div class="cg-title">買い取り</div>
      <div class="cg-stats"><span>所持Ｇ <b>${run.gold}</b></span></div>
      <button class="btn ok cg-done" data-act="buyout-leave">立ち去る</button>
    </div>
    <p class="cg-note buyout-note">借りているカードを買い取ると、あなたのものになります。
      記憶データに残り、探索が終わっても返さなくてよくなります。</p>
    <div class="cg-wrap">
      <div class="cg-main">${cgCardGridHTML(items, 'いま借りているカードはありません', function (it, idx) {
        const price = CQRun.buyoutPrice(CARD_BY_ID, it.id, run.areaId);
        const rare = CQCollection.isRare(CARD_BY_ID[it.id], CQAreas.rareThreshold(run.areaId));
        return `<button class="tiny" data-act="buyout" data-idx="${idx}" ${run.gold < price ? 'disabled' : ''}>
            Ｇ${price}で買い取る</button>
          ${rare ? '<div class="buyout-rare">貴重（定価×1.5）</div>' : ''}`;
      })}</div>
      <div class="detail cg-detail">${cgDetailHTML('')}</div>
    </div>`;
}

/** デッキ確認（M6.6 WP9-c・新規）。ラン中いつでもマップのHUD「デッキ」ボタンから開ける。
 * 操作は一切できない（閲覧のみ）——編集は開始マスだけ、という§2-3の原則はここでも崩さない。 */
function renderDeckView() {
  const run = RUI.run;
  gridEnter('deckview');
  const items = runCarryItems(run);
  /* M7 WP3.5（案B）：レンタルはデッキ40枚の枠外なので別掲する（40／40と表示されているのに
   * 実際は42枚戦えている、という不一致を避ける）。 */
  const total = CQCollection.countsTotal(run.deck);
  const blank = Math.max(0, CQRun.DECK_SIZE - total);
  const rentals = run.rentals ? run.rentals.length : 0;
  runRoot().innerHTML = `
    <div class="cg-head">
      <div class="cg-title">デッキ</div>
      <div class="cg-stats">
        <span>デッキ <b>${total}</b>／${CQRun.DECK_SIZE}</span>
        <span>空白 <b>${blank}</b>枚</span>
        ${rentals ? `<span>レンタル <b>${rentals}</b>枚（枠外）</span>` : ''}
      </div>
      <button class="btn ok cg-done" data-act="deckview-leave">マップに戻る</button>
    </div>
    <div class="cg-wrap">
      <div class="cg-main">${cgGridHTML(items, '持ち出しているカードがありません')}</div>
      <div class="detail cg-detail">${cgDetailHTML('')}</div>
    </div>`;
}

/* ================= コレクション図鑑（M7 WP6） =================
 *
 * ホームの「コレクション」施設。cq_meta.known（記憶データ＝一度でも入手した種類）を
 * 元に、全169種（U73／M48／S48）を種別タブで一覧する。未入手は「？」のみの伏せカードにし、
 * 名前は「？？？」に伏せるが、入手方法（data.jsの`g`フィールド）は既読・未読どちらも出す＝
 * 『作業パッケージ』WP6の「未入手カードには入手経路のヒントを出す」に沿う。
 * 2026-09-02 本人指摘で分かったこと：当初は霧の中の敵と同じCSSフィルタ（brightness(0)）で
 * 「形だけ分かる」影にしようとしたが、あちらは背景が透明なキャラの切り抜きPNGだから輪郭が
 * 残る——カードの絵は全面を塗った長方形の1枚絵で透明部分が無いため、フィルタをかけても
 * 「輪郭のある影」にはならず、ただの塗り潰しにしかならない（実際に暗い地色の上でほぼ
 * 見えなかった）。なので絵そのものは出さず、伏せカードは最初から「？」の記号だけにした。
 * カードグリッド＋情報パネルはWP9の共通部品（cgGridHTML等）ではなく専用のcolXxx系を使う——
 * cgTileHTML/cgDetailHTMLは「持っている枚数」前提の作りで、未入手（0枚だが存在は分かって
 * いる）を表せないため。 */

/* コレクション対象＝U／M／S の3種別（カースやおじゃま虫は収集対象外）。169種（ゲーム仕様書§6.3）。
 * id180「空白」はt:'S'だがデッキ枠埋め用の見張り値（CQRun.BLANK）で実在のカードではないため除く。 */
const COLLECTION_TOTAL = CARDS.filter(function (c) {
  return (c.t === 'U' || c.t === 'M' || c.t === 'S') && c.id !== CQRun.BLANK;
}).length;

function colTileHTML(id, known, idx) {
  const c = CARD_BY_ID[id];
  const inner = known
    ? `<div class="cg-tile-art">${artInner(c, 3)}</div>`
    : '<span class="col-unknown-mark">？</span>';
  return `<div class="cg-tile ${known ? '' : 'col-unknown'} ${RUI.gridSelIdx === idx ? 'on' : ''}"
      data-act="grid-pick" data-id="${id}" data-idx="${idx}">
      ${inner}
    </div>`;
}

function colGridHTML(items) {
  if (!items.length) return '<div class="cg-empty">カードがありません</div>';
  return `<div class="cg-grid col-grid">${items.map(function (it, idx) {
    return colTileHTML(it.id, it.known, idx);
  }).join('')}</div>`;
}

function colDetailHTML() {
  const c = CARD_BY_ID[RUI.gridSel];
  if (!c) return '<div class="carry-detail-empty">カードを選ぶと、ここに絵と詳細が出ます。</div>';
  const known = (RUI.meta.known || []).indexOf(c.id) >= 0;
  const obtHTML = `<div class="obt"><h4>入手方法</h4><div class="obtain">${esc(c.g || '（未設定）')}</div></div>`;
  if (!known) {
    return `
      <div class="big ${c.t} col-unknown">
        <div class="bigart col-unknown-mark">？</div>
        <div class="bn">？？？</div>
      </div>
      ${obtHTML}`;
  }
  const stat = c.t === 'U'
    ? `<span>攻撃力 ${c.a}</span><span>防御力 ${c.d}</span>
       <span>ＣＨ ${c.ch}</span><span>召還Ｌｖ ${c.lv}</span><span>${c.p} G</span>`
    : `<span>${TYPE_NAME[c.t]}</span>${c.t === 'M' ? `<span>詠唱Ｌｖ ${c.lv}</span>` : ''}<span>${c.p} G</span>`;
  return `
    <div class="big ${c.t}">
      <div class="bigart">${artInner(c)}</div>
      <div class="bn">${esc(c.n)}</div>
      <div class="bstat">${stat}</div>
      <div class="btext">${esc(c.e || '')}</div>
    </div>
    ${obtHTML}`;
}

function renderCollection() {
  const meta = RUI.meta;
  const tab = RUI.colTab || 'U';
  keepScrollSave('collection:' + tab);
  gridEnter('collection:' + tab);
  const known = meta.known || [];
  const items = CARDS.filter(function (c) { return c.t === tab && c.id !== CQRun.BLANK; })
    .sort(function (a, b) { return a.id - b.id; })
    .map(function (c) { return { id: c.id, known: known.indexOf(c.id) >= 0 }; });
  const lv = CQCollection.masterLevelOf(meta);
  const need = CQCollection.nextStageNeed(known.length);
  const tabsHTML = CARRY_TABS.map(function (t) {
    return `<button class="dtab ${t.t} ${tab === t.t ? 'on' : ''}" data-act="col-tab" data-id="${t.t}">${t.label}</button>`;
  }).join('');
  runRoot().innerHTML = `
    <div class="cg-head">
      <div class="cg-title">コレクション</div>
      <div class="cg-stats">
        <span>記憶データ <b>${known.length}</b>／${COLLECTION_TOTAL}</span>
        <span>マスターレベル <b>${lv}</b>／${CQCollection.STAGE_MAX}</span>
        ${need ? `<span>次の段階まであと <b>${need}</b>種</span>` : '<span>最終段階</span>'}
      </div>
      <button class="btn ok cg-done" data-act="collection-leave">ホームへ戻る</button>
    </div>
    <div class="carry-tabs">${tabsHTML}</div>
    <div class="cg-wrap">
      <div class="cg-main">${colGridHTML(items)}</div>
      <div class="detail cg-detail">${colDetailHTML()}</div>
    </div>`;
  keepScrollRestore('collection:' + tab);
}

/* ================= 設定画面（ホーム・M7 WP11） =================
 *
 * 『作業パッケージ』WP11＝**バックアップ（書き出し／読み込み）**の置き場所。
 * ゲーム仕様書§9「機種変更・事故対策」。あわせて、これまでエリア選択の隅にあった
 * 「最初からやり直す」（M6.6 WP2の開発機能）もここに集約した。
 *
 * ★**読み込みは既存のセーブを壊さない**（受け入れ基準）。検査はすべて
 * `CQBackup.validate()`（storage に触らない）で済ませ、通ったときだけ書き込む。
 * 読み込んだあとは必ずリロードする——画面が持っている RUI.meta・中断中のランを
 * 中途半端に作り替えるより、最初から読み直すほうが確実。 */

/** 演出の速さの設定値（localStorage cq_fx）。★未設定は 'slow'（2026-09-05 本人指定：
 * 初めて遊ぶ人がいちばん困るのは「相手の手番で何が起きたか分からない」ことなので、
 * 既定を「ゆっくり」にしておく。js/layout.js の FX_SPEED_DEFAULT と揃えること） */
function fxSpeedSetting() {
  try { const v = JSON.parse(RUN_STORAGE.getItem('cq_fx') || '{}').speed; return ['slow', 'normal', 'fast'].indexOf(v) >= 0 ? v : 'slow'; }
  catch (_) { return 'slow'; }
}

function renderSettings() {
  const meta = RUI.meta;
  const st = RUI.backupState || {};
  const keys = CQBackup.collectKeys(RUN_STORAGE);
  runRoot().innerHTML = `
    <div class="cg-head">
      <div class="cg-title">設定</div>
      <div class="cg-stats"><span>通算 <b>${meta.day || 0}</b>日目</span></div>
      <button class="btn ok cg-done" data-act="settings-leave">ホームへ戻る</button>
    </div>
    <div class="set-wrap">
      <section class="set-box">
        <h4>バックアップ</h4>
        <p class="set-note">セーブを1つのファイルに書き出します。機種を変えるとき、
          データが消えたときに備えて、ときどき書き出しておくと安心です。</p>
        <p class="set-note">いま保存されているもの：${keys.length}件（${esc(keys.join('・'))}）</p>
        <div class="set-acts">
          <button class="btn ok" data-act="backup-export">バックアップを書き出す</button>
          <label class="btn ng set-file">バックアップを読み込む
            <input type="file" accept="application/json,.json" data-file="backup" hidden>
          </label>
        </div>
        ${st.msg ? `<p class="set-msg ${st.ok ? 'ok' : 'ng'}">${esc(st.msg)}</p>` : ''}
        <p class="set-note">読み込むと、いまのセーブは<b>書き出したときの状態に置き換わります</b>
          （中断中の探索も含めて丸ごと戻ります）。壊れたファイルを読ませても、いまのセーブは
          そのままです。</p>
      </section>
      <section class="set-box">
        <h4>演出の速さ</h4>
        <p class="set-note">戦闘中の「攻撃の宣言」「判定の数字」「ＬＰの減少」「憑依・傀儡」を
          止まって見せる時間を変えます。<b>はじめは「ゆっくり」</b>です。相手の手番の流れが
          分かるようになったら「ふつう」「速い」にすると、さくさく進みます。</p>
        <div class="set-acts">
          ${[['slow', 'ゆっくり'], ['normal', 'ふつう'], ['fast', '速い']].map(([v, label]) =>
            `<button class="btn ${fxSpeedSetting() === v ? 'ok' : 'ng'}" data-act="fx-speed" data-id="${v}">${label}</button>`).join('')}
        </div>
      </section>
      <section class="set-box">
        <h4>最初からやり直す</h4>
        <p class="set-note">すべての記録（本・デッキ・記憶データ・称号・日誌）を消して、
          目覚めの場面から始め直します。<b>元には戻せません。</b>
          心配なら、先にバックアップを書き出しておいてください。</p>
        <div class="set-acts">
          <button class="btn ng" data-act="reset-progress">最初からやり直す</button>
        </div>
      </section>
    </div>`;
}

/** バックアップの書き出し（ファイルとして保存させる）。
 * Blob → 一時的な <a download> を押す、という素直なやり方（confquest の backup.js と同じ）。 */
function backupExport() {
  try {
    const text = CQBackup.serialize(RUN_STORAGE, { version: (typeof APP_VERSION !== 'undefined') ? APP_VERSION : '' });
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = CQBackup.fileName();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    RUI.backupState = { ok: true, msg: '書き出しました：' + CQBackup.fileName() };
  } catch (e) {
    RUI.backupState = { ok: false, msg: '書き出せませんでした。' };
  }
  runRender();
}

/** バックアップの読み込み。検査 → 確認 → 書き込み → リロード。 */
function backupImport(text) {
  const chk = CQBackup.validate(text);
  if (!chk.ok) {
    RUI.backupState = { ok: false, msg: chk.reason + '（いまのセーブはそのままです）' };
    return runRender();
  }
  const when = chk.savedAt ? chk.savedAt.slice(0, 16).replace('T', ' ') : '日時不明';
  showConfirm(
    when + ' に書き出したバックアップを読み込みます。いまのセーブは置き換わります。よろしいですか？',
    function () {
      const r = CQBackup.importData(RUN_STORAGE, text);
      if (!r.ok) {
        RUI.backupState = { ok: false, msg: r.reason };
        return runRender();
      }
      location.reload();
    },
    '読み込む'
  );
}

/* ================= 記録画面（ホーム・M7 WP10） =================
 *
 * 『作業パッケージ』WP10。ホームの「記録」施設。
 *
 * ★**トップの「いまの目標」1行は必ず出す**（世界観§6.6）。原作がクリアされなかった
 * 最大の原因（何をすればいいのか分からなくなる）への対策として名指しで指定されている項目で、
 * 作業パッケージにも「省略しないこと」と書いてある。何を出すかは
 * `CQCollection.nextGoal()`（進行から決める）、文面は `CQLore.goalLine()`（台本）が持つ。
 *
 * 左に実績・称号・エリア・統計、右に日誌（新しい順）。日誌は `cq_meta.journal` に
 * M6.6 WP11 から溜まっているもので、読み返す画面がここで初めて付いた。 */

/** 鍵の総数（世界観§5・七罪人の封印）。鍵そのものは M8 の実装なので、
 * ここでは「これから何を集めるのか」を見せるためだけに枠を出す。 */
const RECORD_KEYS_TOTAL = 7;

function recordGoalHTML(meta) {
  const areas = CQAreas.list().map(function (a) {
    return { id: a.id, name: a.name, unlocked: CQAreas.isUnlocked(a.id, meta.cleared || []) };
  });
  const goal = CQCollection.nextGoal(meta, areas);
  return `<div class="rec-goal">
      <span class="rec-goal-cap">いまの目標</span>
      <span class="rec-goal-text">${esc(CQLore.goalLine(goal))}</span>
    </div>`;
}

/* 称号の名前は**未獲得でも伏せない**。この画面は「次に何を目指すか」を見せるためのもの
 * （世界観§6.6）なので、名前を隠すと目標が1つ減ってしまう。獲得済みは★＋明るい色で区別する。 */
function recordTitlesHTML(meta) {
  const had = meta.titles || [];
  return CQRun.TITLES.map(function (t) {
    const got = had.indexOf(t.key) >= 0;
    return `<div class="rec-title ${got ? 'on' : ''}">
        <span class="rec-title-mark">${got ? '★' : '☆'}</span>
        <span class="rec-title-name">${esc(t.name)}</span>
        <span class="rec-title-desc">${esc(t.desc)}</span>
      </div>`;
  }).join('');
}

function recordAreasHTML(meta) {
  const cleared = meta.cleared || [];
  return CQAreas.list().map(function (a) {
    const unlocked = CQAreas.isUnlocked(a.id, cleared);
    const done = cleared.indexOf(a.id) >= 0;
    return `<div class="rec-row">
        <span>${esc(a.name)}</span>
        <b class="${done ? 'ok' : ''}">${done ? '踏破' : (unlocked ? '未踏破' : '未解放')}</b>
      </div>`;
  }).join('');
}

function renderRecord() {
  const meta = RUI.meta;
  const st = meta.stats || {};
  const known = (meta.known || []).length;
  /* 日誌は**新しい順**（受け入れ基準）。溜まった順に push しているので逆から並べる。 */
  const journal = (meta.journal || []).slice().reverse();
  const journalHTML = journal.length
    ? journal.map(function (line) { return `<li>${esc(line)}</li>`; }).join('')
    : '<li class="rec-empty">まだ何も書かれていない。ひとつ探索を終えると、ここに残る。</li>';
  runRoot().innerHTML = `
    <div class="cg-head">
      <div class="cg-title">記録</div>
      <div class="cg-stats">
        <span>通算 <b>${meta.day || 0}</b>日目</span>
        <span>記憶データ <b>${known}</b>／${COLLECTION_TOTAL}</span>
        <span>マスターレベル <b>${CQCollection.masterLevelOf(meta)}</b>／${CQCollection.STAGE_MAX}</span>
      </div>
      <button class="btn ok cg-done" data-act="record-leave">ホームへ戻る</button>
    </div>
    ${recordGoalHTML(meta)}
    <div class="rec-wrap">
      <div class="rec-col">
        <h4>称号</h4>
        <div class="rec-titles">${recordTitlesHTML(meta)}</div>
        <h4>踏破</h4>
        <div class="rec-rows">
          ${recordAreasHTML(meta)}
          <div class="rec-row"><span>鍵</span><b>${(meta.keys || []).length}／${RECORD_KEYS_TOTAL}</b></div>
          <p class="cg-note rec-note">鍵は、この先の土地で見つかる。</p>
        </div>
        <h4>統計</h4>
        <div class="rec-rows">
          <div class="rec-row"><span>探索した日数</span><b>${meta.day || 0}</b></div>
          <div class="rec-row"><span>マスター撃破</span><b>${st.boss || 0}</b></div>
          <div class="rec-row"><span>踏破して帰還</span><b>${st.win || 0}</b></div>
          <div class="rec-row"><span>引き返した</span><b>${st.retire || 0}</b></div>
          <div class="rec-row"><span>倒れた</span><b>${st.lose || 0}</b></div>
          <div class="rec-row"><span>持ち帰ったカード</span><b>${st.cards || 0}枚</b></div>
          <div class="rec-row"><span>所持Ｇ</span><b>${meta.gold || 0}</b></div>
        </div>
      </div>
      <div class="rec-col rec-journal">
        <h4>日誌<span class="rec-n">${journal.length}行</span></h4>
        <ul class="rec-journal-list">${journalHTML}</ul>
      </div>
    </div>`;
}

/* ================= ログショップ（ホーム・M7 WP7） =================
 *
 * 『作業パッケージ』WP7 と『経済追補』§4-2・§4-2b の画面側。3つの機能が1画面に同居する：
 *
 *   買う … ①段階で解禁された新規（魔法・技能・貴重は除く）②所持済みの複製（いつでも可）
 *          ③貴重カードの限定枠1枠（定価×1.5・通算日数で入れ替わる）
 *   売る … 本の在庫を1枚ずつ（定価25%）。**デッキの分は出さない**＝売れない
 *   一括 … ダブり（デッキと本の合計で3枚を超えた分）をまとめて換金。
 *          確定前に必ず対象一覧と合計額を見せ、個別に除外できる（§4-2b）
 *
 * ★金額・対象の判断はすべて CQCollection / CQRun.sellPrice に委ねてある。
 * この画面は数字を1つも自前で計算しない——率や保護枚数を2箇所に持つと必ずズレる
 * （M6.6 WP9 の売値で一度踏んだ事故）。 */

function shopStockItems(meta) {
  const items = [];
  const slot = CQCollection.rareSlot(CARD_BY_ID, meta);
  if (slot) items.push({ id: slot.id, price: slot.price, badge: '限', rare: true });
  CQCollection.homeStock(CARD_BY_ID, meta).forEach(function (it) {
    items.push({ id: it.id, price: it.price, badge: it.dup ? '複' : '' });
  });
  return items;
}

/** 売り場に並べる本の在庫（1枚ずつタイルに展開）。デッキの分は**そもそも並べない**。 */
function shopBookItems(meta) {
  const items = [];
  Object.keys(meta.book || {}).sort(function (a, b) { return +a - +b; }).forEach(function (k) {
    const id = +k;
    if (id === CQRun.BLANK) return;
    for (let i = 0; i < meta.book[k]; i++) items.push({ id: id, badge: '' });
  });
  return items;
}

function shopHeadHTML(meta, title) {
  const lv = CQCollection.masterLevelOf(meta);
  return `<div class="cg-head">
      <div class="cg-title">${esc(title)}</div>
      <div class="cg-stats">
        <span>所持Ｇ <b>${meta.gold}</b></span>
        <span>品揃え 段階 <b>${lv}</b>／${CQCollection.STAGE_MAX}</span>
      </div>
      <button class="btn ok cg-done" data-act="logshop-leave">ホームへ戻る</button>
    </div>`;
}

function renderLogShop() {
  const meta = RUI.meta;
  if (RUI.shopBulk) return renderBulkSell();
  const tab = RUI.shopTab || 'buy';
  const key = 'logshop:' + tab;
  keepScrollSave(key);
  gridEnter(key);
  const items = (tab === 'buy') ? shopStockItems(meta) : shopBookItems(meta);
  const gridHTML = (tab === 'buy')
    ? cgCardGridHTML(items, '売り物がありません', function (it) {
        return `<button class="tiny" data-act="logshop-buy" data-id="${it.id}"
          ${meta.gold < it.price ? 'disabled' : ''}>Ｇ${it.price}で買う</button>`;
      })
    : cgCardGridHTML(items, '本に売れるカードがありません', function (it) {
        const price = CQRun.sellPrice(CARD_BY_ID, it.id);
        return `<button class="tiny" data-act="logshop-sell" data-id="${it.id}">Ｇ${price}で売る</button>`;
      });
  const plan = CQCollection.bulkSellPlan(meta, function (id) { return CQRun.sellPrice(CARD_BY_ID, id); });
  const bulkBar = (tab === 'sell')
    ? `<div class="shop-bulkbar">
         <span class="shop-bulk-note">ダブり（デッキと本の合計で${CQCollection.KEEP_MIN}枚を超えた分）
           <b>${plan.cards}</b>種 <b>${plan.sheets}</b>枚 ＝ <b>${plan.total}</b>Ｇ</span>
         <button class="btn ok" data-act="logshop-bulk" ${plan.items.length ? '' : 'disabled'}>
           ダブりを一括で換金する</button>
       </div>`
    : '';
  runRoot().innerHTML = `
    ${shopHeadHTML(meta, 'ログショップ')}
    <div class="carry-tabs">
      <button class="dtab ${tab === 'buy' ? 'on' : ''}" data-act="shop-tab" data-id="buy">買う</button>
      <button class="dtab ${tab === 'sell' ? 'on' : ''}" data-act="shop-tab" data-id="sell">売る</button>
    </div>
    ${bulkBar}
    <div class="cg-wrap">
      <div class="cg-main">${gridHTML}</div>
      <div class="detail cg-detail">${cgDetailHTML(shopDetailNote(tab))}</div>
    </div>`;
  keepScrollRestore(key);
}

/** 情報パネル下部の一言。ボタンはタイル直下に置く流儀（M6.6 WP9）なので、
 * ここには「そのカードが何者か」の補足だけを出す。 */
function shopDetailNote(tab) {
  const id = RUI.gridSel;
  if (id == null) return '';
  const c = CARD_BY_ID[id];
  if (!c) return '';
  if (tab === 'buy') {
    return CQCollection.isRare(c)
      ? `<p class="cg-note">貴重なログ。値は定価の1.5倍（${c.p}Ｇ→${CQCollection.homeBuyPrice(c)}Ｇ）。</p>`
      : '';
  }
  const meta = RUI.meta;
  const owned = (meta.book[id] || 0) + (meta.deck[id] || 0);
  return `<p class="cg-note">本に${meta.book[id] || 0}枚・デッキに${meta.deck[id] || 0}枚（合計${owned}枚）。
    売っても記憶データ（図鑑）からは消えません。</p>`;
}

/** 一括換金の確認画面（§4-2b「確定前に一覧と合計額を必ず見せ、個別に除外できること」）。
 * M6.6 WP11 の清算のひっ算と同じ流儀で、**見せた数字がそのまま実額になる**
 * （表示も実行も同じ plan を使う）。取り消せない操作なので確認はこの1段だけ。 */
function renderBulkSell() {
  const meta = RUI.meta;
  keepScrollSave('logshop:bulk');
  gridEnter('logshop:bulk');
  const priceOf = function (id) { return CQRun.sellPrice(CARD_BY_ID, id); };
  const excl = RUI.bulkExclude || [];
  const plan = CQCollection.bulkSellPlan(meta, priceOf, { exclude: excl });
  /* 除外したカードも「戻せる」よう一覧には残す（消えると戻し方が分からなくなる） */
  const all = CQCollection.bulkSellPlan(meta, priceOf);
  const items = all.items.map(function (it) {
    const off = excl.indexOf(it.id) >= 0;
    return { id: it.id, n: it.n, unit: it.unit, sub: it.sub, off: off, badge: off ? '除' : '' };
  });
  runRoot().innerHTML = `
    ${shopHeadHTML(meta, 'ダブりの一括換金')}
    <div class="cg-wrap">
      <div class="cg-main">${cgCardGridHTML(items, '換金できるダブりがありません', function (it) {
        return `<div class="shop-bulk-sub ${it.off ? 'off' : ''}">${it.n}枚 ${it.sub}Ｇ</div>
          <button class="tiny" data-act="bulk-toggle" data-id="${it.id}">${it.off ? '戻す' : '除外'}</button>`;
      })}</div>
      <div class="detail cg-detail">
        <div class="bulk-sheet">
          <h4>換金の内訳</h4>
          <div class="bulk-row"><span>対象</span><b>${plan.cards}種 ${plan.sheets}枚</b></div>
          <div class="bulk-row"><span>合計</span><b>＋${plan.total}Ｇ</b></div>
          <div class="bulk-row"><span>所持Ｇ</span><b>${meta.gold} → ${meta.gold + plan.total}</b></div>
          <p class="cg-note">各カードは<b>デッキと本の合計で${plan.keepMin}枚</b>残します。
            デッキに入っている分は売りません。記憶データ（図鑑）も減りません。</p>
          <p class="cg-note">取り消しはできません。</p>
        </div>
        <div class="cg-actions bulk-acts">
          <button class="btn ng" data-act="bulk-cancel">やめる</button>
          <button class="btn ok" data-act="bulk-confirm" ${plan.items.length ? '' : 'disabled'}>
            この内容で換金する</button>
        </div>
      </div>
    </div>`;
  keepScrollRestore('logshop:bulk');
}

/* ================= 戦利品の振り分け（M6.6 WP7） ================= */

/** 勝利直後、マップに戻る前に出す画面。得た戦利品を全部並べ、1枚ずつ「デッキに加える」
 * 「本に送る」を選ばせる（§4 WP7）。確定ボタンは無く、全部選び終えたら自動で次へ進む
 * （runAct の 'loot-deck'／'loot-book' が空になったタイミングで進める）。
 * 2026-08-29 本人指摘：ボタンを情報パネル側に置くと、選んだカードから離れていて見にくい。
 * 情報パネルは詳細表示のみに戻し、「デッキへ／本へ」は**各カードのタイル直下**に常時出す
 * （選ばなくても押せる。resolveLootPick は同じidが複数あっても先頭の1枚を消すだけなので、
 * どのタイルの下のボタンを押しても結果は同じ）。タイル自体は引き続き押すと選択状態になり、
 * 右の情報パネルに絵と詳細が出る（cgTileHTML／cgDetailHTMLをそのまま流用）。 */
function renderLoot() {
  const run = RUI.run;
  gridEnter('loot');
  const pending = run.lootPending || [];
  /* M7 WP3.5（案B）：デッキの空きはレンタル枚数と無関係（レンタルは枠外）。 */
  const remain = Math.max(0, CQRun.DECK_SIZE - CQCollection.countsTotal(run.deck));
  const items = pending.map(function (id) { return { id: id, rental: false }; });
  runRoot().innerHTML = `
    <div class="cg-head">
      <div class="cg-title">戦利品</div>
      <div class="cg-stats"><span>デッキの空き <b>${remain}</b>枚</span></div>
    </div>
    <div class="cg-wrap">
      <div class="cg-main">${cgCardGridHTML(items, '戦利品はありません', function (it) {
        const canDeck = CQRun.canAssignToDeck(run, it.id);
        return `<button class="tiny" data-act="loot-deck" data-id="${it.id}" ${canDeck ? '' : 'disabled'}>デッキへ</button>
          <button class="tiny" data-act="loot-book" data-id="${it.id}">本へ</button>`;
      })}</div>
      <div class="detail cg-detail">${cgDetailHTML('')}</div>
    </div>
    <p class="node-note cg-foot">カードごとに「デッキへ」か「本へ」を選んでください。
      「本へ」を選んだカードは<b>このランでは使えません</b>（次のランから持ち出せます）。
      どちらを選んでもカードは必ず手に入ります。</p>`;
}

/* ================= 結果画面（M6.6 WP11・追補§4 WP11） ================= */

/** ランを終える共通処理。清算（`CQRun.settle`）に加えて、台本の側の仕事——日誌の1行と
 * 「初めてのゲームオーバー」の判定——をここでまとめる。エンジン（run.js）は台本（lore.js）に
 * 依存させたくないので、文面の組み立てはUI側のこの関数が引き受ける形にしてある。
 * 呼び出しは戦闘決着（advanceAfterBattle）とリタイヤの2箇所だけ＝ランにつき1回。 */
function finishRun(run) {
  const meta = RUI.meta;
  const area = CQAreas.get(run.areaId);
  /* 日誌の「ボス初撃破の日」用。settle() が meta.cleared に足してしまう前に見ておく。 */
  const firstClear = run.outcome === 'win' && (meta.cleared || []).indexOf(run.areaId) < 0;
  /* NEWバッジ用。settle() は gainedCards を known へ登録してしまうので、
   * 「このランより前に知っていた種類」はここで写しを取っておかないと復元できない。 */
  const knownBefore = ((meta.known || []).slice());
  CQRun.settle(run, meta);
  const kind = run.outcome === 'win' ? (firstClear ? 'bossFirst' : 'clear')
    : run.outcome === 'retire' ? 'retire' : 'gameOver';
  const line = CQLore.journalLine(kind, {
    day: meta.day,
    area: area ? area.name : run.areaId,
    count: (run.gainedCards || []).length,
    lp: run.lp,
    master: area ? area.bossName : 'マスター'
  });
  CQRun.pushJournal(meta, line);
  if (run.settled) {
    run.settled.journal = line;
    run.settled.knownBefore = knownBefore;
    /* 台本§5 gameOverFirst＝『世界観とプレイヤー案内』§6.3 #13「記録は失われない」。
     * 原作最大のストレスが無いことを、プレイヤーが最初に不安になる瞬間に伝える一節。 */
    if (run.outcome === 'lose' && !CQSave.hintSeen(meta, 'gameOverFirst')) {
      run.settled.gameOverFirst = true;
      CQSave.markHint(meta, 'gameOverFirst');
    }
  }
  CQSave.saveMeta(RUN_STORAGE, meta);
  CQSave.clearRun(RUN_STORAGE);
  RUI.view = 'result';
}

/** 結果画面のカードタイル。グリッドの `cgTileHTML` とは違い**押せない**（閲覧専用）ので、
 * data-act を持たせず、バッジだけ差し替えられるようにしてある。 */
function resTileHTML(id, badge) {
  const c = CARD_BY_ID[id];
  if (!c) return '';
  return `<div class="res-tile" title="${esc(c.n)}">
      <div class="cg-tile-art">${artInner(c, 3)}</div>
      ${badge || ''}
    </div>`;
}

/** 所持Ｇのカウントアップ（追補§4 WP11-4）。描き直しのたびに走らせると数字が跳ねるので、
 * 1つのランにつき1回だけ animate する（2回目以降は最終値をそのまま出す）。 */
function runCountUp(el, to, ms) {
  if (!el) return;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const from = 0;
  function step(now) {
    const p = Math.min(1, ((now || Date.now()) - t0) / ms);
    /* 終わりぎわを緩める（ease-out）。数字が止まる瞬間が読み取りやすくなる。 */
    const v = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    el.textContent = String(v);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function renderResult() {
  const run = RUI.run;
  const win = run.outcome === 'win';
  const title = win ? 'クリア！' : run.outcome === 'retire' ? 'リタイヤ' : 'ゲームオーバー';
  const area = CQAreas.get(run.areaId);
  /* 中断からの復帰など、清算の内訳が残っていない経路でも落ちないようにしておく
   * （settleGold は副作用が無いので、ここで作り直しても安全）。 */
  const st = run.settled || { gold: CQRun.settleGold(run), titles: [], day: RUI.meta.day || 0 };
  const g = st.gold;

  /* --- 1. 取得したカード（初入手には NEW バッジ） ------------------------ */
  /* NEW の判定は「このランで初めて記憶データに載った種類」。settle() が既に known へ
   * 登録した後なので meta.known では判定できない——run.gainedCards の中で、その id が
   * 初めて現れた1枚だけを NEW にする（同じカードを2枚拾った日は1枚目だけが NEW）。 */
  const knownBefore = st.knownBefore || [];
  const seen = {};
  const gainedHTML = (run.gainedCards || []).map(function (id) {
    const isNew = knownBefore.indexOf(id) < 0 && !seen[id];
    seen[id] = true;
    return resTileHTML(id, isNew ? '<span class="res-badge-new">NEW</span>' : '');
  }).join('');

  /* --- 2. 返却するカード（レンタル・借バッジ） --------------------------- */
  const returnedHTML = (run.rentals || []).map(function (id) {
    return resTileHTML(id, '<span class="cg-badge">借</span>');
  }).join('');

  /* --- 3. ゴールドのひっ算（段階表示はCSSのアニメーション遅延で出す） ----- */
  const cutLabel = run.outcome === 'retire' ? 'リタイヤ ▲50%'
    : run.outcome === 'lose' ? 'ゲームオーバー ▲75%' : '減額なし（撃破）';
  const calcHTML = `
    <table class="res-calc">
      <tr class="res-row" style="--d:0ms"><th>持ち込み</th><td>${g.carried}</td></tr>
      <tr class="res-row" style="--d:320ms"><th>今日の獲得</th><td>＋ ${g.earned}</td></tr>
      <tr class="res-row res-cut ${g.cut ? '' : 'res-none'}" style="--d:640ms">
        <th>${cutLabel}</th><td>${g.cut ? '− ' + g.cut : '—'}</td></tr>
      <tr class="res-row res-total" style="--d:960ms"><th>所持Ｇ</th><td><b id="res-gold">0</b></td></tr>
    </table>`;

  /* --- 5. 称号（このランで新しく得たものだけ並べる） --------------------- */
  const titlesHTML = (st.titles || []).length
    ? `<ul class="res-title-list">${st.titles.map(function (t, i) {
        return `<li class="res-title-item" style="--d:${1100 + i * 260}ms">
            <span class="res-title-name">${esc(t.name)}</span>
            <span class="res-title-desc">${esc(t.desc)}</span>
          </li>`;
      }).join('')}</ul>`
    : '<p class="res-none-note">このランで新しく得た称号はありません。</p>';

  /* --- アンバーの一言（台本§7.1） --------------------------------------- */
  const rl = CQLore.LORE.result;
  const bubble = win ? rl.clear
    : run.outcome === 'retire' ? rl.retire
      : (st.gameOverFirst ? rl.gameOverFirst : rl.gameOver);
  const portrait = bubble.face === 'down' ? 'assets/chars/amber_down.png' : 'assets/chars/amber_calm.png';

  runRoot().innerHTML = `
    <div class="res-wrap">
      <div class="res-head">
        <h3 class="res-title ${win ? 'run-win' : 'run-lose'}">${title}</h3>
        <div class="res-sub">${st.day}日目・${esc(area ? area.name : run.areaId)}
          ／ＬＰ ${run.lp}／${run.maxLp}</div>
      </div>
      <div class="res-body">
        <div class="res-col">
          <section class="res-sec">
            <h4>取得したカード<span class="res-n">${(run.gainedCards || []).length}枚</span></h4>
            ${gainedHTML ? `<div class="res-tiles">${gainedHTML}</div>`
              : '<p class="res-none-note">今回は何も書き留められませんでした。</p>'}
          </section>
          <section class="res-sec">
            <h4>返却するカード<span class="res-n">${(run.rentals || []).length}枚</span></h4>
            ${returnedHTML ? `<div class="res-tiles">${returnedHTML}</div>`
              : '<p class="res-none-note">借りているカードはありません。</p>'}
          </section>
        </div>
        <div class="res-col res-col-right">
          <section class="res-sec res-fixed"><h4>清算</h4>${calcHTML}</section>
          <section class="res-sec"><h4>称号</h4>${titlesHTML}</section>
        </div>
      </div>
      <div class="res-foot">
        <div class="res-amber">
          <img class="res-face" src="${portrait}" alt="" draggable="false" onerror="this.remove()">
          <div class="res-amber-lines">${bubble.lines.map(esc).join('<br>')}</div>
        </div>
        <div class="res-foot-right">
          <p class="res-journal">${esc(st.journal || '')}</p>
          <p class="res-carry-note">デッキは次の冒険にそのまま持ち越されます。</p>
          <button class="btn ok res-done" data-act="back-home">今回の探検を終える</button>
        </div>
      </div>
    </div>`;

  /* 所持Ｇのカウントアップは1つのランにつき1回だけ（描き直しでは最終値を静止表示）。 */
  const goldEl = document.getElementById('res-gold');
  if (goldEl) {
    if (RUI.resultCounted === run) { goldEl.textContent = String(g.final); }
    else { RUI.resultCounted = run; runCountUp(goldEl, g.final, 1400); }
  }
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
  else if (RUI.view === 'home') renderHome();
  else if (RUI.view === 'areaSelect') renderAreaSelect();
  else if (RUI.view === 'start') renderStart();
  else if (RUI.view === 'map') renderMap();
  else if (RUI.view === 'node') renderNode();
  else if (RUI.view === 'battle-intro') renderBattleIntro();
  else if (RUI.view === 'event-intro') renderEventIntro();
  else if (RUI.view === 'loot') renderLoot();
  else if (RUI.view === 'deckview') renderDeckView();
  else if (RUI.view === 'collection') renderCollection();
  else if (RUI.view === 'logshop') renderLogShop();
  else if (RUI.view === 'deckedit') renderDeckEdit();
  else if (RUI.view === 'record') renderRecord();
  else if (RUI.view === 'settings') renderSettings();
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
    finishRun(run);                      /* 清算＋日誌＋保存＋結果画面へ（M6.6 WP11） */
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

function runAct(act, id, idx) {
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
    case 'home-guide-next': {
      const next = (RUI.homeGuideStep || 0) + 1;
      if (next >= (RUI.homeGuide || []).length) return finishHomeGuide();
      RUI.homeGuideStep = next;
      return runRender();
    }
    case 'home-guide-skip':
      return finishHomeGuide();
    case 'home-go-adventure': {
      /* ★40枚に満たないデッキでは出発させない（『作業パッケージ』WP9）。
       * 足りないぶんは戦闘中に「空白」で埋まる＝手札事故になるだけなので、出発前に止める。
       * 止めるだけだと何をすればいいか分からないので、そのままデッキ編集を開く。 */
      const dep = CQCollection.canDepart(RUI.meta);
      if (!dep.ok) {
        runFlash('本のカードがあと' + dep.fillable + '枚デッキに入ります。入れてから出かけよう。');
        return enterDeckEdit();
      }
      RUI.view = 'areaSelect';
      return runRender();
    }
    case 'home-collection':
      RUI.view = 'collection';
      return runRender();
    case 'col-tab':
      if (RUI.colTab === id) return;
      RUI.colTab = id;
      return runRender();
    case 'collection-leave':
      return enterHome();

    /* ---- 設定・バックアップ（M7 WP11） ---- */
    case 'home-settings':
      RUI.view = 'settings';
      RUI.backupState = null;
      return runRender();
    case 'settings-leave':
      return enterHome();
    case 'backup-export':
      return backupExport();
    case 'fx-speed':                                  /* M7.9：演出の速さ（js/layout.js の fxMs が読む） */
      try { RUN_STORAGE.setItem('cq_fx', JSON.stringify({ speed: id })); } catch (_) { /* 保存できなくても続行 */ }
      return runRender();

    /* ---- 記録画面（M7 WP10） ---- */
    case 'home-record':
      RUI.view = 'record';
      return runRender();
    case 'record-leave':
      return enterHome();

    /* ---- デッキ編集（M7 WP9） ---- */
    case 'home-deck':
      return enterDeckEdit();
    case 'deck-guide-next': {
      const next = (RUI.deckGuideStep || 0) + 1;
      if (next >= (RUI.deckGuide || []).length) return finishDeckGuide();
      RUI.deckGuideStep = next;
      return runRender();
    }
    case 'deck-guide-skip':
      return finishDeckGuide();

    /* ---- ログショップ（M7 WP7） ---- */
    case 'home-shop':
      RUI.view = 'logshop';
      RUI.shopTab = 'buy'; RUI.shopBulk = false; RUI.bulkExclude = [];
      return runRender();
    case 'shop-tab':
      if (RUI.shopTab === id) return;
      RUI.shopTab = id;
      return runRender();
    case 'logshop-buy': {
      const c = CARD_BY_ID[id];
      const price = CQCollection.homeBuyPrice(c);
      if (!c || !price) return runFlash('買えません');
      if (RUI.meta.gold < price) return runFlash('Ｇが足りません');
      RUI.meta.gold -= price;
      /* 買ったカードは本へ入る（デッキに入れるのはデッキ編集の仕事＝移動モデル・WP3）。
       * addCard が記憶データにも登録するので、貴重カードは以後「複製」で買えるようになる。 */
      CQCollection.addCard(RUI.meta, +id, 'book');
      CQSave.saveMeta(RUN_STORAGE, RUI.meta);
      runFlash(c.n + ' を買った（-' + price + 'Ｇ）');
      return runRender();
    }
    case 'logshop-sell': {
      const price = CQRun.sellPrice(CARD_BY_ID, id);
      const r = CQCollection.sellFromBook(RUI.meta, +id, price);
      if (!r.ok) return runFlash(r.reason);
      CQSave.saveMeta(RUN_STORAGE, RUI.meta);
      runFlash((CARD_BY_ID[id] ? CARD_BY_ID[id].n : id) + ' を売った（+' + price + 'Ｇ）');
      return runRender();
    }
    case 'logshop-bulk':
      RUI.shopBulk = true; RUI.bulkExclude = [];
      return runRender();
    case 'bulk-toggle': {
      const at = RUI.bulkExclude.indexOf(+id);
      if (at >= 0) RUI.bulkExclude.splice(at, 1); else RUI.bulkExclude.push(+id);
      return runRender();
    }
    case 'bulk-cancel':
      RUI.shopBulk = false; RUI.bulkExclude = [];
      return runRender();
    case 'bulk-confirm': {
      /* 見せた内容と同じ plan をそのまま実行する（ここで作り直すと表示とズレる） */
      const plan = CQCollection.bulkSellPlan(RUI.meta,
        function (cid) { return CQRun.sellPrice(CARD_BY_ID, cid); },
        { exclude: RUI.bulkExclude });
      const r = CQCollection.bulkSell(RUI.meta, plan);
      if (!r.ok) return runFlash(r.reason);
      CQSave.saveMeta(RUN_STORAGE, RUI.meta);
      RUI.shopBulk = false; RUI.bulkExclude = [];
      runFlash('ダブり' + r.sheets + '枚を換金した（+' + r.gold + 'Ｇ）');
      return runRender();
    }
    case 'logshop-leave':
      return enterHome();

    case 'go-home':
      return enterHome();
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
      return finishDeckEdit();
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
      RUI.gridSel = null;   /* M6.6 WP9：決まったら情報パネルを空へ戻し、次の1枚を選ばせる */
      RUI.gridSelIdx = null;
      advanceAfterBattle();
      return runRender();
    }
    case 'loot-book': {
      const r = CQRun.resolveLootPick(run, +id, 'book', CARD_BY_ID);
      if (!r.ok) { runFlash(r.reason); return runRender(); }
      RUI.gridSel = null;
      RUI.gridSelIdx = null;
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
    /* ---- 買い取り所（M7 WP8） ---- */
    case 'buyout': {
      /* 同じカードを2枚借りていることがあるので、カードidではなく並びの位置で指定する */
      const r = CQRun.buyout(run, CARD_BY_ID, +idx);
      if (!r.ok) return runFlash(r.reason);
      runSave();
      runFlash((CARD_BY_ID[r.id] ? CARD_BY_ID[r.id].n : r.id) + ' を買い取った（-' + r.price + 'Ｇ）');
      return runRender();
    }
    case 'buyout-leave':
      CQRun.buyoutLeave(run, run.map.nodes[RUI.nodeId]);
      RUI.view = 'map'; runSave();
      return runRender();
    /* M6.6 WP9：カードグリッド＋情報パネルの共通操作。タイルを押すと選ぶだけ（4画面共通）。 */
    case 'grid-pick':
      RUI.gridSel = +id;
      RUI.gridSelIdx = idx != null ? +idx : null;
      return runRender();
    case 'deckview-open':
      RUI.view = 'deckview';
      return runRender();
    case 'deckview-leave':
      RUI.view = 'map';
      return runRender();
    case 'node-done':
      RUI.view = 'map'; runSave();
      return runRender();
    /* M6.6 WP11：清算の減額（リタイヤ▲50%）を実装したので、確認ダイアログでも明示する。
     * それまでは「所持Ｇは持ち帰れます」と書いてあったが、減額の実装が入った以上は嘘になる
     * （「諦める」側のダイアログはWP12の時点で既に▲75%と宣言していた）。 */
    case 'retire':
      return showConfirm(
        'ここでリタイヤしますか？\n集めたＧの50%を失いますが、カードは持ち帰れます。',
        function () {
          CQRun.retire(run);
          finishRun(run);
          runRender();
        }, 'リタイヤする');
    case 'back-home':
      return enterHome();
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
    runAct(t.dataset.act, t.dataset.id, t.dataset.idx);
  });
  bindCarryFilters(el);
  /* バックアップの読み込み（M7 WP11）。<input type="file"> は click ではなく change なので、
   * data-act の委譲とは別に張る（絞り込み欄と同じ理由）。同じファイルを選び直せるよう、
   * 読んだあとに value を空にしておく。 */
  el.addEventListener('change', function (ev) {
    const inp = ev.target.closest('input[data-file="backup"]');
    if (!inp || !inp.files || !inp.files[0]) return;
    const file = inp.files[0];
    const reader = new FileReader();
    reader.onload = function () { backupImport(String(reader.result || '')); };
    reader.onerror = function () {
      RUI.backupState = { ok: false, msg: 'ファイルを読めませんでした。' };
      runRender();
    };
    reader.readAsText(file);
    inp.value = '';
  });
  runInit();
}

document.addEventListener('DOMContentLoaded', function () {
  bootRunUI();
});
/* DOMContentLoaded がすでに発火済みだった場合の保険。
 * （このスクリプトはbody末尾に置いてあるので、実際には readyState はまだ 'loading' で、
 *   通常は上の DOMContentLoaded 側が走る。dataset.bound で二重登録を防いでいる。） */
if (document.readyState !== 'loading') bootRunUI();
