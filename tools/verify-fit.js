/* 画面の収まり検証（Playwright／ヘッドレスChromium）
 *
 * 「タブレットで画面の端が切れる」（2026-08-24 本人の指摘）の再発防止用。
 * いろいろな表示条件で #app が **見えている領域の中に完全に収まっている** ことを確認する。
 *
 *   ・ふつうの画面サイズ（1280×800 ちょうど／それより大きい／小さい）
 *   ・visualViewport が innerHeight より小さいとき
 *     ＝Androidブラウザで上のURLバーが出ている状態。これが実機で端が切れた原因
 *   ・セーフエリア（丸角・切り欠き）が効いているとき
 *
 * 使い方： python3 -m http.server 8321 を立ててから node tools/verify-fit.js
 */
'use strict';
const { chromium } = require('playwright');

const URL = 'http://localhost:8321/index.html';
const APP_W = 1280, APP_H = 800;

/* 画面条件：[幅, 高さ, 見えている高さ(=visualViewport。null なら同じ), セーフエリアpx, 説明] */
const CASES = [
  [1280, 800, null, 0, '1280×800 ちょうど'],
  [1920, 1080, null, 0, 'ＰＣの大きな画面'],
  [1280, 800, 700, 0, 'タブレット横：上にURLバー（見える高さ700）'],
  [1280, 800, 752, 0, 'タブレット横：URLバーが細い（見える高さ752）'],
  [1280, 800, null, 24, 'セーフエリア24px（丸角・切り欠き）'],
  [1280, 800, 720, 16, 'URLバー＋セーフエリアの両方'],
  [1000, 640, null, 0, '小さい画面（縮小表示）'],
  [800, 1280, null, 0, '縦向き']
];

(async () => {
  const browser = await chromium.launch();
  const results = [];
  for (const [w, h, vvH, sa, note] of CASES) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    /* visualViewport を小さく見せる＝URLバーで見える範囲が狭い状態の再現。
       セーフエリアは env() を上書きできないので、プローブ要素の padding を直接盛って再現する */
    await page.addInitScript(([vvH, sa]) => {
      if (vvH) {
        const real = window.visualViewport;
        const fake = {
          width: window.innerWidth, height: vvH, offsetLeft: 0, offsetTop: 0, scale: 1,
          addEventListener: (t, f) => real && real.addEventListener(t, f),
          removeEventListener: (t, f) => real && real.removeEventListener(t, f)
        };
        Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true });
      }
      if (sa) {
        window.addEventListener('DOMContentLoaded', () => {
          const st = document.createElement('style');
          st.textContent = '#sa-probe{padding:' + sa + 'px !important}';
          document.head.appendChild(st);
          setTimeout(() => window.dispatchEvent(new Event('resize')), 0);
        });
      }
    }, [vvH, sa]);
    await page.goto(URL);
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => {
      const a = document.getElementById('app').getBoundingClientRect();
      const p = document.getElementById('sa-probe');
      const cs = p ? getComputedStyle(p) : null;
      return {
        l: a.left, t: a.top, r: a.right, b: a.bottom, w: a.width, h: a.height,
        iw: window.innerWidth, ih: window.innerHeight,
        vv: window.visualViewport ? window.visualViewport.height : null,
        scale: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-scale')),
        sa: cs ? parseFloat(cs.paddingTop) || 0 : 0
      };
    });
    /* 実際に見えている領域 */
    const visW = Math.min(r.iw, r.vv ? r.iw : r.iw);
    const visH = Math.min(r.ih, r.vv == null ? r.ih : r.vv);
    const eps = 0.6;                     // 小数の丸めぶんだけ許容
    const inside = r.l >= r.sa - eps && r.t >= r.sa - eps
      && r.r <= visW - r.sa + eps && r.b <= visH - r.sa + eps;
    /* 中身の縦横比が保たれているか（1280×800 の箱をそのまま縮めているか） */
    const ratio = Math.abs(r.w / r.h - APP_W / APP_H) < 0.01;
    /* 使える範囲をむだに余らせていないか（片方の辺はほぼ一杯まで使う。1.0で頭打ちの場合を除く） */
    const usable = r.scale >= 0.999
      || Math.abs(r.w - (visW - r.sa * 2)) < 14 || Math.abs(r.h - (visH - r.sa * 2)) < 14;
    const okAll = inside && ratio && usable;
    results.push([okAll, note,
      `app=${r.w.toFixed(0)}×${r.h.toFixed(0)} @(${r.l.toFixed(0)},${r.t.toFixed(0)}) `
      + `scale=${r.scale.toFixed(3)} 見える領域=${visW}×${visH} safe=${r.sa}`
      + (inside ? '' : ' ★はみ出し') + (ratio ? '' : ' ★比率崩れ') + (usable ? '' : ' ★余りすぎ')]);
    await page.close();
  }
  /* 仕上げ：縮小表示のまま4タブすべてで #app からのはみ出しが無いことを見る。
     内部スクロールする箱（デッキ一覧・説明文）の中身は対象外＝仕様どおりのスクロール */
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      const fake = { width: 1280, height: 700, offsetLeft: 0, offsetTop: 0, scale: 1,
        addEventListener() {}, removeEventListener() {} };
      Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true });
    });
    await page.goto(URL);
    await page.waitForTimeout(1500);
    for (const t of ['screen-battle', 'screen-deck', 'screen-sim', 'screen-notes']) {
      await page.click('.tab[data-screen="' + t + '"]');
      await page.waitForTimeout(300);
      const worst = await page.evaluate((id) => {
        const app = document.getElementById('app').getBoundingClientRect();
        const inScroller = (el) => {
          for (let p = el.parentElement; p && p.id !== 'app'; p = p.parentElement) {
            const o = getComputedStyle(p);
            if (/(auto|scroll)/.test(o.overflowY + o.overflowX)) return true;
          }
          return false;
        };
        let w = 0;
        document.querySelectorAll('#' + id + ', #' + id + ' *').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || inScroller(el)) return;
          w = Math.max(w, app.left - r.left, app.top - r.top, r.right - app.right, r.bottom - app.bottom);
        });
        return Math.round(w);
      }, t);
      results.push([worst <= 2, '縮小表示中 ' + t + ' のはみ出し', worst + 'px']);
    }
    await page.close();
  }

  await browser.close();
  results.forEach(([o, n, d]) => console.log((o ? 'PASS' : 'FAIL') + ' ' + n + '  … ' + d));
  const fail = results.filter(([o]) => !o).length;
  console.log(fail ? fail + ' 件 FAIL' : 'すべて画面内に収まっています');
  process.exit(fail ? 1 : 0);
})();
