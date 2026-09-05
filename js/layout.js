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
/* カード絵の拡張子（2026-09-02：`.png` → `.webp`）。
 * 発注時の絵は 1024×1024 のPNGで1枚1.7MB前後あり、169枚で**295MB**あった。実際の表示は
 * いちばん大きい情報パネルでも281px角（画面は1280×800固定で拡大しない）で、カード絵には
 * 透過部分が無いためPNGで持つ意味も無い。640px角のWebPに揃えて**約7MB**にした
 * （表示の2.3倍の解像度＝高精細な画面でも粗く見えない）。変換は tools/shrink-assets.py。
 * 差し替えるときは**この1行**を変えれば全画面に効く（絵の読み込みは artInner に一本化済み）。 */
const ART_EXT = '.webp';
const TYPE_MARK = { U: 'Ｕ', M: 'Ｍ', S: 'Ｓ', C: 'Ｃ', X: '虫' };
const TYPE_NAME = { U: 'モンスター', M: '魔法', S: '技能', C: 'カース', X: 'おじゃま虫' };
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
/* おじゃま虫（M6 戦場ルール・ID200）も他のカードと同じ。assets/cards/200.webp を置けば絵になる
   （置くまではカード名の文字表示。カードの地色だけ CSS の .card.X で緑に分けてある）。 */
function artSrcId(card) {
  return card.t === 'C' ? card.id - CURSE_ART_OFFSET : card.id;
}
function artInner(card, chars) {
  /* 絵が無いときの文字の代替。カースは「カース：」を外さないと9種とも「カース」になってしまう */
  const label = card.t === 'C' ? card.n.replace(/^カース[：:]\s*/, '') : card.n;
  const a = abbrev(label, chars || 3);
  /* draggable="false" は必須。付けないと、絵のあるカードをドラッグしたときに
     ブラウザ標準の画像ドラッグが始まってしまい、こちらのポインタ操作が途切れる */
  return `<img ${card.t === 'C' ? 'class="curse-art" ' : ''}src="${ART_DIR}${artSrcId(card)}${ART_EXT}"
     alt="" draggable="false"
     onerror="this.replaceWith(document.createTextNode('${a}'))">`;
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

/** 画面を切り替える（2026-08-29 新設）。
 *
 * **タブとは切り離してある。** 以前は画面の切り替えが「タブを click する」ことでしか
 * できず、ラン中に戦闘へ入るたびタブの光が「バトル画面（検証）」へ移っていた。
 * 本人指定でタブは「ラン」だけに固定したので、画面の出し入れはこの関数が担い、
 * タブの見た目には触らない（ストーリー中はずっと「ラン」が光ったまま）。
 * デッキ編集・フリーバトルは開発用としてデバッグメニュー（js/debug.js）から呼ぶ。 */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((x) => x.classList.remove('on'));
  const el = document.getElementById(id);
  if (el) el.classList.add('on');
  /* v0.16でラン画面が既定になり、バトル画面は最初 display:none のまま
   * newMatch()/renderAll() が走ることがある（非表示中は clientHeight などが0になり、
   * --cw/--chh/--vstep/--hstep に0が焼き込まれる）。表示に切り替えた直後、
   * レイアウトが確定してから（rAFで1フレーム待って）測り直す。 */
  if (id === 'screen-battle') {
    requestAnimationFrame(() => { fitBoard(); if (M) renderHand(); });
  }
}
if (typeof window !== 'undefined') window.showScreen = showScreen;

/* 残っているタブは「ラン」だけ。押すとラン画面へ戻る。
 *
 * ★2026-09-06 本人報告：戦闘開始の演出の途中でここを押すとフリーズする、への対処。
 * ラン中の戦闘が進行中のあいだは、押されても**探索の画面へは戻さず、戦闘へ戻す**。
 * 戦闘はタブを押しても裏で動き続けるので、マップへ戻してしまうと
 *   ・決着していない戦闘の結果が、あとから別のマスに適用される
 *   ・マップから次のマスへ入って、戦闘が二重に始まる
 * という壊れ方をする。戦闘から抜ける道は「逃げる」「諦める」、決着後は「ランへ戻る」
 * （そこで戦利品と結果がランへ反映される）だけ、という設計に合わせる。 */
document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => {
    if (RUN_ACTIVE && M) { showScreen('screen-battle'); return; }
    showScreen(b.dataset.screen);
  });
});

/* ================= 対戦の状態 ================= */

/* 見本デッキ（CQTurn.DECK_SIZE＝40枚。v0.15.1でデッキ枚数を50→40に変更）。
 * M7でデッキ編集画面と繋ぐまでは両陣営ともこれを使う。
 * 能力値に効く技能と、フラグ型の魔法（爆殺・障壁・遮蔽・偽装・鏡身）を中心にしつつ、
 * v0.12（実装計画M4）で発動処理を追加した 167/169/181/199、
 * v0.13で発動処理を追加した魔法カードの一部も混ぜてある。
 * v0.14で発動処理を追加したユニット固有能力の一部（1開：クローズ・3特：石化付加・
 * 9特：ＬＰ消費ＣＨ破壊・31開：ＬＰ回復・70特：妄執憑依）も、通常プレイで触れられるようにしてある。 */
const SAMPLE_DECK = [
  /* ユニット20枚（10 ヨルムンガンドと17 アバドーンは召還Ｌｖが高いので、
     チャネルして上の階層で開く＝リバース召還でしか出せない。ただし場に199光臨があれば
     手札から直接も出せる） */
  8, 1, 3, 2, 5, 7, 9, 19, 20, 22, 31, 70, 58, 65, 66, 67, 71, 73, 10, 17,
  /* 技能13枚 */
  151, 158, 167, 169, 171, 172, 173, 177, 178, 179, 181, 183, 199,
  /* 魔法7枚（v0.13で発動処理を実装。101憑依解除・113透視は瞬間発動、
     104/117/136/143/145はフラグ型で継続効果） */
  101, 104, 113, 117, 136, 143, 145
];

let M = null;                 /* エンジンの対戦状態。これが唯一の真実 */
let foeAuto = true;           /* 相手を自動で動かすか */
/* 相手ＡＩの強さ（M5→M5.7で刷新）。フリー→Ｃ→Ｂ→Ａの順に切り替える。強さの実体は
 * js/engine/ai.js の PRESETS（M5.7：決定化サンプリング＋先読み。差はサンプル数と読みの深さ。
 * 透視率は撤廃済み＝ＡＩが知れる情報は人間と完全対称） */
const AI_RANKS = ['free', 'rankC', 'rankB', 'rankA'];
let aiRank = 'rankC';
/* 戦場ルール（M6。js/engine/fieldrules.js）。本番ではマップ生成が戦闘ごとに確定させるが、
 * 分岐マップが入るまでは、この単発戦闘モードで1種類ずつ切り替えて検証する（追補§M6の導入手順）。
 * 「新しい対戦」を押した時点の選択が、その対局のルールとして確定する */
const FIELD_SETS = [
  { label: 'なし', rules: [] },
  { label: '高ＣＨ禁止', rules: [{ id: 'noHighCH', max: 4 }] },
  { label: '定期爆撃', rules: [{ id: 'bomb', period: 5, layer: 4 }] },
  { label: 'おじゃま虫', rules: [{ id: 'pestCard', period: 3, target: 'self' }] },
  { label: '岩の列', rules: [{ id: 'laneCap', cap: 2, lanes: [1, 4] }] },
  { label: '封鎖の列', rules: [{ id: 'laneLock', lanes: [2] }] }
];
let fieldSet = 0;
/* ラン（M6・js/run/run.js）からこの同じバトル画面を呼ぶための橋渡し。
 * ラン中はバトル画面の「強さ」「戦場」「新しい対戦」（不正な変更・離脱の入口になる）を隠し、
 * 決着後の「もう一度」を「ランへ戻る」に差し替えて runOverHook を呼ぶ。 */
let RUN_ACTIVE = false;
let runOverHook = null;
/** js/run-ui.js から呼ばれる：ラン中の戦闘を、既存のバトル画面でそのまま始める。
 * setup は CQRun.battleSetup() の戻り値そのもの。onOver(M) は決着後「ランへ戻る」を押したときに呼ばれる。 */
function startRunBattle(setup, onOver) {
  RUN_ACTIVE = true; runOverHook = onOver; foeAuto = true;
  M = CQTurn.createMatch(Object.assign({}, setup, {
    rng: CQRng.create(setup.seed),
    hooks: { onMagicOpen: CQMagic.onMagicOpen, onUnitOpen: CQUnits.onUnitOpen }
  }));
  /* M7.10 WP1：ラン中の戦闘は setup.aiPreset（CQRun.battleSetup が仕様どおりに決めた強さ。
   * 通常戦闘＝free／ボス＝エリアのbossRank）を使う。単発戦闘モード（フリーバトル・下のaiRank）
   * から呼ばれたときは setup.aiPreset が無いので、そちらの切り替えがそのまま効く（開発用・従来どおり）。 */
  M.aiConfig = { enemy: CQAi.PRESETS[setup.aiPreset || aiRank] };
  UI.mode = 'idle'; UI.info = null; UI.lane = null; UI.layers = [];
  UI.pending = null; UI.report = null;
  /* M6.6 WP5：先攻／後攻は m.first に対局のあいだ保持されている（m.active は手番ごとに
   * 入れ替わるので、step() が非同期に手番を進めた後だと当てにならない）。 */
  const first = M.first;
  showScreen('screen-battle');     /* タブは「ラン」のまま動かさない（2026-08-29） */
  abandonStep();                   /* 前の対戦の進行・演出を捨てる（2026-09-05） */
  renderAll();                     /* 先に盤面を描いてから進める（相手が先攻でも、演出が新しい盤面の上に乗る） */
  /* バトル画面が表示されると同時に先攻ルーレットを見せる。結果はもう決定済み（上のfirst。
   * CQRun.battleSetup の first＝戦闘シードから決定的に決まっている）なので、ここでは
   * 乱数を使わず、その結果を演出として見せるだけ。
   * ★step() より先に呼ぶこと：runStep は最初の await までは同期で走るので、後から
   * ルーレットを出すと最初の手番（ドロー）がルーレットの下で先に進んでしまう（2026-09-05）。 */
  showFirstTurnRoulette(first);
  step();
}

/** 先攻／後攻ルーレット（M6.6 WP5・追補§4）。黒カットイン→中央の羅針盤（矢印は画像に
 * 焼き込み済み＝assets/ui/first_turn_roulette.png）を回して見せ、自分（右＝0°）か
 * 相手（左＝180°）を指して止まる。抽選そのものはここでは行わない（すでに決まった winner を
 * 見せるだけ）ので、どれだけタップでスキップしても結果は変わらない。
 *
 * 2026-08-29 改訂（本人フィードバック「非常に分かりにくい」）：
 *   ・尺を3秒→**5秒**に延長し、回転もゆっくり見えるようにした
 *   ・**終端の逆回転を無くした**。旧実装は「1080°+最終角」まで回した後に finish() が
 *     `rotate(最終角)` を代入していたため、そこから逆向きに1080°戻る高速回転が見えていた。
 *     回転角は常に `360×n + 最終角` の累積値だけを代入し、最後まで一方向にしか回さない
 *   ・停止位置は**きっかり右か左**（旧実装の±10°のゆらぎを廃止＝ずれた位置で止まらない）
 *   ・止まったあと**1秒そのまま見せてから**、ゆっくり透明にして消える
 * 尺・内訳は下の定数1か所にまとまっている。 */
const FTR_DURATION = 5000;                 /* 全体の尺 */
const FTR_SPIN_MS = 3400;                  /* 回転（減速しながら最終角へ） */
const FTR_HOLD_MS = 1000;                  /* 停止後、そのまま見せる時間 */
const FTR_FADE_MS = 450;                   /* 消えるときのフェード */
const FTR_TURNS = 6;                       /* 何周回してから止まるか */

/** ルーレットが消えるまで手番の進行を待たせるための約束（runStep が見る）。
 * ★2026-09-05 本人指摘：相手が先攻のとき、ルーレットが回っている最中に相手の最初の手番が
 * 済んで「あなたの手番」の帯が出てしまい、そのあとにコンパスが「後攻」と止まる、という
 * 順序の逆転が起きていた。ルーレットの間は手番を進めない。 */
