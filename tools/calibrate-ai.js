/* CardQuest — 敵ＡＩの勝率較正（開発用。実装計画M5→M5.7で拡張）
 *
 *   node tools/calibrate-ai.js [試行回数] [部分]
 *     部分: all（既定）／ladder（段差）／vs（対heuristic・対random）／first（先手）／time（実測時間）
 *
 * M5.7の較正項目（『実装計画追補 M5.7』§5）：
 *   1. 段差の検証 … free/C/B/A の総当たりで、旧透視方式では対ＡＩで消えていた
 *      C/B/A 間の差が「読みの深さ・サンプル数の差」として出ることを確認する
 *   2. 絶対強度 … 各ランク vs heuristic（M5の旧評価関数方策＝旧ランクＣ相当）と vs random
 *   3. 先手勝率 … search 化で72%問題が変化するか再計測
 *   4. 実測時間 … 1手の思考時間（平均・最悪）。budgetMs と N/D の妥当性確認
 * デッキは両陣営とも同じ検証用プールからランダムに組むので、数値は「方策の差」だけを表す。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'js/data.js'), 'utf8')
  .replace(/const (CARDS|CARD_BY_ID|DECKS)\b/g, 'var $1'), ctx);
const CARD_BY_ID = ctx.CARD_BY_ID;

const CQRng = require(path.join(root, 'js/engine/rng.js'));
const CQTurn = require(path.join(root, 'js/engine/turn.js'));
const CQMagic = require(path.join(root, 'js/engine/effects/magic.js'));
const CQUnits = require(path.join(root, 'js/engine/effects/units.js'));
const CQAi = require(path.join(root, 'js/engine/ai.js'));
const HOOKS = { onMagicOpen: CQMagic.onMagicOpen, onUnitOpen: CQUnits.onUnitOpen };

const POOL = [8, 1, 2, 5, 7, 19, 21, 46, 47, 61, 63, 65, 66, 71, 20, 22, 55,
  151, 152, 154, 158, 165, 167, 169, 171, 172, 173, 176, 177, 178, 179, 181, 183, 184, 186, 197, 199,
  101, 104, 110, 113, 117, 130, 135, 136, 143, 145, 3, 9, 10, 31, 70, 180];
function makeDeck(rng) {
  const deck = [];
  while (deck.length < CQTurn.DECK_SIZE) deck.push(POOL[rng.int(0, POOL.length - 1)]);
  return deck;
}

function playTurn(m) {
  CQTurn.beginTurn(m);
  if (m.winner) return;
  let g = 0;
  while (m.phase === 'discard' && g++ < 20) CQAi.discardStep(m);
  if (m.phase === 'placement') { CQAi.playPlacement(m); CQTurn.endPlacement(m); }
  g = 0;
  while (m.phase === 'main' && g++ < 20) {
    if (!CQAi.mainStep(m)) break;
    CQAi.finishCombat(m);
  }
  if (m.phase === 'main') CQTurn.endTurn(m);
}

/** search 方策の1手ごとの計測値（m._searchStats）を収集するプローブ */
function attachProbe(m, sink) {
  let cur = null;
  Object.defineProperty(m, '_searchStats', {
    configurable: true,
    get() { return cur; },
    set(v) { cur = v; if (sink) sink.push(v); }
  });
}

function runOne(seed, cfg, probeSink) {
  const rng = CQRng.create(seed);
  const m = CQTurn.createMatch({
    cards: CARD_BY_ID, rng: rng,
    selfDeck: makeDeck(rng), enemyDeck: makeDeck(rng),
    first: rng.next() < 0.5 ? 'self' : 'enemy',
    opponentId: 101, hooks: HOOKS
  });
  m.aiConfig = cfg;
  if (probeSink) attachProbe(m, probeSink);
  let g = 0;
  while (!m.winner && m.turn < 120 && g++ < 5000) playTurn(m);
  return m;
}

function series(label, cfg, N, evalSide, seedBase) {
  let w = 0, l = 0, d = 0, turns = 0, errs = 0;
  for (let seed = 1; seed <= N; seed++) {
    try {
      const m = runOne(seed + (seedBase || 0), cfg);
      if (m.winner === evalSide) w += 1; else if (m.winner) l += 1; else d += 1;
      turns += m.turn;
    } catch (e) { errs += 1; }
  }
  const rate = (100 * w / Math.max(1, w + l)).toFixed(1);
  console.log(label + '： ' + w + '勝 ' + l + '敗 ' + d + '分 ＝ 勝率 ' + rate +
    '% ／ 平均 ' + (turns / N).toFixed(1) + ' 手番' + (errs ? ' ／ 例外 ' + errs + ' 件' : ''));
  return +rate;
}

