/* CardQuest — ラン（分岐マップ）のヘッドレス自動プレイ（M6）
 *
 *   node tools/simulate-run.js [試行回数=300]
 *
 * 「キャリア」＝同じ cq_meta を使い続けて2ラン連続で遊ぶ（1本目は必ず草原、2本目は
 * 解放されていれば森も選ぶ）。各マスの選択はランダム（分岐・ドラフト・購入・売却・
 * リタイヤも一定確率で）。戦闘は既存の敵ＡＩ同士（tools/simulate.js と同じ駆動）で
 * 自動決着させる。例外・不変条件違反が無いことを確認する回帰チェック。
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
const CQCombat = require(path.join(root, 'js/engine/combat.js'));
const CQMagic = require(path.join(root, 'js/engine/effects/magic.js'));
const CQUnits = require(path.join(root, 'js/engine/effects/units.js'));
const CQAi = require(path.join(root, 'js/engine/ai.js'));
const CQField = require(path.join(root, 'js/engine/fieldrules.js'));
const CQAreas = require(path.join(root, 'js/run/areas.js'));
const CQMap = require(path.join(root, 'js/run/map.js'));
const CQRun = require(path.join(root, 'js/run/run.js'));
const CQSave = require(path.join(root, 'js/meta/save.js'));
const CQCollection = require(path.join(root, 'js/meta/collection.js'));
const HOOKS = { onMagicOpen: CQMagic.onMagicOpen, onUnitOpen: CQUnits.onUnitOpen };

/* スターターセット（M6.6 §2-2確定。js/run-ui.js の STARTER_BOOK・tests/run.js と同じ内容）。
 * WP1から「本」へ入って始まる。値を変えたら3箇所とも直すこと。 */
const STARTER = [
  8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
  101, 101, 101,
  108, 108,
  113, 113,
  153, 153, 153,
  165, 165,
  193, 193, 193,
  194, 194, 194
];

/** M6.6 WP1：スターターは「本」に入って始まり、デッキ編集画面（WP4）が無いとまだ持ち出せない。
 * simulateはヘッドレスでUIを経由できないので、本にあるカードを（同種3枚・ピッグマン無制限の
 * 制限内で）機械的にデッキへ持ち出してから出発する——本物のプレイヤー操作の代用。
 * WP4が入ったら、そこでの実際の選択ロジックに置き換える。 */
function autoCarryOut(meta) {
  Object.keys(meta.book).forEach((k) => {
    const id = +k;
    let guard = meta.book[id] || 0;
    while (guard-- > 0 && (meta.book[id] || 0) > 0) {
      if (!CQCollection.moveToDeck(meta, id, 1).ok) break;
    }
  });
}

function mockStorage() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
}

/* tools/simulate.js と同じ「ＡＩ同士で1バトルを最後まで進める」駆動 */
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

function autoBattle(setup, maxTurns) {
  const rng = CQRng.create(setup.seed);
  const m = CQTurn.createMatch(Object.assign({}, setup, { rng: rng, hooks: HOOKS }));
  m.aiConfig = { self: CQAi.PRESETS.heuristic, enemy: CQAi.PRESETS.heuristic };
  let guard = 0;
  while (!m.winner && m.turn < maxTurns && guard++ < 5000) playTurn(m);
  if (!m.winner) { m.winner = m.players.self.lp >= m.players.enemy.lp ? 'self' : 'enemy'; }  // ターン上限：安全弁
  return m;
}

/** ラン用の不変条件（tools/simulate.js の checkInvariants を流用しつつラン特有の分を追加） */
function checkRunInvariants(run, meta) {
  if (run.gold < 0) throw new Error('Ｇが負になった');
  if (run.lp < 0) throw new Error('ＬＰが負になった');
  Object.keys(run.deck).forEach((k) => { if (run.deck[k] < 0) throw new Error('所持デッキが負になった: ' + k); });
  Object.keys(run.bookAdd || {}).forEach((k) => { if (run.bookAdd[k] < 0) throw new Error('本行き分が負になった: ' + k); });
  if (meta.book) Object.keys(meta.book).forEach((k) => { if (meta.book[k] < 0) throw new Error('本が負になった: ' + k); });
  if (run.map.fog.active === false && run.map.fog.cleared !== true) throw new Error('霧なしランで cleared が立っていない');
  const seg = {};
  Object.values(run.map.nodes).forEach((n) => {
    if (n.seg == null) return;
    seg[n.seg] = (seg[n.seg] || 0) + (n.strength === 'elite' ? 1 : 0);
  });
  if ((seg[0] || 0) > 0 || (seg[1] || 0) > 0) throw new Error('関門以外に精鋭が出た');
}