let INTRO_WAIT = null;
function showFirstTurnRoulette(winner) {
  const app = document.getElementById('app');
  if (!app) return;
  let introDone = null;
  INTRO_WAIT = new Promise(function (res) { introDone = res; });
  /* 針は画像に右向きで焼き込まれている：0°＝右＝自分が先攻、180°＝左＝相手が先攻。
   * 常に「何周ぶんか＋最終角」という累積値にしておくことで、逆回転が起きない。 */
  const endDeg = FTR_TURNS * 360 + (winner === 'enemy' ? 180 : 0);
  const ov = document.createElement('div');
  ov.className = 'first-turn-roulette';
  ov.innerHTML =
    '<div class="ftr-cut"></div>' +
    '<div class="ftr-stage">' +
      '<img class="ftr-compass" src="assets/ui/first_turn_roulette.png" alt="" draggable="false" onerror="this.style.visibility=\'hidden\'">' +
      '<div class="ftr-result">' + (winner === 'enemy' ? '後攻' : '先攻') + '</div>' +
    '</div>';
  app.appendChild(ov);
  const compass = ov.querySelector('.ftr-compass');
  const result = ov.querySelector('.ftr-result');
  let settled = false, gone = false;

  /** 止まった状態にする（回転の完了・タップスキップの両方から呼ばれる）。
   * skip のときだけ transition を切って一気に最終角へ飛ばす——ここでも角度は同じ
   * 累積値なので、巻き戻る動きにはならない。 */
  function settle(skip) {
    if (settled) return;
    settled = true;
    if (skip) compass.style.transition = 'none';
    compass.style.transform = 'rotate(' + endDeg + 'deg)';
    result.classList.add('show');
    setTimeout(fade, FTR_HOLD_MS);          /* きっかりの位置で1秒見せてから消し始める */
  }
  function fade() {
    if (gone) return;
    gone = true;
    ov.classList.add('fade-out');           /* CSS側で opacity を FTR_FADE_MS かけて0へ */
    setTimeout(function () { ov.remove(); }, FTR_FADE_MS + 60);
    INTRO_WAIT = null;
    if (introDone) introDone();             /* ここから手番が進む（runStep が待っている） */
  }

  ov.addEventListener('click', function () { settle(true); });
  requestAnimationFrame(function () {
    compass.style.transition = 'transform ' + FTR_SPIN_MS + 'ms cubic-bezier(.12,.72,.15,1)';
    compass.style.transform = 'rotate(' + endDeg + 'deg)';
  });
  setTimeout(function () { settle(false); }, FTR_SPIN_MS + 120);
}
const UI = {
  mode: 'idle',   /* idle | info | confirm | unit | attack | reverse | battle | over
                     | pick-target（開く前に対象を選ぶ）| draw-pick（引いた札から選ぶ・M6.7 WP3） */
  info: null,     /* 表示中のカード */
  lane: null,     /* 選択中のレーン（アタック元・リバース対象） */
  layers: [],     /* リバースで選んだ階層 */
  pending: null,  /* 確認待ちの操作 */
  report: null,   /* 直前に起きたこと（相手の手番・戦闘の経過） */
  /* pick-target中の状態（M6.7 WP1で汎用化。もとは憑依解除(101)専用の pick-destroy だった）。
   *   card    … 発動しようとしているカードＩＤ（案内文の出し分けに使う）
   *   kind    … 'ch'（チャンネルを選ぶ）/ 'lane'（ユニットのレーンを選ぶ）
   *   need    … 選ぶ枚数（113透視だけ2、それ以外は1）
   *   targets … 選べる候補。kind='ch' なら [{lane,idx}]、'lane' なら [laneIndex]
   *   chosen  … いま選んだぶん
   *   resume  … 選び終えたら呼ぶ関数(choice) */
  pick: null,
  chainFx: null          /* 強制リバース連鎖の演出待ち [{lane, idx}]（下から順） */
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
/** そのレーンのユニットを操作する側＝居る場の陣営（★M7.8 WP6：傀儡はレーンごと相手の場へ
 * 物理的に移る方式になったので、操作側と場所がズレることは無い）。
 * 「もともと誰のユニットか」は unitHome() で別に見る */
function unitOwner(i) { return laneSide(i); }
/** そのレーンのユニットの元の陣営（傀儡で移されていれば ln.puppeted、ふつうは居る場の陣営） */
function unitHome(i) {
  const ln = M.board.lanes[i];
  return ln.puppeted || laneSide(i);
}
/** 中身が見えるか（表・公開済み・自分が置いたカード） */
function chKnown(ch) {
  const v = handSide();
  return ch.up || ch.revealed || (ch.mine === (v === 'self'));
}

/** 憑依解除(101)の破壊候補（発動元自身のＣＨを除く、場にある全ユニットのＣＨ）。
 * js/engine/effects/magic.js の h101 と同じ絞り込み（2026-08-24 本人の指定：対話的選択） */
function destroyCandidates(exceptLane, exceptIdx) {
  const res = [];
  M.board.lanes.forEach((ln, i) => {
    if (ln.unit == null) return;
    ln.channels.forEach((ch, j) => {
      if (i === exceptLane && j === exceptIdx) return;
      res.push({ lane: i, idx: j });
    });
  });
  return res;
}

/** 108強制開放・109強制転回・110閉門の対象レーン候補（M6.7 WP1）。
 * エンジン側 magic.js の forcedTargets() とまったく同じ条件にすること
 * ——ここがズレると「選べたのに不発」「選べないのに効く」が起きる。
 * needFaceUp は110用（表向きのＣＨが1枚以上あるユニットだけが対象）。 */
function forcedLaneCandidates(exceptLane, needFaceUp) {
  const res = [];
  M.board.lanes.forEach((ln, i) => {
    if (ln.unit == null || i === exceptLane || !ln.channels.length) return;
    if (needFaceUp && !ln.channels.some((c) => c.up)) return;
    res.push(i);
  });
  return res;
}

/** 113透視の対象候補（M6.7 WP1）：**相手が置いた**、まだ中身の分かっていない裏向きＣＨ。
 * magic.js の h113 と同じ条件。自分が置いた伏せ札は元から中身が分かるので対象外。 */
function peekCandidates() {
  const mine = humanSide() === 'self';
  const res = [];
  M.board.lanes.forEach((ln, i) => {
    if (ln.unit == null) return;
    ln.channels.forEach((ch, j) => {
      if (!ch.up && ch.mine !== mine && !ch.revealed) res.push({ lane: i, idx: j });
    });
  });
  return res;
}

/** 対象選択を始める。始めたら true を返す（呼び出し側はそこで一旦抜ける）。 */
function startPick(spec) {
  /* 選ぶ余地が無い（候補が必要数以下）なら選ばせない＝エンジンが自動で決める。
   * 4種の型（lane / ch / layer / hand）すべて同じ判定でよい（M6.7 WP5）。 */
  if (spec.targets.length <= (spec.need || 1)) return false;
  UI.pick = { card: spec.card, kind: spec.kind, need: spec.need || 1,
    targets: spec.targets, chosen: [], resume: spec.resume };
  UI.mode = 'pick-target';
  flash(PICK_MSG[spec.card] || '対象を選んでください');
  renderAll();
  return true;
}

/* 選択中に出す案内文（カードごと）。 */
const PICK_MSG = {
  101: '憑依解除：破壊するカードを選んでください',
  108: '強制開放：ＣＨを開かせるユニットを選んでください',
  109: '強制転回：ＣＨを裏返すユニットを選んでください',
  110: '閉門：ＣＨを閉じるユニットを選んでください',
  113: '透視：中身を見る相手の伏せ札を2枚選んでください',
  137: '潜行爆弾：爆弾を仕掛ける相手のユニットを選んでください',
  /* M6.7 WP5（価格順）。候補の条件は magic.js の targetsFor が持っている */
  126: '統合：ＣＨとして吸収するユニットを選んでください',
  116: '解析：ＣＨの中身を全部のぞくユニットを選んでください',
  125: '移送：ＣＨの移動先になるユニットを選んでください',
  114: '暗殺：相手の手札から壊すモンスターを選んでください',
  138: '潜入：潜り込む先のユニットを選んでください',
  102: '侵食：自分の山札のカードで埋めるユニットを選んでください',
  124: '凍結：硬直させるユニットを選んでください',
  121: '招来：自分の場へ呼び出す潜行ユニットを選んでください',
  141: '思念波：破壊するユニットを選んでください（防御力551〜1000）',
  118: '押収：奪い取る裏向きのＣＨを選んでください',
  148: '妄執：自爆して憑依する先のユニットを選んでください',
  135: '雷撃：破壊するユニットを選んでください（防御力550以下）',
  131: '菊一文字：破壊する階層を選んでください（その階層のカードを1枚押す）',
  /* M7.8 WP4：原作準拠で「選んだ他ユニットに撃つ」形になった4枚 */
  105: '歪曲：ＣＨの並びを上下反転させるユニットを選んでください',
  115: '流行り病：疫障を付ける相手を選んでください',
  127: '死の棘：腐食を付ける相手を選んでください',
  130: '漂着：山札の1枚を付ける相手を選んでください（自陣に付けるとそのユニットは硬直します）',
  /* M6.7 WP6 ユニット固有能力。カードＩＤは1〜73なので魔法とぶつからない */
  1: 'クローズ×１：裏に戻すカードを選んでください',
  27: 'クローズ×１：裏に戻すカードを選んでください',
  44: 'クローズ×１：裏に戻すカードを選んでください',
  40: 'ＣＨ×１確認：中身を見るカードを選んでください',
  48: 'ＣＨ×１確認：中身を見るカードを選んでください',
  49: 'ＣＨ×１確認：中身を見るカードを選んでください',
  24: 'ＣＨ×１破壊：壊すカードを選んでください',
  9: 'ＬＰ消費ＣＨ１破壊：壊すカードを選んでください',
  16: 'Ａ６００火弾：撃つ相手を選んでください（防御力600以下）',
  10: 'Ａ５５０雷撃：撃つ相手を選んでください（防御力550以下）',
  32: 'Ａ５５０雷撃：撃つ相手を選んでください（防御力550以下）',
  36: 'Ａ５５０烈風：撃つ相手を選んでください（防御力550以下）',
  3: '石化付加：石化を付ける相手を選んでください',
  6: '疫障付加：疫障を付ける相手を選んでください',
  45: '腐食付加：腐食を付ける相手を選んでください',
  34: '潜入能力：潜り込む先のユニットを選んでください',
  70: '妄執：自爆して憑依する先のユニットを選んでください',
  29: '敵手札×１奪取：相手の手札から奪う1枚を選んでください'
};

/* 開発用デッキ（screen-deck で組むもの）。**アンロックには一切関係なく全169種から組める**
 * ——ストーリー側の「本とデッキ」（cq_meta・移動モデル）とは完全に別物で、こちらは
 * デバッグ専用（2026-08-29 本人指定でその位置づけを明確化した）。
 * ここで組んだデッキが、そのまま「フリーバトル」の自分のデッキになる。
 * localStorage に残すので、画面を閉じても・リロードしても組んだものが消えない。 */
const DEBUG_DECK_KEY = 'cq_debug_deck';
const deck = {};
(function loadDebugDeck() {
  try {
    const raw = localStorage.getItem(DEBUG_DECK_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      Object.keys(o).forEach((k) => { if (CARD_BY_ID[k] && o[k] > 0) deck[k] = Math.min(3, o[k] | 0); });
    }
  } catch (_) { /* 壊れていたら既定の見本デッキで始める */ }
  if (!Object.keys(deck).length) {
    [1, 1, 8, 40, 101, 108, 153, 193].forEach((id) => { deck[id] = (deck[id] || 0) + 1; });
  }
})();
function saveDebugDeck() {
  try { localStorage.setItem(DEBUG_DECK_KEY, JSON.stringify(deck)); } catch (_) { /* 保存できなくても続行 */ }
}

/** 開発用デッキを createMatch に渡せるカードIDの配列にする。
 * 40枚に満たない分は空白(180)で埋める（ラン側の buildPlayerDeck と同じ考え方）。 */
function debugDeckList() {
  const out = [];
  Object.keys(deck).forEach((k) => { for (let i = 0; i < deck[k]; i++) out.push(+k); });
  while (out.length < CQTurn.DECK_SIZE) out.push(180);
  return out.slice(0, CQTurn.DECK_SIZE);
}

/* ================= フリーバトル（開発用・2026-08-29） =================
 * 旧「バトル画面（検証）」を、デバッグメニューから開く独立したモードとして整理したもの。
 * ・自分のデッキ ＝ デッキ編集画面（screen-deck）で組んだもの（アンロック無関係・全169種）
 * ・相手 ＝ 好きなモンスター（体数つき・フリーユニット戦）か、エリアのマスター（ＬＰ勝負）
 * ・先攻／後攻を自分で選べる（ストーリー側は戦闘シードによる50%抽選なので、ここでしか選べない）
 * ストーリー（ラン）の戦闘は startRunBattle() が別に組み立てるので、ここは一切影響しない。 */
const FREE = {
  foeId: 8,            /* 相手のモンスター（フリーユニット戦のとき） */
  foeCount: 2,         /* 体数（1〜3） */
  foeKind: 'unit',     /* 'unit'＝モンスター（フリーユニット戦）／'master'＝マスター（ＬＰ勝負） */
  masterArea: 'grassland',
  first: 'self'        /* 先攻をどちらにするか */
};

/** フリーバトルの設定画面を描く（#screen-free）。 */
function renderFreeSetup() {
  const el = document.getElementById('free-root');
  if (!el) return;
  const units = CARDS.filter((c) => c.t === 'U').sort((a, b) => a.id - b.id);
  const total = Object.values(deck).reduce((s, n) => s + n, 0);
  const areas = (typeof CQAreas !== 'undefined' && CQAreas.list) ? CQAreas.list() : [];
  el.innerHTML = `
    <div class="free-wrap">
      <h2 class="free-h">フリーバトル<small>開発用。デッキ編集で組んだデッキで、好きな相手と戦います</small></h2>
      <div class="free-grid">
        <div class="free-box">
          <h3>自分のデッキ</h3>
          <p class="free-note">デッキ編集で組んだ <b>${total}</b> 枚
            ${total < CQTurn.DECK_SIZE ? `（残り ${CQTurn.DECK_SIZE - total} 枚は空白で埋まります）` : ''}</p>
          <button class="tiny" data-fact="edit-deck">デッキ編集を開く</button>
        </div>
        <div class="free-box">
          <h3>相手</h3>
          <div class="free-row">
            <button class="free-pick ${FREE.foeKind === 'unit' ? 'on' : ''}" data-fact="kind" data-v="unit">モンスター（場を空にすれば勝ち）</button>
            <button class="free-pick ${FREE.foeKind === 'master' ? 'on' : ''}" data-fact="kind" data-v="master">マスター（ＬＰ勝負）</button>
          </div>
          ${FREE.foeKind === 'unit' ? `
            <div class="free-row">
              <select id="free-foe">${units.map((c) =>
                `<option value="${c.id}" ${c.id === FREE.foeId ? 'selected' : ''}>${esc(c.n)}（Ａ${c.a}／Ｄ${c.d}／ＣＨ${c.ch}）</option>`).join('')}</select>
            </div>
            <div class="free-row"><span class="free-cap">体数</span>
              ${[1, 2, 3].map((n) => `<button class="free-pick ${FREE.foeCount === n ? 'on' : ''}" data-fact="count" data-v="${n}">${n}体</button>`).join('')}
            </div>` : `
            <div class="free-row">
              ${areas.map((a) => `<button class="free-pick ${FREE.masterArea === a.id ? 'on' : ''}" data-fact="area" data-v="${a.id}">${esc(a.bossName || a.name)}</button>`).join('')}
            </div>`}
        </div>
        <div class="free-box">
          <h3>先攻・後攻</h3>
          <div class="free-row">
            <button class="free-pick ${FREE.first === 'self' ? 'on' : ''}" data-fact="first" data-v="self">自分が先攻</button>
            <button class="free-pick ${FREE.first === 'enemy' ? 'on' : ''}" data-fact="first" data-v="enemy">相手が先攻（自分は後攻＝手札+1）</button>
          </div>
          <h3>戦場ルール</h3>
          <div class="free-row">
            ${FIELD_SETS.map((f, i) => `<button class="free-pick ${fieldSet === i ? 'on' : ''}" data-fact="field" data-v="${i}">${esc(f.label)}</button>`).join('')}
          </div>
          <h3>相手ＡＩの強さ</h3>
          <div class="free-row">
            ${AI_RANKS.map((r) => `<button class="free-pick ${aiRank === r ? 'on' : ''}" data-fact="rank" data-v="${r}">${esc(CQAi.PRESETS[r].label)}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="free-go">
        <button class="btn ng" data-fact="back">ランへ戻る</button>
        <button class="btn ok" data-fact="start">この設定で始める</button>
      </div>
    </div>`;
}

/** 設定どおりに対戦を組み立てて、バトル画面へ入る。 */
function startFreeBattle() {
  const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
  const isMaster = FREE.foeKind === 'master';
  const area = (typeof CQAreas !== 'undefined' && CQAreas.get) ? CQAreas.get(FREE.masterArea) : null;
  const enemyBoard = [];
  for (let i = 0; i < FREE.foeCount; i++) enemyBoard.push(FREE.foeId);
  RUN_ACTIVE = false; runOverHook = null; foeAuto = true;
  M = CQTurn.createMatch({
    cards: CARD_BY_ID,
    rng: CQRng.create(seed),
    selfDeck: debugDeckList(),                      /* ← デッキ編集で組んだもの */
    enemyDeck: (isMaster && area && typeof CQRun !== 'undefined')
      ? CQRun.buildBossDeck(CARD_BY_ID, area)
      : SAMPLE_DECK.slice(),
    first: FREE.first,
    opponentId: 101,                                /* フリーユニット戦扱い＝戦利品が記録される */
    fieldRules: FIELD_SETS[fieldSet].rules,
    /* モンスター相手はラン中の通常戦闘と同じフリーユニット戦、マスター相手は従来のＬＰ勝負 */
    mode: isMaster ? undefined : 'field',
    enemyBoard: isMaster ? undefined : enemyBoard,
    enemyOpts: (isMaster && area) ? { lp: area.bossLp, maxLp: area.bossLp } : undefined,
    hooks: {
      onMagicOpen: CQMagic.onMagicOpen,             /* M4 v0.13：魔法48種の発動処理 */
      onUnitOpen: CQUnits.onUnitOpen                /* M4 v0.14：ユニット固有能力「開：」型の発動処理 */
    }
  });
  M.aiConfig = { enemy: CQAi.PRESETS[aiRank] };     /* M5：相手ＡＩの強さ（評価関数方策） */
  UI.mode = 'idle'; UI.info = null; UI.lane = null; UI.layers = [];
  UI.pending = null; UI.report = null;
  showScreen('screen-battle');
  abandonStep();                   /* 前の対戦の進行・演出を捨てる（2026-09-05） */
  renderAll();                     /* 先に盤面を描いてから進める（相手が先攻でも、演出が新しい盤面の上に乗る） */
  step();
}

/** 「もう一度対戦する」＝同じ設定でもう1戦（旧 newMatch の役割）。 */
function newMatch() { startFreeBattle(); }

document.getElementById('free-root').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-fact]');
  if (!b) return;
  const v = b.dataset.v;
  switch (b.dataset.fact) {
    case 'kind': FREE.foeKind = v; break;
    case 'count': FREE.foeCount = +v; break;
    case 'area': FREE.masterArea = v; break;
    case 'first': FREE.first = v; break;
    case 'field': fieldSet = +v; break;
    case 'rank': aiRank = v; if (M) M.aiConfig = { enemy: CQAi.PRESETS[aiRank] }; break;
    case 'edit-deck': return showScreen('screen-deck');
    case 'back': return showScreen('screen-run');
    case 'start': {
      const sel = document.getElementById('free-foe');
      if (sel) FREE.foeId = +sel.value;
      return startFreeBattle();
    }
    default: return;
  }
  renderFreeSetup();
});

/* ================= 盤面セットアップ（開発用・2026-08-30） =================
 * 考察『盤面セットアップのデバッグモード』の実装。フリーバトルが「相手と先攻を選ぶ」
 * までなのに対し、こちらは **レーン・ＣＨ（表裏と置いた側）・手札・ＬＰ・手番** まで
 * 指定して戦闘を始める。カード1枚ずつ実機で確かめる工程（M6.7 WP5・WP6）のための道具。
 *
 * 盤面の中身は js/board-spec.js（CQBoardSpec）が持つただのデータで、ここはその編集画面。
 *   ・[この盤面で始める]  … その盤面から戦闘へ
 *   ・[プリセット]        … localStorage（cq_debug_board）に名前を付けて保存・呼び出し
 *   ・[ＪＳＯＮ]          … 貼り付け／書き出し。**Claudeとの受け渡し口**
 *     （「この盤面を試してください」とＪＳＯＮを渡せば本人がそのまま再現でき、
 *       逆に本人が遭遇した盤面をそのままテストへ落とせる）
 *
 * 戦闘に入ったあと、もう一度このメニューを開くと**いまの盤面が初期値として出る**ので、
 * 「試す→崩れたら少し直してまた試す」を繰り返せる（考察§3の案Cが狙っていたのはここ）。
 * ストーリー側のセーブ（cq_meta・cq_run）には一切触らない＝フリーバトルと同じ扱い。 */

const BOARD_PRESET_KEY = 'cq_debug_board';
let BSET = null;                 /* 編集中の盤面（CQBoardSpec の形）。初回は下で作る */
let bsetMsg = '';                /* 画面上部に出す一言（検証の結果など） */
/* 「📮 盤面を報告」で送ったＪＳＯＮ（封筒）をそのまま貼り付けたときに覚えておくもの
 * （2026-08-31 本人指定）。直した後に「同じ場面をもう一度」を確かめるための道具で、
 *   ・コメントと場所を画面に出す（何を確かめようとしていたか思い出せるように）
 *   ・「いま」「−1手」…と、報告に入っている盤面を選んで取り込める
 *   ・報告が戦場ルールを持っていれば、それも再現に使う（BSFIELD）
 * ふつうの盤面ＪＳＯＮを取り込んだとき・まっさらにしたときは null に戻す。 */
let BSREPORT = null;
let BSFIELD = null;              /* 報告から来た戦場ルール（null＝画面の FIELD_SETS を使う） */
let bsSnap = -1;                 /* 取り込んでいる時点（-1＝いま／0以上＝報告の history の番号） */

/** デバッグメニューから開く。戦闘中ならいまの盤面を初期値にする。 */
function openBoardSetup() {
  if (!BSET) BSET = CQBoardSpec.blank();
  if (typeof M !== 'undefined' && M && M.board) {
    BSET = CQBoardSpec.dump(M);
    bsetMsg = 'いまの盤面を読み込みました。直してから「この盤面で始める」を押してください';
  } else {
    bsetMsg = '';
  }
  renderBoardSetup();
  showScreen('screen-board');
}

/** カード選択用の <option> をまとめて作る。kinds は 'U','M','S','C','X' の並び。
 * labels でグループ名を上書きできる（ＣＨ欄のモンスターに「リバース召還」と添えるため）。 */
function bsOptions(kinds, selected, noneLabel, labels) {
  const LABEL = Object.assign(
    { U: 'モンスター', M: '魔法', S: '技能', C: 'カース（憑依として置く・常に表）', X: 'その他' }, labels || {});
  let html = noneLabel ? `<option value="">${esc(noneLabel)}</option>` : '';
  kinds.forEach((k) => {
    const list = CARDS.filter((c) => c.t === k).sort((a, b) => a.id - b.id);
    if (!list.length) return;
    html += `<optgroup label="${LABEL[k]}">` + list.map((c) =>
      `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.id} ${esc(c.n)}</option>`).join('') + '</optgroup>';
  });
  return html;
}

function bsPresetNames() {
  try { return Object.keys(JSON.parse(localStorage.getItem(BOARD_PRESET_KEY) || '{}')); }
  catch (_) { return []; }
}

/** 取り込んだ報告（BSREPORT）の欄。取り込んでいなければ何も出さない。
 * 「いま」と「−N手」を並べ、押すとその時点の盤面が編集欄に入る（2026-08-31 本人指定）。
 * ここが「直した→同じ場面をもう一度」を回すための入口になる。 */
function bsReportBox() {
  const rep = BSREPORT;
  if (!rep) return '';
  const w = rep.where || {};
  const where = [w.area,
    w.turn != null ? 'ターン' + w.turn : null,
    w.active ? (w.active === 'self' ? '自分の手番' : '相手の手番') : null,
    w.lp ? 'ＬＰ 自' + w.lp.self + '／敵' + w.lp.enemy : null].filter(Boolean).join('・');
  const stamp = rep.app ? `（v${esc(rep.app)}${rep.at ? '・' + esc(String(rep.at).replace('T', ' ').slice(0, 16)) : ''}）` : '';
  const pick = (label, i) =>
    `<button class="free-pick ${bsSnap === i ? 'on' : ''}" data-bs="snap" data-i="${i}">${esc(label)}</button>`;
  return `
    <div class="bs-report">
      <div class="bs-report-h">📮 報告を読み込みました${stamp}</div>
      ${rep.comment ? `<p class="bs-report-c">${esc(rep.comment)}</p>` : ''}
      ${where ? `<p class="bs-report-w">${esc(where)}</p>` : ''}
      ${rep.history.length ? `
        <div class="free-row"><span class="free-cap">どの時点にするか</span>
          ${pick('いま', -1)}${rep.history.map((h, i) => pick(h.label, i)).join('')}
        </div>
        <div class="bs-report-l">${bsSnapLog()}</div>` : ''}
      ${BSFIELD ? '<p class="bs-report-w">戦場ルールも報告のものを使います</p>' : ''}
    </div>`;
}

/** いま選んでいる時点で「何が起きたか」。−N手はその手が**終わった**時点の盤面なので、
 * 「−2手を選ぶと −1手の動きをもう一度やり直せる」という関係になる。 */
function bsSnapLog() {
  const rep = BSREPORT;
  if (!rep) return '';
  if (bsSnap < 0) return '報告を押した時点の盤面です。';
  const h = rep.history[bsSnap];
  if (!h) return '';
  const lines = (h.log.length ? h.log : ['（動きなし）']).map((t) => '・' + esc(t)).join('<br>');
  return `${esc(h.label)}が終わった時点の盤面です（この後の動きをもう一度なぞれます）。<br>${lines}`;
}

/** 盤面セットアップ画面を描く（#board-root）。 */
function renderBoardSetup() {
  const el = document.getElementById('board-root');
  if (!el) return;
  const s = BSET;
  const laneBox = (i) => {
    const d = s.lanes[String(i)] || null;
    const cap = d ? (CQState.unitStats(CARD_BY_ID[d.unit]).ch || 0) : 0;
    const rows = d ? d.ch.map((c, k) => `
      <div class="bs-ch">
        <span class="bs-cap">第${k + 1}層</span>
        <select data-bs="ch-card" data-l="${i}" data-k="${k}">${
          /* モンスターも置ける＝リバース召還（開かれるとその場に立つ）。よく使う魔法・技能を先に並べる */
          bsOptions(['M', 'S', 'C', 'U'], c.id, null, { U: 'モンスター（開くとリバース召還）' })}</select>
        ${CARD_BY_ID[c.id] && CARD_BY_ID[c.id].t === 'C'
          ? '<span class="free-pick on" title="カースは憑依として置かれる（常に表向き。裏にはできない）">憑依（表）</span>'
          : `<button class="free-pick ${c.up ? 'on' : ''}" data-bs="ch-up" data-l="${i}" data-k="${k}">${c.up ? '表' : '裏'}</button>`}
        <button class="free-pick ${c.by === 'self' ? 'on' : ''}" data-bs="ch-by" data-l="${i}" data-k="${k}">${c.by === 'self' ? '自が置いた' : '敵が置いた'}</button>
        <button class="free-pick del" data-bs="ch-del" data-l="${i}" data-k="${k}">✕</button>
      </div>`).join('') : '';
    return `
      <div class="bs-lane ${i < 3 ? 'mine' : 'foe'}">
        <div class="bs-lane-h">${i < 3 ? '自陣' : '敵陣'}${(i % 3) + 1}
          ${d ? `<button class="free-pick ${d.stiff ? 'on' : ''}" data-bs="stiff" data-l="${i}">硬直</button>` : ''}
        </div>
        <select data-bs="unit" data-l="${i}">${bsOptions(['U'], d ? d.unit : 0, '（空き）')}</select>
        ${rows}
        ${d && d.ch.length < cap
          ? `<button class="tiny" data-bs="ch-add" data-l="${i}">＋ＣＨを足す（${d.ch.length}／${cap}）</button>`
          : (d ? `<span class="bs-cap">ＣＨ ${d.ch.length}／${cap}（満杯）</span>` : '')}
      </div>`;
  };
  const handBox = (side) => `
    <div class="bs-hand">
      <div class="bs-lane-h">${side === 'self' ? 'あなた' : '相手'}の手札（${s.hand[side].length}／7）</div>
      <div class="bs-chips">${s.hand[side].map((id, k) =>
        `<button class="bs-chip" data-bs="hand-del" data-s="${side}" data-k="${k}">${id} ${esc(CARD_BY_ID[id].n)} ✕</button>`).join('')
        || '<span class="bs-cap">（なし）</span>'}</div>
      ${s.hand[side].length < 7 ? `
        <div class="free-row">
          <select data-bs="hand-pick" data-s="${side}">${bsOptions(['U', 'M', 'S', 'X'], 0)}</select>
          <button class="tiny" data-bs="hand-add" data-s="${side}">手札に足す</button>
        </div>` : ''}
    </div>`;
  const lpSel = (side) => `<select data-bs="lp" data-s="${side}">${
    Array.from({ length: 20 }, (_, n) => n + 1).map((n) =>
      `<option value="${n}" ${n === s.lp[side] ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
  const presets = bsPresetNames();

  el.innerHTML = `
    <div class="free-wrap">
      <h2 class="free-h">盤面をセットして戦う<small>開発用。好きな盤面・手札から戦闘を始めます（ストーリーのセーブには触れません）</small></h2>
      ${bsetMsg ? `<p class="bs-msg">${esc(bsetMsg)}</p>` : ''}
      <div class="bs-lanes">${[0, 1, 2, 3, 4, 5].map(laneBox).join('')}</div>
      <p class="bs-cap">ＣＨにはカース（91〜99）も置けます。カースは憑依として常に表向きで置かれ、傀儡化(92)なら始めた瞬間にそのユニットが相手の場へ移ります。表向きの傀儡(169)も同じです。</p>
      <div class="free-grid">
        <div class="free-box">
          <h3>手札</h3>
          ${handBox('self')}
          ${handBox('enemy')}
        </div>
        <div class="free-box">
          <h3>手番・ＬＰ</h3>
          <div class="free-row"><span class="free-cap">先攻</span>
            <button class="free-pick ${s.first === 'self' ? 'on' : ''}" data-bs="first" data-v="self">自分</button>
            <button class="free-pick ${s.first === 'enemy' ? 'on' : ''}" data-bs="first" data-v="enemy">相手</button>
          </div>
          <div class="free-row"><span class="free-cap">いまの手番</span>
            <button class="free-pick ${s.active === 'self' ? 'on' : ''}" data-bs="active" data-v="self">自分</button>
            <button class="free-pick ${s.active === 'enemy' ? 'on' : ''}" data-bs="active" data-v="enemy">相手</button>
          </div>
          <div class="free-row"><span class="free-cap">開始ステップ</span>
            <button class="free-pick ${s.phase === 'placement' ? 'on' : ''}" data-bs="phase" data-v="placement">配置から</button>
            <button class="free-pick ${s.phase === 'main' ? 'on' : ''}" data-bs="phase" data-v="main">メインから</button>
          </div>
          <div class="free-row"><span class="free-cap">ＬＰ</span>自分 ${lpSel('self')}　相手 ${lpSel('enemy')}</div>
          <div class="free-row"><span class="free-cap">勝利条件</span>
            <button class="free-pick ${s.win === 'field' ? 'on' : ''}" data-bs="win" data-v="field">敵の場を空に（探索と同じ）</button>
            <button class="free-pick ${s.win === 'lp' ? 'on' : ''}" data-bs="win" data-v="lp">ＬＰ勝負（相手も召還する）</button>
          </div>
          <div class="free-row"><span class="free-cap">戦場ルール</span>
            ${FIELD_SETS.map((f, i) => `<button class="free-pick ${fieldSet === i ? 'on' : ''}" data-bs="field" data-v="${i}">${esc(f.label)}</button>`).join('')}
          </div>
        </div>
        <div class="free-box">
          <h3>プリセット</h3>
          <div class="free-row">
            <select id="bs-preset">${presets.length
              ? presets.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')
              : '<option value="">（保存されていません）</option>'}</select>
            <button class="tiny" data-bs="preset-load">呼び出す</button>
            <button class="tiny" data-bs="preset-del">削除</button>
          </div>
          <div class="free-row">
            <input id="bs-preset-name" type="text" placeholder="名前を付けて保存" maxlength="24">
            <button class="tiny" data-bs="preset-save">保存</button>
          </div>
          <h3>ＪＳＯＮ（Claudeとの受け渡し／報告の読み込み）</h3>
          <div class="free-row">
            <button class="tiny" data-bs="json-dump">いまの盤面を書き出す</button>
            <button class="tiny" data-bs="json-load">貼り付けたものを取り込む</button>
            <button class="tiny" data-bs="clear">まっさらにする</button>
          </div>
          <textarea id="bs-json" spellcheck="false" placeholder="盤面のＪＳＯＮ、または「📮 盤面を報告」で送ったメールのＪＳＯＮを貼り付けて「取り込む」"></textarea>
          ${bsReportBox()}
        </div>
      </div>
      <div class="free-go">
        <button class="btn ng" data-bs="back">フリーバトルへ</button>
        <button class="btn ok" data-bs="start">この盤面で始める</button>
      </div>
    </div>`;
}

/** 記述どおりの対戦を組み立ててバトル画面へ入る。 */
function startBoardBattle() {
  const chk = CQBoardSpec.normalize(BSET, CARD_BY_ID);
  if (chk.errors.length) { bsetMsg = '直してください：' + chk.errors.join(' ／ '); renderBoardSetup(); return; }
  const units = Object.keys(chk.spec.lanes).filter((k) => +k >= 3);
  if (chk.spec.win === 'field' && !units.length) {
    bsetMsg = '勝利条件が「敵の場を空に」のときは、敵陣にモンスターを1体は置いてください（置かないと開始と同時に勝ちになります）';
    renderBoardSetup(); return;
  }
  const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
  RUN_ACTIVE = false; runOverHook = null; foeAuto = true;
  M = CQTurn.createMatch({
    cards: CARD_BY_ID,
    rng: CQRng.create(seed),
    selfDeck: debugDeckList(),                 /* 山札はデッキ編集で組んだもの（口寄せ・予見の引き） */
    enemyDeck: SAMPLE_DECK.slice(),
    first: chk.spec.first,
    opponentId: 101,
    /* 報告から取り込んだ戦場ルールがあればそれを使う（同じ場面を作り直すため）。
     * 画面で戦場ルールを選び直すと BSFIELD は外れ、そちらが優先される。 */
    fieldRules: BSFIELD || FIELD_SETS[fieldSet].rules,
    mode: chk.spec.win === 'field' ? 'field' : undefined,
    enemyBoard: chk.spec.win === 'field' ? [1] : undefined,   /* 中身は下で丸ごと差し替える */
    hooks: {
      onMagicOpen: CQMagic.onMagicOpen,        /* ← これを忘れると魔法が一切発動しない */
      onUnitOpen: CQUnits.onUnitOpen
    }
  });
  M.aiConfig = { enemy: CQAi.PRESETS[aiRank] };
  CQBoardSpec.apply(M, chk.spec);
  UI.mode = 'idle'; UI.info = null; UI.lane = null; UI.layers = [];
  UI.pending = null; UI.report = null; UI.pick = null; UI.chainFx = null;
  showScreen('screen-battle');
  abandonStep();                   /* 前の対戦の進行・演出を捨てる（2026-09-05） */
  renderAll();                     /* 先に盤面を描いてから進める（相手が先攻でも、演出が新しい盤面の上に乗る） */
  step();
}

document.getElementById('board-root').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-bs]');
  if (!b) return;
  const s = BSET, v = b.dataset.v, L = String(b.dataset.l), k = +b.dataset.k, side = b.dataset.s;
  const ln = s.lanes[L];
  bsetMsg = '';
  switch (b.dataset.bs) {
    case 'ch-up': ln.ch[k].up = !ln.ch[k].up; break;
    case 'ch-by': ln.ch[k].by = ln.ch[k].by === 'self' ? 'enemy' : 'self'; break;
    case 'ch-del': ln.ch.splice(k, 1); break;
    case 'ch-add': ln.ch.push({ id: 101, up: false, by: CQBoardSpec.ownerOf(+L) }); break;
    case 'stiff': ln.stiff = !ln.stiff; break;
    case 'hand-del': s.hand[side].splice(k, 1); break;
    case 'hand-add': {
      const sel = document.querySelector(`select[data-bs="hand-pick"][data-s="${side}"]`);
      if (sel && sel.value) s.hand[side].push(+sel.value);
      break;
    }
    case 'first': s.first = v; break;
    case 'active': s.active = v; break;
    case 'phase': s.phase = v; break;
    case 'win': s.win = v; break;
    /* 画面で戦場ルールを選び直したら、報告から来たルールより画面の選択を優先する */
    case 'field': fieldSet = +v; BSFIELD = null; break;
    case 'clear': BSET = CQBoardSpec.blank(); BSREPORT = null; BSFIELD = null; bsSnap = -1; break;
    case 'json-dump': {
      const ta = document.getElementById('bs-json');
      if (ta) { ta.value = CQBoardSpec.stringify(BSET); ta.select(); }   /* 貼り付け欄は書き出しで上書きする */
      flash('書き出しました。コピーしてClaudeへ渡せます');
      return;                                    /* 描き直すと textarea の中身が消えるので、ここで終わる */
    }
    case 'json-load': {
      const ta = document.getElementById('bs-json');
      const r = CQBoardSpec.parse(ta ? ta.value : '', CARD_BY_ID);
      if (r.errors.length) { bsetMsg = '取り込めません：' + r.errors.join(' ／ '); break; }
      BSET = r.spec;
      /* 「📮 盤面を報告」のＪＳＯＮ（封筒）なら、中の盤面を取り出したうえで
       * コメント・場所・直前の手も覚えておく（2026-08-31 本人指定）。 */
      BSREPORT = r.report || null;
      bsSnap = -1;
      BSFIELD = (r.report && r.report.where && Array.isArray(r.report.where.fieldRules)
                 && r.report.where.fieldRules.length) ? r.report.where.fieldRules : null;
      bsetMsg = r.report
        ? '報告から盤面を取り込みました' + (r.report.history.length ? '（下の「どの時点にするか」で前の手にも戻せます）' : '')
        : '取り込みました';
      break;
    }
    /* 報告に入っている盤面（いま／−N手）を編集欄へ移す */
    case 'snap': {
      if (!BSREPORT) break;
      const i = +b.dataset.i;
      const src = i < 0 ? BSREPORT.board : (BSREPORT.history[i] || {}).board;
      if (!src) { bsetMsg = 'その時点の盤面は報告に入っていません'; break; }
      const rs = CQBoardSpec.normalize(src, CARD_BY_ID);
      if (rs.errors.length) { bsetMsg = '取り込めません：' + rs.errors.join(' ／ '); break; }
      BSET = rs.spec; bsSnap = i;
      bsetMsg = (i < 0 ? 'いま' : BSREPORT.history[i].label) + 'の盤面にしました';
      break;
    }
    case 'preset-save': {
      const name = (document.getElementById('bs-preset-name') || {}).value;
      if (!name || !name.trim()) { bsetMsg = '名前を入れてください'; break; }
      let all = {};
      try { all = JSON.parse(localStorage.getItem(BOARD_PRESET_KEY) || '{}'); } catch (_) { all = {}; }
      all[name.trim()] = CQBoardSpec.normalize(BSET, CARD_BY_ID).spec;
      try { localStorage.setItem(BOARD_PRESET_KEY, JSON.stringify(all)); bsetMsg = '「' + name.trim() + '」を保存しました'; }
      catch (_) { bsetMsg = '保存できませんでした（保存領域がいっぱいかもしれません）'; }
      break;
    }
    case 'preset-load': {
      const name = (document.getElementById('bs-preset') || {}).value;
      let all = {};
      try { all = JSON.parse(localStorage.getItem(BOARD_PRESET_KEY) || '{}'); } catch (_) { all = {}; }
      if (!name || !all[name]) { bsetMsg = '呼び出せる盤面がありません'; break; }
      BSET = CQBoardSpec.normalize(all[name], CARD_BY_ID).spec;
      BSREPORT = null; BSFIELD = null; bsSnap = -1;
      bsetMsg = '「' + name + '」を呼び出しました';
      break;
    }
    case 'preset-del': {
      const name = (document.getElementById('bs-preset') || {}).value;
      let all = {};
      try { all = JSON.parse(localStorage.getItem(BOARD_PRESET_KEY) || '{}'); } catch (_) { all = {}; }
      if (name && all[name]) { delete all[name]; try { localStorage.setItem(BOARD_PRESET_KEY, JSON.stringify(all)); } catch (_) {} bsetMsg = '「' + name + '」を消しました'; }
      break;
    }
    case 'back': renderFreeSetup(); return showScreen('screen-free');
    case 'start': return startBoardBattle();
    default: return;
  }
  renderBoardSetup();
});

document.getElementById('board-root').addEventListener('change', (ev) => {
  const el = ev.target.closest('select[data-bs]');
  if (!el) return;
  const s = BSET, L = String(el.dataset.l), k = +el.dataset.k;
  switch (el.dataset.bs) {
    case 'unit': {
      const id = +el.value;
      if (!id) { delete s.lanes[L]; break; }
      if (s.lanes[L]) s.lanes[L].unit = id;
      else s.lanes[L] = { unit: id, ch: [] };
      /* ＣＨ数の少ないモンスターに替えたら、はみ出した階層はその場で落とす
       * （開始時に弾かれるより、画面で見えたほうが早い） */
      const cap = CQState.unitStats(CARD_BY_ID[id]).ch || 0;
      if (s.lanes[L].ch.length > cap) s.lanes[L].ch.length = cap;
      break;
    }
    case 'ch-card': s.lanes[L].ch[k].id = +el.value; break;
    case 'lp': s.lp[el.dataset.s] = +el.value; break;
    default: return;                                          /* hand-pick は「足す」を押すまで何もしない */
  }
  bsetMsg = '';
  renderBoardSetup();
});

/** 操作を始める前にログの位置を覚えておく（そのあと起きたことを右パネルに出すため） */
let logMark = null;
function markLog() { if (logMark === null) logMark = M.log.length; }

/* ================= 動きの演出（v0.13.4） =================
 * エンジンの状態変化を「操作前後の差分」から検出し、CSSアニメーションで見せる。
 *   ・手札の配布＝上からスライドイン（1枚ずつ順に）
 *   ・召還・チャネル＝上からスライドイン（相手の手番は1手ずつ間を置いて見せる）
 *   ・押し込み＝出ていくカードが右へ飛び、入るカードは左からスライドイン
 *   ・オープン／クローズ＝めくり（相手の戦闘オープンも1枚ずつ）
 *   ・ユニット破壊＝カードが粉々に割れて飛び散る
 * 演出中は busy が立ち、盤面・手札・パネルの操作を受け付けない（短時間なので待てばよい）。
 * エンジンには一切手を入れず、画面側だけで完結させる。乱数も見た目専用なので Math.random でよい。 */
const FX = { step: 460, deal: 90, out: 280,
  /* M7.9（2026-09-05 本人指定）：相手の手番を追えるようにするための「節目の停止」 */
  banner: 900,      /* 攻撃宣言のバナー（相手が攻撃したとき） */
  verdict: 700,     /* 判定の数字ポップ（Ａ600 vs Ｄ500） */
  lp: 600,          /* ＬＰ減少のフロート */
  telop: 700,       /* 憑依・傀儡のテロップ */
  turn: 700 };      /* 手番の切り替わりの帯（M7.9 第2段 A5） */
/* 演出の速さ（設定画面「演出の速さ」。localStorage cq_fx）。停止時間に一律で掛ける倍率。
 * ★既定は「ゆっくり」（2026-09-05 本人指定）——初めて遊ぶ人は、相手の手番で何が起きているかを
 * 追えないまま負けるのがいちばん困る。慣れた人は設定で「ふつう」「速い」に変えられる。 */
const FX_SPEED = { slow: 1.5, normal: 1, fast: 0.6 };
const FX_SPEED_DEFAULT = 'slow';
function fxSpeed() {
  try { const v = JSON.parse(localStorage.getItem('cq_fx') || '{}').speed; return FX_SPEED[v] ? v : FX_SPEED_DEFAULT; }
  catch (_) { return FX_SPEED_DEFAULT; }
}
function fxMs(key) { return Math.round(FX[key] * FX_SPEED[fxSpeed()]); }
/* M7.9 第2段 B2：コマ送り（設定「相手の手番：タップで1手ずつ」。cq_fx.step === 'tap'）。
 * 相手の手番の節目（手番の帯・宣言・判定・ＬＰ・テロップ・盤面の変化）ごとに止まり、
 * 画面のどこかを押すと次へ進む。人の手番と、決着後は止めない。 */
function tapMode() {
  try { return JSON.parse(localStorage.getItem('cq_fx') || '{}').step === 'tap'; }
  catch (_) { return false; }
}
function gating() { return tapMode() && !!M && !M.winner && isAuto(M.active); }
let tapResolve = null;
function waitTap() {
  return new Promise((res) => {
    tapResolve = res;
    let g = document.getElementById('tap-gate');
    if (!g) {
      g = document.createElement('div');
      g.id = 'tap-gate';
      g.innerHTML = '<div class="tap-gate-hint">タップで次へ ▶</div>';
      g.addEventListener('click', onTapGate);
      document.body.appendChild(g);
    }
    requestAnimationFrame(() => g.classList.add('on'));
  });
}
function onTapGate() {
  const g = document.getElementById('tap-gate');
  if (g) g.classList.remove('on');
  const r = tapResolve; tapResolve = null;
  if (r) r();
}
/** 節目で止まる：コマ送りなら次のタップまで、そうでなければ ms だけ待つ */
function hold(ms) { return gating() ? waitTap() : sleep(ms); }
const HOLD_MS = 600000;   /* コマ送り中の表示物は「タップまで残す」（実質無期限） */
let busy = false;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function snapFx() {
  return {
    lanes: M.board.lanes.map((ln) => ({
      unit: ln.unit,
      chs: ln.channels.map((c) => ({ card: c.card, up: !!c.up }))
    })),
    hand: M.players[handSide()].hand.length,
    handSide: handSide(),
    /* M7.9：節目の演出（宣言・判定・ＬＰ・テロップ）が「この操作で何が起きたか」を知るための控え */
    lp: { self: M.players.self.lp, enemy: M.players.enemy.lp },
    logLen: M.log.length,
    lastBattle: M.lastBattle,
    combat: !!M.combat,
    m: M                      /* どの対戦の控えか（対戦が差し替わったら演出を捨てる） */
  };
}
let FXPREV = null;
/** 人の操作の直前に呼ぶ（直後の step() が差分を演出する） */
function markFx() { FXPREV = snapFx(); }

/** ＣＨカードの「いま見えている高さ」。ＣＨは下に積まれたカード（1つ下の階層、
 * 無ければレーンのユニット）に隠れていて、実際は帯だけが見えている。
 * カード全体を割ると、隠れていた部分が割れる瞬間に現れてしまうので、
 * 見えているぶんだけを割る（2026-08-30）。 */
function chVisibleHeight(el) {
  const r = el.getBoundingClientRect();
  const lane = el.dataset.lane, layer = +el.dataset.layer;
  const below = document.querySelector(`#board .card.ch[data-lane="${lane}"][data-layer="${layer - 1}"]`)
    || document.querySelector(`#board .card.unit[data-lane="${lane}"]`);
  if (!below) return r.height;
  const h = below.getBoundingClientRect().top - r.top;
  return (h > 10 && h < r.height) ? h : r.height;
}

/** 破壊の演出：いま見えているカードを16片に割って飛散させる。
 * opts.height … 割る範囲を上からこの高さぶんに限る（ＣＨは chVisibleHeight を渡す） */
function shatterEffect(el, opts) {
  return new Promise((res) => {
    const r0 = el.getBoundingClientRect();
    const hh = (opts && opts.height) ? Math.min(opts.height, r0.height) : r0.height;
    const r = { left: r0.left, top: r0.top, width: r0.width, height: hh };
    if (!(r.width > 0)) { res(); return; }
    const box = document.createElement('div');
    box.className = 'cq-shard-box';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    const N = 4, w = r.width / N, h = r.height / N;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const p = document.createElement('div');
      p.className = 'cq-shard';
      p.style.left = (x * w) + 'px'; p.style.top = (y * h) + 'px';
      p.style.width = w + 'px'; p.style.height = h + 'px';
      const c = el.cloneNode(true);                       /* 破片＝カードの複製を切り抜いたもの */
      c.style.position = 'absolute'; c.style.margin = '0';
      c.style.left = (-x * w) + 'px'; c.style.top = (-y * h) + 'px';
      /* 複製はカード本来の大きさのまま（高さを切ると絵が潰れる）。切り抜きは .cq-shard 側の overflow */
      c.style.width = r0.width + 'px'; c.style.height = r0.height + 'px';
      p.appendChild(c);
      p.style.setProperty('--sx', ((x - (N - 1) / 2) * (26 + Math.random() * 30)) + 'px');
      p.style.setProperty('--sy', (((y - (N - 1) / 2) * 16) + 60 + Math.random() * 70) + 'px');
      p.style.setProperty('--sr', ((Math.random() * 140) - 70) + 'deg');
      p.style.animation = 'cq-shard-fly ' + (0.5 + Math.random() * 0.22) + 's ease-in forwards';
      p.style.animationDelay = (Math.random() * 0.06) + 's';
      box.appendChild(p);
    }
    el.style.visibility = 'hidden';                        /* 本体は隠す（破片が本体の代わり） */
    document.body.appendChild(box);
    setTimeout(res, 640);                                  /* 演出の山が過ぎたら次へ進む */
    setTimeout(() => box.remove(), 900);                   /* 破片の後始末は裏で */
  });
}

/** 傀儡でユニットがレーンごと相手の場へ移ったとき、**壊れたのではなく移った**と分かるように、
 * 古いカードの分身を移動先のレーンまで滑らせる（2026-09-05 本人指定：破壊の飛散は使わない）。
 * ★呼ぶ側の約束：まだ描き直していないこと（古いＤＯＭのカードを掴んで動かす）。 */
function slideUnitEffect(el, toLane) {
  return new Promise((res) => {
    const fromLane = el.dataset.lane;
    const from = el.getBoundingClientRect();
    const slot = document.querySelector('#board .lane[data-lane="' + toLane + '"] .empty-unit')
      || document.querySelector('#board .lane[data-lane="' + toLane + '"]');
    const to = slot ? slot.getBoundingClientRect() : from;
    const dx = (to.left + (to.width - from.width) / 2) - from.left;
    const dy = (to.bottom - from.height) - from.top;       /* ユニットはレーンの下端に立つ */
    /* ユニットだけでなく、積まれているＣＨもまとめて（レーンごと）滑らせる */
    const cards = Array.from(document.querySelectorAll('#board .lane[data-lane="' + fromLane + '"] .card'))
      .filter((c) => !c.classList.contains('empty-unit'));
    const ghosts = cards.map((c) => {
      const r = c.getBoundingClientRect();
      const g = c.cloneNode(true);
      g.classList.add('cq-slide-ghost');
      g.classList.remove('an-in', 'an-in-left', 'an-flip', 'openable', 'flippable');
      Object.assign(g.style, {
        position: 'fixed', left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px', margin: '0', bottom: 'auto', zIndex: 60,
        pointerEvents: 'none', transition: 'transform .55s cubic-bezier(.2,.7,.2,1)'
      });
      document.body.appendChild(g);
      c.style.visibility = 'hidden';                       /* 本体は隠す（分身が本体の代わり） */
      return g;
    });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ghosts.forEach((g) => { g.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; });
    }));
    setTimeout(res, 580);
    setTimeout(() => ghosts.forEach((g) => g.remove()), 700);
  });
}

