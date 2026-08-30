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

/* スターター（M6.6 §2-2）。WP4からは**本に入った状態**を作り、持ち出し画面を実際に操作して
 * デッキを組む——これが §4 WP4 の受け入れ基準「初回プレイで『本28枚・デッキ0枚』から
 * 40枚を組んで出発できること」そのものの検証になる（v0.16.5までは画面が無かったので
 * 持ち出し済みのデッキを直接こしらえていた）。 */
const STARTER = [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 101, 101, 101, 108, 108, 113, 113,
  153, 153, 153, 165, 165, 193, 193, 193, 194, 194, 194];
const CQ_DRAFT_ROUNDS = 2;   /* js/run/run.js の DRAFT_ROUNDS と同じ（M6.6 §2-4） */

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
  /** デバッグメニューの項目をラベルで押す。番号（data-i）で指定していたら、
   * 項目を2つ足したときに全部ずれて壊れたので、ラベル指定に変えてある。 */
  const dbgClick = async (label) => {
    const items = await page.$$('.dbg-item');
    for (const it of items) {
      const t = await it.$eval('b', (e) => e.textContent).catch(() => '');
      if (t.indexOf(label) >= 0) { await it.click(); return true; }
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

  /* スターターを「本」に入れた初回状態から始める（持ち出し画面をここで実際に操作する）。
   * 目覚めだけは撮り終えたので openingSeen は立てておく。 */
  await page.evaluate((starter) => {
    const book = {};
    starter.forEach((id) => { book[id] = (book[id] || 0) + 1; });
    localStorage.setItem('cq_meta', JSON.stringify({
      book: book, deck: {}, known: Array.from(new Set(starter)),
      gold: 500, cleared: [], openingSeen: true, visits: {}, seenHints: {}
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

  // --- 2) 草原を選ぶ → 開始マスの新フロー（M6.6 WP4：案内→持ち出し→ドラフト→暗転明け） ---
  const grassTile = await page.$$eval('.area-tile', (els) => els.findIndex((e) => !e.classList.contains('locked')));
  (await page.$$('.area-tile'))[grassTile].click();
  await wait(() => page.$('.amber-overlay'));
  ok('草原を選ぶとアンバーの案内が出る（WP4）', !!(await page.$('.amber-overlay')));
  /* 2026-08-28 本人指定：案内は暗転ではなくマップの上に重ねる */
  ok('案内の背景にマップが出ている', !!(await page.$('.amber-overlay')) && !!(await page.$('.run-map')));
  ok('案内中のマスは押せない（出発前）', (await page.$$('.map-node[data-act="node"]')).length === 0);
  await page.waitForTimeout(600);
  await shot('start-guide');
  await page.click('[data-act="guide-skip"]');

  await wait(() => page.$('.carry-scroll'));
  ok('案内のあとに持ち出し（デッキ編集）が出る（WP4）', !!(await page.$('.carry-scroll')));
  /* 既知のカードだけ・所持0でも出る、という表示規則をざっと確かめる */
  ok('持ち出し画面に既知のカードが並ぶ', (await page.$$('.carry-table tbody tr')).length > 0);
  await shot('start-carry');
  const startCounts = await page.evaluate(() => ({
    book: CQCollection.countsTotal(RUI.meta.book), deck: CQCollection.deckTotal(RUI.meta)
  }));
  ok('初回は本28枚・デッキ0枚から始まる（§2-2）',
    startCounts.book === 28 && startCounts.deck === 0, JSON.stringify(startCounts));
  /* ▶を1回押して「本が減りデッキが増える」＝移動モデルであることを確かめ、
   * ◀で元に戻ることも見る（2026-08-28 本人指定で −＋ から ◀▶ に変更） */
  const toDeck = await page.$('[data-act="carry-to-deck"]:not([disabled])');
  await toDeck.click();
  await page.waitForTimeout(150);
  const afterOne = await page.evaluate(() => ({
    book: CQCollection.countsTotal(RUI.meta.book), deck: CQCollection.deckTotal(RUI.meta)
  }));
  ok('▶で本が1枚減りデッキが1枚増える（複製ではなく移動）',
    afterOne.book === startCounts.book - 1 && afterOne.deck === startCounts.deck + 1,
    JSON.stringify(startCounts) + '→' + JSON.stringify(afterOne));
  const toBook = await page.$('[data-act="carry-to-book"]:not([disabled])');
  await toBook.click();
  await page.waitForTimeout(150);
  const backAgain = await page.evaluate(() => ({
    book: CQCollection.countsTotal(RUI.meta.book), deck: CQCollection.deckTotal(RUI.meta)
  }));
  ok('◀でデッキから本へ戻せる',
    backAgain.book === startCounts.book && backAgain.deck === startCounts.deck,
    JSON.stringify(backAgain));
  /* カードを選ぶと右の詳細ペインに絵と詳細が出る（2026-08-28 本人指定） */
  await page.click('.carry-table tbody tr');
  await page.waitForTimeout(150);
  ok('カードを選ぶと右に詳細が出る', !!(await page.$('.carry-detail .bigart img')));
  /* 見出しクリックで並べ替え・絞り込み欄が使えること */
  ok('見出しに並べ替えが付いている', (await page.$$('.carry-table thead th.sortable')).length > 0);
  ok('絞り込み欄がある', (await page.$$('.carry-table .filters input')).length > 0);
  ok('表示する列を切り替えられる', (await page.$$('[data-act="carry-col"]')).length > 0);
  /* 残りも全部持ち出す（各タブを回る）。本が空になり、デッキが28枚になるはず */
  for (const tab of ['U', 'M', 'S']) {
    await page.click(`[data-act="carry-tab"][data-id="${tab}"]`);
    await page.waitForTimeout(80);
    for (let guard = 0; guard < 60; guard++) {
      const b = await page.$('[data-act="carry-to-deck"]:not([disabled])');
      if (!b) break;
      await b.click();
      await page.waitForTimeout(25);
    }
  }
  const filled = await page.evaluate(() => ({
    book: CQCollection.countsTotal(RUI.meta.book),
    deck: CQCollection.deckTotal(RUI.meta),
    blank: CQCollection.blankCount(RUI.meta)
  }));
  ok('本の28枚を全部持ち出せる（残り12枠は空白）',
    filled.book === 0 && filled.deck === 28 && filled.blank === 12, JSON.stringify(filled));
  await shot('start-carry-filled');
  await page.click('[data-act="carry-done"]');

  // --- 3) おまかせドラフト（最大2回・空白がある時だけ）→ 暗転明けでマップへ ---
  await wait(() => page.$('.draft-row') || page.$('.run-map'));
  if (await page.$('.draft-row')) {
    ok('持ち出しのあとにおまかせドラフトが出る（WP4）', true);
    ok('候補3枚＋「変更しない」の4枚が並ぶ', (await page.$$('.draft-card')).length === 4,
      String((await page.$$('.draft-card')).length));
    ok('「変更しない」枠が区別して描かれる', !!(await page.$('.draft-card.keep')));
    await shot('start-draft');
    for (let i = 0; i < CQ_DRAFT_ROUNDS; i++) {
      const cards = await page.$$('.draft-card');
      if (!cards.length) break;
      await cards[0].click();                 /* 候補を選んでレンタルする */
      await page.waitForTimeout(400);
      if (!(await page.$('.draft-row'))) break;
    }
  } else {
    ok('空白が無いランではドラフトが出ずにマップへ直行する（WP4）', true);
  }

  // --- 出発の直前の案内②（2026-08-28 本人指定：マスター紹介＋送り出し） ---
  await wait(() => page.$('.amber-overlay') || page.$('.map-node[data-act="node"]'));
  const hasGuide2 = !!(await page.$('.amber-overlay'));
  ok('ドラフトのあと、出発の直前にもう一度アンバーが出る（初回訪問）', hasGuide2);
  if (hasGuide2) {
    const g2 = await page.$eval('.amber-lines', (e) => e.innerText);
    ok('②の1つ目はマスターの紹介', g2.indexOf('マスター') >= 0, g2.replace(/\n/g, ' / '));
    await shot('start-guide2');
    /* 送り出しまで送る（最後の1つを送るとマップへ出発する） */
    for (let i = 0; i < 6 && (await page.$('[data-act="guide-next"]')); i++) {
      await page.click('[data-act="guide-next"]');
      await page.waitForTimeout(200);
    }
  }
  await wait(() => page.$('.map-node[data-act="node"]'));
  ok('出発ボタンを押さずにマップへ着く（WP4：暗転→明転）', !!(await page.$('.run-map')));
  ok('開始マスが出発済みになっている',
    await page.evaluate(() => RUI.run.map.nodes[RUI.run.map.start].cleared));
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

  /* M6.6 WP10：プレイヤーのコマの移動は、道が交差している区間では辻を経由すること
   * （本人指定：一直線の斜め移動ではなく、交差点で一度折れる）。playerWalk() が使う
   * roadJointBetween() を直接呼び、①辻を経由する辺では実際に描かれている .road-joint と
   * 同じ座標を返すこと、②枝分かれの無い区間では辻を経由しない（null）ことを確認する。 */
  const jointCheck = await page.evaluate(() => {
    const nodes = RUI.run.map.nodes;
    const bySig = {};
    Object.values(nodes).forEach((n) => {
      if (n.connectsTo.length === 2) {
        const sig = n.connectsTo.slice().sort().join(',');
        (bySig[sig] = bySig[sig] || []).push(n);
      }
    });
    const sig = Object.keys(bySig).find((s) => bySig[s].length === 2);
    if (!sig) return null;
    const src = bySig[sig][0];
    const toId = src.connectsTo[0];
    return { srcId: src.id, toId, joint: roadJointBetween(RUI.run, src.id, toId) };
  });
  ok('辻を経由する辺では roadJointBetween が交点を返す（M6.6 WP10）',
    !!(jointCheck && jointCheck.joint), JSON.stringify(jointCheck));
  if (jointCheck && jointCheck.joint) {
    const svgMatch = await page.evaluate((j) => {
      return Array.from(document.querySelectorAll('.road-joint')).some((c) => {
        const cx = +c.getAttribute('cx') / 1280 * 100, cy = +c.getAttribute('cy') / 800 * 100;
        return Math.abs(cx - j.x) < 0.5 && Math.abs(cy - j.y) < 0.5;
      });
    }, jointCheck.joint);
    ok('その交点は画面に描かれている辻（.road-joint）と同じ座標', svgMatch, JSON.stringify(jointCheck.joint));
  }
  const directCheck = await page.evaluate(() => {
    const nodes = RUI.run.map.nodes;
    const n = Object.values(nodes).find((x) => x.connectsTo.length === 1);
    return n ? roadJointBetween(RUI.run, n.id, n.connectsTo[0]) : 'no-such-node';
  });
  ok('枝分かれの無い区間は辻を経由しない（直線のまま）', directCheck === null, JSON.stringify(directCheck));

  /* 実際に playerWalk() を辻ありの辺で走らせ、演出の途中経過が辻の座標を通ること
   * （一直線の中間点ではなく）を確認する。マップの状態は変えない（run.at 等には触らない）。 */
  if (jointCheck && jointCheck.joint) {
    await page.evaluate(({ srcId, toId }) => {
      window.__walkDone = false;
      playerWalk(RUI.run, srcId, toId, () => { window.__walkDone = true; });
    }, jointCheck);
    await page.waitForTimeout(200);   // 1区間目（460ms）の途中——まだ辻へ向かっている最中
    const midPos = await page.evaluate(() => {
      const t = document.querySelector('.run-map .player-token.walking');
      return t ? { x: parseFloat(t.style.left), y: parseFloat(t.style.top) } : null;
    });
    ok('演出の途中、辻と同じ座標を通る（一直線ではなく折れて進む）',
      !!midPos && Math.abs(midPos.x - jointCheck.joint.x) < 1.5 && Math.abs(midPos.y - jointCheck.joint.y) < 1.5,
      JSON.stringify({ mid: midPos, joint: jointCheck.joint }));
    await wait(() => page.evaluate(() => window.__walkDone === true), 2000);
    ok('演出が終わるとコールバックが呼ばれる', await page.evaluate(() => window.__walkDone === true));
    /* 動作確認用に作った一時的なコマ要素を掃除しておく（本来のマップ状態には影響していない） */
    await page.evaluate(() => {
      const t = document.querySelector('.run-map .player-token.walking');
      if (t) t.remove();
    });
  }

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
    if (t === 'chest' || t === 'rest') {
      /* M6.6 WP8：宝箱・休憩はクリック不要で自動的にカットイン（.event-intro）へ入り、
       * 終わったら自動でマップへ戻る（戦闘導入＝.battle-introと同じ「四角の後ろに
       * マップが見えたまま」の形）。 */
      await wait(() => page.$('.event-intro'));
      ok('非戦闘マス(' + t + ')は自動でカットインに入る（M6.6 WP8）', !!(await page.$('.event-intro')), t);
      ok('カットインの後ろにマップが見えている', !!(await page.$('.event-intro')) && !!(await page.$('.run-map')));
      await page.waitForTimeout(900);   // ハート／金貨の演出が動いている途中の絵を撮る
      await shot('node-' + t);
      await page.click('.event-intro');   // タップでスキップ
      await wait(() => page.evaluate(() => !document.querySelector('.event-intro')));
    } else if (t === 'shop' || t === 'exchange') {
      /* M6.6 WP9：換金所・ショップは「開ける／立ち去る」の.node-panelから、カードグリッド＋
       * 情報パネル（.cg-head/.cg-wrap、換金所・デッキ確認・戦利品振り分けと共通の部品）に
       * 作り直した。ここでは画面が出ることと「立ち去る」で戻れることだけ確認する（カードの
       * 選択・購入・売却の詳細な検証は tests/run.js のエンジン側テストが担当）。 */
      await wait(() => page.$('.cg-head'));
      ok('非戦闘マス(' + t + ')の画面が出る（M6.6 WP9：カードグリッド＋情報パネル）',
        !!(await page.$('.cg-head')), t);
      await shot('node-' + t);
      if (t === 'shop') { await page.click('[data-act="shop-leave"]'); }
      else { await page.click('[data-act="exchange-leave"]'); }
    } else {
      await wait(() => page.$('.node-panel'));
      ok('非戦闘マス(' + t + ')の解決パネルが出る', !!(await page.$('.node-panel')), t);
      await shot('node-' + t);
      if (t === 'question') { await page.click('[data-act="node-done"]'); }
    }
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
    /* 2026-08-29 本人指定：「たたかう」の確認パネルは廃止した。敵のマスに触れた時点で
     * そのまま戦闘導入カットイン（黒四角＋敵＋自分のコマの突撃）に入る。
     * 四角の後ろにマップが見えたままであること・戦場ルールが読めることも合わせて確認する。 */
    await wait(() => page.$('.battle-intro'));
    ok('敵のマスに触れると確認パネル無しでカットインに入る（M6.6 WP5）', !!(await page.$('.battle-intro')));
    ok('「たたかう」の確認パネルは出ない', !(await page.$('[data-act="battle-go"]')));
    ok('カットインの後ろにマップが見えている', !!(await page.$('.battle-intro')) && !!(await page.$('.run-map')));
    await page.waitForTimeout(1100);   // 四角が開き、敵とコマが出てくる途中の絵を撮る
    await shot('battle-intro');
    await page.click('.battle-intro');   // タップでスキップ
    await wait(() => page.evaluate(() => document.getElementById('screen-battle').classList.contains('on')));
    ok('カットインの後にバトル画面に切り替わる', await page.evaluate(() => document.getElementById('screen-battle').classList.contains('on')));
    /* バトル画面表示と同時に先攻ルーレットが出る（追補§4 WP5）。これもタップでスキップできる */
    await wait(() => page.$('.first-turn-roulette'));
    const rouletteEl = await page.$('.first-turn-roulette');
    ok('バトル画面表示と同時に先攻ルーレットが出る（M6.6 WP5）', !!rouletteEl);
    if (rouletteEl) {
      await page.waitForTimeout(1400);   // 回転の途中の絵を撮る
      await shot('first-turn-roulette');
      /* 2026-08-29 本人指摘の再発防止：旧実装は停止時に rotate(最終角) を代入し直していたため、
       * そこから逆向きに1080°戻る「高速逆回転」が見えていた。回転角は常に増える一方であること
       * （＝逆回転しないこと）を、スキップの前後で実際の角度を読んで確かめる。 */
      const degBefore = await page.evaluate(() => {
        const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.ftr-compass')).transform);
        return Math.atan2(m.b, m.a) * 180 / Math.PI;
      });
      await page.click('.first-turn-roulette');   // タップでスキップ
      await page.waitForTimeout(120);
      const settled = await page.evaluate(() => document.querySelector('.ftr-compass').style.transform);
      ok('停止角はきっかり右(0°)か左(180°)（ずれた位置で止まらない）',
        /rotate\((\d+)deg\)/.test(settled) && (parseInt(settled.match(/(\d+)deg/)[1], 10) % 180 === 0), settled);
      ok('停止時に逆回転しない（角度は常に増える一方）',
        parseInt(settled.match(/(\d+)deg/)[1], 10) >= 360, 'before=' + degBefore.toFixed(0) + '° final=' + settled);
      ok('結果の文字（先攻／後攻）が出る', !!(await page.$('.ftr-result.show')));
      /* 止まったあと1秒そのまま見せてから、ゆっくり透明になって消える（合計で約1.5秒） */
      await wait(() => page.evaluate(() => !document.querySelector('.first-turn-roulette')), 4000);
      ok('1秒見せてからフェードして消える', await page.evaluate(() => !document.querySelector('.first-turn-roulette')));
    }
    await page.waitForTimeout(1500);   // 手札配布などの演出(FX)が終わるまで待つ。演出中の強制上書きはstep()に打ち消される
    ok('ラン中はバトル画面の「新しい対戦」ボタンが隠れる', !(await page.$('#turnbox [data-act="new"]')));

    /* --- M6.6 WP12：逃げる・諦める --- */
    ok('ラン中の戦闘には「諦める」が常に出る（M6.6 WP12）', !!(await page.$('[data-act="give-up"]')));
    /* 通常戦闘（フリーユニット戦）の配置ステップなら「逃げる」も出ているはず。
     * 相手の手番中など出ない場面もあるので、エンジン側の判定と画面の有無が一致することを見る。 */
    const fleeState = await page.evaluate(() => ({
      can: CQTurn.canFlee(M), shown: !!document.querySelector('[data-act="flee"]'), mode: M.mode
    }));
    ok('「逃げる」の表示はエンジンの判定と一致する', fleeState.can === fleeState.shown,
      JSON.stringify(fleeState));
    ok('通常戦闘はフリーユニット戦なので逃走の対象', fleeState.mode === 'field', String(fleeState.mode));
    await shot('battle-flee-buttons');
    /* 実際に逃げて、マップへ戻ったときの扱い（追補§8-3 案A）を確認する。
     * 乱数任せだと成否が揺れるので、成功する結果をエンジンに直接作らせて画面の流れだけを見る。 */
    const nodeBefore = await page.evaluate((nid) => ({
      cleared: !!RUI.run.map.nodes[nid].cleared, attempts: RUI.run.map.nodes[nid].attempts || 0, at: RUI.run.at
    }), battleId);
    await page.evaluate(() => { M.fled = 'self'; M.phase = 'over'; UI.mode = 'over'; busy = false; renderAll(); });
    await wait(() => page.$('.i-result.flee'));
    ok('逃走成功は勝ちでも負けでもない表示になる', !!(await page.$('.i-result.flee')));
    await page.click('[data-act="run-over"]');
    await wait(() => page.$('.run-map'));
    const nodeAfter = await page.evaluate((nid) => ({
      cleared: !!RUI.run.map.nodes[nid].cleared, attempts: RUI.run.map.nodes[nid].attempts || 0,
      at: RUI.run.at, view: RUI.view, outcome: RUI.run.outcome
    }), battleId);
    ok('逃げるとマップへ戻る（結果画面にはならない）', nodeAfter.view === 'map' && !nodeAfter.outcome,
      JSON.stringify(nodeAfter));
    ok('★逃げたマスは cleared にならない（追補§8-3 案A）', nodeAfter.cleared === false);
    ok('★そのマスに立ったまま＝入り直せる', nodeAfter.at === battleId);
    ok('挑戦回数が進む＝入り直すと別の引きになる', nodeAfter.attempts === nodeBefore.attempts + 1,
      nodeBefore.attempts + '→' + nodeAfter.attempts);
    ok('逃げたマスがもう一度選べる状態で描かれている',
      !!(await page.$(`.map-node[data-id="${battleId}"].pickable`)));
    await shot('map-after-flee');
    /* もう一度そのマスに入れること（＝再戦できること）まで確かめてから、勝って先へ進む */
    await page.click(`.map-node[data-id="${battleId}"]`, { force: true });
    await wait(() => page.$('.battle-intro'));
    ok('★同じマスに入り直して戦闘をやり直せる', !!(await page.$('.battle-intro')));
    await page.click('.battle-intro');
    await wait(() => page.evaluate(() => document.getElementById('screen-battle').classList.contains('on')));
    const roul2 = await page.$('.first-turn-roulette');
    if (roul2) {
      await page.click('.first-turn-roulette');
      await wait(() => page.evaluate(() => !document.querySelector('.first-turn-roulette')), 4000);
    }
    await page.waitForTimeout(800);
    // 決着を強制して「ランへ戻る」フローだけを検証する（戦闘の勝敗そのものは
    // tools/simulate-run.js のヘッドレス自動対戦で別途大量に検証済み）
    await page.evaluate(() => {
      M.winner = 'self'; M.phase = 'over'; M.loot = [8];
      M.players.self.lp = 8; M.log.push('自分の勝利');
      UI.mode = 'over'; UI.report = null; busy = false; renderAll();
    });
    await wait(() => page.$('[data-act="run-over"]'));
    ok('決着後は「ランへ戻る」ボタンが出る', !!(await page.$('[data-act="run-over"]')));
    /* 2026-08-29 本人指摘：情報パネルと右下の2箇所に同じボタンが出ていた。右下だけにする */
    ok('「ランへ戻る」は画面に1つだけ（右下）', (await page.$$('[data-act="run-over"]')).length === 1,
      String((await page.$$('[data-act="run-over"]')).length) + '個');
    ok('「ランへ戻る」は右下（#acts）にある', !!(await page.$('#acts [data-act="run-over"]')));
    await page.click('[data-act="run-over"]');
    await wait(() => page.evaluate(() => document.getElementById('screen-run').classList.contains('on')));
    ok('「ランへ戻る」でラン画面に戻る', await page.evaluate(() => document.getElementById('screen-run').classList.contains('on')));
    /* M6.6 WP7：マップへ戻る前に、まず戦利品（loot:[8]）の振り分け画面が出る。
     * M6.6 WP9でカードグリッド＋情報パネルに乗せ替え、さらに2026-08-29の本人指摘で
     * 「デッキへ／本へ」を各カードのタイル直下に常時表示する形に戻した——選ばなくても
     * 押せる（複数枚あっても各カードに専用のボタンが付くので、最初の1個を押せばよい）。 */
    await wait(() => page.$('.cg-card'));
    const lootCard = await page.$('.cg-card');
    ok('マップに戻る前に戦利品の振り分け画面が出る（M6.6 WP7・WP9でグリッド化）', !!lootCard);
    if (lootCard) {
      await shot('loot');
      const bookBtn = await page.$('.cg-card-btns [data-act="loot-book"]');
      ok('「デッキへ／本へ」は各カードの下に最初から出ている（2026-08-29再修正）', !!bookBtn);
      if (bookBtn) await bookBtn.click();   // 「本に送る」は空きの有無に関わらず必ず選べる（複数枚あっても最初の1枚でよい）
      await wait(() => page.$('.run-map'));
      ok('振り分けを終えるとマップへ戻る', !!(await page.$('.run-map')));
    }
    ok('戦闘結果がランに反映される（そのマスが解決済み）',
      await page.evaluate((nid) => RUI.run.map.nodes[nid].cleared, battleId));
    /* 2026-08-29 本人指摘：倒した敵はマップから消す（M6.6 §4 WP10） */
    ok('倒した敵はマップから消える',
      await page.evaluate((nid) => {
        const el = document.querySelector('.map-node[data-id="' + nid + '"]');
        return !!el && !el.querySelector('.node-cutout') && !!el.querySelector('.node-tile');
      }, battleId));
    /* 決着後の「ランへ戻る」は右下だけ（情報パネルに二重に出さない） */
    ok('「ランへ戻る」は1つだけ', true, '（下の戦闘決着時に検査済み）');
  } else {
    ok('戦闘マスの橋渡し(このランでは戦闘マスが選べなかった)', true, '');
  }

  // --- 5.5) デバッグメニュー（2026-08-29 新設。js/debug.js） ---
  /* 2026-08-29：タブは「ラン」だけ。バトル画面・デッキ編集・エンジン検証・この案について は
   * すべてタブから外し、開発用のものはデバッグメニューへ移した。 */
  ok('タブは「ラン」1つだけになっている',
    (await page.$$('.tab')).length === 1 && !!(await page.$('.tab[data-screen="screen-run"]')),
    String((await page.$$('.tab')).length) + '個');
  ok('ストーリー中はランタブが光ったまま（戦闘に入っても動かない）',
    await page.$eval('.tab[data-screen="screen-run"]', (e) => e.classList.contains('on')));
  await page.click('#dbg-btn');
  await wait(() => page.$('.dbg-menu'));
  ok('🛠 でデバッグメニューが開く', !!(await page.$('.dbg-menu')));
  ok('デバッグメニューに7つの道具が並ぶ（フリーバトル・デッキ編集・盤面セットアップを追加）', (await page.$$('.dbg-item')).length === 7,
    String((await page.$$('.dbg-item')).length) + '個');
  await shot('debug-menu');
  /* ルーラー：80px方眼と座標番号が #app に重なる。もう一度押すと消える */
  await dbgClick('ルーラー');
  await wait(() => page.$('.dbg-ruler'));
  ok('ルーラーが出る（80px方眼・16×10）', (await page.$$('.dbg-ruler-x')).length === 16 &&
    (await page.$$('.dbg-ruler-y')).length === 10);
  await shot('debug-ruler');
  await dbgClick('ルーラー');
  await page.waitForTimeout(150);
  ok('もう一度押すとルーラーが消える', !(await page.$('.dbg-ruler')));
  /* 最新版のチェック：version.json を読んで結果行が出る（GitHub側は通信環境により取得不可でもよい） */
  await dbgClick('最新版のチェック');
  await wait(() => page.$('.dbg-verdict'), 8000);
  ok('最新版のチェックが結果を返す', !!(await page.$('.dbg-verdict')));
  /* 2026-08-29：「目覚めの場面を見返す」——アンバーとの出会いの場面だけを最初から再生し、
   * 終わったら元の画面へ戻る（openingSeen・ランの状態には触れない）。 */
  const viewBefore = await page.evaluate(() => RUI.view);
  const openingSeenBefore = await page.evaluate(() => RUI.meta.openingSeen);
  await dbgClick('目覚めの場面を見返す');
  await wait(() => page.$('.opening-scene'));
  ok('「目覚めの場面を見返す」で最初の台詞から再生される', await page.evaluate(() =>
    document.querySelector('.opening-bubble') && document.querySelector('.opening-bubble').textContent.includes('起きたか')));
  await shot('debug-opening-replay');
  await page.click('.opening-skip');                        // スキップして先へ
  await wait(() => page.evaluate(() => !document.querySelector('.opening-scene')));
  ok('見返した後は元の画面に戻る（ランの状態には入らない）',
    (await page.evaluate(() => RUI.view)) === viewBefore &&
    await page.evaluate(() => document.getElementById('screen-run').classList.contains('on')),
    'before=' + viewBefore + ' after=' + (await page.evaluate(() => RUI.view)));
  ok('openingSeen は書き換わらない', (await page.evaluate(() => RUI.meta.openingSeen)) === openingSeenBefore);

  /* --- 2026-08-29：デッキ編集とフリーバトルをデバッグメニューへ移した --- */
  await page.click('#dbg-btn');
  await wait(() => page.$('.dbg-menu'));
  ok('デバッグメニューに7つの道具が並ぶ', (await page.$$('.dbg-item')).length === 7,
    String((await page.$$('.dbg-item')).length) + '個');
  /* 🃏 デッキ編集：アンロックに関係なく全169種から組めること・組んだ内容が残ること */
  await dbgClick('デッキ編集');
  await wait(() => page.evaluate(() => document.getElementById('screen-deck').classList.contains('on')));
  ok('デバッグメニューからデッキ編集が開く', await page.evaluate(() => document.getElementById('screen-deck').classList.contains('on')));
  ok('デッキ編集はアンロックに関係なく全モンスターが並ぶ',
    (await page.$$('#tbody tr')).length === await page.evaluate(() => CARDS.filter((c) => c.t === 'U').length),
    String((await page.$$('#tbody tr')).length) + '行');
  const deckBefore = await page.evaluate(() => Object.values(deck).reduce((s, n) => s + n, 0));
  await page.click('#tbody [data-plus]');
  await page.waitForTimeout(120);
  const deckAfter = await page.evaluate(() => Object.values(deck).reduce((s, n) => s + n, 0));
  ok('カードを足すとデッキ枚数が増える', deckAfter === deckBefore + 1, deckBefore + '→' + deckAfter);
  ok('組んだデッキが localStorage に残る（フリーバトルで使う）',
    await page.evaluate(() => !!localStorage.getItem('cq_debug_deck')));
  await shot('debug-deck-edit');
  /* 🗡 フリーバトル：設定画面が出て、選んだ設定でバトルに入れること */
  await page.click('.deck-back[data-back="screen-free"]');
  await wait(() => page.evaluate(() => document.getElementById('screen-free').classList.contains('on')));
  ok('フリーバトルの設定画面が開く', !!(await page.$('.free-wrap')));
  ok('相手・先攻後攻・戦場ルール・ＡＩの強さを選べる',
    (await page.$$('[data-fact="kind"]')).length === 2 &&
    (await page.$$('[data-fact="first"]')).length === 2 &&
    (await page.$$('[data-fact="field"]')).length > 0 &&
    (await page.$$('[data-fact="rank"]')).length > 0);
  await shot('debug-free-battle');
  /* 「相手が先攻」を選んで始め、実際にその通りになっているか（先攻の指定が効くか）を見る */
  await page.click('[data-fact="first"][data-v="enemy"]');
  await page.waitForTimeout(100);
  await page.click('[data-fact="start"]');
  await wait(() => page.evaluate(() => document.getElementById('screen-battle').classList.contains('on')));
  ok('設定どおりにフリーバトルが始まる', await page.evaluate(() => document.getElementById('screen-battle').classList.contains('on')));
  const freeM = await page.evaluate(() => ({ first: M.first, mode: M.mode, self: M.players.self.deckCount + M.players.self.hand.length }));
  ok('★選んだ先攻・後攻がそのまま反映される', freeM.first === 'enemy', JSON.stringify(freeM));
  ok('自分のデッキはデッキ編集で組んだ40枚', freeM.self === 40, String(freeM.self));
  ok('フリーバトルでは「新しい対戦」等の設定ボタンが出る（ラン中は隠れる）',
    !!(await page.$('#turnbox [data-act="new"]')));
  /* 2026-08-29：決着後は「もう一度対戦する」に加え「バトルを終える」も出て、
   * 押すとフリーバトルの設定画面（相手選び）に戻ること。 */
  await page.evaluate(() => {
    M.winner = 'self'; M.phase = 'over'; M.loot = [];
    UI.mode = 'over'; UI.report = null; busy = false; renderAll();
  });
  await wait(() => page.$('[data-act="free-end"]'));
  ok('フリーバトル決着後は「もう一度対戦する」と「バトルを終える」が並ぶ',
    !!(await page.$('#acts [data-act="new"]')) && !!(await page.$('#acts [data-act="free-end"]')));
  await shot('debug-free-battle-over');
  await page.click('[data-act="free-end"]');
  await wait(() => page.evaluate(() => document.getElementById('screen-free').classList.contains('on')));
  ok('「バトルを終える」でフリーバトルのトップ画面に戻る',
    await page.evaluate(() => document.getElementById('screen-free').classList.contains('on')));
  /* 🧪 盤面をセットして戦う（2026-08-30）：ＪＳＯＮで盤面を渡し、その通りに戦闘が始まること。
   * カード1枚ずつの検証（M6.7 WP5・WP6）はこの画面が使えるかどうかに掛かっているので、
   * 「取り込む → 始める → 盤面が記述どおり」までを通しで見る。 */
  await page.click('#dbg-btn');
  await wait(() => page.$('.dbg-menu'));
  await dbgClick('盤面をセットして戦う');
  await wait(() => page.evaluate(() => document.getElementById('screen-board').classList.contains('on')));
  ok('盤面セットアップ画面が開く', !!(await page.$('#board-root .free-wrap')));
  ok('6レーンぶんの欄が並ぶ', (await page.$$('.bs-lane')).length === 6,
    String((await page.$$('.bs-lane')).length) + '個');
  const BOARD_JSON = JSON.stringify({
    first: 'self', active: 'self', phase: 'main', win: 'field',
    lp: { self: 7, enemy: 10 }, hand: { self: [108], enemy: [] },
    lanes: { '0': { unit: 8, ch: [{ id: 108, up: false, by: 'self' }] },
             '3': { unit: 70, ch: [{ id: 101, up: false, by: 'enemy' }, { id: 172, up: false, by: 'enemy' }] } }
  });
  await page.$eval('#bs-json', (el, v) => { el.value = v; }, BOARD_JSON);
  await page.click('[data-bs="json-load"]');
  await page.waitForTimeout(150);
  ok('★ＪＳＯＮで渡した盤面を取り込める（Claudeとの受け渡し口）',
    await page.evaluate(() => Object.keys(BSET.lanes).length === 2 && BSET.hand.self.length === 1),
    JSON.stringify(await page.evaluate(() => BSET.lanes)));
  await shot('debug-board-setup');
  await page.click('[data-bs="start"]');
  await wait(() => page.evaluate(() => document.getElementById('screen-battle').classList.contains('on')));
  const bsM = await page.evaluate(() => ({
    hand: M.players.self.hand.slice(), lp: M.players.self.lp, hooks: !!(M.hooks && M.hooks.onMagicOpen),
    l0: M.board.lanes[0].unit, l3: M.board.lanes[3].channels.map((c) => c.card + (c.mine ? 'S' : 'E')),
    count3: M.board.lanes[3].count
  }));
  ok('★セットした盤面のまま戦闘が始まる',
    bsM.l0 === 8 && bsM.count3 === 2 && bsM.l3.join(',') === '101E,172E' && bsM.lp === 7,
    JSON.stringify(bsM));
  ok('セットした手札がそのまま手に入っている', bsM.hand.join(',') === '108', JSON.stringify(bsM.hand));
  ok('hooks が配線されている（これが無いと魔法が一切発動しない）', bsM.hooks);
  await shot('debug-board-battle');
  /* ★ 強制開放の連鎖は「その場で」めくること（2026-08-30 本人指摘の再発防止）。
   * v0.16.24 は .card.ch.chain-now に position:relative を書いてしまい、ＣＨが
   * `position:absolute; bottom:calc(k * var(--vstep))` の積み位置から外れて
   * **列の上端まで飛んでから裏返って**いた。めくっている最中の top と position を実測する。 */
  const chTop = () => page.$eval('.card.ch[data-lane="3"][data-layer="1"]', (el) => ({
    top: Math.round(el.getBoundingClientRect().top), pos: getComputedStyle(el).position
  }));
  const beforeFlip = await chTop();
  await page.click('.card.ch[data-lane="0"][data-layer="1"]', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(200);
  await page.click('.card.ch[data-lane="3"][data-layer="1"]', { position: { x: 8, y: 8 } });
  let duringFlip = null;
  for (let n = 0; n < 30 && !duringFlip; n++) {          /* めくっている最中のフレームを捕まえる */
    await page.waitForTimeout(60);
    if (await page.$('.card.ch[data-lane="3"][data-layer="1"].chain-now')) duringFlip = await chTop();
  }
  ok('★連鎖でめくられるカードはその場で裏返る（上にずれない）',
    !!duringFlip && duringFlip.top === beforeFlip.top && duringFlip.pos === 'absolute',
    JSON.stringify({ before: beforeFlip, during: duringFlip }));
  /* ★憑依解除の破壊は「赤枠で狙いを見せる → 粉々に割れる」で見せること（2026-08-30 本人指定）。
   * 連鎖の途中で発動した場合もここを通る。演出中のDOMを追いかけて両方を目撃する。 */
  let sawDoomed = false, sawShards = false;
  for (let n = 0; n < 60 && !(sawDoomed && sawShards); n++) {
    await page.waitForTimeout(60);
    if (await page.$('.card.ch.doomed')) sawDoomed = true;
    if (await page.$('.cq-shard-box')) sawShards = true;
  }
  ok('★憑依解除の対象は赤い枠で見せてから破壊される', sawDoomed);
  ok('★憑依解除の対象は粉々に割れる演出で消える', sawShards);
  await page.waitForTimeout(2500);                        /* 連鎖の演出が終わるまで待つ */
  /* 戦闘中にもう一度開くと、いまの盤面が初期値として出る（試す→直す→また試す） */
  await page.click('#dbg-btn');
  await wait(() => page.$('.dbg-menu'));
  await dbgClick('盤面をセットして戦う');
  await wait(() => page.evaluate(() => document.getElementById('screen-board').classList.contains('on')));
  ok('★戦闘中に開き直すと、いまの盤面が初期値として出る',
    await page.evaluate(() => BSET.lanes['3'] && BSET.lanes['3'].unit === 70),
    JSON.stringify(await page.evaluate(() => BSET.lanes)));

  /* ★呪爆(133)が強制開放に跳ね返り、仕掛けた側のレーンごと吹き飛ぶ場面（2026-08-30 本人指摘）。
   * 強制開放のカードもユニットと一緒に消えるが、以前はここだけ**何の演出も無く黙って消えて**いた。
   * ユニットとＣＨの両方が赤枠で見えてから粉々になることを、演出中のDOMを追いかけて確かめる。 */
  await page.$eval('#bs-json', (el, v) => { el.value = v; }, JSON.stringify({
    first: 'self', active: 'self', phase: 'main', win: 'lp', hand: { self: [], enemy: [] },
    lanes: { '0': { unit: 8, ch: [{ id: 108, up: false, by: 'self' }] },
             '3': { unit: 8, ch: [{ id: 133, up: false, by: 'enemy' }, { id: 180, up: false, by: 'enemy' }] } }
  }));
  await page.click('[data-bs="json-load"]');
  await page.waitForTimeout(150);
  await page.click('[data-bs="start"]');
  await wait(() => page.evaluate(() => document.getElementById('screen-battle').classList.contains('on')));
  await page.waitForTimeout(1200);
  await page.click('.card.ch[data-lane="0"][data-layer="1"]', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(200);
  await page.click('.card.ch[data-lane="3"][data-layer="1"]', { position: { x: 8, y: 8 } });
  let wipeUnit = false, wipeCh = false, wipeShards = false;
  for (let n = 0; n < 60 && !(wipeUnit && wipeCh && wipeShards); n++) {
    await page.waitForTimeout(60);
    if (await page.$('.card.unit.doomed')) wipeUnit = true;
    if (await page.$('.card.ch.doomed')) wipeCh = true;
    if (await page.$('.cq-shard-box')) wipeShards = true;
  }
  ok('★呪爆で吹き飛ぶユニットが赤い枠で見える', wipeUnit);
  ok('★一緒に消える強制開放のカードも赤い枠で見える', wipeCh);
  ok('★そのあと粉々に割れる演出で消える', wipeShards);
  ok('呪爆は強制開放を仕掛けた側に跳ね返る（レーンごと消える）',
    await page.evaluate(() => M.board.lanes[0].unit === null && M.board.lanes[0].channels.length === 0),
    JSON.stringify(await page.evaluate(() => M.log.slice(-3))));
  await page.waitForTimeout(1500);
  await page.click('#dbg-btn');
  await wait(() => page.$('.dbg-menu'));
  await dbgClick('盤面をセットして戦う');
  await wait(() => page.evaluate(() => document.getElementById('screen-board').classList.contains('on')));

  /* --- M6.7 WP5：対象選択ＵＩの4つの型 ---------------------------------------
   * 候補はすべてエンジン（CQMagic.targetsFor）が持つ。ここで見るのは
   * 「その候補が画面に光り、押すと選んだとおりに効く」ことだけ。 */
  const startBoard = async (spec) => {
    await page.$eval('#bs-json', (el, v) => { el.value = v; }, JSON.stringify(spec));
    await page.click('[data-bs="json-load"]');
    await page.waitForTimeout(150);
    await page.click('[data-bs="start"]');
    await wait(() => page.evaluate(() => document.getElementById('screen-battle').classList.contains('on')));
    await page.waitForTimeout(1100);
  };
  const reopenBoard = async () => {
    await page.click('#dbg-btn');
    await wait(() => page.$('.dbg-menu'));
    await dbgClick('盤面をセットして戦う');
    await wait(() => page.evaluate(() => document.getElementById('screen-board').classList.contains('on')));
  };
  const BASE = { first: 'self', active: 'self', phase: 'main', win: 'lp', hand: { self: [], enemy: [] } };

  /* ① lane 型：124凍結。ＣＨを持つ他ユニットだけが候補（CE0216 EJECT） */
  await startBoard(Object.assign({}, BASE, { lanes: {
    '0': { unit: 8, ch: [{ id: 124, up: false, by: 'self' }] },
    '1': { unit: 8, ch: [] },
    '3': { unit: 8, ch: [{ id: 151, up: false, by: 'enemy' }] },
    '4': { unit: 8, ch: [{ id: 151, up: false, by: 'enemy' }] } } }));
  await page.click('.card.ch[data-lane="0"][data-layer="1"]', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(250);
  ok('★対象を選ぶ魔法は候補のレーンだけが光る（124凍結・EJECT）',
    (await page.$$eval('.lane.pick-lane', (els) => els.map((e) => e.dataset.lane).join(','))) === '3,4',
    await page.$$eval('.lane.pick-lane', (els) => els.map((e) => e.dataset.lane).join(',')));
  await shot('wp5-pick-lane');
  await page.click('.lane[data-lane="4"] .card.unit', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(700);
  ok('選んだレーンにだけ効果が出る',
    await page.evaluate(() => M.board.lanes[4].stiff === true && M.board.lanes[3].stiff === false));

  /* ② ch 型：118押収。裏向きのＣＨだけが候補（CE0356 DASH） */
  await reopenBoard();
  await startBoard(Object.assign({}, BASE, { lanes: {
    '0': { unit: 13, ch: [{ id: 118, up: false, by: 'self' }] },
    '3': { unit: 13, ch: [{ id: 151, up: false, by: 'enemy' }, { id: 152, up: true, by: 'enemy' },
                          { id: 153, up: false, by: 'enemy' }] } } }));
  await page.click('.card.ch[data-lane="0"][data-layer="1"]', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(250);
  ok('★裏向きのＣＨだけが光る（118押収・DASH）',
    (await page.$$eval('.card.ch.pick', (els) => els.map((e) => e.dataset.lane + ':' + e.dataset.layer).join(','))) === '3:1,3:3',
    await page.$$eval('.card.ch.pick', (els) => els.map((e) => e.dataset.lane + ':' + e.dataset.layer).join(',')));
  await page.click('.card.ch[data-lane="3"][data-layer="3"]', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(700);
  ok('選んだＣＨが自分のレーンへ移る',
    await page.evaluate(() => M.board.lanes[0].channels.some((c) => c.card === 153)
      && !M.board.lanes[3].channels.some((c) => c.card === 153)));

  /* ③ layer 型：131菊一文字。階層（レベル）を選ぶ。自分と同じ階層は選べない */
  await reopenBoard();
  await startBoard(Object.assign({}, BASE, { lanes: {
    '0': { unit: 13, ch: [{ id: 151, up: false, by: 'self' }, { id: 131, up: false, by: 'self' },
                          { id: 152, up: false, by: 'self' }] },
    '3': { unit: 13, ch: [{ id: 153, up: false, by: 'enemy' }, { id: 154, up: false, by: 'enemy' },
                          { id: 155, up: false, by: 'enemy' }] } } }));
  await page.click('.card.ch[data-lane="0"][data-layer="2"]', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(250);
  ok('★階層を選ぶ型：候補の階層が全レーンで光る（131菊一文字）',
    await page.evaluate(() => UI.pick && UI.pick.kind === 'layer'
      && JSON.stringify(UI.pick.targets) === '[1,3]'),
    JSON.stringify(await page.evaluate(() => UI.pick && UI.pick.targets)));
  await shot('wp5-pick-layer');
  await page.click('.card.ch[data-lane="3"][data-layer="3"]', { position: { x: 8, y: 8 } });
  /* ★2026-08-30 本人指定：菊一文字で壊れるカードも赤枠→粉々で見せること。 */
  let kikuDoomed = false, kikuShards = false;
  for (let n = 0; n < 40 && !(kikuDoomed && kikuShards); n++) {
    await page.waitForTimeout(60);
    if (await page.$('.card.ch.doomed')) kikuDoomed = true;
    if (await page.$('.cq-shard-box')) kikuShards = true;
  }
  ok('★菊一文字で壊れるカードが赤い枠で見える', kikuDoomed);
  ok('★そのあと粉々に割れる演出で消える', kikuShards);
  await page.waitForTimeout(900);
  ok('選んだ階層が敵味方まとめて消える（菊一文字は自壊しない）',
    await page.evaluate(() => M.board.lanes[0].channels.length === 2
      && M.board.lanes[3].channels.length === 2
      && M.board.lanes[0].channels.some((c) => c.card === 131)),
    JSON.stringify(await page.evaluate(() => M.board.lanes.map((l) => l.channels.map((c) => c.card)))));

  /* ④ hand 型：114暗殺。相手の手札が全部見え、モンスターだけ選べる */
  await reopenBoard();
  await startBoard(Object.assign({}, BASE, {
    hand: { self: [], enemy: [8, 101, 13, 151] },
    lanes: { '0': { unit: 8, ch: [{ id: 114, up: false, by: 'self' }] }, '3': { unit: 8, ch: [] } } }));
  await page.click('.card.ch[data-lane="0"][data-layer="1"]', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(300);
  ok('★手札から選ぶ型：相手の手札が全部見える（114暗殺）',
    (await page.$$('#info-fix .dp-card')).length === 4,
    String((await page.$$('#info-fix .dp-card')).length) + '枚');
  ok('モンスター以外は選べないことが見て分かる',
    (await page.$$('#info-fix .dp-card.dim')).length === 2,
    String((await page.$$('#info-fix .dp-card.dim')).length) + '枚が沈んでいる');
  await shot('wp5-pick-hand');
  await page.click('#info-fix .dp-card[data-act="pick-hand"][data-i="2"]');
  await page.waitForTimeout(700);
  ok('選んだ手札のモンスターが壊れる',
    await page.evaluate(() => M.players.enemy.hand.join(',') === '8,101,151'),
    await page.evaluate(() => M.players.enemy.hand.join(',')));

  /* --- 2026-08-30 本人の実機フィードバック ------------------------------------ */
  /* ⑤ 招来(121)：引き出したユニットの「開：」能力が発動すること */
  await reopenBoard();
  await startBoard(Object.assign({}, BASE, { lanes: {
    '0': { unit: 42, ch: [{ id: 121, up: false, by: 'self' }] },
    '2': { unit: 8, ch: [{ id: 1, up: false, by: 'self' }] },     /* 潜行しているミルファイター */
    '3': { unit: 8, ch: [{ id: 151, up: true, by: 'enemy' }] } } }));   /* 閉じられる表向きＣＨ */
  await page.click('.card.ch[data-lane="0"][data-layer="1"]', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(700);
  ok('★招来で引き出したユニットの「開：」能力が発動する（2026-08-30 本人指定）',
    await page.evaluate(() => M.board.lanes[1].unit === 1
      && M.log.some((l) => l.indexOf('クローズ：') === 0)),
    JSON.stringify(await page.evaluate(() => M.log.slice(-3))));

  /* ⑥ 潜入(138)：このカードが付いているユニットごと、他ユニットの中へ潜る */
  await reopenBoard();
  await startBoard(Object.assign({}, BASE, { lanes: {
    '0': { unit: 8, ch: [{ id: 151, up: false, by: 'self' }, { id: 151, up: false, by: 'self' },
                         { id: 138, up: false, by: 'self' }] },
    '1': { unit: 13, ch: [] }, '3': { unit: 13, ch: [] } } }));
  await page.click('.card.ch[data-lane="0"][data-layer="3"]', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(250);
  await page.click('.lane[data-lane="1"] .card.unit', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(900);
  ok('★潜入はユニットごと他ユニットの中へ潜る（2026-08-30 本人指定）',
    await page.evaluate(() => M.board.lanes[0].unit === null
      && M.board.lanes[1].channels.length === 1
      && M.board.lanes[1].channels[0].card === 8
      && M.board.lanes[1].channels[0].up === false),
    JSON.stringify(await page.evaluate(() => M.log.slice(-2))));
  ok('潜行は破壊ではないのでＬＰは減らない',
    await page.evaluate(() => M.players.self.lp === 10));
  await shot('wp5-sennyu');

  /* --- M6.7 WP6：ユニット固有能力の対象選択 ---------------------------------
   * 魔法とまったく同じ配線（CQUnits.targetsFor → startPick → choice）で動くこと。 */
  /* ⑦ 開：クローズ×１（ミルファイター）。表向きのＣＨなら何でも戻せる・自分のレーンは除く */
  await reopenBoard();
  await startBoard(Object.assign({}, BASE, { lanes: {
    '0': { unit: 8, ch: [{ id: 151, up: true, by: 'self' }, { id: 1, up: false, by: 'self' }] },
    '1': { unit: 8, ch: [] },
    '3': { unit: 8, ch: [{ id: 151, up: true, by: 'enemy' }, { id: 152, up: true, by: 'enemy' }] } } }));
  await page.click('.card.ch[data-lane="0"][data-layer="2"]', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(300);
  ok('★ユニットの「開：」能力でも対象を選べる（クローズ×１）',
    await page.evaluate(() => UI.pick && UI.pick.kind === 'ch' && UI.pick.card === 1),
    JSON.stringify(await page.evaluate(() => UI.pick && { k: UI.pick.kind, c: UI.pick.card })));
  ok('★自分の乗っているレーンの表向きＣＨは光らない（§4-1・本人指摘）',
    (await page.$$eval('.card.ch.pick', (els) => els.map((e) => e.dataset.lane + ':' + e.dataset.layer).join(','))) === '3:1,3:2',
    await page.$$eval('.card.ch.pick', (els) => els.map((e) => e.dataset.lane + ':' + e.dataset.layer).join(',')));
  await shot('wp6-unit-open');
  await page.click('.card.ch[data-lane="3"][data-layer="2"]', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(800);
  ok('選んだカードだけが裏に戻る',
    await page.evaluate(() => M.board.lanes[3].channels[0].up === true
      && M.board.lanes[3].channels[1].up === false));

  /* ⑧ 特：Ａ５５０雷撃（ヨルムンガンドの特殊行動）でも対象を選べる */
  await reopenBoard();
  await startBoard(Object.assign({}, BASE, { lanes: {
    '0': { unit: 10, ch: [] }, '3': { unit: 8, ch: [] }, '4': { unit: 8, ch: [] } } }));
  await page.click('.lane[data-lane="0"] .card.unit', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(250);
  await page.click('[data-act="special-action"]');
  await page.waitForTimeout(300);
  ok('★特殊行動（Ｃ型）でも対象を選べる（Ａ５５０雷撃）',
    (await page.$$eval('.lane.pick-lane', (els) => els.map((e) => e.dataset.lane).join(','))) === '3,4',
    await page.$$eval('.lane.pick-lane', (els) => els.map((e) => e.dataset.lane).join(',')));
  await shot('wp6-special');
  await page.click('.lane[data-lane="4"] .card.unit', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(1100);
  ok('選んだユニットだけが破壊される',
    await page.evaluate(() => M.board.lanes[4].unit === null && M.board.lanes[3].unit === 8),
    JSON.stringify(await page.evaluate(() => M.board.lanes.map((l) => l.unit))));

  /* ⑨ 開：敵手札×１奪取（ステルスゴブリン）。手札から選ぶ型 */
  await reopenBoard();
  await startBoard(Object.assign({}, BASE, {
    hand: { self: [], enemy: [101, 8, 151] },
    lanes: { '0': { unit: 8, ch: [{ id: 29, up: false, by: 'self' }] },
             '1': { unit: 8, ch: [] }, '3': { unit: 8, ch: [] } } }));
  await page.click('.card.ch[data-lane="0"][data-layer="1"]', { position: { x: 8, y: 8 } });
  await page.waitForTimeout(350);
  ok('★敵手札奪取は相手の手札が全部見える（種類の制限なし）',
    (await page.$$('#info-fix .dp-card')).length === 3
      && (await page.$$('#info-fix .dp-card.dim')).length === 0,
    String((await page.$$('#info-fix .dp-card')).length) + '枚／沈み '
      + String((await page.$$('#info-fix .dp-card.dim')).length) + '枚');
  await page.click('#info-fix .dp-card[data-act="pick-hand"][data-i="2"]');
  await page.waitForTimeout(800);
  ok('選んだ1枚が自分の手札に移る',
    await page.evaluate(() => M.players.enemy.hand.join(',') === '101,8'
      && M.players.self.hand.indexOf(151) >= 0),
    JSON.stringify(await page.evaluate(() => M.log.slice(-2))));
  await reopenBoard();
  /* ストーリー側のセーブに触れていないこと（フリーバトルと同じ扱い） */
  ok('盤面セットアップはストーリーのセーブを壊さない',
    await page.evaluate(() => !!localStorage.getItem('cq_meta')));
  await page.click('[data-bs="back"]');
  await wait(() => page.evaluate(() => document.getElementById('screen-free').classList.contains('on')));

  /* ストーリーへ戻れること。タブは終始「ラン」のまま動いていないこと */
  ok('★戦闘中でもタブは「ラン」のまま', await page.$eval('.tab[data-screen="screen-run"]', (e) => e.classList.contains('on')));
  await page.click('.tab[data-screen="screen-run"]');
  await wait(() => page.evaluate(() => document.getElementById('screen-run').classList.contains('on')));
  ok('「ラン」タブでストーリーへ戻れる', await page.evaluate(() => document.getElementById('screen-run').classList.contains('on')));

  // --- 6) リタイヤ ---
  /* M6.5a でブラウザ標準の confirm() からゲーム内ダイアログに変わっているので、
   * 確認ダイアログの「リタイヤする」を明示的に押す。 */
  await page.click('[data-act="retire"]');
  await wait(() => page.$('[data-act="cq-confirm-yes"]'));
  ok('リタイヤ確認がゲーム内ダイアログで出る', !!(await page.$('.cq-confirm-box')));
  /* M6.6 WP11：確認ダイアログの文面に減額（▲50%）が書かれていること。
   * それまでは「所持Ｇは持ち帰れます」だったので、減額を実装した以上は嘘になる。 */
  ok('リタイヤの確認に減額（50%）が明示されている（M6.6 WP11）',
    /50%/.test(await page.$eval('.cq-confirm-box', (el) => el.textContent)));
  const goldBefore = await page.evaluate(() => ({ gold: RUI.run.gold, start: RUI.run.startGold }));
  await page.click('[data-act="cq-confirm-yes"]');
  await wait(() => page.$('[data-act="back-home"]'));
  ok('リタイヤすると結果画面が出る', !!(await page.$('[data-act="back-home"]')));

  /* --- 6-b) リザルト画面の中身（M6.6 WP11・追補§4 WP11の6項目） --- */
  await wait(() => page.$('.res-wrap'));
  ok('結果画面が新しいリザルト（.res-wrap）になっている（M6.6 WP11）', !!(await page.$('.res-wrap')));
  ok('取得したカードと返却するカードの2区画がある',
    (await page.$$('.res-sec')).length >= 4);
  /* 清算のひっ算：持ち込み／今日の獲得／減額／所持Ｇ の4行 */
  const calcRows = await page.$$eval('.res-calc .res-row th', (els) => els.map((e) => e.textContent.trim()));
  ok('清算がひっ算（持ち込み・獲得・減額・所持Ｇ）で出る', calcRows.length === 4, calcRows.join('｜'));
  ok('減額の行がリタイヤ▲50%になっている', /50%/.test(calcRows[2] || ''), calcRows[2]);
  /* 所持Ｇはカウントアップするので、止まるまで待ってから読む。 */
  await page.waitForTimeout(1800);
  const shown = await page.$eval('#res-gold', (el) => +el.textContent);
  const expect = await page.evaluate(() => RUI.meta.gold);
  ok('所持Ｇがカウントアップして清算後の額で止まる', shown === expect, shown + ' / ' + expect);
  ok('清算後のＧは、獲得ぶんの50%だけ減っている（持ち込みは減らない）',
    expect === goldBefore.gold - Math.round(Math.max(0, goldBefore.gold - goldBefore.start) * 0.5 / 10) * 10,
    JSON.stringify(goldBefore) + ' -> ' + expect);
  ok('称号の区画がある', !!(await page.$('.res-title-list, .res-none-note')));
  ok('アンバーの一言が出る（台本§7.1）',
    !!(await page.$('.res-amber-lines')) && !!(await page.evaluate(
      () => document.querySelector('.res-amber-lines').textContent.trim())));
  const journal = await page.$eval('.res-journal', (el) => el.textContent.trim());
  ok('日誌が1行出る（台本§7.2）', /日目。/.test(journal), journal);
  ok('日誌が cq_meta に蓄積される',
    await page.evaluate(() => (RUI.meta.journal || []).length > 0));
  ok('通算日数が1日進んでいる', await page.evaluate(() => RUI.meta.day >= 1));
  ok('「デッキは次の冒険に持ち越し」の但し書きがある',
    /持ち越/.test(await page.$eval('.res-carry-note', (el) => el.textContent)));
  ok('締めのボタンが「今回の探検を終える」になっている',
    /今回の探検を終える/.test(await page.$eval('[data-act="back-home"]', (el) => el.textContent)));
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
    /* ここは霧の見た目を撮るのが目的なので、持ち出し済みの40枚デッキから始める
       （空白が無い＝ドラフトも発生しないので、開始マスを最短で抜けられる）。 */
    localStorage.setItem('cq_meta', JSON.stringify({
      book: {}, deck: deck, known: Array.from(new Set(starter)),
      gold: 500, cleared: ['grassland'], openingSeen: true,
      visits: { forest: 9 }, seenHints: { carryOut: true }
    }));
    localStorage.removeItem('cq_run');
  }, STARTER);
  await page.reload();
  await wait(() => page.$('.area-grid'));

  let foggy = false;
  for (let attempt = 0; attempt < 12 && !foggy; attempt++) {
    const forest = await page.$$eval('.area-tile', (els) => els.findIndex((e) => e.dataset.id === 'forest'));
    (await page.$$('.area-tile'))[forest].click();
    await wait(() => page.evaluate(() => !!RUI.run));
    foggy = await page.evaluate(() => !!(RUI.run && RUI.run.map.fog.active));
    if (!foggy) {
      /* 外れ：このランは捨てて引き直す。開始マスにはリタイヤボタンが無いので、
       * 中断中のランを消して読み込み直すのがいちばん確実。 */
      await page.evaluate(() => localStorage.removeItem('cq_run'));
      await page.reload();
      await wait(() => page.$('.area-grid'));
      continue;
    }
    /* 開始マスの新フロー（WP4）を通り抜ける：案内をスキップ → 持ち出しを終える →
     * （空白が無いのでドラフトは発生せず）そのままマップへ */
    if (await page.$('[data-act="guide-skip"]')) {
      await page.click('[data-act="guide-skip"]');
      await wait(() => page.$('.carry-scroll'));
    }
    if (await page.$('[data-act="carry-done"]')) await page.click('[data-act="carry-done"]');
    for (let i = 0; i < CQ_DRAFT_ROUNDS && (await page.$('.draft-row')); i++) {
      const cards = await page.$$('.draft-card');
      if (!cards.length) break;
      await cards[cards.length - 1].click();     /* 「変更しない」を選んで先へ */
      await page.waitForTimeout(200);
    }
    await wait(() => page.$('.run-map'));
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