function playRun(areaId, seed, meta, rng) {
  autoCarryOut(meta);   /* M6.6 WP1：デッキ編集画面（WP4）の代用。出発前に本から持ち出す */
  const run = CQRun.start(CARD_BY_ID, areaId, seed, meta);
  for (let i = 0; i < 3; i++) {
    const dp = CQRun.beginDraftRound(run, CARD_BY_ID);
    const pool = dp.options.concat([dp.targetId]);
    CQRun.applyDraft(run, pool[rng.int(0, pool.length - 1)]);
  }
  CQRun.depart(run);

  let steps = 0, battles = 0, totalTurns = 0;
  while (!run.outcome && steps++ < 60) {
    const n = CQRun.currentNode(run);
    if (!n.cleared) {
      if (n.type === 'battle' || n.type === 'boss') {
        const setup = CQRun.battleSetup(run, CARD_BY_ID, n);
        const M = autoBattle(setup, 80);
        battles++; totalTurns += M.turn;
        CQRun.reportBattle(run, n, M);
        if (n.type === 'boss' && M.winner === 'self') run.outcome = 'win';
      } else if (n.type === 'chest') {
        CQRun.openChest(run, n);
      } else if (n.type === 'rest') {
        CQRun.rest(run, n);
      } else if (n.type === 'shop') {
        if (n.stock.length && rng.next() < 0.6) {
          const id = n.stock[rng.int(0, n.stock.length - 1)];
          CQRun.shopBuy(run, CARD_BY_ID, n, id);
        }
        if (run.lp < run.maxLp && rng.next() < 0.4) CQRun.shopHeal(run, n);
        if (n.hasFogClear && !run.map.fog.cleared && rng.next() < 0.5) CQRun.shopClearFog(run, n);
        CQRun.shopLeave(run, n);
      } else if (n.type === 'exchange') {
        const ids = Object.keys(run.deck).filter((k) => run.deck[k] > 0 && +k !== CQRun.BLANK);
        if (ids.length && rng.next() < 0.5) CQRun.sell(run, CARD_BY_ID, +ids[rng.int(0, ids.length - 1)]);
        CQRun.exchangeLeave(run, n);
      } else if (n.type === 'question') {
        CQRun.resolveQuestion(run, n);
      }
      checkRunInvariants(run, meta);
      if (run.outcome) break;
    }
    if (rng.next() < 0.02) { CQRun.retire(run); break; }   // まれにリタイヤ経路も踏む
    const choices = CQRun.choices(run);
    if (!choices.length) break;
    const next = choices[rng.int(0, choices.length - 1)];
    CQRun.advance(run, next.id);
  }
  const knownBefore = (meta.known || []).length;
  CQRun.settle(run, meta);
  checkRunInvariants(run, meta);
  /* 清算後の所持デッキ(meta.deck)は run.deck の複製（レンタル配列は混ぜない）。
   * M6.6 WP3：ただし空白(180)と0枚のキーは保存しないので、正の実カードだけを比べる。
   * ※ ドラフトで借りたカードを、その後に戦利品・購入で「本当に」入手するのは正常系
   *   （その場合は run.deck 側にも同じidが乗る＝レンタルと恒久所持が両立するのは仕様どおり） */
  const positive = (counts) => {
    const out = {};
    Object.keys(counts).sort((a, b) => a - b).forEach((k) => { if (counts[k] > 0 && +k !== CQRun.BLANK) out[k] = counts[k]; });
    return out;
  };
  if (JSON.stringify(positive(meta.deck)) !== JSON.stringify(positive(run.deck))) throw new Error('清算後の所持デッキが run.deck と一致しない');
  /* 移動モデルの不変条件：knownは減らない・ラン中の本行き分がbookへ全額入る */
  if ((meta.known || []).length < knownBefore) throw new Error('清算でknown（記憶データ）が減った');
  Object.keys(run.bookAdd || {}).forEach((k) => {
    if ((meta.book[k] || 0) < run.bookAdd[k]) throw new Error('本行き分が清算でbookに入っていない: ' + k);
  });
  return { run, battles, totalTurns };
}

const trials = parseInt(process.argv[2], 10) || 300;
const stat = { win: 0, lose: 0, retire: 0, battles: 0, turns: 0, forestRuns: 0, errors: [] };
for (let seed = 1; seed <= trials; seed++) {
  try {
    const rng = CQRng.create(seed * 7919 + 13);
    const storage = mockStorage();
    let meta = CQSave.loadMeta(storage, STARTER);
    /* キャリア1本目：草原（森はまだ解放されていない） */
    let res = playRun('grassland', seed * 2, meta, rng);
    stat[res.run.outcome] = (stat[res.run.outcome] || 0) + 1;
    stat.battles += res.battles; stat.turns += res.totalTurns;
    CQSave.saveMeta(storage, meta);
    /* キャリア2本目：森が解放されていればそちらも試す（エリア解放・引き継ぎデータの経路を踏む） */
    if (CQAreas.isUnlocked('forest', meta.cleared)) {
      stat.forestRuns++;
      res = playRun('forest', seed * 2 + 1, meta, rng);
      stat[res.run.outcome] = (stat[res.run.outcome] || 0) + 1;
      stat.battles += res.battles; stat.turns += res.totalTurns;
      CQSave.saveMeta(storage, meta);
    }
  } catch (e) {
    stat.errors.push('seed ' + seed + ': ' + e.message);
  }
}
console.log(`${trials} キャリア（草原→森）：勝ち ${stat.win} / 負け ${stat.lose} / リタイヤ ${stat.retire}`
  + `（うち森に到達 ${stat.forestRuns} 回）`);
console.log(`戦闘 ${stat.battles} 回・平均 ${(stat.turns / Math.max(1, stat.battles)).toFixed(1)} ターン/戦`);
if (stat.errors.length) {
  console.log(`\n例外 ${stat.errors.length} 件:`);
  stat.errors.slice(0, 10).forEach((e) => console.log('  ' + e));
  process.exit(1);
}
console.log('例外なし');
