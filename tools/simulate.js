/* CardQuest — ヘッドレス自動対戦（開発用）
 *
 *   node tools/simulate.js [試行回数] [ターン上限]
 *
 * 両陣営が「その場で合法な行動をランダムに選ぶ」だけの方策で対戦させ、
 * 例外・無限ループ・状態不整合が起きないことを確かめる。
 * 原作の「超過ＣＨ無限ループ」のような事故を再発させないための回帰チェックで、
 * 勝率の数字そのものは（敵ＡＩが未実装なので）バランス評価には使えない。
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
const S = require(path.join(root, 'js/engine/state.js'));
const CQTurn = require(path.join(root, 'js/engine/turn.js'));
const CQCombat = require(path.join(root, 'js/engine/combat.js'));
const CQMagic = require(path.join(root, 'js/engine/effects/magic.js'));
const CQUnits = require(path.join(root, 'js/engine/effects/units.js'));
const CQAi = require(path.join(root, 'js/engine/ai.js'));
const HOOKS = { onMagicOpen: CQMagic.onMagicOpen, onUnitOpen: CQUnits.onUnitOpen };

/* 検証用の簡易デッキ：召還Lv1のユニット中心＋技能・魔法少々＋空白で50枚
 * 実装計画M4 v0.12（技能49種＋カース9種）で新たにターン終了時処理・召還特例・
 * 操作権反転を実装した 55, 167, 169, 181, 184, 186, 199 も混ぜてファズの対象にする。
 * M4 v0.13（魔法48種）では101〜148の全ＩＤをPOOLに加え、レベル・戦闘中×・強制中×などの
 * ゲート判定も含めてファズの対象にする */
const POOL = [8, 1, 2, 5, 7, 19, 21, 46, 47, 61, 63, 65, 66, 71, 20, 22, 55,
  151, 152, 154, 158, 165, 167, 169, 171, 172, 173, 176, 177, 178, 179, 181, 183, 184, 186, 197, 199,
  101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120,
  121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140,
  141, 142, 143, 144, 145, 146, 147, 148, 180,
  /* M4 v0.14：ユニット固有能力73種のうちB型（開：10体）・C型（特：14体）をファズの対象にする */
  1, 16, 23, 24, 25, 27, 29, 30, 31, 40,
  3, 6, 9, 10, 32, 34, 35, 36, 38, 44, 45, 48, 49, 70];
function makeDeck(rng) {
  const deck = [];
  while (deck.length < 50) deck.push(POOL[rng.int(0, POOL.length - 1)]);
  return deck;
}

/* 手の選択は js/engine/ai.js（仮のランダム方策）に任せる。M5で本物のＡＩに差し替える */
function playTurn(m) {
  CQTurn.beginTurn(m);
  if (m.winner) return;
  let guard = 0;
  while (m.phase === 'discard' && guard++ < 20) CQAi.discardStep(m);
  if (m.phase === 'placement') { CQAi.playPlacement(m); CQTurn.endPlacement(m); }
  guard = 0;
  while (m.phase === 'main' && guard++ < 20) {
    if (!CQAi.mainStep(m)) break;
    CQAi.finishCombat(m);
    if (m.combat) throw new Error('オープンフェイズが終わらない');
  }
  if (m.phase === 'main') CQTurn.endTurn(m);
}

/** 盤面の不変条件を確かめる（壊れていたら例外） */
function checkInvariants(m) {
  m.board.lanes.forEach(function (ln, i) {
    if (ln.unit == null) {
      if (ln.channels.length) throw new Error('レーン' + i + '：ユニットが居ないのにチャンネルが残っている');
      return;
    }
    if (ln.channels.length > 6) throw new Error('レーン' + i + '：階層が6を超えた');
    if (ln.count !== ln.channels.length) throw new Error('レーン' + i + '：枚数カウントがずれている');
    if (ln.count > ln.cap) throw new Error('レーン' + i + '：上限を超えたチャンネルが残っている');
  });
  ['self', 'enemy'].forEach(function (side) {
    const p = m.players[side];
    if (p.hand.length > 7) throw new Error(side + '：手札が7枚を超えた');
    if (p.deckCount < 0) throw new Error(side + '：山札が負になった');
  });
}

function runMatch(seed, maxTurns) {
  const rng = CQRng.create(seed);
  const m = CQTurn.createMatch({
    cards: CARD_BY_ID, rng: rng,
    selfDeck: makeDeck(rng), enemyDeck: makeDeck(rng),
    first: rng.next() < 0.5 ? 'self' : 'enemy',
    opponentId: 101,
    hooks: HOOKS
  });
  let guard = 0;
  while (!m.winner && m.turn < maxTurns && guard++ < 5000) {
    playTurn(m);
    checkInvariants(m);
  }
  return m;
}

const runs = parseInt(process.argv[2], 10) || 300;
const maxTurns = parseInt(process.argv[3], 10) || 80;
const stat = { self: 0, enemy: 0, draw: 0, turns: 0, loot: 0, errors: [] };
for (let seed = 1; seed <= runs; seed++) {
  try {
    const m = runMatch(seed, maxTurns);
    if (m.winner) stat[m.winner] += 1; else stat.draw += 1;
    stat.turns += m.turn;
    stat.loot += m.loot.length;
  } catch (e) {
    stat.errors.push('seed ' + seed + ': ' + e.message);
  }
}
console.log(runs + ' 戦：自陣側 ' + stat.self + ' 勝 / 敵陣側 ' + stat.enemy + ' 勝 / 決着つかず ' + stat.draw);
console.log('平均 ' + (stat.turns / runs).toFixed(1) + ' 手番、戦利品 平均 ' + (stat.loot / runs).toFixed(2) + ' 枚');
if (stat.errors.length) {
  console.log('\n例外 ' + stat.errors.length + ' 件:');
  stat.errors.slice(0, 10).forEach(function (e) { console.log('  ' + e); });
  process.exit(1);
}
console.log('例外なし');
