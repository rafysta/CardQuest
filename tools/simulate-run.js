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

/* 戦闘の内訳（M6.6 WP6の較正用）。field＝通常戦闘（フリーユニット戦）／boss＝マスター戦 */
const BSTAT = {
  field: { n: 0, win: 0, loot: 0, turns: 0, fled: 0 },
  boss: { n: 0, win: 0, loot: 0, turns: 0, fled: 0 }
};
/* M6.6 WP12/§2-11：**先攻・後攻それぞれの勝率**。ここがWP5以降いちばん見たい数字。
 * 全体の勝率だけ見ていると「後攻+1ドロー」の効果は測れない——この補正は
 * 「後攻の側」に付くので、自分が後攻のときも相手が後攻のときも等しく効き、
 * ＡＩ同士の対戦では**合計するとほぼ打ち消し合う**（実際 1000キャリアで 43.6%→44.2% と
 * 誤差程度しか動かなかった）。効いているかどうかは、先攻・後攻に分けて初めて分かる。 */
const FSTAT = { first: { n: 0, win: 0 }, second: { n: 0, win: 0 } };
/* 1ランあたりの経済（マップ仕様書§7・追補§7-1の確認用）。
 * WP6で通常戦闘のＧが無くなったので、宝箱が主収入になっているかを見る。 */
const ESTAT = { runs: 0, goldEnd: 0, cards: 0 };

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

/* M6.6 WP12：プレイヤー側の逃走方策（ヘッドレスでの近似）。
 *
 * **案A（逃げてもマスは残る）のもとで、逃走が何の役に立つのかを取り違えないこと。**
 * 逃げても先へは進めない＝その相手とはいずれ戦う。だから逃走は「勝てない戦いを避ける」
 * 手ではなく、**引きが悪い初手をやり直す（仕切り直す）**手である
 * （battleSeed が挑戦回数を含むので、入り直すと別の引きになる）。
 *
 * 実際、初版は「ＬＰが3以下になったら逃げる」という方策にしていたが、これは
 * **明確に下手な打ち方**で、数字が悪化するだけだった（通常戦闘 45.6%→36.3%）。
 * ＬＰ3で逃げても、結局ＬＰ3のまま同じ相手と戦い直すことになり、逃走失敗のＬＰ−1と
 * 1ターンぶんの手番を捨てるだけ損をする。方策の欠陥であって、ゲームの欠陥ではない。
 *
 * そこで、人がやるであろう使い方＝**初手が悪いときの1回だけの引き直し**を近似する：
 *   ・自分の1ターン目であること（＝まだ何も起きていない）
 *   ・手札に**すぐ場に出せるユニットが1枚も無い**（＝盤面を作れない＝勝ち目が薄い初手）
 *   ・そのマスでまだ逃げていない（FLEE_MAX_PER_NODE）
 * この方策はバランス評価用の仮置きで、仕様ではない。 */
/* CQ_NO_FLEE=1 で逃走方策を切って回せる。「逃走を入れたことで数字がどう動いたか」を
 * 同じ試行回数で見比べるため（方策の良し悪しとゲームの良し悪しを混同しないための道具）。 */
const NO_FLEE = process.env.CQ_NO_FLEE === '1';
const FLEE_MAX_PER_NODE = 1;
function wantsToFlee(m, node) {
  if (NO_FLEE) return false;
  if ((node.attempts || 0) >= FLEE_MAX_PER_NODE) return false;
  if (m.players.self.turnsTaken !== 1) return false;          /* 1ターン目の引き直しとしてだけ使う */
  const playable = m.players.self.hand.filter((id) => {
    const c = CARD_BY_ID[id];
    return c && c.t === 'U' && (c.lv || 1) <= 1;              /* 手札から直接出せるユニット（召還Lv1） */
  });
  return playable.length === 0;
}

function autoBattle(setup, maxTurns, fleeNode) {
  const rng = CQRng.create(setup.seed);
  const m = CQTurn.createMatch(Object.assign({}, setup, { rng: rng, hooks: HOOKS }));
  m.aiConfig = { self: CQAi.PRESETS.heuristic, enemy: CQAi.PRESETS.heuristic };
  let guard = 0;
  while (!m.winner && !m.fled && m.turn < maxTurns && guard++ < 5000) {
    /* 逃走は「自分の配置ステップで、まだ何もしていないうち」だけ＝ターンの頭で判断する。
     * beginTurn を playTurn の中でやっているので、ここでは1手前に自分で beginTurn する。 */
    if (fleeNode && m.active === 'self' && m.phase === 'draw') {
      CQTurn.beginTurn(m);
      if (m.winner) break;
      let g2 = 0;
      while (m.phase === 'discard' && g2++ < 20) CQAi.discardStep(m);
      if (CQTurn.canFlee(m) && wantsToFlee(m, fleeNode)) {
        const r = CQTurn.flee(m);
        if (r.escaped) break;
        if (m.winner) break;             /* 失敗のＬＰ−1で力尽きた */
      }
      if (m.phase === 'placement') { CQAi.playPlacement(m); CQTurn.endPlacement(m); }
      let g3 = 0;
      while (m.phase === 'main' && g3++ < 20) {
        if (!CQAi.mainStep(m)) break;
        CQAi.finishCombat(m);
        if (m.combat) throw new Error('オープンフェイズが終わらない');
      }
      if (m.phase === 'main') CQTurn.endTurn(m);
      continue;
    }
    playTurn(m);
  }
  if (!m.winner && !m.fled) { m.winner = m.players.self.lp >= m.players.enemy.lp ? 'self' : 'enemy'; }  // ターン上限：安全弁
  return m;
}

