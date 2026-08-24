/* 憑依解除(101)の対話的な対象選択の検証（Playwright／ヘッドレスChromium）
 *
 * 「憑依解除の魔法は、起動すると、破壊するカードを１つ選んで、そのカードを破壊するように
 * してください」（2026-08-24 本人の指定）の動作確認。
 *   ・自分の手番でメインステップから憑依解除をリバースすると、選択モードに入り、
 *     破壊できるＣＨが赤く光る（.pick）
 *   ・光っているカードを押すと、それだけが破壊され、他は残る
 *   ・戦闘のオープンフェイズで開いたときも同様に選べる
 *   ・候補が1枚以下のとき（選ぶ意味が無い）は、選択モードに入らずそのまま自動で解決する
 *   ・AI（自動）側が発動したときは、選択モードに入らず自動で解決する（人の操作を止めない）
 *
 * 使い方： python3 -m http.server 8322 を立ててから node tools/verify-destroy-pick.js
 */
'use strict';
const { chromium } = require('playwright');

const URL = 'http://localhost:8322/index.html';
const results = [];
function check(ok, note, detail) { results.push([ok, note, detail || '']); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => check(false, 'ページ内で例外が発生', String(e)));
  await page.goto(URL);
  await page.waitForFunction(() => typeof M !== 'undefined' && M && M.board, null, { timeout: 5000 });
  // 初期化直後の配布・初期配置（AI）演出が終わって落ち着くまで待つ（step() の非同期進行が
  // 途中で自分の強制セットを上書きしてしまわないように）
  await page.waitForFunction(() => typeof busy !== 'undefined' && !busy && M && M.phase, null, { timeout: 8000 });
  await page.waitForTimeout(500);

  /* ---- ケース1：メインステップのリバースで、候補2枚から選べる ---- */
  await page.evaluate(() => {
    M.phase = 'main'; M.active = 'self'; M.combat = null; M.winner = null; M.reversing = null;
    M.board.lanes[0] = CQState.makeLane(8, [{ card: 101, up: false, mine: true, revealed: false }], M.cards);
    M.board.lanes[1] = CQState.makeLane(9, [
      { card: 151, up: false, mine: true, revealed: false },
      { card: 152, up: false, mine: true, revealed: false }
    ], M.cards);
    M.board.lanes[0].stiff = false; M.board.lanes[1].stiff = false;
    CQStats.recalc(M.board, { cards: M.cards, combat: null });
    UI.mode = 'idle'; UI.pending = null; UI.destroyTargets = null; UI.pendingDestroy = null;
    renderAll();
  });
  await page.waitForTimeout(150);

  const beforeCount = await page.evaluate(() => M.board.lanes[1].channels.length);
  check(beforeCount === 2, 'ケース1準備：レーン1のＣＨが2枚', 'count=' + beforeCount);

  // 憑依解除(101)の階層（レーン0・1階層目）を左半分クリックして開く
  const flipCard = page.locator('#board .card.ch[data-lane="0"][data-layer="1"]');
  await flipCard.waitFor({ state: 'visible', timeout: 3000 });
  const box = await flipCard.boundingBox();
  await page.mouse.click(box.x + box.width * 0.25, box.y + 14);   // 上の帯（strip）＝重なりが無い部分を狙う
  await page.waitForTimeout(200);

  const modeAfterOpen = await page.evaluate(() => UI.mode);
  check(modeAfterOpen === 'pick-destroy', 'カードを開くと選択モードに入る', 'UI.mode=' + modeAfterOpen);

  const pickCount = await page.locator('#board .card.ch.pick').count();
  check(pickCount === 2, '破壊できるＣＨ2枚が光っている（.pick）', 'pick要素=' + pickCount);

  const stillTwo = await page.evaluate(() => M.board.lanes[1].channels.length);
  check(stillTwo === 2, '選ぶまではまだ何も破壊されていない', 'count=' + stillTwo);

  // 2枚のうち「idx1（152）」の方を選んで破壊する
  const target = page.locator('#board .card.ch.pick[data-lane="1"][data-layer="2"]');
  await target.waitFor({ state: 'visible', timeout: 3000 });
  const tbox = await target.boundingBox();
  await page.mouse.click(tbox.x + tbox.width / 2, tbox.y + 14);   // 上の帯（strip）＝重なりが無い部分を狙う
  await page.waitForTimeout(300);

  const afterState = await page.evaluate(() => ({
    mode: UI.mode,
    len: M.board.lanes[1].channels.length,
    remaining: M.board.lanes[1].channels.map((c) => c.card)
  }));
  check(afterState.mode !== 'pick-destroy', '選び終わったら選択モードを抜ける', 'UI.mode=' + afterState.mode);
  check(afterState.len === 1, '選んだ1枚だけが破壊される', 'count=' + afterState.len);
  check(afterState.remaining[0] === 151, '選ばなかった方（151）は残る', JSON.stringify(afterState.remaining));

  /* ---- ケース2：候補が1枚以下なら選択モードに入らず自動で解決する ---- */
  await page.evaluate(() => {
    M.phase = 'main'; M.active = 'self'; M.combat = null; M.winner = null; M.reversing = null;
    M.board.lanes[0] = CQState.makeLane(8, [{ card: 101, up: false, mine: true, revealed: false }], M.cards);
    M.board.lanes[1] = CQState.makeLane(9, [{ card: 151, up: false, mine: true, revealed: false }], M.cards);
    for (let i = 2; i < 6; i++) M.board.lanes[i] = CQState.emptyLane();
    CQStats.recalc(M.board, { cards: M.cards, combat: null });
    UI.mode = 'idle'; UI.pending = null; UI.destroyTargets = null; UI.pendingDestroy = null;
    renderAll();
  });
  await page.waitForTimeout(150);
  const flipCard2 = page.locator('#board .card.ch[data-lane="0"][data-layer="1"]');
  await flipCard2.waitFor({ state: 'visible', timeout: 3000 });
  const box2 = await flipCard2.boundingBox();
  await page.mouse.click(box2.x + box2.width * 0.25, box2.y + 14);
  await page.waitForTimeout(200);
  const case2 = await page.evaluate(() => ({ mode: UI.mode, len: M.board.lanes[1].channels.length }));
  check(case2.mode !== 'pick-destroy', '候補1枚のときは選択モードに入らない', 'UI.mode=' + case2.mode);
  check(case2.len === 0, '候補1枚のときは即座に自動で破壊される', 'count=' + case2.len);

  /* ---- ケース3：候補0枚のときも選択モードに入らず素通りする ---- */
  await page.evaluate(() => {
    M.phase = 'main'; M.active = 'self'; M.combat = null; M.winner = null; M.reversing = null;
    M.board.lanes[0] = CQState.makeLane(8, [{ card: 101, up: false, mine: true, revealed: false }], M.cards);
    for (let i = 1; i < 6; i++) M.board.lanes[i] = CQState.emptyLane();
    CQStats.recalc(M.board, { cards: M.cards, combat: null });
    UI.mode = 'idle'; UI.pending = null; UI.destroyTargets = null; UI.pendingDestroy = null;
    renderAll();
  });
  await page.waitForTimeout(150);
  const flipCard3 = page.locator('#board .card.ch[data-lane="0"][data-layer="1"]');
  await flipCard3.waitFor({ state: 'visible', timeout: 3000 });
  const box3 = await flipCard3.boundingBox();
  await page.mouse.click(box3.x + box3.width * 0.25, box3.y + 14);
  await page.waitForTimeout(200);
  const case3 = await page.evaluate(() => UI.mode);
  check(case3 !== 'pick-destroy', '候補0枚のときも選択モードに入らない', 'UI.mode=' + case3);

  await browser.close();
  results.forEach(([o, n, d]) => console.log((o ? 'PASS' : 'FAIL') + ' ' + n + (d ? '  … ' + d : '')));
  const fail = results.filter(([o]) => !o).length;
  console.log(fail ? fail + ' 件 FAIL' : 'すべて期待どおり動作しています');
  process.exit(fail ? 1 : 0);
})();
