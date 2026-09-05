/* 盤面レポートの検証（Playwright／ヘッドレスChromium・2026-08-31）
 *
 * 「📮 盤面を報告」（js/report.js）が、実際のブラウザで期待どおり動くかを見る。
 *   1) 🛠メニューから開く／閉じる
 *   2) レポートの中身：盤面・直前の手・カード名の対応表・場所
 *   3) 盤面のＪＳＯＮが「🧪盤面をセットして戦う」にそのまま貼れる形になっている
 *   4) 履歴は直前5手ぶんで頭打ちになる（際限なく溜まらない）
 *   5) 共有：ＪＳＯＮが添付として渡る／添付できない端末では .txt に落ちる／
 *      共有そのものが無い端末では本文に丸ごと入る
 *   6) mailto: は宛先が入っていて、長すぎるときはＪＳＯＮを本文から外す
 *   7) 控え：残る・消せる・20件で頭打ち
 *   8) コンソールエラー 0 件
 *
 * 使い方： python3 -m http.server 8321 を立ててから node tools/verify-report.js
 */
'use strict';
const { chromium } = require('playwright');

const URL = 'http://localhost:8321/index.html';

/* 検証に使う盤面（js/board-spec.js の説明に載っている例そのまま） */
const SPEC = {
  first: 'self', active: 'self', phase: 'main', win: 'lp',
  lp: { self: 10, enemy: 10 },
  hand: { self: [108, 113], enemy: [] },
  lanes: {
    '0': { unit: 8, ch: [{ id: 108, up: false, by: 'self' }] },
    '3': { unit: 70, ch: [{ id: 101, up: false, by: 'enemy' }] }
  }
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    /* 絵の読み込み失敗（404）は本筋ではないので外す。メッセージ本文にはファイル名が
     * 入らないので、**どのURLで起きたか**で判断する。 */
    const url = (m.location() && m.location().url) || '';
    if (/\.(png|webp|jpe?g|svg)(\?|$)/.test(url)) return;
    errors.push(m.text() + (url ? ' @' + url : ''));
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  const results = [];
  const ok = (name, cond, extra) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (extra || '')]);

  /* この検証にService Workerは要らない。登録させておくと、主導権を取った瞬間に
   * js/update.js の controllerchange が location.reload() を呼び、**始めたばかりの戦闘ごと
   * 流される**（実機では起動直後に一度起きるだけなので害はない）。登録を断るだけにして、
   * update.js 側の .catch に拾わせる。 */
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'serviceWorker', {
      configurable: true,
      get: () => ({
        register: () => Promise.reject(new Error('検証中は使いません')),
        getRegistrations: () => Promise.resolve([]),
        addEventListener: () => {}, controller: null
      })
    });
  });
  /* 2026-09-05：🛠 は既定で隠れる（js/devmode.js）。この検査は 🛠 から開くので立てておく */
  await page.addInitScript(() => { try { localStorage.setItem('cq_dev', '1'); } catch (_) {} });
  await page.goto(URL);
  await page.waitForFunction(() => typeof CQReport !== 'undefined' && typeof startBoardBattle === 'function');

  /* --- 決まった盤面から戦闘を始める（乱数に左右されない） --- */
  await page.evaluate((spec) => {
    BSET = CQBoardSpec.normalize(spec, CARD_BY_ID).spec;
    startBoardBattle();
  }, SPEC);
  await page.waitForTimeout(1200);

  /* --- 1) 🛠メニューから開く／閉じる --- */
  await page.click('#dbg-btn');
  const items = await page.$$eval('.dbg-item .dbg-item-t b', (a) => a.map((e) => e.textContent));
  ok('🛠メニューに「盤面を報告」がある', items.indexOf('盤面を報告') >= 0, items.join('／'));
  await page.click(`.dbg-item:nth-child(${items.indexOf('盤面を報告') + 2})`);
  ok('ダイアログが開く', await page.$('.cqr-overlay') !== null);
  ok('コメント欄がある', await page.$('#cqr-comment') !== null);
  ok('メニューは閉じている', await page.$('.dbg-menu') === null);

  await page.fill('#cqr-comment', 'レーン3の敵が硬直しているはずなのに動いた');

  /* --- 2) レポートの中身 --- */
  const rep = await page.evaluate(() => CQReport.build(document.getElementById('cqr-comment').value));
  ok('kind が入る', rep.kind === 'cardquest-board-report');
  ok('版が入る', typeof rep.app === 'string' && /^\d+\.\d+\.\d+$/.test(rep.app), rep.app);
  ok('時刻が時差つきで入る', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(rep.at), rep.at);
  ok('コメントが入る', rep.comment.indexOf('硬直') >= 0);
  ok('盤面のレーン0が入る', !!(rep.board && rep.board.lanes['0']) && rep.board.lanes['0'].unit === 8);
  ok('盤面のレーン3が入る', !!(rep.board && rep.board.lanes['3']) && rep.board.lanes['3'].unit === 70);
  ok('手札が入る', JSON.stringify(rep.board.hand.self) === JSON.stringify([108, 113]),
     JSON.stringify(rep.board.hand));
  ok('カード名の対応表が付く', rep.names['8'] && rep.names['70'] && rep.names['108'],
     JSON.stringify(rep.names));
  ok('場所（ターン・手番）が入る', rep.where.turn != null && !!rep.where.active, JSON.stringify(rep.where));
  ok('戦闘画面なので stale が付かない', rep.where.boardIsStale === undefined);
  ok('対戦ログの欄がある', Array.isArray(rep.log), typeof rep.log);
  ok('セットしたばかりの盤面ではログは空', rep.log.length === 0, String(rep.log.length));
  ok('履歴の各手に盤面とログが入る',
     rep.history.length === 0 || rep.history.every((h) => h.board && Array.isArray(h.log) && h.turn != null),
     JSON.stringify(rep.history.map((h) => h.log)));

  /* --- 3) 盤面のＪＳＯＮが盤面セットアップに貼れる形か --- */
  const round = await page.evaluate((b) => {
    const r = CQBoardSpec.parse(JSON.stringify(b), CARD_BY_ID);
    return { errors: r.errors, lanes: Object.keys(r.spec.lanes).sort() };
  }, rep.board);
  ok('盤面ＪＳＯＮがそのまま読み込める', round.errors.length === 0, round.errors.join('／'));
  ok('読み込んだ盤面のレーンが一致', JSON.stringify(round.lanes) === JSON.stringify(['0', '3']),
     JSON.stringify(round.lanes));

  /* --- 3.5) 実際に手を進めると、その手の盤面とログが履歴に積まれる --- */
  const real = await page.evaluate(() => {
    const before = CQReport.history().length;
    CQTurn.endTurn(M);
    renderAll();
    const rep = CQReport.build('実際に手を進めた');
    const last = rep.history.length ? rep.history[rep.history.length - 1] : null;
    return { before: before, after: CQReport.history().length,
             lines: last ? last.log : [], hasBoard: !!(last && last.board) };
  });
  ok('手を進めると履歴が1つ増える', real.after === real.before + 1, real.before + '→' + real.after);
  ok('その手のログが履歴に入る', real.lines.some((t) => /ターン終了/.test(t)), JSON.stringify(real.lines));
  ok('その手の盤面も履歴に入る', real.hasBoard);

  /* --- 4) 履歴は5手ぶんで頭打ち --- */
  const capped = await page.evaluate(() => {
    for (let i = 0; i < 40; i++) { M.log.push('（検証）' + i); renderAll(); }
    const r = CQReport.build('');
    return { buf: CQReport.history().length, hist: r.history.length,
             last: r.history.length ? r.history[r.history.length - 1].log[0] : null,
             logLen: r.log.length, logLast: r.log[r.log.length - 1] };
  });
  ok('輪番バッファは6件まで', capped.buf === 6, String(capped.buf));
  ok('レポートに入るのは5手ぶん＋出発点の6件', capped.hist === 6, String(capped.hist));
  ok('新しい手が残っている（古い手から捨てる）', capped.last === '（検証）39', String(capped.last));
  ok('対戦ログは末尾30行まで', capped.logLen === 30, String(capped.logLen));
  ok('対戦ログの末尾はいちばん新しい行', capped.logLast === '（検証）39', String(capped.logLast));

  /* --- 5) 共有 --- */
  const shared = await page.evaluate(async () => {
    const seen = {};
    navigator.canShare = () => true;
    navigator.share = (d) => {
      seen.title = d.title; seen.text = d.text;
      seen.files = (d.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size }));
      return Promise.resolve();
    };
    const r = await CQReport.share(CQReport.build('共有のテスト'));
    return { seen, how: r.how };
  });
  ok('共有にＪＳＯＮが添付される',
     shared.seen.files.length === 1 && /\.json$/.test(shared.seen.files[0].name) &&
     shared.seen.files[0].type === 'application/json' && shared.seen.files[0].size > 200,
     JSON.stringify(shared.seen.files));
  ok('件名にコメントが入る', /共有のテスト/.test(shared.seen.title), shared.seen.title);
  ok('本文に「気になったこと」が入る', /【気になったこと】/.test(shared.seen.text));

  const sharedTxt = await page.evaluate(async () => {
    const seen = {};
    navigator.canShare = (d) => !/\.json$/.test(d.files[0].name);   /* .json を拒む端末のふり */
    navigator.share = (d) => { seen.files = (d.files || []).map((f) => f.name); return Promise.resolve(); };
    await CQReport.share(CQReport.build('txt落ち'));
    return seen;
  });
  ok('ＪＳＯＮを拒む端末では .txt で送る',
     sharedTxt.files.length === 1 && /\.txt$/.test(sharedTxt.files[0]), JSON.stringify(sharedTxt));

  const sharedNoFile = await page.evaluate(async () => {
    const seen = {};
    navigator.canShare = () => false;
    navigator.share = (d) => { seen.text = d.text; seen.files = d.files; return Promise.resolve(); };
    await CQReport.share(CQReport.build('添付なし'));
    return seen;
  });
  ok('添付できない端末では本文に丸ごと入れる',
     !sharedNoFile.files && /"kind": "cardquest-board-report"/.test(sharedNoFile.text || ''));

  /* --- 6) mailto: --- */
  const mail = await page.evaluate(() => {
    const rep = CQReport.build('メールのテスト');
    const withJson = CQReport.mailtoUrl(rep, true);
    const without = CQReport.mailtoUrl(rep, false);
    return { to: CQReport.MAIL_TO, withJson: withJson, without: without,
             long: withJson.length };
  });
  ok('宛先が自分になっている', mail.withJson.indexOf('mailto:' + mail.to) === 0, mail.withJson.slice(0, 40));
  ok('本文にＪＳＯＮを入れられる', /cardquest-board-report/.test(decodeURIComponent(mail.withJson)));
  ok('長いときはクリップボードへ回す案内になる',
     /クリップボードに入れました/.test(decodeURIComponent(mail.without)));
  ok('実際に長くなる盤面なので外す判断が働く', mail.long > 1800, String(mail.long));

  /* --- 7) 控え --- */
  const store = await page.evaluate(() => {
    localStorage.removeItem('cq_reports');
    for (let i = 0; i < 25; i++) CQReport.save(CQReport.build('控え' + i));
    const n1 = CQReport.load().length;
    const head = CQReport.load()[0].comment;
    CQReport.removeAt(0);
    const n2 = CQReport.load().length;
    const head2 = CQReport.load()[0].comment;
    return { n1, n2, head, head2 };
  });
  ok('控えは20件で頭打ち', store.n1 === 20, String(store.n1));
  ok('新しいものが先頭', store.head === '控え24', store.head);
  ok('1件消せる', store.n2 === 19 && store.head2 === '控え23', store.n2 + '／' + store.head2);

  /* --- ストーリーのセーブに触っていないこと --- */
  const untouched = await page.evaluate(() => ({
    meta: localStorage.getItem('cq_meta') !== null || true,   /* 触っていなければ存在有無は変わらない */
    keys: Object.keys(localStorage).sort()
  }));
  ok('cq_reports 以外の保存領域を増やしていない',
     untouched.keys.filter((k) => k.indexOf('cq_') === 0 &&
       ['cq_meta', 'cq_run', 'cq_reports', 'cq_debug_board'].indexOf(k) < 0).length === 0,
     untouched.keys.join('／'));

  /* --- 9) 往復：報告のＪＳＯＮを「盤面をセットして戦う」に貼って、その場面を作り直す ---
   * 2026-08-31 本人指定の本命の使い道。直したあとに同じ場面をもう一度確かめるための道。 */
  await page.evaluate((spec) => {
    BSET = CQBoardSpec.normalize(spec, CARD_BY_ID).spec;
    startBoardBattle();                       /* 履歴を作り直す（4節で偽のログを積んだため） */
  }, SPEC);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    renderAll();                              /* いちばん古い履歴＝この時点の盤面 */
    /* 盤面が実際に変わる手を1つ挟む（「−1手」と「いま」が別物になるように） */
    const ln = M.board.lanes[3];
    ln.channels.pop(); ln.count = ln.channels.length;
    M.log.push('（検証）敵のＣＨが1枚減った');
    renderAll();
  });

  const trip = await page.evaluate(() => {
    const rep = CQReport.build('直したので同じ場面をもう一度');
    openBoardSetup();
    const ta = document.getElementById('bs-json');
    ta.value = JSON.stringify(rep, null, 2);
    document.querySelector('[data-bs="json-load"]').click();
    const snaps = Array.from(document.querySelectorAll('[data-bs="snap"]'));
    return {
      msg: bsetMsg,
      box: !!document.querySelector('.bs-report'),
      comment: (document.querySelector('.bs-report-c') || {}).textContent || '',
      labels: snaps.map((b) => b.textContent),
      nowCh: (BSET.lanes['3'] || { ch: [] }).ch.length
    };
  });
  ok('報告のＪＳＯＮをそのまま取り込める', /報告から盤面を取り込みました/.test(trip.msg), trip.msg);
  ok('報告の欄が出る', trip.box);
  ok('コメントが画面に出る', /同じ場面をもう一度/.test(trip.comment), trip.comment);
  ok('「いま」と「−N手」が並ぶ', trip.labels[0] === 'いま' && /^−\d+手$/.test(trip.labels[1] || ''),
     JSON.stringify(trip.labels));
  ok('「いま」の盤面は手を進めた後のもの', trip.nowCh === 0, String(trip.nowCh));

  const older = await page.evaluate(() => {
    const snaps = Array.from(document.querySelectorAll('[data-bs="snap"]'));
    snaps[1].click();                          /* いちばん古い −N手 */
    return { msg: bsetMsg, ch: (BSET.lanes['3'] || { ch: [] }).ch.length,
             unit: (BSET.lanes['3'] || {}).unit };
  });
  ok('前の手の盤面に戻せる', older.ch === 1 && older.unit === 70, JSON.stringify(older));

  const restarted = await page.evaluate(() => {
    document.querySelector('[data-bs="start"]').click();
    return { screen: (document.querySelector('.screen.on') || {}).id,
             ch: M.board.lanes[3].channels.length,
             unit: M.board.lanes[3].unit };
  });
  await page.waitForTimeout(300);
  ok('その盤面で戦闘を始められる', restarted.screen === 'screen-battle', restarted.screen);
  ok('作り直した盤面が報告どおり', restarted.ch === 1 && restarted.unit === 70, JSON.stringify(restarted));

  const cleared = await page.evaluate(() => {
    openBoardSetup();
    document.querySelector('[data-bs="clear"]').click();
    return { box: !!document.querySelector('.bs-report'), report: BSREPORT };
  });
  ok('まっさらにすると報告の欄も消える', cleared.box === false && cleared.report === null);

  /* --- 8) コンソールエラー --- */
  ok('コンソールエラー 0 件', errors.length === 0, errors.slice(0, 3).join(' ／ '));

  await browser.close();

  let bad = 0;
  results.forEach(([r, name, extra]) => {
    if (r === 'FAIL') bad++;
    console.log((r === 'PASS' ? '  ✓ ' : '  ✗ ') + name + (extra ? '  → ' + extra : ''));
  });
  console.log(bad ? `\n${bad} 件が FAIL` : `\nすべて PASS（${results.length} 件）`);
  process.exit(bad ? 1 : 0);
})();