/** 差分を検出して演出しつつ再描画する。
 * 戻り値＝演出が落ち着くまでに待つべきミリ秒（見える変化が無ければ 0） */
async function animateFx(prev) {
  if (!prev) { renderAll(); return 0; }
  let wait = 0;
  const lanes = M.board.lanes;
  /* 傀儡の移動（エンジンが控えた from→to）。破壊ではなく「滑って移る」演出にする */
  const moves = (M.fxMoves || []).slice();
  M.fxMoves = [];
  const movedTo = {};
  /* --- 再描画の前：古いDOMのまま行う演出（破壊の飛散・押し出されるカード・傀儡の移動） --- */
  const pre = [];
  let hadOut = false;
  for (let i = 0; i < 6; i++) {
    const pv = prev.lanes[i], now = lanes[i];
    if (pv.unit != null && now.unit !== pv.unit) {
      const el = document.querySelector('#board .card.unit[data-lane="' + i + '"]');
      const mv = moves.find((v) => v.from === i && v.unit === pv.unit && lanes[v.to].unit === v.unit);
      if (el && mv) { pre.push(slideUnitEffect(el, mv.to)); movedTo[mv.to] = true; wait = Math.max(wait, 580); }
      else if (el) { pre.push(shatterEffect(el)); wait = Math.max(wait, 340); }
    } else if (pv.unit != null && now.unit != null && pv.chs.length === now.channels.length) {
      for (let k = 1; k <= now.channels.length; k++) {
        if (pv.chs[k - 1] && pv.chs[k - 1].card !== now.channels[k - 1].card) {
          const el = document.querySelector('#board .card.ch[data-lane="' + i + '"][data-layer="' + k + '"]');
          if (el) { el.classList.add('an-out'); wait = Math.max(wait, 340); hadOut = true; }
        }
      }
    }
  }
  if (pre.length) await Promise.all(pre);
  else if (hadOut) await sleep(FX.out);
  renderAll();
  /* --- 再描画の後：新しく現れた・めくられたカードに演出クラスを付ける --- */
  for (let i = 0; i < 6; i++) {
    const pv = prev.lanes[i], now = lanes[i];
    if (now.unit == null) continue;
    if (pv.unit !== now.unit) {                            /* 召還・リバース召還 */
      if (movedTo[i]) continue;                            /* 傀儡で滑って来た札は、もうそこに居る（出現の演出はしない） */
      const el = document.querySelector('#board .card.unit[data-lane="' + i + '"]');
      if (el) { el.classList.add('an-in'); wait = Math.max(wait, 340); }
      continue;
    }
    for (let k = 1; k <= now.channels.length; k++) {
      const el = document.querySelector('#board .card.ch[data-lane="' + i + '"][data-layer="' + k + '"]');
      if (!el) continue;
      const p = pv.chs[k - 1], c = now.channels[k - 1];
      if (!p) { el.classList.add('an-in'); wait = Math.max(wait, 340); continue; }   /* 新しく積まれた */
      if (p.card !== c.card) {                                                       /* 入れ替わった */
        el.classList.add(pv.chs.length === now.channels.length ? 'an-in-left' : 'an-in');
        wait = Math.max(wait, 340); continue;
      }
      if (p.up !== !!c.up) { el.classList.add('an-flip'); wait = Math.max(wait, 340); }  /* めくられた */
    }
  }
  /* --- 手札の配布（同じ側の手札が増えたときだけ。1枚ずつ順に） --- */
  if (prev.handSide === handSide()) {
    const n = M.players[handSide()].hand.length;
    for (let i = prev.hand; i < n; i++) {
      const el = document.querySelector('#hand .hand-card[data-hand="' + i + '"]');
      if (el) {
        el.classList.add('an-deal');
        el.style.animationDelay = ((i - prev.hand) * FX.deal) + 'ms';
        wait = Math.max(wait, (i - prev.hand) * FX.deal + 340);   /* 最後の1枚が収まるまで */
      }
    }
  }
  return wait;
}