/** ラン用の不変条件（tools/simulate.js の checkInvariants を流用しつつラン特有の分を追加） */
function checkRunInvariants(run, meta) {
  if (run.gold < 0) throw new Error('Ｇが負になった');
  if (run.lp < 0) throw new Error('ＬＰが負になった');
  Object.keys(run.deck).forEach((k) => { if (run.deck[k] < 0) throw new Error('所持デッキが負になった: ' + k); });
  Object.keys(run.bookAdd || {}).forEach((k) => { if (run.bookAdd[k] < 0) throw new Error('本行き分が負になった: ' + k); });
  if ((run.lootPending || []).length) throw new Error('戦利品の振り分け（M6.6 WP7）が終わらないまま次に進んだ');
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
  autoCarryOut(meta);   /* 持ち出し（WP4のデッキ編集画面）の代用。出発前に本から持ち出す */
  const run = CQRun.start(CARD_BY_ID, areaId, seed, meta);
  /* おまかせドラフト：M6.6 WP4から最大2回・空白がある時だけ発生する。
   * beginDraftRound が null を返したらそこで打ち切る（本物のUIと同じ判断）。 */
  for (let i = 0; i < CQRun.DRAFT_ROUNDS; i++) {
    const dp = CQRun.beginDraftRound(run, CARD_BY_ID);
    if (!dp) break;
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
        const M = autoBattle(setup, 80, n.type === 'boss' ? null : n);
        battles++; totalTurns += M.turn;
        /* M6.6 WP6（§7-5）：フリーユニット戦の較正用の計測。通常戦闘とボス戦を分けて
         * 勝率と平均獲得枚数を出す（§7-1の経済確認にも使う）。 */
        const bucket = (n.type === 'boss') ? BSTAT.boss : BSTAT.field;
        bucket.n++;
        if (M.fled) bucket.fled++;
        if (M.winner === 'self') { bucket.win++; bucket.loot += (M.loot || []).length; }
        bucket.turns += M.turn;
        /* 先攻・後攻べつの勝率（逃走で終わった戦闘は勝敗が付かないので数えない） */
        if (!M.fled) {
          const fb = (M.first === 'self') ? FSTAT.first : FSTAT.second;
          fb.n++;
          if (M.winner === 'self') fb.win++;
        }
        /* M6.6 WP12：逃走で終わった戦闘は勝敗が付いていない。マスは cleared にならないので、
         * このループはもう一度同じマスに入る＝再挑戦になる（本物の操作と同じ）。 */
        if (M.fled) {
          CQRun.reportFlee(run, n, M);
          checkRunInvariants(run, meta);
          if (run.outcome) break;
          continue;
        }
        CQRun.reportBattle(run, n, M, meta);
        /* M6.6 WP7：戦利品はここでは自動で振り分けない（振り分け画面待ちに積まれるだけ）。
         * ヘッドレスなので本物のUI操作の代用として、空きがあればデッキへ・無ければ本へ、
         * という単純な方針でその場で確定させる（本物のプレイヤー操作の近似）。 */
        (run.lootPending || []).slice().forEach((id) => {
          const dest = CQRun.canAssignToDeck(run, id) ? 'deck' : 'book';
          CQRun.resolveLootPick(run, id, dest);
        });
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
  ESTAT.runs++; ESTAT.goldEnd += run.gold; ESTAT.cards += (run.gainedCards || []).length;
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
/* M6.6 WP6（§7-5）の較正表。通常戦闘＝フリーユニット戦（場を空にすれば勝ち）、
 * ボス＝従来どおりのＬＰ勝負。獲得枚数は勝った戦闘あたりの平均。 */
const pct = (a, b) => (b ? (a / b * 100).toFixed(1) : '—') + '%';
['field', 'boss'].forEach((k) => {
  const s = BSTAT[k];
  console.log(`  ${k === 'field' ? '通常戦闘（フリーユニット戦）' : 'ボス（マスター戦）'}：`
    + `${s.n} 回 / 勝率 ${pct(s.win, s.n)} / 平均 ${(s.turns / Math.max(1, s.n)).toFixed(1)} ターン`
    + ` / 勝利1回あたり戦利品 ${(s.loot / Math.max(1, s.win)).toFixed(2)} 枚`
    + (s.fled ? ` / うち逃走 ${s.fled} 回（${pct(s.fled, s.n)}）` : ''));
});
console.log(`  先攻・後攻べつ（全戦闘）：先攻 ${pct(FSTAT.first.win, FSTAT.first.n)}（${FSTAT.first.n}回）`
  + ` / 後攻 ${pct(FSTAT.second.win, FSTAT.second.n)}（${FSTAT.second.n}回）`
  + `　差 ${(FSTAT.first.n && FSTAT.second.n
      ? (FSTAT.first.win / FSTAT.first.n * 100 - FSTAT.second.win / FSTAT.second.n * 100).toFixed(1)
      : '—')} ポイント`);
console.log(`  1ランあたり：獲得カード ${(ESTAT.cards / Math.max(1, ESTAT.runs)).toFixed(2)} 枚`
  + ` / 清算前の所持Ｇ ${(ESTAT.goldEnd / Math.max(1, ESTAT.runs)).toFixed(0)}`);
if (stat.errors.length) {
  console.log(`\n例外 ${stat.errors.length} 件:`);
  stat.errors.slice(0, 10).forEach((e) => console.log('  ' + e));
  process.exit(1);
}
console.log('例外なし');
