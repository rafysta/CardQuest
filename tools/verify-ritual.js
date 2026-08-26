/* 生贄召還（v0.15.3／実装計画M5.8）の検証（Playwright／ヘッドレスChromium）
 *
 * 実ブラウザに読み込ませた本物のＵＩ・エンジンで、盤面を直接セットして決定的に確かめる
 * （verify-destroy-pick.js と同じ方式。ランダムファズだと狙った盤面が出ないため）。
 *
 *   ・召還Ｌｖ2以上のユニットカードを開こうとすると、生贄の内訳を示す確認が出る
 *   ・ＯＫでホストが生贄になり、下のカードを引き継いで跡地に立つ（ＬＰは減らない・硬直しない）
 *   ・キャンセルすると何も起きない（カードも開かない）
 *   ・儀式が成立しない場合は「破壊されます」と理由が出る
 *   ・相手が置いた裏向きカードでは確認を出さない（ＵＩが中身を知っていることが漏れない）
 *   ・召還Ｌｖ1では確認を出さず、従来どおり即オープン
 *
 * 使い方： python3 -m http.server 8321 を立ててから node tools/verify-ritual.js
 */
'use strict';
const { chromium } = require('playwright');

const URL = 'http://localhost:8321/index.html';
const res = [];
function ck(ok, note, detail) { res.push([ok, note, detail || '']); }

/** 盤面を直接組み立てる。chs は [カードID, 表向きか, 自分が置いたか] の配列 */
async function setup(page, spec) {
  await page.evaluate((s) => {
    M.phase = 'main'; M.active = 'self'; M.turn = 5; M.winner = null; M.combat = null;
    M.players.self.turnsTaken = 3; M.players.self.lp = 10;
    for (let i = 0; i < 6; i++) M.board.lanes[i] = CQState.emptyLane();
    M.board.lanes[0] = CQState.makeLane(s.host, s.chs.map(function (c) {
      return { card: c[0], up: !!c[1], mine: c[2] === undefined ? true : c[2] };
    }), CARD_BY_ID);
    if (s.foe) M.board.lanes[3] = CQState.makeLane(s.foe, [], CARD_BY_ID);
    CQStats.recalc(M.board, { cards: CARD_BY_ID });
    UI.mode = 'idle'; UI.pending = null; renderAll();
  }, spec);
  await page.waitForTimeout(250);
}

/** そのＣＨカードの見えている帯の左半分を押す（＝開く。v0.13.3の左右分割タップ） */
async function flip(page, layer) {
  const sel = '#board .card.ch[data-lane="0"][data-layer="' + layer + '"]';
  await page.waitForSelector(sel, { timeout: 8000 });
  const box = await page.$eval(sel, function (el) {
    const s = el.querySelector('.strip') || el;
    const r = s.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.click(box.x + box.w * 0.25, box.y + box.h * 0.7);
  await page.waitForTimeout(450);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/cards\/\d+\.png/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  await page.goto(URL);
  await page.waitForFunction(() => typeof M !== 'undefined' && M && M.board, null, { timeout: 8000 });
  await page.waitForFunction(() => typeof busy !== 'undefined' && !busy, null, { timeout: 8000 });

  /* ---- 1. 儀式が成立する盤面：確認が出て、押すまでは何も起きない ---- */
  await setup(page, { host: 2, chs: [[180], [180], [180], [180], [12]] });
  await flip(page, 5);
  let st = await page.evaluate(() => ({
    mode: UI.mode, host: M.board.lanes[0].unit,
    txt: document.getElementById('info-fix').innerText
  }));
  ck(st.mode === 'confirm', '生贄召還の確認が出る', 'UI.mode=' + st.mode);
  ck(/生贄/.test(st.txt), '「生贄」の文言が出る');
  ck(/4枚/.test(st.txt), '引き継ぐ枚数（4枚）が示される');
  ck(/ＬＰは減りません/.test(st.txt), 'ＬＰが減らないことが書いてある');
  ck(st.host === 2, '押すまではホストが無事');

  /* ---- 2. ＯＫで実行される ---- */
  await page.click('#info-fix [data-act="ok"]');
  await page.waitForTimeout(1000);
  st = await page.evaluate(() => ({
    unit: M.board.lanes[0].unit, ch: M.board.lanes[0].channels.length,
    lp: M.players.self.lp, stiff: M.board.lanes[0].stiff, def: M.board.lanes[0].def
  }));
  ck(st.unit === 12, 'ホストの跡地にウロボロスが立つ', 'unit=' + st.unit);
  ck(st.ch === 4, '下の4枚を引き継ぐ', 'ch=' + st.ch);
  ck(st.lp === 10, 'ＬＰが減っていない（生贄はsuppress）', 'lp=' + st.lp);
  ck(st.stiff === false, '硬直しない（その場で攻撃できる）');
  ck(st.def === 950, '引き継いだ4枚が防御力になる（550+400）', 'def=' + st.def);

  /* ---- 3. キャンセルすると何も起きない ---- */
  await setup(page, { host: 2, chs: [[180], [180], [180], [180], [12]] });
  await flip(page, 5);
  await page.click('#info-fix [data-act="cancel"]');
  await page.waitForTimeout(350);
  st = await page.evaluate(() => ({
    unit: M.board.lanes[0].unit, ch: M.board.lanes[0].channels.length,
    up: M.board.lanes[0].channels[4].up
  }));
  ck(st.unit === 2 && st.ch === 5 && !st.up, 'キャンセルで盤面が変わらない（開いてもいない）',
    JSON.stringify(st));

  /* ---- 4. 儀式が成立しない（救済が表向き）：破壊の警告と理由が出る ---- */
  await setup(page, { host: 2, chs: [[179, true], [180], [180], [180], [12]] });
  await flip(page, 5);
  st = await page.evaluate(() => ({ mode: UI.mode, txt: document.getElementById('info-fix').innerText }));
  ck(st.mode === 'confirm' && /破壊/.test(st.txt), '失敗する場合は破壊の警告が出る');
  ck(/救済/.test(st.txt), '理由（救済）が示される');

  /* ---- 5. 相手が置いた裏向きカードでは確認を出さない（情報が漏れない） ---- */
  await setup(page, { host: 2, chs: [[180], [180], [180], [180], [12, false, false]] });
  const known = await page.evaluate(() => chKnown(M.board.lanes[0].channels[4]));
  ck(known === false, '相手が置いた裏向きカードは中身が見えない');
  await flip(page, 5);
  st = await page.evaluate(() => UI.mode);
  ck(st !== 'confirm', '相手のカードでは確認を出さない（中身を知っていることが漏れない）', 'UI.mode=' + st);

  /* ---- 6. 召還Ｌｖ1では確認を出さない（従来どおり） ---- */
  await setup(page, { host: 2, chs: [[19]] });
  await flip(page, 1);
  st = await page.evaluate(() => ({ mode: UI.mode, host: M.board.lanes[0].unit }));
  ck(st.mode !== 'confirm', '召還Ｌｖ1では確認を出さない', 'UI.mode=' + st.mode);
  ck(st.host === 2, 'Ｌｖ1ではホストが生き残る（生贄なし）');

  ck(errors.length === 0, 'コンソールエラー0件', errors.slice(0, 3).join(' / '));

  await browser.close();
  res.forEach(([o, n, d]) => console.log((o ? 'PASS' : 'FAIL') + ' ' + n + (d ? '  … ' + d : '')));
  const fail = res.filter(([o]) => !o).length;
  console.log(fail ? fail + ' 件 FAIL' : 'すべて期待どおり動作しています');
  process.exit(fail ? 1 : 0);
})();