/** エンジンを1手動かして、その差分を演出する（相手の自動手番・自動オープン用） */
async function fxAct(fn) {
  const prev = snapFx();
  /* 憑依解除(101)のような破壊は「予約」で受け取り、赤枠→粉々の演出を挟んでから消す。
   * 相手の手番・相手の戦闘オープンもここを通るので、**誰が撃っても同じ見え方**になる。 */
  CQMagic.beginAim(M);
  let ret, err = null;
  try { ret = fn(); } catch (e) { err = e; }
  const aimed = CQMagic.endAim(M);
  if (err) { CQMagic.strikeDoomed(M); throw err; }
  const w = await playChanges(prev);
  if (aimed.length) { await playAimedDestroy(aimed); if (gating()) await waitTap(); return ret; }
  if (w) {
    await sleep(Math.max(w, fxMs('step')));   /* 1手ごとに少し間を置いて、動きが目で追えるようにする */
    if (gating()) await waitTap();            /* コマ送り：盤面が変わったら、次の手はタップまで待つ */
  }
  return ret;
}

/* ================= M7.9：節目の演出（2026-09-05 本人指定） =================
 * 「相手の手番が速すぎて何が起きたか分からないまま負ける」への対処。エンジンの1手ごとに
 * 差分を見て、宣言 → 判定の数字 → ＬＰの減少 → 憑依・傀儡のテロップ → 盤面の変化（割れる・
 * 滑る）の順に、**止まって見せる**。停止時間は FX と設定「演出の速さ」で決まる。
 * エンジンには一切触れない（宣言は M.combat／M.lastBattle、ＬＰは M.players、憑依と傀儡は
 * M.log の行から読む）。 */

/** 1手の差分をすべて演出して描き直す。戻り値＝animateFx と同じ「待つべきミリ秒」 */
async function playChanges(prev) {
  if (!prev) { renderAll(); return 0; }
  if (prev.m && prev.m !== M) return 0;               /* 前の対戦の控え：新しい対戦には何もしない */
  const newLines = M.log.slice(prev.logLen);
  const battle = (M.lastBattle && M.lastBattle !== prev.lastBattle) ? M.lastBattle : null;
  /* この1手で戦闘が宣言されたか：まだ戦闘中なら M.combat、宣言→即判定なら lastBattle */
  const declared = !prev.combat ? (M.combat || battle) : null;
  /* B1 ログの逐次表示：相手の手番の最中も「ここまでの動き」を1行ずつ足す */
  if (liveLogMark !== null && M.log.length > liveLogMark) revealReport(M.log.slice(liveLogMark));
  /* A1 攻撃宣言のバナー（相手が攻撃したときだけ。自分の攻撃は自分で選んでいる） */
  if (declared && isAuto(declared.attackerSide)) await playDeclare(declared, prev);
  /* A2 判定の数字ポップ（まだ描き直していないので、両方のカードが画面に残っている） */
  if (battle && battle.atk != null && battle.def != null) await playVerdict(battle);
  /* A3 ＬＰの減少（フロート表示。両者ぶんを同時に） */
  let lpWait = 0;
  const floats = [];
  ['self', 'enemy'].forEach((side) => {
    const d = M.players[side].lp - prev.lp[side];
    if (d < 0) { floats.push(floatLp(side, d)); lpWait = fxMs('lp'); }
  });
  if (lpWait) { await hold(lpWait); floats.forEach((f) => f && f.classList.add('done')); }
  /* A4 憑依・傀儡のテロップ。傀儡（移動）は滑る演出と重ねて見せる（コマ送りではタップまで残す） */
  const telops = newLines.filter((l) => /^(憑依：|傀儡：|傀儡が解けた：)/.test(l));
  for (let i = 0; i < telops.length; i++) {
    const move = /へ移った/.test(telops[i]);
    if (gating()) {
      const t = showTelop(telops[i], HOLD_MS);
      await waitTap();
      hideTelop(t);
      continue;
    }
    showTelop(telops[i], move ? fxMs('telop') + 550 : fxMs('telop'));
    if (!move) await sleep(fxMs('telop'));
    else await sleep(Math.round(fxMs('telop') * 0.4));    /* 少し見せてから滑らせ始める */
  }
  if (prev.m && prev.m !== M) return 0;               /* 演出の途中で対戦が差し替わった */
  return animateFx(prev);
}

/** A5（M7.9 第2段）：手番の切り替わりの帯。「相手の手番」「あなたの手番」を画面の中央に
 * 横切る黒い帯で出し、消えるまで次へ進まない（コマ送りなら相手の手番はタップまで） */
async function playTurnCut(side) {
  if (!M || M.turn === 0) return;                  /* 最初の手番は先攻ルーレット／導入が兼ねる */
  const mine = side === handSide();
  let b = document.getElementById('turn-cut');
  if (!b) { b = document.createElement('div'); b.id = 'turn-cut'; document.body.appendChild(b); }
  b.className = mine ? 'mine' : 'foe';
  b.innerHTML = `<div class="turn-cut-in"><span class="turn-cut-who">${mine ? 'あなた' : '相手'}</span>の手番</div>`;
  requestAnimationFrame(() => b.classList.add('on'));
  if (!mine && tapMode() && !M.winner) await waitTap();
  else await sleep(fxMs('turn'));
  b.classList.remove('on');
}

/** 相手の手番の最中にログを逐次表示するための、手番開始時点のログ位置（runStep が置く） */
let liveLogMark = null;
/** B1：「ここまでの動き」を1行ずつ増やして見せる（演出の進みと歩調を合わせる）。
 * 新しい行が来たら、前回までの行は即座に全部出し、増えた分だけを間隔を置いて足す */
let revealTimer = null;
function revealReport(lines) {
  clearTimeout(revealTimer); revealTimer = null;
  const have = (UI.report && UI.report.length) || 0;
  let k = Math.min(have, lines.length);
  const tick = () => {
    k += 1;
    UI.report = lines.slice(0, k);
    renderPanel();
    if (k < lines.length) revealTimer = setTimeout(tick, Math.round(380 * FX_SPEED[fxSpeed()]));
    else revealTimer = null;
  };
  if (k < lines.length) tick();
  else { UI.report = lines.slice(); renderPanel(); }
}

/** A1：攻撃宣言のバナー。攻撃側と防御側の2枚を強調し、消えるまで次へ進まない */
async function playDeclare(c, prev) {
  /* 名前は**操作前の控え（prev）**から取る——宣言→即判定で相手が既に壊れていることがある */
  const A = prev.lanes[c.attacker], D = prev.lanes[c.defender];
  const an = A && A.unit != null && CARD_BY_ID[A.unit] ? CARD_BY_ID[A.unit].n : '';
  const dn = D && D.unit != null && CARD_BY_ID[D.unit] ? CARD_BY_ID[D.unit].n : '';
  const aSide = c.attackerSide === handSide() ? 'あなた' : '相手';
  const dSide = c.attackerSide === handSide() ? '相手' : 'あなた';
  const atkEl = document.querySelector('#board .card.unit[data-lane="' + c.attacker + '"]');
  const defEl = document.querySelector('#board .card.unit[data-lane="' + c.defender + '"]');
  if (atkEl) atkEl.classList.add('fx-atk');
  if (defEl) defEl.classList.add('fx-def');
  const ms = fxMs('banner');
  const g = gating();
  showBanner(`<span class="fb-side">${aSide}の</span><b>${esc(an)}</b>
    <span class="fb-arrow">→</span>
    <span class="fb-side">${dSide}の</span><b>${esc(dn)}</b><span class="fb-side"> に攻撃</span>`, g ? HOLD_MS : ms + 200);
  await hold(ms);
  if (g) hideBanner();
}

/** A2：判定の数字ポップ。攻撃側に「Ａ600」、防御側に「Ｄ500」を大きく出し、勝った側を色で示す */
async function playVerdict(b) {
  const ok = !!b.success;
  const g = gating();
  const pops = [];
  const pop = (lane, text, cls) => {
    const el = document.querySelector('#board .card.unit[data-lane="' + lane + '"]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    const p = document.createElement('div');
    p.className = 'cq-verdict ' + cls + (g ? ' hold' : '');
    p.textContent = text;
    Object.assign(p.style, { left: (r.left + r.width / 2) + 'px', top: (r.top - 34) + 'px' });   /* カードの上に浮かせる */
    document.body.appendChild(p);
    pops.push(p);
    if (!g) setTimeout(() => p.remove(), fxMs('verdict') + 400);
  };
  pop(b.attacker, 'Ａ' + b.atk, ok ? 'win' : 'lose');
  pop(b.defender, 'Ｄ' + b.def, ok ? 'lose' : 'win');
  showBanner(ok ? `<b class="fb-ok">攻撃成功</b><span class="fb-side">（${b.atk} ≧ ${b.def}）</span>`
                : `<b class="fb-ng">攻撃失敗</b><span class="fb-side">（${b.atk} ＜ ${b.def}）</span>`,
             g ? HOLD_MS : fxMs('verdict') + 200);
  await hold(fxMs('verdict'));
  if (g) { hideBanner(); pops.forEach((p) => p.remove()); }
}

/** A3：ＬＰが減ったことをハートの横に「−4」と浮かせて見せる。ハートも一瞬赤く光る */
function floatLp(side, diff) {
  const el = document.getElementById(side === handSide() ? 'my-lp' : 'foe-lp');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const f = document.createElement('div');
  const g = gating();
  f.className = 'cq-lp-float' + (M.players[side].lp <= 0 ? ' fatal' : '') + (g ? ' hold' : '');
  f.textContent = '−' + (-diff);
  Object.assign(f.style, { left: (r.right + 4) + 'px', top: r.top + 'px' });
  document.body.appendChild(f);
  el.classList.add('hit');
  setTimeout(() => el.classList.remove('hit'), 700);
  if (!g) setTimeout(() => f.remove(), fxMs('lp') + 500);
  else f.classList.add('hold');
  /* コマ送り：タップ後に .done が付いたら消す（呼び出し側） */
  const obs = new MutationObserver(() => { if (f.classList.contains('done')) { obs.disconnect(); f.remove(); } });
  obs.observe(f, { attributes: true, attributeFilter: ['class'] });
  return f;
}

/** A4：画面中央のテロップ（憑依・傀儡）。ms 後に消える。await はしない（呼ぶ側で待つ） */
function showTelop(text, ms) {
  const t = document.createElement('div');
  t.className = 'cq-telop';
  t.textContent = text;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('on'));
  setTimeout(() => hideTelop(t), ms);
  return t;
}
function hideTelop(t) {
  if (!t || !t.parentNode) return;
  t.classList.remove('on'); setTimeout(() => t.remove(), 250);
}

