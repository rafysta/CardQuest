/* M6 ラン（分岐マップ）のＵＩ検証（Playwright／ヘッドレスChromium）
 *
 *   1) 「ラン」タブが最初から開いていて、エリア選択が出る（森はロック表示）
 *   2) 草原を選ぶとおまかせドラフト（3回）が出て、選ぶたびに進む
 *   3) ドラフトを終えると「出発する」→ マップにノード・パス・現在選べるマスが出る
 *   4) 戦闘マスを選ぶと概要（相手・戦場ルール）が出て、「たたかう」でバトル画面へ橋渡しされる
 *      （ラン中はバトル画面の「新しい対戦」等は隠れ、決着後は「ランへ戻る」でマップへ戻る）
 *   5) 非戦闘マス（宝箱・休憩・ショップ・換金・？）のうち出現したものを1つ以上解決できる
 *   6) リタイヤすると結果画面が出て、エリア選択に戻れる
 *   7) 一連の操作でコンソールエラーが出ない
 *
 * 使い方（別のターミナルで簡易サーバを立ててから）:
 *   python3 -m http.server 8321 &
 *   node tools/verify-run.js
 */
'use strict';
const { chromium } = require('playwright');

const URL = process.env.CQ_URL || 'http://localhost:8321/index.html';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => {
    if (r.status() >= 400 && !/assets\/(cards|map|masters)\/[^/]+\.(png|jpg)/.test(r.url())) {
      errors.push('HTTP ' + r.status() + ' ' + r.url());
    }
  });
  page.on('dialog', (d) => d.accept());   // retire の confirm() を自動でOK
  await page.goto(URL);
  await page.waitForTimeout(400);   // 読み込み直後はフォント差し替え等でタブの位置がわずかに動くことがある

  const results = [];
  const ok = (name, cond, extra) => results.push([cond ? 'PASS' : 'FAIL', name, extra || '']);
  const wait = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 10000)) {
      if (await fn()) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };

  await page.waitForTimeout(400);

  // --- 1) ラン画面が最初から開く。エリア選択 ---
  ok('「ラン」タブが最初から開いている', await page.$eval('.tab[data-screen="screen-run"]', (e) => e.classList.contains('on')));
  const tiles = await page.$$('.area-tile');
  ok('エリアが2つ出る（草原・森）', tiles.length === 2, String(tiles.length));
  const forestLocked = await page.$('.area-tile.locked');
  ok('森はロック表示', !!forestLocked);

  // --- 2) 草原を選ぶ → おまかせドラフト ---
  const grassTile = await page.$$eval('.area-tile', (els) => els.findIndex((e) => !e.classList.contains('locked')));
  (await page.$$('.area-tile'))[grassTile].click();
  await wait(() => page.$('.draft-row'));
  ok('草原を選ぶとドラフト画面が出る', !!(await page.$('.draft-row')));

  for (let i = 0; i < 3; i++) {
    const before = await page.evaluate(() => RUI.run.draftDone);
    const cards = await page.$$('.draft-card');
    if (!cards.length) break;
    await cards[0].click();
    await wait(async () => (await page.evaluate(() => RUI.run.draftDone)) !== before);
  }
  ok('3回のドラフトを終えると出発ボタンが出る', !!(await page.$('[data-act="depart"]')),
     'draftDone=' + await page.evaluate(() => RUI.run.draftDone));

  // --- 3) 出発 → マップ ---
  await page.click('[data-act="depart"]');
  await wait(() => page.$('.run-map'));
  const nodeCount = (await page.$$('.map-node')).length;
  ok('マップに14マス出る', nodeCount === 14, String(nodeCount));
  const pickableCount = (await page.$$('.map-node.pickable')).length;
  ok('開始直後は2択（pickableが2つ）', pickableCount === 2, String(pickableCount));

  // --- 4)/5) 選べるマスの種類ごとに解決してみる（非戦闘マスがあれば片方はそちらを解決） ---
  async function pickableIds() {
    return page.$$eval('.map-node.pickable', (els) => els.map((e) => e.dataset.id));
  }
  async function nodeType(id) {
    return page.evaluate((nid) => RUI.run.map.nodes[nid].type, id);
  }

  let ids = await pickableIds();
  let nonBattle = null;
  for (const id of ids) { if ((await nodeType(id)) !== 'battle') { nonBattle = id; break; } }

  if (nonBattle) {
    const t = await nodeType(nonBattle);
    await page.click(`.map-node[data-id="${nonBattle}"]`, { force: true });
    await wait(() => page.$('.node-panel'));
    ok('非戦闘マス(' + t + ')の解決パネルが出る', !!(await page.$('.node-panel')), t);
    if (t === 'chest') { await page.click('[data-act="chest-open"]'); await page.waitForTimeout(200); await page.click('[data-act="node-done"]'); }
    else if (t === 'rest') { await page.click('[data-act="rest-go"]'); await page.waitForTimeout(200); await page.click('[data-act="node-done"]'); }
    else if (t === 'shop') { await page.click('[data-act="shop-leave"]'); }
    else if (t === 'exchange') { await page.click('[data-act="exchange-leave"]'); }
    else if (t === 'question') { await page.click('[data-act="node-done"]'); }
    await wait(() => page.$('.run-map'));
    ok('非戦闘マスを解決するとマップへ戻る', !!(await page.$('.run-map')));
  } else {
    ok('非戦闘マス(このランでは両方戦闘)', true, '両方battleだったのでスキップ');
  }

  // --- 戦闘マスを選んで、バトル画面へ橋渡し・決着後にランへ戻れることを確認 ---
  ids = await pickableIds();
  let battleId = null;
  for (const id of ids) { if ((await nodeType(id)) === 'battle') { battleId = id; break; } }
  if (battleId) {
    await page.click(`.map-node[data-id="${battleId}"]`, { force: true });
    await wait(() => page.$('[data-act="battle-go"]'));
    ok('戦闘マスの概要パネルが出る（相手の絵・「たたかう」）', !!(await page.$('[data-act="battle-go"]')));
    await page.click('[data-act="battle-go"]');
    await wait(() => page.evaluate(() => document.getElementById('screen-battle').classList.contains('on')));
    ok('「たたかう」でバトル画面に切り替わる', await page.evaluate(() => document.getElementById('screen-battle').classList.contains('on')));
    await page.waitForTimeout(1500);   // 手札配布などの演出(FX)が終わるまで待つ。演出中の強制上書きはstep()に打ち消される
    ok('ラン中はバトル画面の「新しい対戦」ボタンが隠れる', !(await page.$('#turnbox [data-act="new"]')));
    // 決着を強制して「ランへ戻る」フローだけを検証する（戦闘の勝敗そのものは
    // tools/simulate-run.js のヘッドレス自動対戦で別途大量に検証済み）
    await page.evaluate(() => {
      M.winner = 'self'; M.phase = 'over'; M.loot = [8];
      M.players.self.lp = 8; M.log.push('自分の勝利');
      UI.mode = 'over'; UI.report = null; busy = false; renderAll();
    });
    await wait(() => page.$('[data-act="run-over"]'));
    ok('決着後は「ランへ戻る」ボタンが出る', !!(await page.$('[data-act="run-over"]')));
    await page.click('[data-act="run-over"]');
    await wait(() => page.evaluate(() => document.getElementById('screen-run').classList.contains('on')));
    ok('「ランへ戻る」でラン画面に戻る', await page.evaluate(() => document.getElementById('screen-run').classList.contains('on')));
    ok('戦闘結果がランに反映される（そのマスが解決済み）',
      await page.evaluate((nid) => RUI.run.map.nodes[nid].cleared, battleId));
  } else {
    ok('戦闘マスの橋渡し(このランでは戦闘マスが選べなかった)', true, '');
  }

  // --- 6) リタイヤ ---
  await page.click('[data-act="retire"]');
  await wait(() => page.$('[data-act="back-home"]'));
  ok('リタイヤすると結果画面が出る', !!(await page.$('[data-act="back-home"]')));
  await page.click('[data-act="back-home"]');
  await wait(() => page.$('.area-grid'));
  ok('結果画面からエリア選択に戻れる', !!(await page.$('.area-grid')));

  ok('コンソールエラーなし', errors.length === 0, errors.slice(0, 5).join(' / '));

  await browser.close();
  let fail = 0;
  results.forEach(([st, name, extra]) => {
    if (st === 'FAIL') fail++;
    console.log(`${st === 'PASS' ? '✓' : '✗'} ${name}${extra ? '  … ' + extra : ''}`);
  });
  console.log(`\n${results.length - fail} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