function firstSeries(label, cfg, N) {
  let fw = 0, sw = 0;
  for (let seed = 1; seed <= N; seed++) {
    const rng = CQRng.create(seed + 90000);
    const first = rng.next() < 0.5 ? 'self' : 'enemy';
    const m = CQTurn.createMatch({
      cards: CARD_BY_ID, rng: rng,
      selfDeck: makeDeck(rng), enemyDeck: makeDeck(rng),
      first: first, opponentId: 101, hooks: HOOKS
    });
    m.aiConfig = cfg;
    let g = 0;
    while (!m.winner && m.turn < 120 && g++ < 5000) playTurn(m);
    if (m.winner === first) fw += 1; else if (m.winner) sw += 1;
  }
  console.log(label + '： 先手 ' + fw + '勝 / 後手 ' + sw + '勝（先手勝率 ' +
    (100 * fw / Math.max(1, fw + sw)).toFixed(1) + '%）');
}

function timeSeries(label, preset, N) {
  const sink = [];
  for (let seed = 1; seed <= N; seed++) {
    runOne(seed + 70000, { self: CQAi.PRESETS[preset], enemy: CQAi.PRESETS[preset] }, sink);
  }
  const done = sink.filter((s) => s && s.ms !== undefined);
  if (!done.length) { console.log(label + '：計測なし'); return; }
  let sum = 0, max = 0, sSum = 0;
  done.forEach((s) => { sum += s.ms; if (s.ms > max) max = s.ms; sSum += s.samples; });
  console.log(label + '： 1手平均 ' + (sum / done.length).toFixed(1) + 'ms ／ 最悪 ' + max +
    'ms ／ 平均サンプル ' + (sSum / done.length).toFixed(1) + ' 世界 ／ 決定 ' + done.length + ' 回');
}

const N = parseInt(process.argv[2], 10) || 300;
const part = process.argv[3] || 'all';
const P = CQAi.PRESETS;

if (part === 'all' || part === 'vs') {
  console.log('=== 各ランク vs heuristic（M5の旧評価関数＝旧ランクＣ相当。各' + N + '戦） ===');
  series('フリー   vs heuristic', { self: P.heuristic, enemy: P.free }, N, 'enemy');
  series('ランクＣ vs heuristic', { self: P.heuristic, enemy: P.rankC }, N, 'enemy');
  series('ランクＢ vs heuristic', { self: P.heuristic, enemy: P.rankB }, N, 'enemy');
  series('ランクＡ vs heuristic', { self: P.heuristic, enemy: P.rankA }, N, 'enemy');
  console.log('=== 対ランダム（絶対強度の下限確認） ===');
  series('ランクＣ vs ランダム', { enemy: P.rankC }, N, 'enemy');
}
if (part === 'all' || part === 'ladder') {
  console.log('=== 段差の検証（search同士の総当たり。各' + N + '戦） ===');
  series('フリー   vs ランクＣ', { self: P.rankC, enemy: P.free }, N, 'enemy');
  series('ランクＣ vs ランクＢ', { self: P.rankB, enemy: P.rankC }, N, 'enemy');
  series('ランクＢ vs ランクＡ', { self: P.rankA, enemy: P.rankB }, N, 'enemy');
  series('ランクＣ vs ランクＡ', { self: P.rankA, enemy: P.rankC }, N, 'enemy');
}
if (part === 'all' || part === 'first') {
  console.log('=== 先手の有利（search 化での再計測） ===');
  firstSeries('ランクＣ同士（先手の有利）', { self: P.rankC, enemy: P.rankC }, N);
}
if (part === 'all' || part === 'time') {
  console.log('=== 1手の実測時間（このマシンでの参考値。実機はタブレットで別途計測） ===');
  const tn = Math.max(3, Math.min(10, Math.floor(N / 30)));
  timeSeries('フリー  ', 'free', tn);
  timeSeries('ランクＣ', 'rankC', tn);
  timeSeries('ランクＢ', 'rankB', tn);
  timeSeries('ランクＡ', 'rankA', tn);
}
