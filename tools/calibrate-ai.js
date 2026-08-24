/* CardQuest — 敵ＡＩの勝率較正（開発用。実装計画M5）
 *
 *   node tools/calibrate-ai.js [試行回数]
 *
 * 評価関数ＡＩ（js/engine/ai.js の PRESETS）を、ランダム方策と、評価関数同士で
 * 対戦させて勝率・平均手番を計測する。エリア難易度（M6〜M8）の初期値を決めるための
 * 基礎データ。デッキは両陣営とも同じ検証用プール（tools/simulate.js と同じ）から
 * ランダムに組むので、数値は「方策の差」だけを表す。
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
  while (deck.length < 50) deck.push(POOL[rng.int(0, POOL.length - 1)]);
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

function series(label, cfg, N, evalSide) {
  let w = 0, l = 0, d = 0, turns = 0, errs = 0;
  for (let seed = 1; seed <= N; seed++) {
    try {
      const rng = CQRng.create(seed);
      const m = CQTurn.createMatch({
        cards: CARD_BY_ID, rng: rng,
        selfDeck: makeDeck(rng), enemyDeck: makeDeck(rng),
        first: rng.next() < 0.5 ? 'self' : 'enemy',
        opponentId: 101, hooks: HOOKS
      });
      m.aiConfig = cfg;
      let g = 0;
      while (!m.winner && m.turn < 120 && g++ < 5000) playTurn(m);
      if (m.winner === evalSide) w += 1; else if (m.winner) l += 1; else d += 1;
      turns += m.turn;
    } catch (e) { errs += 1; }
  }
  const rate = (100 * w / Math.max(1, w + l)).toFixed(1);
  console.log(label + '： ' + w + '勝 ' + l + '敗 ' + d + '分 ＝ 勝率 ' + rate +
    '% ／ 平均 ' + (turns / N).toFixed(1) + ' 手番' + (errs ? ' ／ 例外 ' + errs + ' 件' : ''));
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

const N = parseInt(process.argv[2], 10) || 500;
console.log('=== 評価関数ＡＩ vs ランダム方策（' + N + '戦ずつ） ===');
series('フリー   vs ランダム', { enemy: CQAi.PRESETS.free }, N, 'enemy');
series('ランクＣ vs ランダム', { enemy: CQAi.PRESETS.rankC }, N, 'enemy');
series('ランクＢ vs ランダム', { enemy: CQAi.PRESETS.rankB }, N, 'enemy');
series('ランクＡ vs ランダム', { enemy: CQAi.PRESETS.rankA }, N, 'enemy');
console.log('=== 評価関数ＡＩ同士 ===');
series('フリー   vs ランクＣ', { self: CQAi.PRESETS.rankC, enemy: CQAi.PRESETS.free }, N, 'enemy');
firstSeries('ランクＣ同士（先手の有利）', { self: CQAi.PRESETS.rankC, enemy: CQAi.PRESETS.rankC }, N);