/** 盤面の上に出る帯（宣言・判定）。同時に1本だけ */
function showBanner(html, ms) {
  let b = document.getElementById('fx-banner');
  if (!b) { b = document.createElement('div'); b.id = 'fx-banner'; document.body.appendChild(b); }
  b.innerHTML = html;
  b.classList.add('on');
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(hideBanner, ms);
}
function hideBanner() {
  const b = document.getElementById('fx-banner');
  if (b) b.classList.remove('on');
  document.querySelectorAll('#board .fx-atk, #board .fx-def').forEach((e) => e.classList.remove('fx-atk', 'fx-def'));
}

/* ---- 破壊の予約を演出して解決する（2026-08-30 本人指定） --------------------
 * 「憑依解除が発動したら、狙われたカードを赤い枠で見せて、少し置いてから粉々に割る」。
 * 対象を自分で選んだとき・対象が1つしかなくて自動で決まったとき・強制開放でめくられて
 * 発動したとき・相手が撃ったとき——**すべて同じ見え方**にするための共通処理。
 * エンジン側は js/engine/effects/magic.js の beginAim / endAim / strikeDoomed。 */
const AIM_SHOW_MS = 620;       /* 赤枠で「これを狙った」を見せる長さ */

/** レーンごと吹き飛んだとき（呪爆(133)など）に、そのレーンのユニットと
 * 積まれていたカードをまとめて「赤枠 →（間）→ 粉々」で見せる（2026-08-30 本人指定）。
 *
 * ★呼ぶ側の約束：**まだ描き直していないこと。** エンジンの盤面からは既に消えているが、
 * 画面には壊れる前のカードが残っている——その古いＤＯＭを掴んで割る。
 * 描き直してしまうとカードは影も形も無くなり、何も見せられない
 * （強制リバース連鎖の中で呪爆が跳ね返ったとき、実際にそうなっていた）。 */
async function playLaneWipe(lanes) {
  const els = [];
  lanes.forEach((i) => {
    const u = document.querySelector(`#board .card.unit[data-lane="${i}"]`);
    if (u) els.push({ el: u, opts: null });
    document.querySelectorAll(`#board .card.ch[data-lane="${i}"]`).forEach((el) => {
      els.push({ el: el, opts: { height: chVisibleHeight(el) } });   /* ＣＨは見えている帯だけ割る */
    });
  });
  if (!els.length) return false;
  els.forEach((e) => e.el.classList.add('doomed'));                  /* 赤枠で「これが壊れる」 */
  await sleep(AIM_SHOW_MS);
  await Promise.all(els.map((e) => shatterEffect(e.el, e.opts)));
  return true;
}

/** aimed＝[{lane, idx, card}]。赤枠 →（間）→ 粉々に割れる → 実際に取り除く。 */
async function playAimedDestroy(aimed) {
  if (!aimed || !aimed.length) return false;
  renderAll();                                   /* doomed の印が赤枠になって出る */
  await sleep(AIM_SHOW_MS);
  await Promise.all(aimed.map((a) => {
    const el = document.querySelector(
      `#board .card.ch[data-lane="${a.lane}"][data-layer="${a.idx + 1}"]`);
    return el ? shatterEffect(el, { height: chVisibleHeight(el) }) : Promise.resolve();
  }));
  CQMagic.strikeDoomed(M);
  renderAll();
  return true;
}

/** 人の入力が要るところまで進める。UIの操作は必ず最後にこれを呼ぶ。
 * 相手の手番と戦闘のオープンは1手ずつ、間（FX.step）を置いて見せる */
let stepQueued = false;
/* 対戦の世代番号（2026-09-05）。新しい対戦を始めたら +1 して、前の対戦の演出を待っていた
 * runStep が目を覚ましたとき「もう自分の対戦ではない」と分かるようにする。演出が長くなった
 * （M7.9）ことで、前の対戦の進行が残ったまま次の対戦が始まると busy が立ちっぱなしになり、
 * 新しい盤面への最初の操作が無視されることがあった（verify-run で判明）。 */
let MATCH_GEN = 0;
/** 新しい対戦を始める側が呼ぶ：前の対戦の進行・待ち・表示物を捨てる */
function abandonStep() {
  MATCH_GEN += 1;
  busy = false; stepQueued = false;
  liveLogMark = null; clearTimeout(revealTimer); revealTimer = null;
  const r = tapResolve; tapResolve = null;
  const g = document.getElementById('tap-gate'); if (g) g.classList.remove('on');
  if (r) r();                                            /* 待っていた古い進行を起こして終わらせる */
  hideBanner();
  document.querySelectorAll('.cq-telop, .cq-verdict, .cq-lp-float, .cq-slide-ghost').forEach((e) => e.remove());
  const tc = document.getElementById('turn-cut'); if (tc) tc.classList.remove('on');
}
function step() {
  if (busy) { stepQueued = true; return; }
  busy = true;
  const gen = MATCH_GEN;
  runStep(gen)
    .catch((e) => { console.error(e); })
    .then(() => {
      if (gen !== MATCH_GEN) return;                     /* 古い対戦の進行：新しい対戦には触れない */
      busy = false;
      if (stepQueued) { stepQueued = false; step(); }
    });
}

async function runStep(gen) {
  const stale = () => gen !== MATCH_GEN;
  const mark = logMark === null ? M.log.length : logMark;
  logMark = null;
  liveLogMark = mark;                                   /* B1：この手番のログを逐次表示するための起点 */
  const pv = FXPREV; FXPREV = null;
  if (pv) { const w = await playChanges(pv); if (w) await sleep(w); }   /* 人の操作直後の変化をまず見せる */
  if (stale()) return;
  let guard = 0;
  while (M && !M.winner && !M.fled && guard++ < 500) {   /* M.fled＝逃走成功。勝敗は付かないが対局は終わり */
    if (INTRO_WAIT) await INTRO_WAIT;                 /* 先攻ルーレットが消えるまで手番を進めない */
    if (stale()) return;
    if (M.combat) {                                   /* 戦闘中のオープンフェイズ */
      if (!isAuto(CQCombat.openerSide(M))) break;
      await fxAct(() => CQAi.openStep(M));            /* 相手のオープンは1枚ずつめくって見せる */
      continue;
    }
    if (isAuto(M.active)) {                           /* 相手の手番（自動） */
      if (M.phase === 'draw') {
        await playTurnCut(M.active);                  /* A5：「相手の手番」の帯 */
        if (stale()) return;
        CQTurn.beginTurn(M); renderAll(); continue;
      }
      if (M.phase === 'discard') { CQAi.discardStep(M); continue; }
      if (M.phase === 'placement') {                  /* 1枚ずつ場に出して見せる */
        let n = 0;
        while (n++ < 4 && M.phase === 'placement') {
          if (!(await fxAct(() => CQAi.placementStep(M)))) break;
          if (stale()) return;
        }
        if (M.phase === 'placement') CQTurn.endPlacement(M);
        continue;
      }
      if (M.phase === 'main') { if (await fxAct(() => CQAi.mainStep(M))) continue; if (stale()) return; CQTurn.endTurn(M); continue; }
      break;
    }
    if (M.phase === 'draw') {                         /* 人の手番：ドローは自動＋配布演出 */
      await playTurnCut(M.active);                    /* A5：「あなたの手番」の帯 */
      if (stale()) return;
      await fxAct(() => CQTurn.beginTurn(M)); continue;
    }
    break;
  }
  if (stale()) return;
  liveLogMark = null;
  clearTimeout(revealTimer); revealTimer = null;      /* 逐次表示の途中なら、ここで全部出す */
  const lines = M.log.slice(mark);
  if (lines.length) UI.report = lines;
  if (M.winner || M.fled) UI.mode = 'over';
  else if (M.combat && !isAuto(CQCombat.openerSide(M))) {
    if (UI.mode !== 'battle') UI.mode = 'battle';
  } else if (UI.mode === 'battle' || UI.mode === 'over') UI.mode = 'idle';
  renderAll();
}

/* ================= 描画 ================= */

/* 盤面レポート（js/report.js・2026-08-31）：ログが伸びていたらその時点の盤面を1つ積む。
 * ここに置くのは「エンジンのどの入口を通っても必ず最後にここへ来る」ため。読むだけなので
 * 対戦・乱数には影響しない（report.js 側で例外も握りつぶしてある）。 */
function renderAll() {
  /* 巻き戻し中は仮の対戦（REPLAY の盤面）を描いているので、履歴には積まない */
  if (typeof CQReport !== 'undefined' && UI.mode !== 'replay') CQReport.tick();
  renderStatus(); renderBoard(); renderHand(); renderPanel();
  renderReplayBar();
}

/* ================= M7.9 第2段 B4：巻き戻して見る（2026-09-05 本人指定） =================
 * 決着後、「📮 盤面を報告」が持っている輪番バッファ（直近5手の盤面＋その手のログ。
 * js/report.js の CQReport.history()）をそのまま使って、最後の手を盤面つきで1手ずつ見返す。
 * 新しいデータは要らない。見ている間は本物の対戦（REPLAY.live）を脇に置き、その手の
 * 盤面から作った仮の対戦を M に入れて描く。操作はすべて止め、終えると本物に戻す。 */
let REPLAY = null;
function replayEnter() {
  const hist = (typeof CQReport !== 'undefined') ? CQReport.history() : [];
  if (hist.length < 2) { flash('見返せる手がありません'); return; }
  REPLAY = { live: M, hist: hist, idx: hist.length - 1, mode: UI.mode };
  UI.mode = 'replay';
  replayShow(REPLAY.idx);
}
function replayShow(idx) {
  const r = REPLAY; if (!r) return;
  r.idx = Math.max(0, Math.min(r.hist.length - 1, idx));
  const h = r.hist[r.idx];
  const live = r.live;
  const m = CQTurn.createMatch({
    cards: CARD_BY_ID, rng: CQRng.create(1),
    selfDeck: [], enemyDeck: [],
    first: h.board.first || 'self',
    opponentId: live.opponentId,
    fieldRules: live.fieldRules,
    mode: h.board.win === 'field' ? 'field' : undefined,
    enemyBoard: h.board.win === 'field' ? [1] : undefined,
    hooks: {}
  });
  CQBoardSpec.apply(m, h.board);
  m.turn = h.turn;
  if (h.deck) { m.players.self.deckCount = h.deck.self; m.players.enemy.deckCount = h.deck.enemy; }
  m.replay = true;
  M = m;
  renderAll();
}
function replayExit() {
  const r = REPLAY; if (!r) return;
  M = r.live;
  UI.mode = r.mode === 'replay' ? 'over' : r.mode;
  REPLAY = null;
  const bar = document.getElementById('replay-bar');
  if (bar) bar.remove();
  renderAll();
}
function renderReplayBar() {
  let bar = document.getElementById('replay-bar');
  if (UI.mode !== 'replay' || !REPLAY) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div'); bar.id = 'replay-bar';
    document.getElementById('board').parentNode.appendChild(bar);
  }
  const n = REPLAY.hist.length - 1 - REPLAY.idx;
  bar.innerHTML = `巻き戻して見る　<b>${n === 0 ? 'いま' : n + '手前'}</b>　（${REPLAY.idx + 1}／${REPLAY.hist.length}）`;
}
function panelReplay() {
  const r = REPLAY; if (!r) return panelIdle();
  const h = r.hist[r.idx];
  const n = r.hist.length - 1 - r.idx;
  const who = h.active === handSide() ? 'あなた' : '相手';
  const lines = (h.log || []).length ? h.log : ['（この手ではログが増えていない）'];
  paint(`<div class="i-replay-h">巻き戻して見る（${n === 0 ? 'いま' : n + '手前'}）</div>
    <div class="i-replay-turn">第 ${h.turn} ターン・${who}の手番</div>
    <h3>この手で起きたこと</h3>
    <ul class="rep">${lines.map((l, i) => `<li class="${i === lines.length - 1 ? 'now' : ''}">${esc(l)}</li>`).join('')}</ul>
    <div class="rep-nav">
      <button class="tiny" data-act="replay-prev" ${r.idx === 0 ? 'disabled' : ''}>◀ 前の手</button>
      <button class="tiny" data-act="replay-next" ${r.idx >= r.hist.length - 1 ? 'disabled' : ''}>次の手 ▶</button>
    </div>`,
    `<p class="i-hint">盤面はその手が終わった時点のものです。右下の「見返しを終える」で戻ります。</p>`);
}

function renderStatus() {
  const me = M.players.self, foe = M.players.enemy;
  const top = handSide() === 'self' ? foe : me;          /* 上段は「いま操作していない側」 */
  document.getElementById('foe-name').textContent = handSide() === 'self' ? '相手' : 'あなた';
  /* M6.6 WP6：フリーユニット戦の敵にはＬＰの概念が無い（§2-6）。ＬＰの代わりに
   * 「あと何体倒せば勝ちか」＝敵の場の残り体数を出す。これが実際の勝利条件なので、
   * プレイヤーが見るべき数字もこちらになる。 */
  const fieldFoe = CQTurn.isFieldMode(M) && handSide() === 'self';
  document.getElementById('foe-lp').textContent = fieldFoe
    ? '残り ' + CQTurn.enemyUnitCount(M) + ' 体'
    : '♥ ' + Math.max(0, (handSide() === 'self' ? foe : me).lp);
  document.getElementById('foe-lp').classList.toggle('field-remain', fieldFoe);
  document.getElementById('foe-deck').textContent = top.deckCount;
  document.getElementById('my-lp').textContent = '♥ ' + Math.max(0, (handSide() === 'self' ? me : foe).lp);
  document.getElementById('my-deck').textContent = (handSide() === 'self' ? me : foe).deckCount;
  document.getElementById('my-name').textContent = handSide() === 'self' ? 'あなた' : '相手';

  let h = '';
  for (let i = 0; i < top.hand.length; i++) h += `<span class="mini" style="z-index:${20 - i}"></span>`;
  document.getElementById('ehand').innerHTML = h + `<b>${top.hand.length}</b>`;

  document.getElementById('turnbox').innerHTML = RUN_ACTIVE
    ? `<span class="tn">第 ${M.turn} ターン</span>
       <span class="tw">${phaseLabel()}</span>
       ${fieldChipsHTML()}`
    : `<span class="tn">第 ${M.turn} ターン</span>
       <span class="tw">${phaseLabel()}</span>
       ${fieldChipsHTML()}
       <button class="tiny" data-act="mode">相手：${foeAuto ? '自動' : '手動'}</button>
       <button class="tiny" data-act="rank">強さ：${CQAi.PRESETS[aiRank].label}</button>
       <button class="tiny" data-act="field">戦場：${FIELD_SETS[fieldSet].label}</button>
       <button class="tiny" data-act="new">新しい対戦</button>`;
}

/* --- 戦場ルール（M6）の常時表示 ---
 * 追補§M6の大原則「戦闘前に必ず見える」を画面側でも守る。有効なルールのアイコンを
 * ターン表示の隣に出しっぱなしにし、押すと説明が右のパネルに出る。
 * 定期爆撃だけは着弾までの残りターン数を数字で併記する（カウントダウン） */
function fieldChipsHTML() {
  const rules = (M && M.fieldRules) || [];
  if (!rules.length) return '';
  return '<span class="fchips">' + rules.map((r, k) => {
    const d = CQField.describe(r);
    const cd = r.id === 'bomb' ? CQField.bombCountdown(M) : null;
    const num = cd == null ? '' : `<b class="${cd === 0 ? 'now' : ''}">${cd === 0 ? '着弾' : 'あと' + cd}</b>`;
    return `<button class="fchip" data-act="field-info" data-idx="${k}"
      title="${esc(d.name)}">${d.icon}<span>${esc(d.name)}</span>${num}</button>`;
  }).join('') + '</span>';
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
  const pup = unitHome(i) !== laneSide(i);            // 傀儡で相手の場から移ってきた／持って行かれた
  const cls = (v, base) => (v !== base ? (v > base ? ' up' : ' dn') : '');
  const tags = [];
  if (ln.stiff && !ln.extraAttack) tags.push('<div class="st-tag">行動済</div>');
  if (ln.extraAttack) tags.push('<div class="st-tag go">連続</div>');
  /* 戦闘の当事者には「攻撃／防御」の札を出す（どちらが攻めているかを明示） */
  if (M.combat && M.combat.attacker === i) tags.push('<div class="fight-tag atk">攻撃</div>');
  else if (M.combat && M.combat.defender === i) tags.push('<div class="fight-tag def">防御</div>');
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
  /* リバースは開いた瞬間に硬直するが、継続中（M.reversing）のレーンだけは続きを開ける */
  const canFlipHere = !M.combat && !M.winner && humanSide() === M.active && M.phase === 'main'
    && CQState.controlSide(ln, i) === M.active && (!ln.stiff || M.reversing === i)
    && !(ln.acc && ln.acc.lock >= 1)
    && allowedLayers(i).indexOf(k) >= 0;
  const flip = canFlipHere && !ch.up;
  const closable = canFlipHere && ch.up;
  /* 憑依解除(101)などの発動で「破壊する対象を選ぶ」最中なら、選べるＣＨを光らせる
     （2026-08-24 本人の指定：対話的な対象選択） */
  const pickable = UI.mode === 'pick-target' && UI.pick
    && ((UI.pick.kind === 'ch'
          && UI.pick.targets.some((t) => t.lane === i && t.idx === k - 1)
          && !UI.pick.chosen.some((t) => t.lane === i && t.idx === k - 1))
        /* 菊一文字(131)は「階層（レベル）」を選ぶ。その階層のカードを全部光らせ、
           どれを押してもその階層が選ばれる（M6.7 WP5の4つ目の型） */
        || (UI.pick.kind === 'layer' && UI.pick.targets.indexOf(k) >= 0));
  /* 複数選択（113透視）で既に選んだぶんは、選択済みとして別の色にする */
  const pickedCls = UI.mode === 'pick-target' && UI.pick && UI.pick.kind === 'ch'
    && UI.pick.chosen.some((t) => t.lane === i && t.idx === k - 1) ? 'picked' : '';
  /* 強制リバース連鎖（M6.7 WP1・2026-08-30 作り直し）：
     いま処理している1枚だけをその場でめくる。壊されると決まったカードは赤枠で見せる。 */
  const chainNow = !!(UI.chainNow && UI.chainNow.lane === i && UI.chainNow.idx === k - 1);
  const doomed = !!ch.doomed;
  const attr = `data-lane="${i}" data-layer="${k}" data-card="${card.id}"
    data-own="${own ? 1 : 0}" data-known="${known ? 1 : 0}" data-st="${ch.st || ''}"
    ${closable ? 'data-closable="1"' : ''}`;
  /* 開けるカードは「左半分＝開く／右半分＝内容を見る」の2つのタップ領域に分ける。
     ▶（左）とⓘ（右）がその目印。境目には薄い縦線を出す（.card.ch.split の ::after） */
  const split = open || flip;
  const mark = split ? '<span class="cur">▶</span>' : '';
  const info = split ? '<span class="inf">ⓘ</span>' : '';
  const splitCls = split ? 'split' : '';
  const pickCls = (pickable ? 'pick ' : '') + pickedCls
    + (chainNow ? ' chain-now' : '') + (doomed ? ' doomed' : '');
  if (!ch.up) {
    const nm = known ? `<span class="nm">${card.n}</span>` : '<span class="nm hid">？</span>';
    return `<div class="card ch back ${oc} ${open ? 'openable' : ''} ${flip ? 'flippable' : ''} ${splitCls} ${pickCls}" ${attr} ${bottom}>
      <div class="strip">${mark}${nm}${badge}${info}</div></div>`;
  }
  return `<div class="card ch ${card.t} ${oc} ${pos ? 'possess' : ''} ${splitCls} ${pickCls}" ${attr} ${bottom}>
    <div class="strip">${mark}<span class="nm">${card.n}</span>${badge}${info}</div>
    <div class="art">${artInner(card)}</div></div>`;
}

