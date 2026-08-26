/* M6 戦場ルールのＵＩ検証（Playwright／ヘッドレスChromium）
 *
 *   1) 「戦場」ボタンで5種のルールを切り替え、「新しい対戦」で確定できる
 *   2) 有効なルールのアイコンがターン表示の隣に常時出る（追補§M6「戦闘前に必ず見える」）
 *   3) アイコンを押すと右のパネルに説明が出る
 *   4) 定期爆撃はカウントダウンが出て、ターンが進むと数字が減る
 *   5) 使えない列（laneLock）には蓋が被さり、そこには何も置けない
 *   6) おじゃま虫が実際に手札に現れ、チャネリングしようとすると理由が出る
 *   7) 一連の操作でコンソールエラーが出ない
 *
 * 使い方（別のターミナルで簡易サーバを立ててから）:
 *   python3 -m http.server 8321 &
 *   node tools/verify-field-rules.js
 */
'use strict';
const { chromium } = require('playwright');

const URL = process.env.CQ_URL || 'http://localhost:8321/index.html';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (msg) => {
    /* 絵の無いカード（空白180・おじゃま虫200など）の画像404は文字表示にフォールバックする
       正常動作。ブラウザのconsoleにはURLが載らないので、リソース読み込み失敗は
       下の response ハンドラ側（URLで判定できる）に任せてここでは無視する */
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  /* 404 は「どのファイルか」まで出さないと直せない。カードの絵の欠けだけは除外する */
  page.on('response', (r) => {
    if (r.status() >= 400 && !/assets\/cards\/\d+\.png/.test(r.url())) {
      errors.push('HTTP ' + r.status() + ' ' + r.url());
    }
  });
  await page.goto(URL);

  const results = [];
  const ok = (name, cond, extra) => results.push([cond ? 'PASS' : 'FAIL', name, extra || '']);
  const phaseText = () => page.$eval('#turnbox .tw', (e) => e.textContent);
  const fieldLabel = () => page.$eval('#turnbox [data-act="field"]', (e) => e.textContent);
  const waitPhase = async (re, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 15000)) {
      if (re.test(await phaseText())) return true;
      await page.waitForTimeout(120);
    }
    return false;
  };
  /** 「戦場」ボタンを押して目的のルールに合わせ、新しい対戦を始める。
   * ＵＩは配布・召還の演出のたびにターン表示を作り直すので、押した瞬間に要素が
   * 差し替わってクリックが空振りすることがある。実際に切り替わったかを確かめてから次へ進む */
  async function startWith(label) {
    for (let i = 0; i < 24; i++) {
      if ((await fieldLabel()).indexOf(label) >= 0) break;
      const before = await page.evaluate(() => fieldSet);
      await page.click('#turnbox [data-act="field"]').catch(() => {});
      for (let w = 0; w < 10; w++) {
        if (await page.evaluate((b) => fieldSet !== b, before)) break;
        await page.waitForTimeout(60);
      }
    }
    ok('戦場ルールを「' + label + '」に切り替えられる', (await fieldLabel()).indexOf(label) >= 0,
       await fieldLabel());
    await page.click('#turnbox [data-act="new"]');
    await waitPhase(/配置ステップ/, 15000);
    await page.waitForTimeout(900);
  }

  await waitPhase(/配置ステップ/, 15000);

  // --- 1) ルール無し（従来どおり）：アイコンは出ない ---
  await startWith('なし');
  ok('ルール無しではアイコンが出ない', (await page.$$('.fchip')).length === 0);

  // --- 2) 高ＣＨ禁止 ---
  await startWith('高ＣＨ禁止');
  const chip = await page.$('.fchip');
  ok('高ＣＨ禁止のアイコンが出る', !!chip);
  if (chip) {
    await chip.click();
    await page.waitForTimeout(200);
    const txt = await page.$eval('#info-fix', (e) => e.textContent);
    ok('アイコンを押すと説明が出る', /召還できません/.test(txt), txt.slice(0, 40));
    await page.click('#info-fix [data-act="cancel"]').catch(() => {});
  }

  // --- 3) 定期爆撃：カウントダウンが出て、ターンが進むと減る ---
  await startWith('定期爆撃');
  const cd0 = await page.$eval('.fchip b', (e) => e.textContent).catch(() => null);
  ok('着弾までのカウントダウンが出る', !!cd0 && /あと|着弾/.test(cd0), String(cd0));
  await page.click('#acts [data-act="end-place"]').catch(() => {});
  await page.waitForTimeout(300);
  await page.click('#acts [data-act="end-turn"]').catch(() => {});
  await waitPhase(/あなた：配置ステップ/, 30000);
  await page.waitForTimeout(600);
  const cd1 = await page.$eval('.fchip b', (e) => e.textContent).catch(() => null);
  ok('ターンが進むとカウントダウンが減る', cd0 !== cd1, `${cd0} → ${cd1}`);

  // --- 4) 封鎖の列：蓋が被さり、押すと説明が出る ---
  await startWith('封鎖の列');
  const lid = await page.$('.lane.locked .lane-lid');
  ok('使えない列に蓋が被さる', !!lid);
  ok('蓋の列には空きレーンの札が出ない', (await page.$$('.lane.locked .empty-unit')).length === 0);
  if (lid) {
    await lid.click();
    await page.waitForTimeout(200);
    ok('蓋を押すと説明が出る', /使えません/.test(await page.$eval('#info-fix', (e) => e.textContent)));
    await page.click('#info-fix [data-act="cancel"]').catch(() => {});
  }

  // --- 5) 岩の列：制限された列の上限が減っている ---
  await startWith('岩の列');
  ok('岩の列のアイコンが出る', (await page.$$('.fchip')).length === 1);
  const caps = await page.evaluate(() => M.board.fieldCap);
  ok('レーン1と4のＣＨ上限が2に制限されている',
    caps[1] === 2 && caps[4] === 2 && caps[0] === null, JSON.stringify(caps));

  // --- 6) おじゃま虫：手番を進めると手札に現れ、置こうとすると断られる ---
  await startWith('おじゃま虫');
  let gotPest = false;
  for (let n = 0; n < 16 && !gotPest; n++) {
    // 決着が付いていたら同じルールで仕切り直す（何もせず手番を渡し続けるので早く負ける）
    if (await page.$('#acts [data-act="new"]')) {
      await page.click('#acts [data-act="new"]').catch(() => {});
      await waitPhase(/配置ステップ/, 15000);
      await page.waitForTimeout(600);
    }
    // 手札を減らしておく（実際のプレイでは召還・チャネルで減る）。7枚のまま放置すると
    // 「手札が満杯なら投げ込まない」という仕様が正しく働いて、永久に現れない
    await page.evaluate(() => { while (M.players.self.hand.length > 4) M.players.self.hand.pop(); });
    if (await page.$('#acts [data-act="end-place"]')) {
      await page.click('#acts [data-act="end-place"]').catch(() => {});
      await page.waitForTimeout(200);
    }
    if (await page.$('#acts [data-act="end-turn"]')) {
      await page.click('#acts [data-act="end-turn"]').catch(() => {});
    }
    await waitPhase(/あなた：配置ステップ|勝ち|負け/, 30000);
    await page.waitForTimeout(400);
    gotPest = await page.evaluate(() => M.players.self.hand.indexOf(200) >= 0);
  }
  ok('数手番でおじゃま虫が手札に投げ込まれる', gotPest,
     '投入カウンタ=' + await page.evaluate(() => (M.fieldState || {}).pest));
  if (gotPest) {
    const r = await page.evaluate(() => {
      const i = M.players.self.hand.indexOf(200);
      /* チャネル先のユニットが居ないことがあるので、判定用に1体立てておく */
      if (!M.board.lanes.some((l, k) => k < 3 && l.unit != null)) {
        M.board.lanes[0] = CQState.makeLane(8, [], CARD_BY_ID);
        CQStats.recalc(M.board, { cards: CARD_BY_ID });
      }
      const lane = M.board.lanes.findIndex((l, k) => k < 3 && l.unit != null);
      M.phase = 'placement';
      return CQTurn.channel(M, lane, i);
    });
    ok('おじゃま虫はチャネリングできない（理由が返る）',
      r.ok === false && /おじゃま虫/.test(r.reason), JSON.stringify(r));
  }

  // --- 7) おじゃま虫を配置ステップで捨てる（v0.15.5） ---
  if (gotPest) {
    // 直前の判定で phase を書き換えているので、配置ステップの状態に戻して描画し直す
    await page.evaluate(() => { M.phase = 'placement'; renderAll(); });
    await page.waitForTimeout(300);
    const pestEl = await page.$('#hand .hand-card[data-card="200"]');
    ok('手札のおじゃま虫が見つかる', !!pestEl);
    if (pestEl) {
      const b = await pestEl.boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + 14);
      await page.waitForTimeout(300);
      const txt = await page.$eval('#info-fix', (e) => e.textContent);
      ok('押すと「捨てますか？」の確認が出る', /捨てますか/.test(txt), txt.slice(0, 30));
      await page.click('#info-fix [data-act="ok"]').catch(() => {});
      await page.waitForTimeout(500);
      ok('捨てると手札から消える',
        await page.evaluate(() => M.players.self.hand.indexOf(200) < 0));
      // 2枚目は同じターンには捨てられない（エンジンの理由がそのまま出る）
      const second = await page.evaluate(() => {
        M.players.self.hand.push(200);
        return CQTurn.canDiscardPest(M, M.players.self.hand.length - 1);
      });
      ok('同じターンの2枚目は理由付きで断られる',
        second.ok === false && /1ターンに1枚/.test(second.reason), JSON.stringify(second));
    }
  }

  ok('コンソールエラーなし', errors.length === 0, errors.slice(0, 3).join(' / '));

  await browser.close();
  let fail = 0;
  results.forEach(([st, name, extra]) => {
    if (st === 'FAIL') fail++;
    console.log(`${st === 'PASS' ? '✓' : '✗'} ${name}${extra ? '  … ' + extra : ''}`);
  });
  console.log(`\n${results.length - fail} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
