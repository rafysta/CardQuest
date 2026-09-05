/* CardQuest — 先攻・後攻の勝率差の「切り分け」（診断用・ゲーム本体には一切触れない）
 *
 *   node tools/diag-first-turn.js [試行回数（条件ごと・既定300）]
 *
 * 目的：M7 から持ち越されている「先攻・後攻の勝率差 20.2 ポイント」（経済追補§5-4）が、
 *   (a) 先に動ける＝先に殴れるという**ルール由来**なのか
 *   (b) フリーユニット戦で**敵だけが最初から場に立っている**という初期配置の非対称由来なのか
 * を分ける。両者で有効な手がまったく違うため、対策の前にここを確定させる。
 *
 * 条件（プレイヤーのデッキ・ＡＩ・ＬＰはすべて共通。変えるのは初期配置だけ）：
 *   deck    … 対等なデッキ戦。両者とも場が空・**同一のデッキ**・同じＬＰ・同じＡＩ（＝完全対称）
 *   field1  … フリーユニット戦。敵だけ場に1体
 *   field2  … 同・2体
 *   field3  … 同・3体（実際のマップで最も多い編成）
 *
 * 各シードについて first='self'（自分が先攻）と first='enemy'（自分が後攻）の**両方**を回す
 * 対応のある比較にしてある（同じ引きの分だけばらつきが小さくなる）。
 *
 * 読み方：
 *   deck の差が小さく、field の差が体数とともに開く → 原因は (b)。
 *     ＝戦闘ルールを触らずに、フリーユニット戦の初期配置だけで是正できる。
 *   deck の差も大きい → 原因は (a)。ルール側（先攻の初手アタック不可など）に手を入れる必要がある。
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
const CQAreas = require(path.join(root, 'js/run/areas.js'));
const CQRun = require(path.join(root, 'js/run/run.js'));
const HOOKS = { onMagicOpen: CQMagic.onMagicOpen, onUnitOpen: CQUnits.onUnitOpen };

/* プレイヤーのデッキ：スターター28枚＋空白で40枚（tools/simulate-run.js の STARTER と
 * js/run/run.js の buildPlayerDeck が出発時に作るものと同じ内容）。全条件で共通。 */
const STARTER = [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 101, 101, 101, 108, 108, 113, 113,
  153, 153, 153, 165, 165, 193, 193, 193, 194, 194, 194];
const PLAYER_DECK = STARTER.slice();
while (PLAYER_DECK.length < CQTurn.DECK_SIZE) PLAYER_DECK.push(180);

/* 場に立てる敵：草原プールの中位（価格順の真ん中）を固定で使う。全 field 条件で同じ。 */
const AREA = CQAreas.get('grassland');
const POOL = CQAreas.enemyPool(CARD_BY_ID, 'grassland')
  .filter((e) => e.price <= AREA.priceMax).sort((a, b) => a.price - b.price);
const FOE = POOL[Math.floor(POOL.length / 2)];

const AI = { self: CQAi.PRESETS.heuristic, enemy: CQAi.PRESETS.heuristic };
const MAX_TURNS = 80;

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
    if (m.combat) throw new Error('オープンフェイズが終わらない');
  }
  if (m.phase === 'main') CQTurn.endTurn(m);
}

/** 1戦。cond='deck'|'field1'|'field2'|'field3'、first='self'|'enemy' */
function battle(cond, first, seed) {
  const rng = CQRng.create(seed);
  const foes = cond === 'deck' ? 0 : +cond.slice(-1);
  const setup = {
    cards: CARD_BY_ID, rng: rng, hooks: HOOKS,
    selfDeck: PLAYER_DECK.slice(),
    enemyDeck: foes === 0 ? PLAYER_DECK.slice()          /* 対等：同じデッキ */
      : CQRun.buildBattleDeck(CARD_BY_ID, AREA, { enemy: { id: FOE.id, count: foes } }),
    first: first,
    opponentId: 101,
    selfOpts: { lp: 10, maxLp: 15 },
    enemyOpts: { lp: 10, maxLp: 15 },
    fieldRules: []
  };
  if (foes > 0) {
    setup.mode = 'field';
    setup.enemyBoard = new Array(foes).fill(FOE.id);
  }
  const m = CQTurn.createMatch(setup);
  m.aiConfig = AI;
  let g = 0;
  while (!m.winner && m.turn < MAX_TURNS && g++ < 5000) playTurn(m);
  return m;
}