/* --- 1レーン --- */
function laneHTML(i) {
  const ln = M.board.lanes[i];
  const cls = [];
  if (UI.lane === i) cls.push('sel');
  if (UI.mode === 'attack' && UI.targets && UI.targets.indexOf(i) >= 0) cls.push('target');
  /* M6.7 WP1：レーンを選ぶタイプの対象選択（108/109/110）で、選べるレーンを光らせる */
  if (UI.mode === 'pick-target' && UI.pick && UI.pick.kind === 'lane'
    && UI.pick.targets.indexOf(i) >= 0) cls.push('pick-lane');
  /* 戦闘中：当事者の2レーンを黄色い点線で囲み、それ以外は暗くして
     「どのカードとどのカードが戦っているか」を一目で分かるようにする（2026-08-24 本人の要望） */
  if (M.combat) {
    if (M.combat.attacker === i) cls.push('fighting', 'atk');
    else if (M.combat.defender === i) cls.push('fighting', 'def');
    else cls.push('dimmed');
    if (CQCombat.openerLane(M) === i) cls.push('opening');
  }
  /* M6 戦場ルール laneLock：使えないレーンには蓋を被せる（何も置けないことが一目で分かる） */
  const locked = !CQField.laneUsable(M.board, i);
  if (locked) cls.push('locked');
  let inner = '';
  if (locked) {
    return `<div class="lane ${cls.join(' ')}" data-lane="${i}">
      <div class="card lane-lid" data-act="field-info">🚧<span>使用不可</span></div></div>`;
  }
  if (ln.unit != null) {
    const max = Math.max(ln.cap, ln.channels.length);
    inner += `<div class="cap-box" style="height:calc(var(--chh) + ${max} * var(--vstep) + 8px)"></div>`;
    for (let k = 1; k <= Math.min(ln.channels.length, LAYERS); k++) inner += chHTML(i, k);
    inner += unitHTML(i);
  } else {
    inner = '<div class="card empty-unit" data-lane="' + i + '">空き</div>';
  }
  /* ★2026-09-05 本人指定：M6 戦場ルール laneCap（🪨 岩でふさがれた列）を**絵で見せる**。
   * それまで岩の列は数字（ＣＨ上限）が下がるだけで、盤面を見ても塞がれていることが分からなかった
   * （チップの説明を読まないと気づけない）。使えない階層のぶんだけ、レーンの上から岩を積む。 */
  const fcap = M.board.fieldCap && M.board.fieldCap[i];
  if (fcap != null && fcap < LAYERS) {
    inner += `<div class="lane-rocks" data-act="field-info"
        style="height:calc(${LAYERS - fcap} * var(--vstep))">
      <span class="lane-rocks-cap">ＣＨ ${fcap} まで</span></div>`;
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
const APP_EDGE = 6;        /* 画面の縁に触れないための余白。丸角・1px単位の丸め対策 */

/** セーフエリア（切り欠き・丸角）の実測。env() はJSから直接読めないので
 * `#sa-probe` の padding に入れておいて px で測る（index.html は viewport-fit=cover） */
function safeInsets() {
  const p = document.getElementById('sa-probe');
  if (!p) return { t: 0, r: 0, b: 0, l: 0 };
  const cs = getComputedStyle(p);
  return {
    t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0,
    b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0
  };
}

/** いま実際に見えている領域の大きさ。
 * Androidブラウザは上にURLバーが出ていると **innerHeight が見えている高さより大きい**
 * （innerHeight＝レイアウトビューポート＝URLバーが隠れたときの高さ）ことがある。
 * これを信じて縮小率を決めていたため、Galaxy Tab で下端が切れていた。
 * いちばん小さい値＝確実に見えている範囲を採る。 */
function viewSize() {
  let w = window.innerWidth, h = window.innerHeight;
  const vv = window.visualViewport;
  if (vv && vv.width > 0) {
    w = Math.min(w, vv.width);
    /* ただしソフトキーボードが出ているときは visualViewport が大きく縮む。
       これに追従すると、デッキ編集の絞り込み欄に文字を打つたび画面全体が跳ねてしまうので、
       入力中の極端な縮み（2割超）は画面が狭くなったとは見なさない */
    const ae = document.activeElement;
    const typing = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
    if (!(typing && vv.height < h * 0.8)) h = Math.min(h, vv.height);
  }
  const de = document.documentElement;
  if (de && de.clientWidth > 0) w = Math.min(w, de.clientWidth);   // 縦スクロールバーぶんを避ける
  return { w: w, h: h };
}

/** 見えている領域にぴったり収まるよう縮小率と位置を決める（拡大はしない） */
function fitApp() {
  const v = viewSize(), sa = safeInsets();
  const availW = Math.max(320, v.w - sa.l - sa.r - APP_EDGE * 2);
  const availH = Math.max(200, v.h - sa.t - sa.b - APP_EDGE * 2);
  const s = Math.min(1, availW / APP_W, availH / APP_H);
  document.documentElement.style.setProperty('--app-scale', s);
  const el = document.getElementById('app');
  if (el) {
    el.style.left = (sa.l + APP_EDGE + (availW - APP_W * s) / 2) + 'px';
    el.style.top = (sa.t + APP_EDGE + (availH - APP_H * s) / 2) + 'px';
  }
}

/** 画面の大きさが変わるきっかけをすべて拾う（URLバーの出入りは resize では来ないことがある） */
function onViewChange() { fitApp(); fitBoard(); if (M) renderHand(); }
window.addEventListener('resize', onViewChange);
window.addEventListener('orientationchange', () => setTimeout(onViewChange, 250));
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', onViewChange);
  window.visualViewport.addEventListener('scroll', onViewChange);
}
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
  if (UI.mode === 'replay') {
    /* M7.9 第2段 B4：巻き戻し中は、手を進める・戻す・終える、だけ */
    b = '<button class="act-btn sub" data-act="replay-prev">◀ 前の手</button>'
      + '<button class="act-btn sub" data-act="replay-next">次の手 ▶</button>'
      + '<button class="act-btn" data-act="replay-exit">見返しを<br>終える</button>';
    acts.innerHTML = b;
    return;
  }
  if (M.winner || M.fled) {
    /* 2026-08-29：フリーバトルの決着後は「もう一度対戦する」に加えて「バトルを終える」も
     * 出す（本人指定）。押すとフリーバトルのトップ（相手選び）画面に戻る。
     * ラン中の戦闘（RUN_ACTIVE）には無関係——そちらは「ランへ戻る」がその役割を兼ねる。 */
    b = RUN_ACTIVE ? '<button class="act-btn" data-act="run-over">ランへ<br>戻る</button>'
                   : '<button class="act-btn" data-act="new">もう一度<br>対戦する</button>' +
                     '<button class="act-btn sub" data-act="free-end">バトルを<br>終える</button>';
    /* M7.9 第2段 B4：決着後に「なぜそうなったか」を最後の5手ぶん盤面つきで見返せる */
    if (typeof CQReport !== 'undefined' && CQReport.history().length >= 2) {
      b = '<button class="act-btn sub rep" data-act="replay">巻き戻して<br>見る</button>' + b;
    }
  }
  else if (M.combat) {
    /* オープンフェイズを終えるボタンは、他のステップの「配置を終える」と同じ右下に置く。
     * 防御側は既に1枚以上開いていることもあるので「開かずに終える」ではなく「迎撃を終える」
     * （2026-08-24 本人の指定） */
    if (humanOpening()) {
      b = M.combat.opener === 'defender'
        ? '<button class="act-btn warn" data-act="open-end">迎撃を<br>終える</button>'
        : '<button class="act-btn warn" data-act="open-end">オープンを<br>終える</button>';
    }
  }
  else if (humanSide() === M.active) {
    if (M.phase === 'placement') b = '<button class="act-btn" data-act="end-place">配置を<br>終える</button>';
    else if (M.phase === 'main') b = '<button class="act-btn" data-act="end-turn">ターンを<br>終了する</button>';
  }
  /* M6.6 WP12：ラン中の戦闘には「逃げる」「諦める」を右下に添える。
   *   逃げる … フリーユニット戦の配置ステップで、そのターンまだ何もしていないときだけ
   *             （CQTurn.canFlee が原作の条件をそのまま判定する）。マスター戦では出ない
   *   諦める … いつでも押せる。確認ダイアログを挟んで自らゲームオーバーを選ぶ
   * 単発の検証モード（RUN_ACTIVE=false）では出さない——戻る先のランが無いため。 */
  let sub = '';
  if (RUN_ACTIVE && !M.winner && !M.fled) {
    if (CQTurn.canFlee(M)) sub += '<button class="act-btn sub" data-act="flee">逃げる</button>';
    sub += '<button class="act-btn sub ng" data-act="give-up">諦める</button>';
  }
  acts.innerHTML = sub + b;
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
  /* M6.7 WP2：魔法にも「詠唱Ｌｖ」を出す。配置した階層がこの数字以上でないと発動しない
   * （ユニットの召還Ｌｖとまったく同じ概念。エンジン側は magic.js の LEVEL_REQ）。
   * 今までレベルの存在が画面のどこにも出ておらず、8種は不発の理由が分からなかった。 */
  const kv = card.t === 'U'
    ? `<span>攻撃力 ${card.a}</span><span>防御力 ${card.d}</span>
       <span>ＣＨ ${card.ch}</span><span>召還Ｌｖ ${card.lv}</span>`
    : `<span>${TYPE_NAME[card.t]}</span>${card.t === 'M' ? `<span>詠唱Ｌｖ ${card.lv}</span>` : ''}`;
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
    /* ★M7.8 WP6：own＝いま操作できる側（居る場の陣営）。傀儡は相手の場へ物理的に移る */
    foot += own
      ? '<p class="i-t pup">傀儡：相手のモンスターですが、いまは<b>自分の場に移って自分が操作できます</b>。倒されると自分のＬＰが減ります。傀儡が外れると相手の場へ戻ります。</p>'
      : '<p class="i-t pup">傀儡：自分のモンスターですが、いまは<b>相手の場に移って相手が操作しています</b>。倒しても戦利品にはなりません。傀儡が外れると自分の場へ戻ります。</p>';
  }
  return `<div class="i-art ${card.t} ${back ? 'downed' : ''}">${artInner(card)}</div>
    <div class="i-tag">${TYPE_NAME[card.t]}</div>${own === undefined ? '' : ownTagHTML(own, unit)}
    <h3>${card.n}</h3>
    <div class="i-kv">${kv}</div>${now}
    <p class="i-t">${card.e || '（特殊能力なし）'}</p>${cardCondHTML(card)}${foot}`;
}

/** 発動条件のバッジ（M6.7 WP4・2026-08-30）。
 * 説明文に「／戦闘中×強制中×（レベル３」と押し込むのをやめ、**別の欄**に出す。
 * 条件はエンジン（magic.js の NO_COMBAT / NO_FORCED）が持っているものをそのまま読む
 * ——data.js に書き写すと必ずどちらかが古くなるので、**二重に持たない**。
 * 詠唱Ｌｖ・召還Ｌｖは能力値の欄（i-kv）に既に出ているので、ここでは繰り返さない。 */
function cardCondHTML(card) {
  if (!card || typeof CQMagic === 'undefined') return '';
  const tags = [];
  if (CQMagic.NO_COMBAT && CQMagic.NO_COMBAT[card.id]) tags.push('戦闘中は発動しません');
  if (CQMagic.NO_FORCED && CQMagic.NO_FORCED[card.id]) tags.push('強制開放・強制転回では発動しません');
  if (!tags.length) return '';
  return `<div class="i-cond">${tags.map((t) => `<span>${t}</span>`).join('')}</div>`;
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
  const shown = lines.slice(-14);
  return `<h3>ここまでの動き</h3>
    <ul class="rep">${shown.map((l, i) => `<li class="${i === shown.length - 1 ? 'now' : ''}">${esc(l)}</li>`).join('')}</ul>`;
}

function renderPanel() {
  switch (UI.mode) {
    case 'over':      return panelOver();
    case 'replay':    return panelReplay();
    case 'battle':    return panelBattle();
    case 'unit':      return panelUnit();
    case 'attack':    return panelAttack();
    case 'pick-target': return panelPickTarget();
    case 'draw-pick': return panelDrawPick();
    case 'confirm':   return;                       /* 確認画面は出したまま */
    case 'info':      return panelInfo();
    case 'field':     return panelField();
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
    const endLabel = M.combat.opener === 'defender' ? '迎撃を終える' : 'オープンを終える';
    return paint(infoCardHTML(CARD_BY_ID[UI.info.card], UI.info)
      + '<p class="i-t dim">※ 開くときは、カードの<b>左半分（▶側）</b>を押します。</p>',
      `<p class="i-hint">終えるときは右下の「${endLabel}」ボタンを押します</p>`);
  }
  /* 表になっている技能カード（自分が操作するレーン・メインステップ）は、ここから閉じられる。
   * 場のカードを押した瞬間に閉じてしまう誤操作を防ぐため、ワンクッション置いている */
  const foot = UI.info.closable
    ? `<button class="btn ng" data-act="close-ch" data-lane="${UI.info.lane}"
        data-layer="${UI.info.layer}">この技能を閉じる（リバース）</button>`
    : '';
  paint(infoCardHTML(CARD_BY_ID[UI.info.card], UI.info), foot, !!foot);
}

/* --- 戦場ルールの説明（アイコンを押したとき） --- */
function panelField() {
  const rules = (M && M.fieldRules) || [];
  const body = rules.map((r) => {
    const d = CQField.describe(r);
    const cd = r.id === 'bomb' ? CQField.bombCountdown(M) : null;
    return `<div class="i-field"><h3>${d.icon} ${esc(d.name)}</h3>
      <p class="i-t">${esc(d.text)}</p>
      ${cd == null ? '' : `<p class="i-t"><b>${cd === 0 ? 'このターンの終わりに着弾します' : 'あと ' + cd + ' ターンで着弾します'}</b></p>`}
    </div>`;
  }).join('');
  paint('<div class="i-lead">この戦場には特別なルールがあります</div>' + body, ngBtn('閉じる'), true);
}

function panelOver() {
  /* M6.6 WP12：逃走成功は勝ちでも負けでもない第3の終わり方。マスは残ったままなので、
   * 「入り直せる」ことをここで伝える（そうしないとマップに戻ったとき何が起きたか読めない）。 */
  if (M.fled) {
    paint(`<div class="i-result flee">戦いから離脱した</div>
      <p class="i-t">このマスの相手はまだ残っています。もう一度入り直せます（第 ${M.turn} ターン）</p>
      ${UI.report ? reportHTML(UI.report) : ''}`,
      `<p class="i-hint">${RUN_ACTIVE ? '右下の「ランへ戻る」で探索に戻ります' : ''}</p>`);
    return;
  }
  const win = M.winner === 'self';
  /* v0.15.1：山札切れ敗北は廃止（尽きたら自動再装填・ＬＰ−2）。敗因はＬＰ0のみ。
   * M6.6 WP6：フリーユニット戦は勝利条件が違う（敵の場を空にする）ので理由の文も変える。
   * M6.6 WP12：自分から諦めた場合はＬＰ0の理由が違うので、その旨を出す。 */
  const why = win
    ? (CQTurn.isFieldMode(M) ? '相手の場のユニットを全て倒しました' : '相手のＬＰが0になりました')
    : (M.resigned === 'self' ? 'あなたが探索を諦めました' : 'あなたのＬＰが0になりました');
  /* 2026-08-29 本人指摘：決着後の「ランへ戻る」が情報パネルと右下の2箇所に出ていた。
   * 進行のボタンは常に右下（#acts）に置く決まりなので、パネル側からは外して右下だけにする。
   * 単発の検証モード（RUN_ACTIVE=false）の「もう一度」も同じ理由で右下だけにする。 */
  paint(`<div class="i-result ${win ? 'win' : 'lose'}">${win ? 'あなたの勝ち' : 'あなたの負け'}</div>
    <p class="i-t">${why}（第 ${M.turn} ターン）</p>
    ${M.loot.length ? `<div class="i-loot">戦利品：${M.loot.map((id) => CARD_BY_ID[id].n).join('・')}</div>` : ''}
    ${UI.report ? reportHTML(UI.report) : ''}`,
    `<p class="i-hint">${RUN_ACTIVE ? '右下の「ランへ戻る」で探索に戻ります' : '右下の「もう一度対戦する」で次の対戦を始めます'}</p>`);
}

/* --- メインステップ：ユニットを選んだときの行動メニュー --- */
function panelUnit() {
  const i = UI.lane, ln = M.board.lanes[i];
  // 情報パネルを開いたあとに、そのユニットが戦闘や魔法で破壊されていることがある
  // （演出の途中描画のレース。panelBattle の同種のガードと同じ理由。2026-08-24 に発見・修正）
  if (!ln || ln.unit == null) { UI.mode = 'idle'; UI.lane = null; return panelIdle(); }
  const card = CARD_BY_ID[ln.unit];
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
  // 特殊行動（Ｃ型ユニット固有能力。M4 v0.14）：Ｃ型を持つユニットだけボタンを出す
  const spec = CQTurn.canSpecialAction(M, i);
  if (CQUnits.C_TYPE[ln.unit]) {
    if (spec.ok) {
      btns += `<button class="act-row" data-act="special-action">特殊行動<span class="sub">${card.e || ''}</span></button>`;
    } else {
      btns += `<div class="act-row off">特殊行動：${spec.reason}</div>`;
    }
  }
  return paint(miniCardHTML(card)
    + `<div class="i-kv now"><span>攻撃力 <b>${ln.atk}</b></span><span>防御力 <b>${ln.def}</b></span>
       <span>ＣＨ ${ln.count}／${ln.cap}</span></div>`
    + `<div class="acts-list">${btns}</div>`,
    ngBtn('やめる'), true);
}

function canReverse(i) {
  const ln = M.board.lanes[i];
  if (ln.stiff && M.reversing !== i) return { ok: false, reason: 'そのユニットは行動済みです' };
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
  // 同上（panelUnit）：攻撃対象を選んでいる間にこのユニット自身が破壊されていることがある
  if (!ln || ln.unit == null) { UI.mode = 'idle'; UI.lane = null; UI.targets = null; return panelIdle(); }
  return paint(miniCardHTML(CARD_BY_ID[ln.unit])
    + askHTML('攻撃する相手を選んでください',
      `黄色い枠の付いた相手のモンスターを押します。<br>
       あなたの攻撃力 <b>${ln.atk}</b> が相手の防御力以上なら成功です（同値も成功）。`, 'warn'),
    ngBtn('やめる'), true);
}

