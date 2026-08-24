/* v0.13.4 のＵＩ検証（Playwright／ヘッドレスChromium）
 * 1) 初期配布のスライドイン・配置ステップ到達
 * 2) メインステップではカードを置けない（droppable が出ない・理由が出る）
 * 3) リバース＝裏返した瞬間に「行動済」が出る・同レーンの続きは開ける
 * 4) 自動対戦ファズ中に、戦闘の当事者表示（dimmed / fight-tag / 迎撃ボタン）と
 *    各演出（an-in / an-flip / an-deal / shatter）が実際に現れることを目視代わりに記録
 * 5) コンソールエラー 0 件
 */
'use strict';
const { chromium } = require('playwright');

const URL = 'http://localhost:8321/index.html';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/cards\/\d+\.png/.test(msg.text())) errors.push(msg.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  // 演出マーカーの観測を仕込む（DOMの変化ごとに記録。リロードにも耐えるよう addInitScript で）
  await page.addInitScript(() => {
    window.__seen = window.__seen || {};
    window.addEventListener('DOMContentLoaded', () => {
      const sels = {
        deal: '.hand-card.an-deal', inTop: '#board .card.an-in', inLeft: '#board .card.an-in-left',
        flip: '#board .card.an-flip', out: '#board .card.an-out', shard: '.cq-shard-box',
        dimmed: '.lane.dimmed', fightTag: '.fight-tag', endBtn: '#acts .act-btn.warn'
      };
      const scan = () => {
        for (const k in sels) {
          const el = document.querySelector(sels[k]);
          if (el) window.__seen[k] = (k === 'endBtn') ? el.textContent : true;
        }
      };
      new MutationObserver(scan).observe(document.documentElement,
        { subtree: true, attributes: true, childList: true });
      setInterval(scan, 40);
    });
  });
  await page.goto(URL);

  const results = [];
  const ok = (name, cond) => results.push([cond ? 'PASS' : 'FAIL', name]);
  const phaseText = () => page.$eval('#turnbox .tw', (e) => e.textContent);
  const waitPhase = async (re, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 8000)) {
      if (re.test(await phaseText())) return true;
      await page.waitForTimeout(120);
    }
    return false;
  };

  // --- 1) 初期状態：配置ステップに到達・手札が配られている ---
  ok('配置ステップに到達', await waitPhase(/配置ステップ/, 8000));
  await page.waitForTimeout(1200);
  const handN = await page.$$eval('#hand .hand-card', (a) => a.length);
  ok('手札が6枚配られた', handN === 6);

  // --- ユニットを1体召還（ドラッグ）＋チャネル1枚 ---
  async function dragTo(fromSel, toSel) {
    const f = await page.$(fromSel); const t = await page.$(toSel);
    if (!f || !t) return false;
    const fb = await f.boundingBox(); const tb = await t.boundingBox();
    if (!fb || !tb) return false;
    await page.mouse.move(fb.x + fb.width / 2, fb.y + 20);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(fb.x + (tb.x - fb.x) * i / 6 + tb.width / 2 * (i === 6 ? 1 : 0),
        fb.y + (tb.y + tb.height - 40 - fb.y) * i / 6);
      await page.waitForTimeout(30);
    }
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height - 40);
    await page.waitForTimeout(50);
    await page.mouse.up();
    await page.waitForTimeout(700);   // 演出待ち
    return true;
  }
  // 手札からユニット（.hand-card.U）を自陣レーン0へ
  await dragTo('#hand .hand-card.U', '.lane[data-lane="0"]');
  let unit0 = await page.$('.card.unit[data-lane="0"]');
  ok('ドラッグで召還できる', !!unit0);
  // 続けて2枚をレーン0へ（チャネル。開いても消えない技能・魔法カードを選ぶ。
  // ユニットカードだと開いた瞬間にリバース召還で階層から消え、めくり演出の検証にならない）
  await dragTo('#hand .hand-card.S, #hand .hand-card.M', '.lane[data-lane="0"]');
  await dragTo('#hand .hand-card.S, #hand .hand-card.M', '.lane[data-lane="0"]');
  const ch01 = await page.$('.card.ch[data-lane="0"][data-layer="1"]');
  ok('ドラッグでチャネルできる', !!ch01);

  // --- 2) メインステップでは置けない ---
  await page.click('#acts [data-act="end-place"]');
  await page.waitForTimeout(400);
  ok('メインステップに到達', /メインステップ/.test(await phaseText()));
  // 手札カードを押してもドラッグにならず情報表示になる
  const hc = await page.$('#hand .hand-card');
  if (hc) {
    const hb = await hc.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + 20);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y - 200, { steps: 8 });
    const droppableN = await page.$$eval('.lane.droppable', (a) => a.length);
    await page.mouse.up();
    ok('メインステップでは置ける場所が光らない', droppableN === 0);
    const ghostN = await page.$$eval('.ghost', (a) => a.length);
    ok('メインステップではドラッグ自体が始まらない', ghostN === 0);
  }
  await page.waitForTimeout(300);

  // --- 3) リバース＝即硬直・同レーン継続 ---
  // 召還・チャネルしたターンは硬直しているので、ターンを渡して自分の次のターンで検証する
  await page.click('#acts [data-act="end-turn"]');
  ok('相手のターンを経て自分の配置ステップに戻る', await waitPhase(/あなた：配置ステップ/, 30000));
  await page.waitForTimeout(600);
  if (await page.$('#acts [data-act="end-place"]')) {
    await page.click('#acts [data-act="end-place"]');
    await page.waitForTimeout(400);
  }
  const flip1 = await page.$('.card.ch.flippable[data-lane="0"][data-layer="1"]');
  ok('メインステップで▶付きの裏カードがある（※敵に破壊されていたら以下は仕様上スキップ）', !!flip1 || !(await page.$('.card.unit[data-lane="0"]')));
  if (flip1) {
    const b = await flip1.boundingBox();
    await page.mouse.click(b.x + b.width * 0.25, b.y + 14);
    await page.waitForTimeout(800);   // めくり演出＋硬直表示待ち
    const opened = await page.$eval('.card.ch[data-lane="0"][data-layer="1"]',
      (e) => !e.classList.contains('back'));
    ok('タップで開いた', opened);
    const stiffTag = await page.$('.card.unit[data-lane="0"] .st-tag');
    ok('裏返した瞬間にユニットが「行動済」になる', !!stiffTag);
    const flip2 = await page.$('.card.ch.flippable[data-lane="0"][data-layer="2"]');
    ok('硬直していても同じレーンの上の階層は続けて開ける（▶が残る）', !!flip2
      || !(await page.$('.card.ch[data-lane="0"][data-layer="2"]')));   // 2階層目が消えていたら対象外
  }

  // --- 4) 自動対戦ファズ：戦闘表示と演出の観測＋エラーなし ---
  // ターンを終了し、以後はランダムに操作しながら演出マーカーを収集する
  const clickables = ['#acts .act-btn', '.card.ch.openable', '.card.ch.flippable',
    '.card.unit', '#hand .hand-card', '.lane', '#info-fix .btn'];
  const t0 = Date.now();
  let sawBattlePanel = false;
  while (Date.now() - t0 < 120000) {
    // 勝敗が付いたら「もう一度」
    const again = await page.$('#acts [data-act="new"]');
    if (again) { await again.click().catch(() => {}); await page.waitForTimeout(800); continue; }
    // 戦闘中の防御側なら、たまに▶を開き、たまに「迎撃を終える」
    const endBtn = await page.$('#acts .act-btn.warn');
    if (endBtn) {
      sawBattlePanel = true;
      const open = await page.$('.card.ch.openable');
      if (open && Math.random() < 0.6) {
        const b = await open.boundingBox();
        if (b) await page.mouse.click(b.x + b.width * 0.25, b.y + 12).catch(() => {});
      } else await endBtn.click().catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }
    // それ以外：ランダム操作（ドラッグ攻撃・配置・ボタン）
    const sel = clickables[Math.floor(Math.random() * clickables.length)];
    const els = await page.$$(sel);
    if (els.length) {
      const el = els[Math.floor(Math.random() * els.length)];
      const b = await el.boundingBox().catch(() => null);
      if (b) {
        if (Math.random() < 0.35 && (sel === '.card.unit' || sel === '#hand .hand-card')) {
          // ドラッグ（攻撃 or 配置）
          const lanes = await page.$$('.lane');
          const tl = lanes[Math.floor(Math.random() * lanes.length)];
          const tb = tl && await tl.boundingBox();
          if (tb) {
            await page.mouse.move(b.x + b.width / 2, b.y + 16);
            await page.mouse.down();
            await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height - 50, { steps: 6 });
            await page.mouse.up();
          }
        } else {
          await page.mouse.click(b.x + Math.random() * b.width, b.y + Math.min(14, b.height / 2)).catch(() => {});
        }
      }
    }
    await page.waitForTimeout(180);
  }

  const seen = (await page.evaluate(() => window.__seen).catch(() => null)) || {};
  ok('手札配布のスライドインを観測', !!seen.deal);
  ok('場に出るスライドインを観測', !!seen.inTop);
  ok('めくり演出を観測', !!seen.flip);
  ok('戦闘中に他レーンが暗くなるのを観測', !!seen.dimmed);
  ok('攻撃／防御の札を観測', !!seen.fightTag);
  ok('右下の終了ボタン（迎撃を終える／オープンを終える）を観測',
    typeof seen.endBtn === 'string' && /(迎撃|オープン)を終える/.test(seen.endBtn));
  ok('破壊の粉砕演出を観測', !!seen.shard);
  ok('防御側オープンフェイズに入った', sawBattlePanel);
  ok('コンソールエラー0件', errors.length === 0);

  console.log(results.map(([s, n]) => s + ' ' + n).join('\n'));
  if (errors.length) console.log('ERRORS:\n' + errors.slice(0, 10).join('\n'));
  await browser.close();
  process.exit(results.some(([s]) => s === 'FAIL') ? 1 : 0);
})();
