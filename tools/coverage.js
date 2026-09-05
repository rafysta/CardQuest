/* CardQuest — 入手経路の網羅表（M8.1 WP1）
 * 使い方: node tools/coverage.js [--planned]
 *
 * 全169種（ユニット・魔法・技能）の入手経路を js/meta/routes.js で洗い出し、
 * 経路が1本も無いカード（FAIL）があれば非0で終了する。M8.3（実装計画§4 WP18）で
 * FAIL・PLANNED をともに0にするまでは、PLANNED（原作の記述はあるが未実装）が
 * 残っていてもビルドは失敗にしない——第一幕だけの今、鍵やダンジョンの経路が
 * 「予定」のままなのは正常な状態だから。
 *
 * --planned を付けると PLANNED の内訳（どのカードが何の実装待ちか）も表示する。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const ctx = { window: undefined };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'js/data.js'), 'utf8')
  .replace(/const (CARDS|CARD_BY_ID)\b/g, 'var $1'), ctx);
vm.runInContext('globalThis.CARD_BY_ID = CARD_BY_ID;', ctx);
const CARD_BY_ID = ctx.CARD_BY_ID;

const CQRoutes = require(path.join(root, 'js/meta/routes.js'));

const showPlanned = process.argv.indexOf('--planned') >= 0;
const { rows, summary } = CQRoutes.coverageReport(CARD_BY_ID);

console.log(`全${summary.total}種：OK ${summary.ok} / 予定(PLANNED) ${summary.planned} / FAIL ${summary.fail}`);

const fails = rows.filter((r) => r.status === 'FAIL');
if (fails.length) {
  console.log('\n--- 経路が1本も無いカード（FAIL） ---');
  fails.forEach((r) => console.log(`  ${r.id}\t${r.name}`));
}

if (showPlanned) {
  console.log('\n--- 予定（原作の記述はあるが、対応するエリア・仕組みが未実装） ---');
  rows.filter((r) => r.status === 'PLANNED').forEach((r) => {
    console.log(`  ${r.id}\t${r.name}\t${r.routes.map((x) => x.label).join(' ｜ ')}`);
  });
}

if (fails.length) {
  console.log(`\n✗ FAIL：${fails.length}件（経路0本のカードがあります。実装計画M8 §3-5を見直してください）`);
  process.exit(1);
} else {
  console.log('\n✓ 経路0本のカードはありません（PLANNEDぶんはM8.2／M8.3の実装で埋まる想定）');
}