/** 憑依解除(101)：破壊する対象を選んでいる最中のパネル（2026-08-24 本人の指定） */
/** 引いた札から選ぶ画面（122予見・146口寄せ。M6.7 WP3）。
 * 予見 … 5枚を並べ、押した1枚をもらう。
 * 口寄せ … 1枚を見せ、「もらう」か「捨ててもう1枚」を選ぶ（捨てた札は山札に戻らない）。 */
function panelDrawPick() {
  const pc = M.pendingChoice;
  if (!pc) return paint('', '', true);
  const foresee = pc.kind === 'foresee';
  const cards = pc.options.map((id, i) => {
    const c = CARD_BY_ID[id];
    return `<div class="dp-card ${c.t}" data-act="draw-pick" data-i="${i}">
        <div class="dp-art">${artInner(c, 3)}</div>
        <div class="dp-nm">${c.n}</div>
        <div class="dp-ef">${c.e || TYPE_NAME[c.t]}</div>
      </div>`;
  }).join('');
  const q = foresee ? '予見：もらう１枚を選んでください'
    : '口寄せ：このカードをもらいますか？';
  const how = foresee
    ? '選ばなかったカードは山札へ戻ります。'
    : '「捨ててもう１枚」を選ぶと、この札は山札に戻らずもう１枚めくります（' + (pc.tries || 1) + '枚目）。';
  const foot = foresee ? ''
    : `<button class="btn ok" data-act="draw-keep">これをもらう</button>
       <button class="btn" data-act="draw-skip">捨ててもう１枚</button>`;
  return paint(askHTML(q, how, 'warn') + `<div class="dp-row">${cards}</div>`, foot, !foresee);
}

function panelPickTarget() {
  const p = UI.pick;
  if (!p) return paint('', '', true);
  const rest = p.need - p.chosen.length;
  const ask = PICK_MSG[p.card] || '対象を選んでください';
  /* 相手の手札から選ぶ型（114暗殺）。盤面には出ていないので、ここに並べて押させる。
   * ——原作でもこのカードは「選んでいる間、相手の手札が全部見える」＝偵察になる。 */
  if (p.kind === 'hand') {
    const hand = M.players[handSide() === 'self' ? 'enemy' : 'self'].hand;
    const cards = hand.map((id, i) => {
      const c = CARD_BY_ID[id];
      const ok = p.targets.indexOf(i) >= 0;
      const act = p.card === 114 ? '押すと破壊' : '押すと奪う';
      return `<div class="dp-card ${c.t} ${ok ? '' : 'dim'}" ${ok ? `data-act="pick-hand" data-i="${i}"` : ''}>
          <div class="dp-art">${artInner(c, 3)}</div>
          <div class="dp-nm">${c.n}</div>
          <div class="dp-ef">${ok ? act : TYPE_NAME[c.t] + 'は選べません'}</div>
        </div>`;
    }).join('');
    const note = p.card === 114
      ? '相手の手札がすべて見えています。モンスターだけが選べます。'
      : '相手の手札がすべて見えています。どのカードでも奪えます。';
    return paint(miniCardHTML(CARD_BY_ID[p.card])
      + askHTML(ask, note, 'warn') + `<div class="dp-row">${cards}</div>`, '', true);
  }
  const how = p.kind === 'lane'
    ? '光っているユニットを押すと、そのユニットが対象になります。'
    : p.kind === 'layer'
      ? '光っているカードを押すと、<b>その階層が全レーンで</b>対象になります。'
      : '光っているＣＨカードを押して選びます。' + (p.need > 1 ? 'あと' + rest + '枚。' : '');
  return paint(miniCardHTML(CARD_BY_ID[p.card]) + askHTML(ask, how, 'warn'), '', true);
}

/* --- 戦闘：オープンフェイズ ---
 * 開く操作は場の▶付きカードを直接押す（選択ＵＩはパネルに置かない。2026-08-24 本人の指定）。
 * フェイズを終えるボタンは右下（「配置を終える」と同じ場所）に出す（2026-08-24 本人の指定）。
 * パネルは対戦カードといまどちらのフェイズかの説明だけ */
