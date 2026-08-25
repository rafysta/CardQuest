/* M5.5（v0.15.1）の検証（Playwright／ヘッドレスChromium）
 *
 * デッキ40枚と山札再装填（ゲーム仕様書§4.1）が、実際にブラウザへ読み込まれた
 * エンジン・ＵＩで動くことを確かめる。
 *   ・見本デッキが CQTurn.DECK_SIZE＝40枚になっている
 *   ・山札が尽きた状態でドローすると、初期リストが復元され、ＬＰ−2、ログに「再装填」が出る
 *   ・画面の山札カウンタが復元後の枚数を表示する
 *   ・再装填のＬＰコストでＬＰ0になると、その場で敗北する（終了保証）
 *   ・ＵＩのターン終了（未行動補充のドロー）経由でも再装填が起きる
 *
 * 使い方： python3 -m http.server 8322 を立ててから node tools/verify-reload.js
 */
'use strict';
const { chromium } = require('playwright');

const URL = 'http://localhost:8322/index.html';
const results = [];
function check(ok, note, detail) { results.push([ok, note, detail || '']); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/cards\/\d+\.png|masters\//.test(msg.text())) errors.push(msg.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForFunction(() => typeof M !== 'undefined' && M && M.board, null, { timeout: 5000 });
  await page.waitForFunction(() => typeof busy !== 'undefined' && !busy && M && M.phase, null, { timeout: 8000 });
  await page.waitForTimeout(500);

  /* ---- 1) デッキ枚数が40 ---- */
  const sizes = await page.evaluate(() => ({
    constSize: CQTurn.DECK_SIZE,
    self: M.players.self.initial.length,
    enemy: M.players.enemy.initial.length
  }));
  check(sizes.constSize === 40, 'CQTurn.DECK_SIZE が 40', String(sizes.constSize));
  check(sizes.self === 40 && sizes.enemy === 40, '両陣営の初期デッキが40枚',
    'self=' + sizes.self + ' enemy=' + sizes.enemy);

  /* ---- 2) 山札が尽きた状態のドロー → 再装填・ＬＰ−2・ログ ---- */
  const r2 = await page.evaluate(() => {
    const p = M.players.self;
    M.winner = null;
    p.deck = {}; p.deckCount = 0; p.lp = 9;
    const lpBefore = p.lp;
    const id = CQTurn.draw(M.rng, p, M);
    renderAll();
    return {
      id: id, lp: p.lp, lpBefore: lpBefore, reloads: p.reloads, deckCount: p.deckCount,
      logHit: M.log.slice(-5).some((s) => s.indexOf('再装填') >= 0),
      winner: M.winner
    };
  });
  check(r2.id != null, '空の山札からでも1枚引ける（再装填）', 'id=' + r2.id);
  check(r2.reloads >= 1, '再装填回数が記録される', 'reloads=' + r2.reloads);
  check(r2.lp === r2.lpBefore - 2, '再装填でＬＰ−2', r2.lpBefore + '→' + r2.lp);
  check(r2.deckCount === 39, '初期40枚を復元して1枚引いた＝残39', 'deckCount=' + r2.deckCount);
  check(r2.logHit, 'ログに「再装填」が出る');
  check(r2.winner == null, 'ＬＰが残っていれば敗北しない', 'winner=' + r2.winner);

  const counter = await page.evaluate(() => document.getElementById('my-deck').textContent);
  check(counter === '39', '画面の山札カウンタが39を表示', counter);

  /* ---- 3) 再装填のＬＰコストで敗北（終了保証） ---- */
  const r3 = await page.evaluate(() => {
    const p = M.players.self;
    p.deck = {}; p.deckCount = 0; p.lp = 2;
    const id = CQTurn.draw(M.rng, p, M);
    renderAll();
    return { id: id, lp: p.lp, winner: M.winner, hand: p.hand.length };
  });
  check(r3.winner === 'enemy', 'ＬＰ2で再装填→ＬＰ0＝敗北', 'winner=' + r3.winner + ' lp=' + r3.lp);
  check(r3.id == null, '決着後はカードを引かない（死後の手札に積まない）', 'id=' + r3.id);

  /* ---- 4) ＵＩのターン終了（未行動補充）経由でも再装填が起きる ---- */
  await page.evaluate(() => { location.reload(); });
  await page.waitForFunction(() => typeof M !== 'undefined' && M && M.board, null, { timeout: 8000 });
  await page.waitForFunction(() => typeof busy !== 'undefined' && !busy && M && M.phase, null, { timeout: 8000 });
  await page.waitForTimeout(500);
  const r4 = await page.evaluate(async () => {
    // 自分のメインステップ・未行動・手札5枚以下・山札空、の状態を直接作る
    M.phase = 'main'; M.active = 'self'; M.combat = null; M.winner = null; M.reversing = null;
    const p = M.players.self;
    p.actedThisTurn = false; p.hand = [8, 101]; p.deck = {}; p.deckCount = 0; p.lp = 9;
    renderAll();
    const lpBefore = p.lp;
    CQTurn.endTurn(M);           // 未行動補充のドロー → 山札が空 → 再装填
    renderAll();
    return { lpBefore: lpBefore, lp: p.lp, reloads: p.reloads,
      logHit: M.log.slice(-6).some((s) => s.indexOf('再装填') >= 0) };
  });
  check(r4.reloads >= 1 && r4.lp === r4.lpBefore - 2, 'ターン終了の補充ドローでも再装填（ＬＰ−2）',
    'reloads=' + r4.reloads + ' lp=' + r4.lpBefore + '→' + r4.lp);
  check(r4.logHit, 'そのログにも「再装填」が出る');

  check(errors.length === 0, 'コンソールエラー0件', errors.slice(0, 3).join(' / '));

  console.log(results.map(([ok, n, d]) => (ok ? 'PASS' : 'FAIL') + ' ' + n + (d ? '  … ' + d : '')).join('\n'));
  await browser.close();
  process.exit(results.some(([ok]) => !ok) ? 1 : 0);
})();
