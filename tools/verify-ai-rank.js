/* 敵ＡＩ（M5→M5.7で探索方策に刷新）と強さ切替ＵＩの検証（Playwright／ヘッドレスChromium）
 *
 *   ・上部の「強さ：Ｃ」ボタンが表示され、押すたびにＣ→Ｂ→Ａ→フリー→Ｃと巡回する
 *   ・切替が M.aiConfig.enemy に反映される（新しい対戦にも引き継がれる）
 *   ・探索ＡＩ（policy:'search'）を相手に1ターン回してもエラーが出ない（敵の手番が完走する）
 *   ・ブラウザに CQSearch が読み込まれ、敵の思考が実際に search で行われている
 *
 * 使い方： python3 -m http.server 8324 を立ててから node tools/verify-ai-rank.js
 */
'use strict';
const { chromium } = require('playwright');

const URL = 'http://localhost:8324/index.html';
const results = [];
function check(ok, note, detail) { results.push([ok, note, detail || '']); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/cards\/\d+\.png/.test(msg.text())) errors.push(msg.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForFunction(() => typeof M !== 'undefined' && M && M.board, null, { timeout: 5000 });
  await page.waitForFunction(() => typeof busy !== 'undefined' && !busy && M && M.phase, null, { timeout: 8000 });
  await page.waitForTimeout(400);

  /* ---- 1. 既定はランクＣで、aiConfig が新しい対戦に入っている ---- */
  const initial = await page.evaluate(() => ({
    label: document.querySelector('#turnbox [data-act="rank"]') &&
           document.querySelector('#turnbox [data-act="rank"]').textContent,
    cfg: M.aiConfig && M.aiConfig.enemy && M.aiConfig.enemy.label,
    policy: M.aiConfig && M.aiConfig.enemy && M.aiConfig.enemy.policy
  }));
  check(initial.label === '強さ：Ｃ', '既定の強さ表示は「強さ：Ｃ」', initial.label);
  check(initial.cfg === 'Ｃ' && initial.policy === 'search', 'M.aiConfig に探索ＡＩ(rankC/search)が入っている',
    JSON.stringify({ cfg: initial.cfg, policy: initial.policy }));
  const hasSearch = await page.evaluate(() => typeof CQSearch !== 'undefined' && !!CQSearch.placementStep);
  check(hasSearch, 'CQSearch（js/engine/search.js）がブラウザに読み込まれている');

  /* ---- 2. ボタンでＣ→Ｂ→Ａ→フリー→Ｃと巡回する ---- */
  const seq = [];
  for (let i = 0; i < 4; i++) {
    await page.click('#turnbox [data-act="rank"]');
    await page.waitForTimeout(150);
    seq.push(await page.evaluate(() => M.aiConfig.enemy.label));
  }
  check(JSON.stringify(seq) === JSON.stringify(['Ｂ', 'Ａ', 'フリー', 'Ｃ']),
    '強さがＢ→Ａ→フリー→Ｃと巡回する', JSON.stringify(seq));

  /* ---- 3. 評価関数ＡＩ相手に1ターン回す（配置を終える→ターン終了→敵の手番完走） ---- */
  const turn0 = await page.evaluate(() => M.turn);
  if (await page.$('#acts [data-act="end-place"]')) {
    await page.click('#acts [data-act="end-place"]');
    await page.waitForTimeout(400);
  }
  if (await page.$('#acts [data-act="end-turn"]')) {
    await page.click('#acts [data-act="end-turn"]');
  }
  // 敵の手番（評価関数ＡＩ）が終わって自分の番へ戻るのを待つ。戦闘（防御側オープン）で
  // 止まった場合は「迎撃を終える」を押して進める
  const t0 = Date.now();
  let backToMe = false;
  while (Date.now() - t0 < 45000) {
    const st = await page.evaluate(() => ({
      turn: M.turn, active: M.active, busy: typeof busy !== 'undefined' && busy,
      combat: !!M.combat, winner: M.winner
    }));
    if (st.winner) { backToMe = true; break; }
    if (st.combat && !st.busy) {
      const warn = await page.$('#acts .act-btn.warn');
      if (warn) { await warn.click().catch(() => {}); }
    }
    if (!st.busy && !st.combat && st.active === 'self' && st.turn >= turn0 + 2) { backToMe = true; break; }
    await page.waitForTimeout(300);
  }
  check(backToMe, '探索ＡＩの手番が完走して自分の番に戻る（または決着）');
  const stats = await page.evaluate(() => M._searchStats || null);
  check(!!stats && stats.ms !== undefined, '敵の思考が search で行われた（M._searchStats が残る）',
    JSON.stringify(stats));
  check(!stats || stats.ms <= 1500, '1手の思考が時間予算内（≦1500ms）', stats && (stats.ms + 'ms'));
  check(errors.length === 0, 'コンソールエラー0件', errors.slice(0, 3).join(' / '));

  await browser.close();
  results.forEach(([o, n, d]) => console.log((o ? 'PASS' : 'FAIL') + ' ' + n + (d ? '  … ' + d : '')));
  const fail = results.filter(([o]) => !o).length;
  console.log(fail ? fail + ' 件 FAIL' : 'すべて期待どおり動作しています');
  process.exit(fail ? 1 : 0);
})();