function panelBattle() {
  const c = M.combat;
  /* 演出の途中描画では、UI.mode がまだ 'battle' のまま戦闘が終わっていることがある */
  if (!c) return panelIdle();
  const A = M.board.lanes[c.attacker], D = M.board.lanes[c.defender];
  const role = c.opener === 'attacker' ? '攻撃側' : '防御側';
  const endLabel = c.opener === 'defender' ? '迎撃を終える' : 'オープンを終える';
  const head = `<div class="vs">
      <span class="vs-a">攻 ${CARD_BY_ID[A.unit] ? CARD_BY_ID[A.unit].n : '—'} <b>${A.atk}</b></span>
      <span class="vs-x">▶</span>
      <span class="vs-d">防 ${CARD_BY_ID[D.unit] ? CARD_BY_ID[D.unit].n : '—'} <b>${D.def}</b></span>
    </div>`;
  return paint(head + askHTML(`${jpSide(CQCombat.openerSide(M))}の${role}オープンフェイズ`,
    `▶の付いたカードの<b>左半分（▶側）を押すと開き</b>、<b>右半分（ⓘ側）を押すと中身を確認</b>できます。<br>
     下から上への一方通行です（開いた階層より下の▶は消えます）。クローズはできません。<br>
     終えるときは右下の<b>「${endLabel}」</b>ボタンを押します。`, 'warn')
    + (UI.report ? reportHTML(UI.report) : ''));
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

  /* カードを置けるのは配置ステップだけ（2026-08-24 本人の指定。エンジン側でも拒否される） */
  if (M.phase !== 'placement') {
    return paintNG(card, 'カードを置けるのは配置ステップだけです。メインステップではアタックとリバースだけができます。');
  }
  if (ln.unit == null) {
    if (!mine) return paintNG(card, 'モンスターを相手の場に直接召還することはできません。相手の場に関われるのは、相手のユニットへのチャネルだけです。');
    if (card.t !== 'U') return paintNG(card, 'ここは空き枠です。魔法と技能はモンスターの上にしか置けません。');
    markLog(); markFx();
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
  if (full && pushLayer == null) {
    return paintNG(card, `${host.n} のチャネルは一杯です。押し込むときは、<b>入れ替えたい階層のカードに直接重ねて</b>離してください。その階層のカードを捨てて入れ替えます。`);
  }
  markLog(); markFx();
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

/* M6 戦場ルール：おじゃま虫だけは配置ステップで手札から直接捨てられる（2026-08-26 本人の指定）。
   1ターン1枚まで・捨てると「行動した」扱い、というコストはエンジン側（CQTurn.canDiscardPest）が見る */
function showPestDiscardConfirm(handIdx) {
  const card = CARD_BY_ID[M.players[M.active].hand[handIdx]];
  const chk = CQTurn.canDiscardPest(M, handIdx);
  UI.mode = 'confirm';
  if (!chk.ok) {
    UI.pending = null;
    return paint(miniCardHTML(card) + askHTML('いまは捨てられません', chk.reason, 'ng'), ngBtn('閉じる'), true);
  }
  UI.pending = { kind: 'pest-discard', handIdx };
  paint(miniCardHTML(card) + askHTML('おじゃま虫を捨てますか？',
    'このカードは<b>置くことも召還することもできません</b>。捨てられるのは<b>1ターンに1枚まで</b>で、'
    + '捨てるとそのターンは「行動した」扱いになります（何もしなかったときの手札1枚補充は受けられません）。', 'warn'),
    okBtn('捨てる') + ngBtn(), true);
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
  markLog(); markFx();
  const r = CQCombat.declareAttack(M, atkLane, defLane);
  UI.mode = 'idle'; UI.lane = null; UI.targets = null; UI.report = null;
  if (!r.ok) { flash(r.reason || 'その操作はできません'); renderAll(); return; }
  step();
}

/** 場のカードを1階層だけリバースする（直接クリック用。原作の SW583「行動継続中」に対応：
 * 同じレーンなら続けて上の階層も開け、別の行動を始めるか最上段まで開くと確定して硬直する）
 * choice … 憑依解除(101)で対話的に選んだ破壊対象 {lane, idx}（省略時はエンジンが自動選択） */
function doFlip(laneIdx, layer, choice) {
  markLog(); markFx();
  M.lastForcedChain = null;
  CQMagic.beginAim(M);                         /* 憑依解除の破壊は演出してから消す */
  const r = CQTurn.reverseAction(M, laneIdx, [layer],
    choice ? { cont: true, choice, interactive: true } : { cont: true, interactive: true });
  const aimed = CQMagic.endAim(M);
  UI.report = null;
  if (UI.mode === 'info') UI.mode = 'idle';   /* 内容を見たあとに開いたら、結果の表示に戻す */
  if (!r.ok) { CQMagic.strikeDoomed(M); flash(r.reason || 'その操作はできません'); renderAll(); return; }
  if (aimed.length) {
    /* 演出中は盤面のクリックを弾く（連鎖と同じ扱い）。終わってから続きへ進む。 */
    UI.mode = 'chain';
    playAimedDestroy(aimed).then(() => { UI.mode = 'idle'; afterFlip(); });
    return;
  }
  return afterFlip();

  function afterFlip() {
  if (M.forcedChain) {
    /* 強制開放・強制転回：1枚ずつの演出が終わってから続きへ進む。
     * 演出中は busy が立っていないので、renderAll() のたびに盤面は触れてしまう。
     * 誤操作を防ぐため UI.mode を 'chain' にして盤面のクリックを弾く。 */
    UI.mode = 'chain';
    playForcedChain().then(() => {
      UI.mode = 'idle';
      if (enterDrawPickIfPending()) return;
      step();
    });
    return;
  }
  if (enterDrawPickIfPending()) return;       /* 予見・口寄せ：引いた札から選ばせる */
  step();
  }
}

/** 強制リバース連鎖（108/109）が起きていたら、めくられたＣＨを**下から順に1枚ずつ**
 * めくれて見えるように演出の目印を仕込む（M6.7 WP1）。
 *
 * エンジンは既に最後まで解決済みで、盤面は最終状態になっている。ここでやるのは
 * 「どのＣＨが何番目に処理されたか」を CSS のアニメーション遅延（--i）に渡すことだけ。
 * ——効果そのものは magic.js が1枚ずつ順に発動させており（中断もそこで起きる）、
 * ここは見た目の担当。**盤面の状態を触らないこと。**
 * 中断された場合は、実際にめくれた枚数ぶんしか steps に入っていないので、
 * 「途中で止まった」ことがそのまま演出に出る。 */
/** 122予見・146口寄せのように**引いた結果を見てから決める**カードは、
 * エンジンが `m.pendingChoice` を残して抜けてくる（`interactive: true` を渡したときだけ）。
 * それを拾って選択画面に入る。選び終えたら `CQMagic.resolvePending()` を呼ぶ。
 * ——ＡＩ・シミュレータは `interactive` を渡さないのでここには来ない（自動解決される）。 */
function enterDrawPickIfPending() {
  if (!M || !M.pendingChoice) return false;
  UI.mode = 'draw-pick';
  renderAll();
  return true;
}

/* 強制リバース連鎖の演出の間合い（2026-08-30 本人指摘：「早すぎて確認できない」）。
 * エンジンが1ビートずつ止まるので、ここで人が読める長さの間を置く。 */
const CHAIN_FLIP_MS = 380;     /* めくるアニメーション自体の長さ（CSS .chain-now と揃える） */
const CHAIN_READ_MS = 750;     /* めくった後、内容を読むための静止 */
const CHAIN_AIM_MS = 700;      /* 「このカードを狙った」を赤枠で見せる長さ */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 連鎖が始まっていたら、最後まで1枚ずつ再生する（M6.7 WP1・2026-08-30 作り直し）。
 *
 * 1枚ぶんの流れ：
 *   flip   … その場で裏返す（**上に動かさない**）→ 読む間だけ静止
 *   effect … 効果を発動。壊す相手が居れば**まだ消さず**赤い枠で見せる
 *   strike … 破壊アニメーションのあと実際に取り除く
 * この1周が終わってから次の1枚に移る。 */
async function playForcedChain() {
  if (!M.forcedChain) return false;
  const kindName = CARD_BY_ID[M.forcedChain.kind].n;
  flash(kindName + '：下から順に1枚ずつ開きます');
  let guard = 0, lastDone = null;
  while (M.forcedChain && guard++ < 64) {
    /* このビートでユニットごと吹き飛んだレーンを見つけるための控え。
     * 呪爆(133)は「連鎖を仕掛けた側」のユニットを壊す＝**強制開放のカードも一緒に消える**。
     * 今までここは何の演出も無く、カードが黙って消えていた（2026-08-30 本人指摘）。 */
    const unitsBefore = M.board.lanes.map((ln) => ln.unit);
    const r = CQMagic.forcedChainStep(M);
    if (r.done) { lastDone = r; break; }
    const wiped = [];
    M.board.lanes.forEach((ln, i) => { if (unitsBefore[i] != null && ln.unit !== unitsBefore[i]) wiped.push(i); });
    /* ★描き直す前に演出する（古いＤＯＭにまだカードが残っているうちに割る） */
    if (wiped.length) await playLaneWipe(wiped);

    if (r.phase === 'flip') {
      /* いまめくった1枚だけに印を付けて、その場でめくるアニメーションを見せる。 */
      UI.chainNow = { lane: r.lane, idx: r.idx };
      renderAll();
      await wait(CHAIN_FLIP_MS + CHAIN_READ_MS);
      UI.chainNow = null;
      continue;
    }

    if (r.phase === 'effect') {
      if (r.aimed && r.aimed.length) {
        /* 狙われたカードは doomed の印が付いているだけでまだ場にある。
         * 赤い枠で「これを狙った」を見せてから、粉々に割れる演出を回す。
         * 実際に取り除くのは次のビート（strike）なので、ここでは割るところまで。
         * ——手で撃ったときと同じ見え方にするため playAimedDestroy と同じ部品を使う。 */
        renderAll();
        await wait(CHAIN_AIM_MS);
        await Promise.all(r.aimed.map((a) => {
          const el = document.querySelector(
            `#board .card.ch[data-lane="${a.lane}"][data-layer="${a.idx + 1}"]`);
          return el ? shatterEffect(el, { height: chVisibleHeight(el) }) : Promise.resolve();
        }));
      } else if (r.summoned && r.summoned.lane != null) {
        /* めくられたユニットが分離してリバース召還された（2026-08-31 本人指摘の修正）。
         * 出てきたユニットに召還と同じ入場アニメーションを付け、読める間を置く。 */
        renderAll();
        const el = document.querySelector(`#board .card.unit[data-lane="${r.summoned.lane}"]`);
        if (el) el.classList.add('an-in');
        flash('リバース召還：' + (CARD_BY_ID[r.summoned.card] ? CARD_BY_ID[r.summoned.card].n : ''));
        await wait(700);
      } else {
        renderAll();
        await wait(260);
      }
      continue;
    }

    /* strike：実際に取り除かれた後の盤面 */
    renderAll();
    await wait(200);
  }
  UI.chainNow = null;
  /* ★連鎖の終わり：この連鎖が表にした魔法と、役目を終えた強制開放カード自身が消える
   * （2026-08-31 本人指摘。原作§1-8⑤の魔法消去）。エンジンは doomed の印を付けて
   * 待っているので、赤枠→粉々を見せてから strikeDoomed で実際に取り除く。 */
  if (lastDone && lastDone.expired && lastDone.expired.length) {
    renderAll();                                   /* 赤枠が出る */
    await wait(AIM_SHOW_MS);
    await Promise.all(lastDone.expired.map((a) => {
      const el = document.querySelector(
        `#board .card.ch[data-lane="${a.lane}"][data-layer="${a.idx + 1}"]`);
      return el ? shatterEffect(el, { height: chVisibleHeight(el) }) : Promise.resolve();
    }));
    CQMagic.strikeDoomed(M);
  }
  const fc = M.lastForcedChain;
  if (fc) {
    flash(kindName + '：' + fc.steps.length + '枚'
      + (fc.aborted ? 'で中断（' + fc.aborted + '）' : 'を処理しました'));
  }
  renderAll();
  return true;
}

/** 開こうとしているカードが「対象を選ぶ」型なら、選ばせるモードに入る。
 * 呼べる状況でなければ false を返す（呼び出し元はそのまま通常どおり開く処理を続ける）。
 *
 * ★M6.7 WP5：候補の列挙はすべてエンジン（CQMagic.targetsFor）に移した。
 * ここは「候補を貰って光らせ、選ばせて choice を返す」だけ＝**カードが増えても
 * この関数に書き足す必要が無い**。対応するカードを増やすときは magic.js の
 * targetsFor に足し、下の PICK_MSG に案内文を1行足せばよい。
 *
 * 中身を知らないカードは選ばせない（伏せたまま開いたら、従来どおりエンジンが自動で選ぶ
 * ——そのときも憑依解除なら赤枠→粉々の演出が入る）。 */
function tryStartDestroyPick(laneIdx, layer, ch, resume) {
  if (!ch || !chKnown(ch)) return false;               /* 中身を知らないカードは選ばせない */
  if (typeof CQMagic.targetsFor !== 'function') return false;
  const ctx = { laneIndex: laneIdx, layer: layer, caster: ch.mine ? 'self' : 'enemy' };
  /* 魔法（magic.js）とユニット固有能力（units.js・M6.7 WP6）は同じ形の候補を返す。
   * ユニットカードを開くと「開：」能力が先に解決されるので、そちらも同じ口で選ばせる。 */
  const spec = CQMagic.targetsFor(M, ch.card, ctx)
    || (typeof CQUnits.targetsFor === 'function' ? CQUnits.targetsFor(M, ch.card, ctx) : null);
  if (!spec) return false;
  return startPick({ card: ch.card, kind: spec.kind, need: spec.need,
    targets: spec.targets, resume: resume });
}

/** 特殊行動（Ｃ型ユニット固有能力）で対象を選ばせる。選ばせたら true（M6.7 WP6）。 */
function tryStartSpecialPick(laneIdx, resume) {
  const ln = M.board.lanes[laneIdx];
  if (!ln || ln.unit == null) return false;
  if (typeof CQUnits.targetsFor !== 'function') return false;
  const spec = CQUnits.targetsFor(M, ln.unit, {
    laneIndex: laneIdx, caster: CQState.controlSide(ln, laneIdx)
  });
  if (!spec) return false;
  return startPick({ card: ln.unit, kind: spec.kind, need: spec.need,
    targets: spec.targets, resume: resume });
}

/* ================= 生贄召還の確認（v0.15.3） =================
 * 召還Ｌｖ2以上のユニットカードをリバースすると、ホストを生贄に捧げて召還するか、
 * 儀式が成立せずそのカードが破壊されるかのどちらかになる。どちらも取り返しがつかないので、
 * 開く前に何が起きるかを提示する。
 * **介入するのは「自分に中身が見えているカード」だけ**（chKnown）。相手が置いた裏向きカードでは
 * 確認が出ない＝ＵＩが中身を知っていることが漏れない（憑依解除(101)の対象選択と同じ考え方）。 */
const RITUAL_NG = {
  ritualCombat: '戦闘中は生贄の儀式ができません。',
  ritualFoe: '相手が操作しているユニットは生贄にできません。',
  ritualSalvation: '救済に守られたユニットは生贄にできません。',
  nospace: '自分の場に空きレーンがありません。'
};
function tryConfirmRitual(laneIdx, layer, ch, resume) {
  if (!ch || ch.up || !chKnown(ch)) return false;
  const card = CARD_BY_ID[ch.card];
  if (!card || card.t !== 'U') return false;
  const lv = CQState.unitStats(card).lv;
  if (lv < 2) return false;                                  /* Ｌｖ1は従来どおり＝確認は不要 */
  const ln = M.board.lanes[laneIdx];
  if (!ln || ln.unit == null) return false;
  const hostName = (CARD_BY_ID[ln.unit] || {}).n || 'ユニット';
  const acc = ln.acc || {};
  let q, body;
  if (acc.resist >= 1) {
    q = `${card.n} は破壊されます`;
    body = '抵抗が付いているため、出てこようとしたユニットカードは破壊されます。';
  } else if (acc.fusion >= 1) {
    q = `${card.n} は潜行したまま残ります`;
    body = '融合が付いているため、場には出ずチャネリングのまま留まります。';
  } else if (layer < lv - (acc.tome || 0)) {
    q = `${card.n} は破壊されます`;
    body = `召還レベルが足りません（${lv - (acc.tome || 0)}階層目以上に潜っている必要があります）。`;
  } else {
    const rit = CQCombat.ritualCheck(M, laneIdx, ch.mine ? 'self' : 'enemy');
    if (!rit.ok) {
      q = `${card.n} は召還できず破壊されます`;
      body = (RITUAL_NG[rit.result] || '生贄の儀式が成立しません。')
        + '<br>召還Ｌｖ2以上のユニットは、ホストを生贄に捧げないと場に出られません。';
    } else {
      const carried = layer - 1, upper = ln.channels.length - layer;
      q = `${hostName} を生贄に ${card.n} を召還しますか？`;
      body = `${hostName} は破壊されます（ＬＰは減りません）。`
        + `<br>下に積まれた <b>${carried}枚</b> は ${card.n} に引き継がれます。`
        + (upper > 0 ? `<br>上に積まれた <b>${upper}枚</b> は一緒に破壊されます。` : '');
    }
  }
  UI.pending = { kind: 'run', run: resume };
  UI.mode = 'confirm';
  paint(miniCardHTML(card) + askHTML(q, body, 'warn'), okBtn('開く') + ngBtn(), true);
  return true;
}

function doPending() {
  /* kind:'run' … 確認のあとに実行する処理を関数ごと預かる形（生贄召還の確認で使う）。
     預けた関数が自分で markLog/markFx を呼ぶので、ここでは二重に呼ばない */
  const pr = UI.pending;
  if (pr && pr.kind === 'run') {
    UI.pending = null;
    UI.mode = 'idle'; UI.lane = null; UI.layers = []; UI.report = null;
    return pr.run();
  }
  markLog(); markFx();
  const p = UI.pending;
  UI.pending = null;
  if (!p) return;
  let r = { ok: true };
  if (p.kind === 'change') r = CQTurn.change(M);
  else if (p.kind === 'discard') r = CQTurn.discardCard(M, p.handIdx);
  else if (p.kind === 'pest-discard') r = CQTurn.discardPest(M, p.handIdx);
  else if (p.kind === 'deck-attack') r = CQCombat.deckAttack(M, p.lane);
  else if (p.kind === 'special-action') r = CQTurn.specialAction(M, p.lane, { choice: p.choice });
  UI.mode = 'idle'; UI.lane = null; UI.layers = []; UI.report = null;
  if (!r.ok) { flash(r.reason || 'その操作はできません'); renderAll(); return; }
  step();
}

/** 引いた札から選ぶ（122予見・146口寄せ）の確定。M6.7 WP3。
 * 口寄せで「捨ててもう1枚」を選ぶと、エンジンがもう1枚めくって選択待ちのまま返してくる
 * （pending が残る）。その場合は画面を描き直して、同じ画面で選び続ける。 */
function resolveDrawPick(action) {
  markLog(); markFx();
  /* 選択が済むと、使い終わった予見・口寄せのカードが破壊される（2026-08-31 の新原則）。
   * 他の破壊と同じく赤枠→粉々で見せてから消す。 */
  CQMagic.beginAim(M);
  const r = CQMagic.resolvePending(M, action);
  const aimed = CQMagic.endAim(M);
  if (!r || !r.ok) { CQMagic.strikeDoomed(M); flash((r && r.reason) || 'その操作はできません'); return renderAll(); }
  if (M.pendingChoice) { CQMagic.strikeDoomed(M); return renderAll(); }   /* まだ選択が続く（口寄せの引き直し） */
  UI.mode = 'idle';
  if (aimed.length) { UI.mode = 'chain'; playAimedDestroy(aimed).then(() => { UI.mode = 'idle'; step(); }); return; }
  step();
}

function panelAct(act, data) {
  /* M7.9 第2段 B4：巻き戻し中は、その操作だけを受け付ける */
  if (UI.mode === 'replay') {
    if (act === 'replay-prev') return replayShow(REPLAY.idx - 1);
    if (act === 'replay-next') return replayShow(REPLAY.idx + 1);
    if (act === 'replay-exit') return replayExit();
    return;
  }
  if (act === 'replay') return replayEnter();
  if (busy) return;                                  /* 演出中は操作を受け付けない */
  switch (act) {
    /* M6.7 WP3：引いた札から選ぶ。予見はカードそのもの、口寄せは2つのボタン。
     * どれも情報パネルの中にあるので、盤面のクリック経路ではなくここへ来る。 */
    /* M6.7 WP5：暗殺(114)は相手の手札から選ぶ。情報パネルの中なのでここへ来る。 */
    case 'pick-hand': {
      const p = UI.pick;
      if (!p) return;
      const resume = p.resume;
      UI.mode = 'idle'; UI.pick = null;
      if (resume) resume({ handIndex: +data.i });
      return;
    }
    case 'draw-pick': return resolveDrawPick({ pick: +data.i });
    case 'draw-keep': return resolveDrawPick({ keep: true });
    case 'draw-skip': return resolveDrawPick({ keep: false });
    case 'ok': return doPending();
    case 'cancel':
      UI.pending = null; UI.mode = 'idle'; UI.lane = null; UI.layers = [];
      return renderAll();
    case 'new': return newMatch();
    /* 2026-08-29：フリーバトルの決着後「バトルを終える」→ フリーバトルのトップへ戻る。
     * RUN_ACTIVE の戦闘には出ないボタンなので、run-over のような後始末は不要。 */
    case 'free-end':
      renderFreeSetup();
      showScreen('screen-free');
      return;
    case 'run-over': {                                  /* ラン中の戦闘決着 → ランの画面へ戻る */
      const m = M, hook = runOverHook;
      RUN_ACTIVE = false; runOverHook = null;
      if (hook) hook(m);
      return;
    }
    /* M6.6 WP12：逃げる。成功なら対局はそこで終わり（勝敗は付かない）、
     * 失敗ならＬＰ−1を払ってそのまま続行する。 */
    case 'flee': {
      markLog();
      const r = CQTurn.flee(M);
      if (!r.ok) { flash(r.reason); return; }
      if (r.escaped) { flash('逃げきった'); return step(); }
      flash('逃げそこねた（ＬＰ−' + CQTurn.FLEE_LP_COST + '）');
      return step();
    }
    /* M6.6 WP12：諦める。ＬＰを0にして通常の敗北と同じ経路に乗せる＝清算はゲームオーバー
     * （▲75%）。リタイヤ（▲50%）とは別物なので、確認ダイアログでその差を明示する。 */
    case 'give-up':
      showConfirm(
        'この探検をここで終えます。\nゲームオーバー扱いになり、集めたＧの75%を失います。\nよろしいですか？',
        function () {
          markLog();
          CQTurn.resign(M, 'self');
          step();
        }, '諦める');
      return;
    case 'mode':
      foeAuto = !foeAuto;
      flash(foeAuto ? '相手を自動で動かします' : '相手もあなたが操作します');
      return step();
    case 'rank': {                                     /* 相手ＡＩの強さ切替（M5） */
      aiRank = AI_RANKS[(AI_RANKS.indexOf(aiRank) + 1) % AI_RANKS.length];
      if (M) M.aiConfig = { enemy: CQAi.PRESETS[aiRank] };
      flash('相手の強さ：' + CQAi.PRESETS[aiRank].label + '（次の手番から反映）');
      return renderAll();
    }
    case 'field': {                                    /* 戦場ルールの切替（M6。次の対戦から） */
      fieldSet = (fieldSet + 1) % FIELD_SETS.length;
      flash('戦場ルール：' + FIELD_SETS[fieldSet].label + '（「新しい対戦」から反映）');
      return renderAll();
    }
    case 'field-info':                                 /* 有効な戦場ルールの説明を出す */
      UI.mode = 'field';
      return renderAll();
    case 'attack':
      UI.mode = 'attack'; UI.targets = CQCombat.attackTargets(M, UI.lane);
      return renderAll();
    case 'deck-attack':
      UI.pending = { kind: 'deck-attack', lane: UI.lane };
      return doPending();
    case 'special-action': {                            /* Ｃ型ユニット固有能力（M4 v0.14） */
      const lane = UI.lane;
      /* M6.7 WP6：対象を選ぶ能力なら先に選ばせる（選ぶ余地が無ければそのまま実行） */
      if (tryStartSpecialPick(lane, (choice) => {
        UI.pending = { kind: 'special-action', lane: lane, choice: choice };
        doPending();
      })) return;
      UI.pending = { kind: 'special-action', lane: lane };
      return doPending();
    }
    case 'close-ch':                                  /* 表の技能を閉じる（情報パネルのボタン） */
      return doFlip(+data.lane, +data.layer);
    case 'open-end':
      markLog(); markFx();
      CQCombat.endOpen(M);
      return step();
    case 'end-place':
      markLog();
      CQTurn.endPlacement(M); UI.report = null;
      return step();
    case 'end-turn':
      markLog(); markFx();
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
  if (busy) return;                                  /* 演出中は操作を受け付けない */
  if (UI.mode === 'replay') return;                  /* 巻き戻し中は盤面に触れない（右のボタンだけ） */
  /* 前のドラッグが何らかの理由で残っていたら、まず片付ける（保険） */
  if (drag) { clearDragVisuals(drag); drag = null; }
  /* 岩でふさがれた列（2026-09-05）：岩を押したら戦場ルールの説明を出す（蓋と同じ） */
  if (ev.target.closest('.lane-rocks')) { UI.mode = 'field'; return renderAll(); }
  const el = ev.target.closest('.card');
  if (!el) return;
  if (el.id === 'change-card') { if (canChange()) showChangeConfirm(); return; }
  /* M6 戦場ルール：使用不可レーンの蓋を押したら、そのルールの説明を出す */
  if (el.classList.contains('lane-lid')) { UI.mode = 'field'; return renderAll(); }

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

  /* 憑依解除(101)：破壊する対象を選んでいる最中。光っているＣＨを押したら確定する
     （2026-08-24 本人の指定）。それ以外を押しても何も起きない（選ぶまで先に進めない） */
  /* 強制リバース連鎖の演出中はいっさい受け付けない（M6.7 WP1）。 */
  if (UI.mode === 'chain') return;
  /* 引いた札から選ぶ最中（122予見・146口寄せ）は、選ぶまで盤面の操作を受け付けない。
   * 選ぶ操作そのものは情報パネルの中で行う（panelAct の draw-pick/keep/skip）。 */
  if (UI.mode === 'draw-pick') {
    flash('右のパネルでカードを選んでください');
    return;
  }
  if (UI.mode === 'pick-target' && UI.pick) {
    const p = UI.pick;
    const finish = (choice) => {
      const resume = p.resume;
      UI.mode = 'idle'; UI.pick = null;
      if (resume) resume(choice);
    };
    if (p.kind === 'lane') {
      /* レーンのどこを押しても、そのレーンが候補なら決定（ユニット枠でもＣＨでもよい） */
      const i = el.dataset.lane !== undefined ? +el.dataset.lane : null;
      if (i != null && p.targets.indexOf(i) >= 0) return finish({ lane: i });
      flash('光っているユニットから対象を選んでください');
      return;
    }
    if (p.kind === 'layer') {
      /* 菊一文字(131)：押したカードの「階層」が対象。どのレーンのものでもよい。 */
      if (el.classList.contains('pick') && el.dataset.layer !== undefined) {
        return finish({ layer: +el.dataset.layer });
      }
      flash('光っているカードから階層を選んでください');
      return;
    }
    if (el.classList.contains('pick') && el.dataset.lane !== undefined && el.dataset.layer !== undefined) {
      p.chosen.push({ lane: +el.dataset.lane, idx: +el.dataset.layer - 1 });
      if (p.chosen.length >= p.need) {
        /* 1枚だけのカード（101）は従来どおり {lane,idx} を渡す。
           複数選ぶカード（113）は {picks:[…]} で渡す——magic.js 側がこの形を読む。 */
        return finish(p.need === 1 ? p.chosen[0] : { picks: p.chosen.slice() });
      }
      flash('あと' + (p.need - p.chosen.length) + '枚選んでください');
      renderAll();
      return;
    }
    flash('光っているカードから選んでください');
    return;
  }
  /* 戦闘中：▶付きのカードの左半分を押したら、その階層をそのまま開く */
  if (humanOpening() && el.classList.contains('openable') && !wantInfo) {
    const layer = +el.dataset.layer;
    const laneIdx = CQCombat.openerLane(M);
    const ch = M.board.lanes[laneIdx].channels[layer - 1];
    /* 戦闘中のオープンも doFlip と同じ流れ（憑依解除の破壊は赤枠→粉々を挟んでから消す）。 */
    const doOpen = (choice) => {
      markLog(); markFx();
      M.lastForcedChain = null;
      CQMagic.beginAim(M);
      const r = CQCombat.open(M, layer, choice ? { choice, interactive: true } : { interactive: true });
      const aimed = CQMagic.endAim(M);
      if (!r.ok) { CQMagic.strikeDoomed(M); flash(r.reason); }
      const next = () => {
        if (M.forcedChain) { UI.mode = 'chain'; playForcedChain().then(() => { UI.mode = 'idle'; if (!enterDrawPickIfPending()) step(); }); return; }
        if (enterDrawPickIfPending()) return;
        step();
      };
      if (aimed.length) { UI.mode = 'chain'; playAimedDestroy(aimed).then(() => { UI.mode = 'idle'; next(); }); return; }
      next();
    };
    if (tryStartDestroyPick(laneIdx, layer, ch, doOpen)) return;
    const openNow = () => doOpen(null);
    if (tryConfirmRitual(laneIdx, layer, ch, openNow)) return;   /* 生贄召還の確認（v0.15.3） */
    return openNow();
  }
  /* 攻撃対象を選んでいる最中（行動メニュー経由）：対象を押したら即攻撃 */
  if (UI.mode === 'attack' && el.dataset.lane !== undefined) {
    const i = +el.dataset.lane;
    if (UI.targets.indexOf(i) >= 0) return doAttack(UI.lane, i);
  }
  /* メインステップ：▶の付いた裏向きカードの左半分を押したら、その階層を直接開く */
  if (el.classList.contains('flippable') && !wantInfo) {
    const laneIdx = +el.dataset.lane, layer = +el.dataset.layer;
    const ch = M.board.lanes[laneIdx].channels[layer - 1];
    if (tryStartDestroyPick(laneIdx, layer, ch, (choice) => doFlip(laneIdx, layer, choice))) return;
    if (tryConfirmRitual(laneIdx, layer, ch, () => doFlip(laneIdx, layer))) return;  /* v0.15.3 */
    return doFlip(laneIdx, layer);
  }
  if (el.classList.contains('empty-unit')) return;

  if (el.classList.contains('hand-card')) {
    if (humanSide() !== M.active || M.combat) { showCardInfo(el); return; }
    if (M.phase === 'discard') { showDiscardConfirm(+el.dataset.hand); return; }
    if (M.phase !== 'placement') { showCardInfo(el); return; }   /* 置けるのは配置ステップだけ */
    /* M6 戦場ルール：おじゃま虫は場に置けないので、ドラッグではなく「捨てる」確認を出す */
    if (CQField.isPest(+el.dataset.card)) { showPestDiscardConfirm(+el.dataset.hand); return; }
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
        /* カードを置けるのは配置ステップだけ（2026-08-24 本人の指定） */
        const ok = M.phase === 'placement' && (ln.unit != null
          ? (full ? ln.channels.length > 0 : true)
          : (mine && c.t === 'U'));
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
/* 2026-08-29：ここにあった起動時の newMatch() は廃止した。
 * バトル画面は「フリーバトル」かラン中の戦闘からしか入らなくなり、どちらも自分で
 * 対戦（M）を組み立てる。起動時に作ってしまうと、いまは newMatch＝フリーバトル開始なので
 * アプリを開いた瞬間に戦闘画面へ飛んでしまう。 */

/* ================= デッキ編集画面（v0.3から変更なし） ================= */
const ALL_COLS = {
  U: [
    /* ＩＤ列は既定で隠す（2026-08-29 本人指定）。「表示する列」で出すと、カード名の左に
     * ＩＤが並び、≧／≦の絞り込み欄でＩＤを直接指定して1枚を素早く引ける。
     * デバッグ用途（仕様書・開発メモがカードをＩＤで指すため）なので既定はオフ。 */
    { k: 'id',  label: 'ＩＤ',      w: 104, type: 'range', def: false },
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
    { k: 'id',  label: 'ＩＤ',      w: 104, type: 'range', def: false },   /* 同上 */
    { k: 'n',   label: 'カード名',  w: 220, type: 'text',  fixed: true, def: true },
    /* M6.7 WP2：魔法の詠唱Ｌｖ（技能は持たないので空欄になる）。**既定で表示する**
     * ——配置した階層がこの数字未満だと魔法は不発になるので、デッキを組むときに
     * 見えていないと「なぜか発動しない」が起きる。 */
    { k: 'lv',  label: '詠唱Ｌｖ',  w: 96,  type: 'range', def: true },
    { k: 'e',   label: '効果',      w: 0,   type: 'text',  def: true },
    { k: 'p',   label: '価格',      w: 100, type: 'range', def: false },
    { k: 'cnt', label: '採用',      w: 122, type: 'count', fixed: true, def: true }
  ]
};
const shown = { U: {}, MS: {} };
Object.keys(ALL_COLS).forEach((g) => ALL_COLS[g].forEach((c) => { shown[g][c.k] = c.def; }));


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
    `<span>魔法 <b>${m}</b></span><span>技能 <b>${k}</b></span><span>合計 <b>${u + m + k}</b>／${CQTurn.DECK_SIZE}</span>`;
}
function renderDetail() {
  const c = CARD_BY_ID[selectedId];
  const stat = c.t === 'U'
    ? `<span>攻撃力 ${c.a}</span><span>防御力 ${c.d}</span>
       <span>ＣＨ ${c.ch}</span><span>召還Ｌｖ ${c.lv}</span><span>${c.p} G</span>`
    : `<span>${TYPE_NAME[c.t]}</span>${c.t === 'M' ? `<span>詠唱Ｌｖ ${c.lv}</span>` : ''}<span>${c.p} G</span>`;
  document.getElementById('detail').innerHTML = `
    <div class="big ${c.t}">
      <div class="bigart">${artInner(c)}</div>
      <div class="bn">${c.n}</div>
      <div class="bstat">${stat}</div>
      <div class="btext">${c.e || ''}</div>
      ${cardCondHTML(c)}
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
  if (plus) {
    const id = +plus.dataset.plus; deck[id] = Math.min(3, (deck[id] || 0) + 1);
    saveDebugDeck();                       /* 組んだ内容を残す（フリーバトルで使う） */
    return renderBody();
  }
  const minus = ev.target.closest('[data-minus]');
  if (minus) {
    const id = +minus.dataset.minus;
    deck[id] = (deck[id] || 0) - 1; if (deck[id] <= 0) delete deck[id];
    saveDebugDeck();
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
/* デッキ編集画面からの戻り道（タブが「ラン」固定になったので明示的に置いてある） */
document.querySelectorAll('.deck-back').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.back === 'screen-free') renderFreeSetup();
    showScreen(b.dataset.back);
  });
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
