/* Ｃ型ユニット固有能力「特殊行動」ＵＩの検証（Playwright／ヘッドレスChromium）
 *
 * M4 v0.14で追加した、メインステップの4つ目の主行動「特殊行動」の画面確認。
 *   ・Ｃ型固有能力を持つユニット（例：3 ダーククラウド）を選ぶと「特殊行動」ボタンが出る
 *   ・押すと効果が解決し（例：敵ユニットに石化(168)が付加される）、そのユニットは硬直する
 *   ・実行後は再度押せない（行動済みの理由が表示される）
 *   ・Ｃ型を持たない通常ユニット（例：8 ピッグマン）を選んでも「特殊行動」は出ない
 *
 * 使い方： python3 -m http.server 8323 を立ててから node tools/verify-special-action.js
 */
'use strict';
const { chromium } = require('playwright');

const URL = 'http://localhost:8323/index.html';
const results = [];
function check(ok, note, detail) { results.push([ok, note, detail || '']); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => check(false, 'ページ内で例外が発生', String(e)));
  await page.goto(URL);
  await page.waitForFunction(() => typeof M !== 'undefined' && M && M.board, null, { timeout: 5000 });
  await page.waitForFunction(() => typeof busy !== 'undefined' && !busy && M && M.phase, null, { timeout: 8000 });
  await page.waitForTimeout(500);

  /* ---- ケース1：Ｃ型ユニット（3 ダーククラウド）を選ぶと「特殊行動」ボタンが出て、押すと発動する ---- */
  await page.evaluate(() => {
    M.phase = 'main'; M.active = 'self'; M.combat = null; M.winner = null; M.reversing = null;
    M.board.lanes[0] = CQState.makeLane(3, [], M.cards);
    M.board.lanes[3] = CQState.makeLane(8, [], M.cards);        // 石化を付ける敵ユニット
    for (let i = 1; i < 3; i++) M.board.lanes[i] = CQState.emptyLane();
    for (let i = 4; i < 6; i++) M.board.lanes[i] = CQState.emptyLane();
    M.board.lanes[0].stiff = false; M.board.lanes[0].channeled = false;
    CQStats.recalc(M.board, { cards: M.cards, combat: null });
    UI.mode = 'unit'; UI.lane = 0; UI.pending = null;
    renderAll();
  });
  await page.waitForTimeout(150);

  const btn = page.locator('#info-fix [data-act="special-action"]');
  check(await btn.count() === 1, '「特殊行動」ボタンが表示される', 'count=' + await btn.count());
  const btnText = await btn.textContent().catch(() => '');
  check(/特殊行動/.test(btnText || ''), 'ボタンのラベルが「特殊行動」', btnText);

  await btn.click();
  await page.waitForTimeout(250);

  const afterCast = await page.evaluate(() => ({
    curseOnEnemy: M.board.lanes[3].channels.some((c) => c.card === 168),
    stiff: M.board.lanes[0].stiff
  }));
  check(afterCast.curseOnEnemy, '発動すると敵ユニットに「石化」(168)が付加される', JSON.stringify(afterCast));
  check(afterCast.stiff, '発動したユニットは硬直する', JSON.stringify(afterCast));

  /* ---- ケース2：実行済み（硬直中）は再度押せず、理由が表示される ---- */
  await page.evaluate(() => { UI.mode = 'unit'; UI.lane = 0; renderAll(); });
  await page.waitForTimeout(150);
  const off = page.locator('#info-fix .act-row.off:has-text("特殊行動")');
  check(await off.count() === 1, '行動済みのときは非活性の理由表示になる', 'count=' + await off.count());
  const offText = await off.textContent().catch(() => '');
  check(/行動済み/.test(offText || ''), '理由に「行動済み」が含まれる', offText);

  /* ---- ケース3：Ｃ型を持たない通常ユニットには「特殊行動」欄そのものが出ない ---- */
  await page.evaluate(() => {
    M.board.lanes[1] = CQState.makeLane(8, [], M.cards);        // 8 ピッグマン＝Ｃ型なし
    M.board.lanes[1].stiff = false; M.board.lanes[1].channeled = false;
    CQStats.recalc(M.board, { cards: M.cards, combat: null });
    UI.mode = 'unit'; UI.lane = 1; UI.pending = null;
    renderAll();
  });
  await page.waitForTimeout(150);
  const anyRow = page.locator('#info-fix .act-row:has-text("特殊行動")');
  check(await anyRow.count() === 0, 'Ｃ型を持たないユニットには特殊行動の行自体が出ない', 'count=' + await anyRow.count());

  await browser.close();
  results.forEach(([o, n, d]) => console.log((o ? 'PASS' : 'FAIL') + ' ' + n + (d ? '  … ' + d : '')));
  const fail = results.filter(([o]) => !o).length;
  console.log(fail ? fail + ' 件 FAIL' : 'すべて期待どおり動作しています');
  process.exit(fail ? 1 : 0);
})();