const runs = parseInt(process.argv[2], 10) || 300;
const CONDS = ['deck', 'field1', 'field2', 'field3'];
const label = { deck: '対等なデッキ戦（両者とも場が空）', field1: 'フリーユニット戦・敵1体',
  field2: 'フリーユニット戦・敵2体', field3: 'フリーユニット戦・敵3体' };
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '—';
const rows = [];
const errors = [];

CONDS.forEach((cond) => {
  const st = { self: { n: 0, win: 0, turns: 0, cap: 0 }, enemy: { n: 0, win: 0, turns: 0, cap: 0 } };
  for (let seed = 1; seed <= runs; seed++) {
    ['self', 'enemy'].forEach((first) => {
      try {
        const m = battle(cond, first, seed * 2654435761 % 2147483647);
        const b = st[first];
        b.n++; b.turns += m.turn;
        if (!m.winner) b.cap++;                 /* ターン上限＝決着つかず（プレイヤーの負け扱いにはしない） */
        else if (m.winner === 'self') b.win++;
      } catch (e) { errors.push(cond + '/' + first + ' seed ' + seed + ': ' + e.message); }
    });
  }
  const f = 100 * st.self.win / (st.self.n || 1);
  const s = 100 * st.enemy.win / (st.enemy.n || 1);
  rows.push({ cond: cond, first: f, second: s, diff: f - s, st: st });
});

console.log('先攻・後攻差の切り分け — 条件ごと ' + runs + ' シード×2（先攻／後攻）');
console.log('プレイヤーのデッキ：スターター28枚＋空白12枚（全条件で共通）／'
  + '場に立つ敵：' + (CARD_BY_ID[FOE.id] || {}).n + '（' + FOE.price + 'Ｇ）／ＡＩ：両陣営とも heuristic');
console.log('');
rows.forEach((r) => {
  const st = r.st;
  console.log('■ ' + label[r.cond]);
  console.log('    自分が先攻 ' + pct(st.self.win, st.self.n) + '（' + st.self.n + '戦）'
    + ' ／ 自分が後攻 ' + pct(st.enemy.win, st.enemy.n) + '（' + st.enemy.n + '戦）'
    + ' ／ 差 ' + (r.diff >= 0 ? '+' : '') + r.diff.toFixed(1) + 'pt');
  console.log('    平均 ' + ((st.self.turns + st.enemy.turns) / (st.self.n + st.enemy.n)).toFixed(1)
    + ' 手番 ／ 決着つかず ' + pct(st.self.cap + st.enemy.cap, st.self.n + st.enemy.n));
});
console.log('');
const deck = rows.find((r) => r.cond === 'deck');
const f3 = rows.find((r) => r.cond === 'field3');
const se = 100 * Math.sqrt(0.25 / runs + 0.25 / runs);   /* 差の標準誤差の目安（p=0.5のとき） */
console.log('差の標準誤差の目安（片側 n=' + runs + '）：±' + se.toFixed(1) + 'pt'
  + '　→ この2倍（' + (2 * se).toFixed(1) + 'pt）より小さい差は誤差とみなす');
console.log('対等なデッキ戦の差 ' + deck.diff.toFixed(1) + 'pt ／ 敵3体のフリーユニット戦の差 '
  + f3.diff.toFixed(1) + 'pt　→ 初期配置による上乗せ ' + (f3.diff - deck.diff).toFixed(1) + 'pt');
if (errors.length) {
  console.log('\n例外 ' + errors.length + ' 件:');
  errors.slice(0, 5).forEach((e) => console.log('  ' + e));
  process.exit(1);
}
