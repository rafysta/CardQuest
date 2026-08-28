/* M6 ラン（分岐マップ）のＵＩ検証＋スクショ検収（Playwright／ヘッドレスChromium）
 *
 *   0) 初回起動で「目覚めの場面」が出て、スキップでエリア選択に着地する（M6.6 WP1）
 *   1) 「ラン」タブが最初から開いていて、エリア選択が出る（森はロック表示）
 *   2) 草原を選ぶとおまかせドラフト（3回）が出て、選ぶたびに進む
 *   3) ドラフトを終えると「出発する」→ マップにノード・パス・現在選べるマスが出る
 *   4) 戦闘マスを選ぶと概要（相手・戦場ルール）が出て、「たたかう」でバトル画面へ橋渡しされる
 *      （ラン中はバトル画面の「新しい対戦」等は隠れ、決着後は「ランへ戻る」でマップへ戻る）
 *   5) 非戦闘マス（宝箱・休憩・ショップ・換金・？）のうち出現したものを1つ以上解決できる
 *   6) リタイヤすると結果画面が出て、エリア選択に戻れる
 *   7) 霧の出た森のマップを1枚撮る（M6.5b：霧のベール・敵のシルエット・「？」）
 *   8) 一連の操作でコンソールエラーが出ない
 *
 * **スクショ検収**（『実装計画追補M6.5』§3・M6.5bで整備）：各画面のPNGを自動で吐く。
 * 機能テストが通っても絵ができていなければ「完了」にしない、という M6.5 §0.5 の再発防止策の実体。
 * 出力先は既定で tmp/verify-run/（CQ_SHOTS で変更可）。撮った画像は §3 のチェックリストと
 * 突き合わせて目視（またはClaudeに見せて）確認する。
 *
 * 使い方（別のターミナルで簡易サーバを立ててから）:
 *   python3 -m http.server 8321 &
 *   node tools/verify-run.js
 *
 * 環境変数：
 *   CQ_URL     … 検証するURL（既定 http://localhost:8321/index.html）
 *   CQ_SHOTS   … スクショの出力ディレクトリ（既定 tmp/verify-run）
 *   CQ_CHROME  … Chromiumの実行ファイルパス。Playwrightが自前でブラウザを持っていない環境
 *                （Claudeのクラウド環境など。/opt/pw-browsers/chromium）で指定する
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const URL = process.env.CQ_URL || 'http://localhost:8321/index.html';
const SHOT_DIR = process.env.CQ_SHOTS || path.join(__dirname, '..', 'tmp', 'verify-run');

/* WP4（開始マスのデッキ編集画面）が入るまでの仮の橋渡し。M6.6 WP1でスターターは「本」に
 * 入って始まるようになり、デッキが空のままではランを始められない。本物のプレイヤー操作の
 * 代わりに、ここでは持ち出し済みのデッキを直接こしらえる（tools/simulate-run.js の
 * autoCarryOut と同じ役どころ）。WP4が入ったら、その画面を操作する形に置き換えること。 */
