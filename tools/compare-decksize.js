/* CardQuest — デッキ枚数の比較較正（開発用。実装計画M5.5）
 *
 *   node tools/compare-decksize.js [試行回数]
 *
 * デッキ枚数 50／40／30 のそれぞれで評価関数ＡＩ（rankC）同士を対戦させ、
 * 平均手番数・先手勝率・山札再装填の発生率・膠着率（ターン上限到達）を比べる。
 * 「40枚（仮値）」の妥当性を判断するための基礎データ（ゲーム仕様書§4.1）。
 * デッキは tools/simulate.js と同じ検証用プールからランダムに組む。
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

function makeDeck(rng, size) {
  const deck = [];
  while (deck.length < size) deck.push(POOL[rng.int(0, POOL.length - 1)]);
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

const MAX_TURNS = 120;

function series(size, N) {
  let firstWin = 0, decided = 0, stall = 0, turns = 0, reloads = 0, reloadGames = 0, errs = 0;
  for (let seed = 1; seed <= N; seed++) {
    try {
      const rng = CQRng.create(seed * 7 + size);   // サイズごとに独立したシード列
      const first = rng.next() < 0.5 ? 'self' : 'enemy';
      const m = CQTurn.createMatch({
        cards: CARD_BY_ID, rng: rng,
        selfDeck: makeDeck(rng, size), enemyDeck: makeDeck(rng, size),
        first: first, opponentId: 101, hooks: HOOKS
      });
      m.aiConfig = { self: CQAi.PRESETS.rankC, enemy: CQAi.PRESETS.rankC };
      let g = 0;
      while (!m.winner && m.turn < MAX_TURNS && g++ < 5000) playTurn(m);
      turns += m.turn;
      const rl = m.players.self.reloads + m.players.enemy.reloads;
      reloads += rl;
      if (rl > 0) reloadGames += 1;
      if (m.winner) { decided += 1; if (m.winner === first) firstWin += 1; }
      else stall += 1;
    } catch (e) { errs += 1; }
  }
  console.log(size + '枚: 平均' + (turns / N).toFixed(1) + '手番'
    + '  先手勝率' + (decided ? (100 * firstWin / decided).toFixed(1) : '--') + '%'
    + '  再装填 平均' + (reloads / N).toFixed(2) + '回（発生' + (100 * reloadGames / N).toFixed(1) + '%）'
    + '  膠着(ターン' + MAX_TURNS + '上限)' + (100 * stall / N).toFixed(1) + '%'
    + (errs ? '  例外' + errs + '件' : ''));
}

const N = parseInt(process.argv[2], 10) || 500;
console.log('デッキ枚数の比較（rankC同士・各' + N + '戦・ターン上限' + MAX_TURNS + '）');
[50, 40, 30].forEach(function (size) { series(size, N); });