const STARTER = [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 101, 101, 101, 108, 108, 113, 113,
  153, 153, 153, 165, 165, 193, 193, 193, 194, 194, 194];

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch(
    process.env.CQ_CHROME ? { executablePath: process.env.CQ_CHROME } : {});
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
  /* スクショ検収（M6.5§3）。番号を頭に付けて撮った順に並ぶようにする。 */
  const shots = [];
  let shotNo = 0;
  const shot = async (name) => {
    const file = path.join(SHOT_DIR, String(++shotNo).padStart(2, '0') + '_' + name + '.png');
    await page.screenshot({ path: file });
    shots.push(file);
  };

  await page.waitForTimeout(400);

  // --- 0) 目覚めの場面（M6.6 WP1。localStorageが空＝初回起動なので必ず出る） ---
  const hasOpening = !!(await page.$('.opening-scene'));
  ok('初回起動で目覚めの場面が出る（M6.6 WP1）', hasOpening);
  if (hasOpening) {
    await page.waitForTimeout(2200);         // 背景・肖像のフェードインが終わってから撮る
    await shot('opening');
    await page.click('[data-act="opening-skip"]');
    await wait(() => page.$('.area-grid'));
  }

  /* WP4が無いあいだの仮の持ち出し（冒頭のコメント参照）。ここから先は「デッキ40枚を持って
   * 出発できる状態のプレイヤー」として検証する。 */
  await page.evaluate((starter) => {
    const deck = {};
    starter.forEach((id) => { deck[id] = (deck[id] || 0) + 1; });
    localStorage.setItem('cq_meta', JSON.stringify({
      book: {}, deck: deck, known: Array.from(new Set(starter)),
      gold: 500, cleared: [], openingSeen: true
    }));
    localStorage.removeItem('cq_run');
  }, STARTER);
  await page.reload();
  await page.waitForTimeout(500);

  // --- 1) ラン画面が最初から開く。エリア選択 ---
  ok('「ラン」タブが最初から開いている', await page.$eval('.tab[data-screen="screen-run"]', (e) => e.classList.contains('on')));
  const tiles = await page.$$('.area-tile');
  ok('エリアが2つ出る（草原・森）', tiles.length === 2, String(tiles.length));
  const forestLocked = await page.$('.area-tile.locked');
  ok('森はロック表示', !!forestLocked);
  await shot('area-select');

  // --- 2) 草原を選ぶ → おまかせドラフト ---
  const grassTile = await page.$$eval('.area-tile', (els) => els.findIndex((e) => !e.classList.contains('locked')));
  (await page.$$('.area-tile'))[grassTile].click();
  await wait(() => page.$('.draft-row'));
  ok('草原を選ぶとドラフト画面が出る', !!(await page.$('.draft-row')));
  await shot('start-node-draft');

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
  /* M6.5b：ボスがマップ内に収まっているか（旧配置は x=1210 で右端から見切れていた）。
   * 見た目の話だが座標なので機械的に測れる。スクショと合わせて確認する。 */
  const bossBox = await page.$eval('.map-node.boss', (e) => {
    const b = e.getBoundingClientRect(); const m = e.closest('.run-map').getBoundingClientRect();
    return { right: b.right, mapRight: m.right };
  });
  ok('ボスがマップの右端で見切れない（M6.5b）', bossBox.right <= bossBox.mapRight + 0.5,
    `boss.right=${bossBox.right.toFixed(0)} map.right=${bossBox.mapRight.toFixed(0)}`);
  ok('道の合流点（辻）が描かれている（M6.5b）', (await page.$$('.road-joint')).length >= 2,
    String((await page.$$('.road-joint')).length));
  await page.waitForTimeout(400);
  await shot('map');

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
    await shot('node-' + t);
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
    await shot('node-battle');
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
  /* M6.5a でブラウザ標準の confirm() からゲーム内ダイアログに変わっているので、
   * 確認ダイアログの「リタイヤする」を明示的に押す。 */
  await page.click('[data-act="retire"]');
  await wait(() => page.$('[data-act="cq-confirm-yes"]'));
  ok('リタイヤ確認がゲーム内ダイアログで出る', !!(await page.$('.cq-confirm-box')));
  await page.click('[data-act="cq-confirm-yes"]');
  await wait(() => page.$('[data-act="back-home"]'));
  ok('リタイヤすると結果画面が出る', !!(await page.$('[data-act="back-home"]')));
  await shot('result');
  await page.click('[data-act="back-home"]');
  await wait(() => page.$('.area-grid'));
  ok('結果画面からエリア選択に戻れる', !!(await page.$('.area-grid')));

  // --- 7) 霧の出た森のマップ（M6.5b） ---
  /* 森を解放した状態にして、霧が出るまでランを引き直す（森の霧は50%なので数回で当たる）。
   * 霧は生成時に決まるので、当たるまでリタイヤして始め直すのがいちばん素直な引き方。 */
  await page.evaluate((starter) => {
    const deck = {};
    starter.forEach((id) => { deck[id] = (deck[id] || 0) + 1; });
    localStorage.setItem('cq_meta', JSON.stringify({
      book: {}, deck: deck, known: Array.from(new Set(starter)),
      gold: 500, cleared: ['grassland'], openingSeen: true
    }));
    localStorage.removeItem('cq_run');
  }, STARTER);
  await page.reload();
  await wait(() => page.$('.area-grid'));

  let foggy = false;
  for (let attempt = 0; attempt < 12 && !foggy; attempt++) {
    const forest = await page.$$eval('.area-tile', (els) => els.findIndex((e) => e.dataset.id === 'forest'));
    (await page.$$('.area-tile'))[forest].click();
    await wait(() => page.$('.draft-row'));
    foggy = await page.evaluate(() => !!(RUI.run && RUI.run.map.fog.active));
    if (!foggy) {
      /* 外れ：このランは捨てて引き直す。開始マス（ドラフト画面）にはリタイヤボタンが無いので、
       * 中断中のランを消して読み込み直すのがいちばん確実。 */
      await page.evaluate(() => localStorage.removeItem('cq_run'));
      await page.reload();
      await wait(() => page.$('.area-grid'));
      continue;
    }
    for (let i = 0; i < 3; i++) {
      const cards = await page.$$('.draft-card');
      if (!cards.length) break;
      await cards[cards.length - 1].click();
      await page.waitForTimeout(180);
    }
    if (await page.$('[data-act="depart"]')) {
      await page.click('[data-act="depart"]');
      await wait(() => page.$('.run-map'));
    }
  }
  ok('霧の出た森のランを引けた', foggy, foggy ? '' : '12回引いて霧なし（確率的な失敗の可能性）');
  if (foggy) {
    await page.waitForTimeout(600);
    ok('霧のベールが出る（M6.5b）', !!(await page.$('.fog-layer')));
    ok('霧の中の敵はシルエットになる（M6.5b）', (await page.$$('.node-cutout.silhouette')).length > 0,
      String((await page.$$('.node-cutout.silhouette')).length) + '体');
    ok('霧の中の非戦闘マスは「？」になる（M6.5b）', (await page.$$('.node-silhouette')).length > 0,
      String((await page.$$('.node-silhouette')).length) + 'マス');
    await shot('map-fog');
    /* 霧払い＝溶ける演出（§5）。ショップに寄らずとも描画は確かめられるので、
     * ここではフラグを立てた状態を1枚撮って「溶けている途中」を記録に残す。 */
    await page.evaluate(() => {
      RUI.run.map.fog.cleared = true; RUI.fogDissolving = true; runRender();
    });
    await page.waitForTimeout(500);
    await shot('map-fog-dissolving');
    await page.waitForTimeout(1200);
    ok('霧払い後は霧のベールが消える（M6.5b）', !(await page.$('.fog-layer')) || await page.$eval('.fog-layer', (e) => +getComputedStyle(e).opacity < 0.05));
    await shot('map-fog-cleared');
  }

  ok('コンソールエラーなし', errors.length === 0, errors.slice(0, 5).join(' / '));

  await browser.close();
  let fail = 0;
  results.forEach(([st, name, extra]) => {
    if (st === 'FAIL') fail++;
    console.log(`${st === 'PASS' ? '✓' : '✗'} ${name}${extra ? '  … ' + extra : ''}`);
  });
  console.log(`\n${results.length - fail} passed / ${fail} failed`);
  console.log(`\nスクショ ${shots.length} 枚 → ${SHOT_DIR}`);
  console.log('『実装計画追補M6.5』§3 のチェックリストと突き合わせて目視確認すること。');
  process.exit(fail ? 1 : 0);
})();
