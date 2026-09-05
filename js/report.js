/* CardQuest — 盤面レポート（気になった場面を、その場でメールに送る・2026-08-31）
 *
 * ランを進めているときに「いまのカードの動きはおかしくないか」と思うことがある。その場で
 * 手を止めて調べるのは惜しいので、**盤面と直前の数手をそのまま持ち出して自分あてにメールで
 * 送っておき、後で落ち着いて見る**ための道具（2026-08-31 本人指定）。
 *
 * 送る中身（ＪＳＯＮ 1ファイル）：
 *   comment … その場で書いた「気になったこと」
 *   where   … どこで起きたか（エリア・マス・相手・ターン・手番・戦場ルール・ＬＰ）
 *   board   … いまの盤面。**js/board-spec.js と同じ形**なので、デバッグメニューの
 *             「🧪 盤面をセットして戦う」の［ＪＳＯＮ］欄にそのまま貼れば再現できる
 *   history … 直前5手ぶんの { その手で出たログ, その手が終わった時点の盤面 }。いちばん古い
 *             1件は「5手前の出発点」として付ける（＝最大6件）。5つの変化を、その前後の
 *             盤面つきで辿れる形にしてある
 *   names   … 出てきたカードＩＤ→名前の対応（人が読むためだけの付録）
 *   log     … 対戦ログの末尾30行
 *
 * 履歴の取り方は**ただの輪番バッファ**にしてある。js/layout.js の renderAll() から tick() を
 * 呼び、`M.log` が伸びていたらそのときの盤面を1つ積むだけ。エンジンには一切触れないので、
 * 対戦の進行にも乱数にも影響しない。1手あたり小さなオブジェクト1個（数百バイト）で、
 * 6手ぶんしか持たない＝押した瞬間まで常に用意できている（押してから作るのでは間に合わない）。
 *
 * 送り方は3通り。Androidの共有シートが本命で、残り2つはその保険：
 *   ① 📧 共有して送る … navigator.share にＪＳＯＮ（中身）の .txt ファイルを添えて渡す
 *      （Chrome の Web Share は .json を添付できない＝permission denied になる。2026-09-05）。
 *      Androidの共有シートが開くのでＧmailを選ぶ。**宛先はWeb標準の側で指定できない**ので、Ｇmailの画面で自分あてに
 *      する（一度送れば以後は宛先の履歴から選べる）。
 *   ② ✉ メールを開く … mailto: で宛先（MAIL_TO）まで埋めて開く。添付は付けられないので
 *      ＪＳＯＮは本文に入れる（長すぎるときはクリップボードへ回す）。
 *   ③ 📋 コピー … ＪＳＯＮをクリップボードへ。どこにでも貼れる最後の手段。
 *
 * 送った控えは端末にも20件残す（localStorage: cq_reports）。共有シートを取り消しても書いた
 * 文章が消えないための保険で、あとから一覧・再送信・削除ができる。ストーリーのセーブ
 * （cq_meta・cq_run）には一切触らない。
 *
 * DOM前提のコードなのでNode（tests/・tools/）からは読み込まれない。
 */
'use strict';

const CQReport = (function () {

  const KEEP_MOVES = 5;               /* 履歴に残す手数（本人指定） */
  const KEEP_LOG = 30;                /* 同梱する対戦ログの行数 */
  const STORE_KEY = 'cq_reports';
  const KEEP_STORE = 20;              /* 端末に残す控えの件数 */
  const MAIL_TO = 'rafysta@gmail.com';
  const MAILTO_LIMIT = 1800;          /* mailto: のURLはこのくらいで頭打ちにする（端末差が大きい） */

  /* ================= 手ごとの盤面（輪番バッファ） ================= */

  /* hist[i] = { turn, active, phase, lp, log:[この手で出たログ], board:{board-spec} }
   * 「board は log の**あと**の盤面」。先頭が最も古い。KEEP_MOVES+1 個持つ——いちばん古い
   * 1個は、その次の手が始まる前の盤面（＝5つの変化を前後つきで見るための出発点）。 */
  let hist = [];
  let watched = null;                 /* いま見ている対戦（M）。変わったら履歴を捨てる */
  let watchedLen = 0;                 /* 最後に見た M.log の行数 */

  function match() { return (typeof M !== 'undefined' && M) ? M : null; }

  /** 描画のたびに呼ばれる。ログが伸びていたら、その時点の盤面を1つ積む。
   * 例外は握りつぶす——**報告の仕組みが対戦を止めることは絶対にあってはならない**。 */
  function tick() {
    try {
      const m = match();
      if (!m || !m.log) return;
      if (m !== watched) { watched = m; watchedLen = 0; hist = []; }
      else if (m.log.length === watchedLen) return;
      const lines = m.log.slice(watchedLen);
      watchedLen = m.log.length;
      hist.push({
        turn: m.turn, active: m.active, phase: m.phase,
        lp: { self: m.players.self.lp, enemy: m.players.enemy.lp },
        deck: { self: m.players.self.deckCount, enemy: m.players.enemy.deckCount },   /* 巻き戻しの表示用（M7.9 第2段） */
        log: lines,
        board: CQBoardSpec.dump(m)
      });
      while (hist.length > KEEP_MOVES + 1) hist.shift();
    } catch (_) { /* 履歴が取れなくても対戦は続ける */ }
  }

  /* ================= レポートの組み立て ================= */

  /** 端末の時刻を "2026-08-31T22:05:11+09:00" の形にする（時差もそのまま残す）。 */
  function nowStamp() {
    const d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    const off = -d.getTimezoneOffset(), sg = off < 0 ? '-' : '+', a = Math.abs(off);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
      sg + p(Math.floor(a / 60)) + ':' + p(a % 60);
  }
  /** ファイル名用の "20260831-2205"。 */
  function fileStamp() {
    const d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function cardName(id) {
    const c = (typeof CARD_BY_ID !== 'undefined') ? CARD_BY_ID[id] : null;
    return c ? c.n : ('#' + id);
  }

  /** 盤面記述に出てくるカードＩＤを集める（名前の対応表を作るため）。 */
  function collectIds(spec, into) {
    if (!spec) return;
    ['self', 'enemy'].forEach(function (s) {
      ((spec.hand || {})[s] || []).forEach(function (id) { into[id] = 1; });
    });
    Object.keys(spec.lanes || {}).forEach(function (k) {
      const d = spec.lanes[k];
      if (!d) return;
      into[d.unit] = 1;
      (d.ch || []).forEach(function (c) { into[c.id] = 1; });
    });
  }

  /** いまどこで起きたことなのか。ラン側（RUI）と対戦側（M）の両方から拾う。 */
  function whereOf(m) {
    const w = {};
    const scr = document.querySelector('.screen.on');
    w.screen = scr ? scr.id.replace('screen-', '') : '?';
    w.mode = (typeof RUN_ACTIVE !== 'undefined' && RUN_ACTIVE) ? 'run' : 'free';
    if (typeof RUI !== 'undefined' && RUI && RUI.run) {
      const run = RUI.run;
      const area = (typeof CQAreas !== 'undefined' && CQAreas.get) ? CQAreas.get(run.areaId) : null;
      w.area = area ? area.name : run.areaId;
      w.view = RUI.view;
      w.nodeId = RUI.nodeId;
      const n = (run.map && run.map.nodes) ? run.map.nodes[RUI.nodeId] : null;
      if (n) { w.nodeType = n.type; w.attempts = n.attempts || 0; }
      w.runLp = run.lp; w.gold = run.gold;
    }
    if (m) {
      w.turn = m.turn; w.first = m.first; w.active = m.active; w.phase = m.phase;
      w.win = m.mode === 'field' ? 'field' : 'lp';
      w.opponentId = m.opponentId;
      w.lp = { self: m.players.self.lp, enemy: m.players.enemy.lp };
      w.deck = { self: m.players.self.deckCount, enemy: m.players.enemy.deckCount };
      if (m.fieldRules && m.fieldRules.length) w.fieldRules = JSON.parse(JSON.stringify(m.fieldRules));
      if (m.combat) w.inCombat = true;
      if (m.winner) w.winner = m.winner;
      if (m.fled) w.fled = true;
      if (typeof aiRank !== 'undefined') w.aiRank = aiRank;
      /* バトル画面を見ていないのに M が残っている＝直前の戦闘の残骸。盤面は参考値でしかない */
      if (w.screen !== 'battle') w.boardIsStale = true;
    }
    return w;
  }

  /** 送るもの一式を作る。DOMには触らない（控えからの再送信でも同じものを使う）。 */
  function build(comment) {
    const m = match();
    const rep = {
      kind: 'cardquest-board-report',
      app: (typeof APP_VERSION === 'string') ? APP_VERSION : '?',
      at: nowStamp(),
      comment: String(comment || '').trim(),
      where: whereOf(m),
      board: null,
      history: [],
      names: {},
      log: []
    };
    if (m) {
      try { rep.board = CQBoardSpec.dump(m); } catch (_) { rep.board = null; }
      rep.log = m.log.slice(-KEEP_LOG);
      /* 輪番バッファをそのまま渡す。**いちばん新しい1件は board が上の rep.board と同じ**に
       * なるが、そこを落とすと「直前の一手のログ」まで一緒に落ちてしまうので残す。 */
      rep.history = hist.slice();
    }
    const ids = {};
    collectIds(rep.board, ids);
    rep.history.forEach(function (h) { collectIds(h.board, ids); });
    Object.keys(ids).sort(function (a, b) { return a - b; }).forEach(function (id) {
      rep.names[id] = cardName(+id);
    });
    return rep;
  }

  /* ================= 人が読む形（メールの件名・本文） ================= */

  function subjectOf(rep) {
    const head = (rep.comment || '（コメントなし）').split('\n')[0];
    return 'CardQuest 盤面報告 v' + rep.app + '：' + (head.length > 28 ? head.slice(0, 28) + '…' : head);
  }

  /** どこで起きたかを1行にする（画面にもメール本文にも同じものを出す）。 */
  function whereLine(w) {
    const bits = [];
    if (w.area) bits.push(w.area);
    if (w.nodeType) bits.push({ battle: '戦闘', boss: 'ボス', shop: 'ショップ', rest: '休憩', treasure: '宝箱', event: '？', start: '出発' }[w.nodeType] || w.nodeType);
    if (w.turn != null) bits.push('ターン' + w.turn);
    if (w.active) bits.push((w.active === 'self' ? '自分' : '相手') + 'の手番');
    if (w.phase) bits.push({ draw: 'ドロー', discard: '手札調整', placement: '配置', main: 'メイン', over: '決着' }[w.phase] || w.phase);
    if (w.lp) bits.push('ＬＰ 自' + w.lp.self + '／敵' + w.lp.enemy);
    if (w.inCombat) bits.push('戦闘中');
    if (w.boardIsStale) bits.push('※戦闘画面ではありません');
    return bits.join('・');
  }

  /** 直前の動きを人が読む行にする（新しいものが下）。 */
  function historyLines(rep) {
    const out = [];
    rep.history.forEach(function (h, i) {
      const n = rep.history.length - i;
      (h.log.length ? h.log : ['（動きなし）']).forEach(function (t, k) {
        out.push((k === 0 ? '−' + n + '手 ' : '      ') + t);
      });
    });
    return out;
  }

  function bodyOf(rep) {
    const lines = [
      'CardQuest 盤面報告',
      'v' + rep.app + '　' + rep.at,
      '',
      '【気になったこと】',
      rep.comment || '（コメントなし）',
      '',
      '【どこで】',
      whereLine(rep.where) || '（不明）'
    ];
    const h = historyLines(rep);
    if (h.length) { lines.push('', '【直前の動き】'); lines.push.apply(lines, h); }
    return lines.join('\n');
  }

  function jsonOf(rep) { return JSON.stringify(rep, null, 2); }

  /* ================= 控え（localStorage） ================= */

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const a = raw ? JSON.parse(raw) : [];
      return Array.isArray(a) ? a : [];
    } catch (_) { return []; }
  }

  /** 新しいものを先頭に積んで20件で切る。容量が足りなければ古いものから捨てて入れ直す。 */
  function save(rep) {
    let list = load();
    list.unshift(rep);
    for (let n = Math.min(list.length, KEEP_STORE); n >= 1; n--) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, n))); return true; }
      catch (_) { /* 容量オーバー：件数を減らしてもう一度 */ }
    }
    return false;
  }

  function removeAt(i) {
    const list = load();
    if (i < 0 || i >= list.length) return;
    list.splice(i, 1);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch (_) { /* noop */ }
  }

  /* ================= 送る ================= */

  /** クリップボードへ。新しいAPIが無い／権限が無い端末のために古い手も残す。 */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) { return false; }
  }

  /** 共有シートを開く。**ユーザーの操作から途切れずに呼ぶこと**（間にawaitを挟むと
   * 「ユーザー操作から来た呼び出し」と見なされず、端末によっては何も起きない）。
   *
   * ★2026-09-05 本人報告「共有できませんでした：permission denied」の修正。
   * Chrome（Android含む）の Web Share は**添付できるファイルの種類を拡張子で制限**していて、
   * `.json`／`application/json` は許可リストに無い。`canShare()` は true を返すのに
   * `share()` だけが NotAllowedError（Permission denied）で落ちる、という分かりにくい
   * 失敗になる。許可リストにある **`.txt`（text/plain）を最初の候補**にし（中身はＪＳＯＮの
   * まま。盤面セットアップの「取り込む」は文字列を読むので拡張子は関係ない）、
   * それでも駄目なら本文にＪＳＯＮを入れた添付なしの共有へ順に落とす。
   * 取り消し（AbortError）だけは落とさずそのまま返す。 */
  function share(rep) {
    const json = jsonOf(rep);
    const base = 'cardquest-' + fileStamp();
    const cands = [
      { n: base + '.txt', t: 'text/plain' },
      { n: base + '.json', t: 'application/json' }
    ];
    const data = { title: subjectOf(rep), text: bodyOf(rep) };
    const textOnly = function () {
      if (!navigator.share) return Promise.reject(new Error('この端末は共有に対応していません'));
      /* 添付できない端末：本文にＪＳＯＮを丸ごと入れて共有する（読める形は保たれる） */
      return navigator.share({ title: data.title, text: data.text + '\n\n' + json })
        .then(function () { return { ok: true, how: '本文に入れて共有しました（添付は使えない端末です）' }; });
    };
    const files = [];
    if (navigator.canShare && typeof File === 'function') {
      cands.forEach(function (c) {
        let f = null;
        try { f = new File([json], c.n, { type: c.t }); } catch (_) { return; }
        let ok = false;
        try { ok = navigator.canShare({ files: [f] }); } catch (_) { ok = false; }
        if (ok) files.push({ f: f, n: c.n });
      });
    }
    const tryAt = function (k) {
      if (k >= files.length) return textOnly();
      return navigator.share(Object.assign({ files: [files[k].f] }, data))
        .then(function () { return { ok: true, how: files[k].n + ' を添えて共有しました' }; },
              function (e) {
                if (e && e.name === 'AbortError') throw e;      /* 取り消しは次を試さない */
                return tryAt(k + 1);                             /* 種類が拒まれた等：次の候補へ */
              });
    };
    return tryAt(0);
  }

  /** mailto: を組み立てる。長すぎるときはＪＳＯＮを本文から外す（クリップボードへ回す）。 */
  function mailtoUrl(rep, withJson) {
    const body = bodyOf(rep) + (withJson
      ? '\n\n【盤面のＪＳＯＮ】\n' + JSON.stringify(rep)
      : '\n\n【盤面のＪＳＯＮ】\nクリップボードに入れました。ここに貼り付けてください。');
    return 'mailto:' + MAIL_TO + '?subject=' + encodeURIComponent(subjectOf(rep)) +
      '&body=' + encodeURIComponent(body);
  }
  function openMail(rep) {
    let url = mailtoUrl(rep, true);
    let inline = true;
    if (url.length > MAILTO_LIMIT) { url = mailtoUrl(rep, false); inline = false; }
    if (!inline) copyText(jsonOf(rep));
    location.href = url;
    return inline;
  }

  const api = { tick, build, subjectOf, bodyOf, jsonOf, whereLine, historyLines,
                share, openMail, mailtoUrl, copyText, load, save, removeAt,
                MAIL_TO: MAIL_TO,
                history: function () { return hist.slice(); } };
  return api;
})();

/* ================= 報告の画面（🛠メニューから開く） =================
 * cq-confirm-overlay と同じ作り：**#app の中に position:absolute で置く**。
 * body直下に position:fixed で置くと、画面が小さくて #app ごと縮小表示されているとき
 * （--app-scale）だけこのダイアログが縮尺に従わず、実寸のまま画面をはみ出す。 */
(function () {

  let ov = null;              /* 出ているダイアログ（無ければ null） */
  let view = 'edit';          /* 'edit'＝書いて送る ／ 'list'＝控えの一覧 */
  let draft = '';             /* 書きかけの文章（一覧を見て戻ってきても消えない） */
  let msg = '';               /* 下に出す一言（送った結果など） */
  let current = null;         /* このダイアログで作って控えに入れたレポート */
  let currentFor = null;      /* その控えを作ったときの文章（変わっていたら作り直す） */

  function esc2(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  function open() {
    close();
    view = 'edit'; msg = ''; current = null; currentFor = null;
    ov = document.createElement('div');
    ov.className = 'cqr-overlay';
    (document.getElementById('app') || document.body).appendChild(ov);
    ov.addEventListener('click', onClick);
    ov.addEventListener('input', function (ev) {
      if (ev.target && ev.target.id === 'cqr-comment') draft = ev.target.value;
    });
    render();
    const ta = ov.querySelector('#cqr-comment');
    if (ta) { try { ta.focus(); } catch (_) { /* noop */ } }
  }

  function close() { if (ov) { ov.remove(); ov = null; } }

  /* ---- 描画 ---------------------------------------------------------------- */

  function render() {
    if (!ov) return;
    const n = CQReport.load().length;
    ov.innerHTML =
      '<div class="cqr-box">' +
        '<div class="cqr-h">📮 盤面を報告' +
          '<span class="cqr-sub">v' + esc2(typeof APP_VERSION === 'string' ? APP_VERSION : '?') + '</span>' +
          '<button class="cqr-x" data-cqr="close">✕</button>' +
        '</div>' +
        (view === 'edit' ? editBody() : listBody()) +
        (msg ? '<div class="cqr-msg">' + msg + '</div>' : '') +
        (view === 'edit' ? editBtns(n) : '<div class="cqr-btns"><button class="tiny" data-cqr="edit">← 報告を書く画面へ</button></div>') +
      '</div>';
  }

  function editBody() {
    const rep = CQReport.build(draft);
    const w = CQReport.whereLine(rep.where);
    const h = CQReport.historyLines(rep);
    return '<div class="cqr-body">' +
      '<label class="cqr-lb" for="cqr-comment">気になったことを書いてください（後で自分が読んで分かる程度で十分です）</label>' +
      '<textarea class="cqr-ta" id="cqr-comment" rows="3" ' +
        'placeholder="例：敵陣2の◯◯は硬直しているはずなのに攻撃してきた">' + esc2(draft) + '</textarea>' +
      '<div class="cqr-where">' + (w ? esc2(w) : '（場所の情報がありません）') + '</div>' +
      (rep.board
        ? '<div class="cqr-hist"><div class="cqr-hist-h">いっしょに送るもの：いまの盤面＋直前' +
            h.length + '行の動き（途中の盤面' + rep.history.length + '枚つき）</div>' +
            (h.length ? h.map(function (t) { return '<div>' + esc2(t) + '</div>'; }).join('')
                      : '<div class="cqr-dim">（まだ動きがありません）</div>') +
          '</div>'
        : '<div class="cqr-hist"><div class="cqr-dim">戦闘中ではないので盤面はありません。' +
          'コメントと場所だけを送ります。</div></div>') +
      '</div>';
  }

  function editBtns(n) {
    return '<div class="cqr-btns">' +
      '<button class="btn ok" data-cqr="share">📧 メールで送る</button>' +
      '<button class="tiny" data-cqr="mail">✉ 宛先つきで開く</button>' +
      '<button class="tiny" data-cqr="copy">📋 コピー</button>' +
      '<button class="tiny" data-cqr="list">🗂 控え（' + n + '）</button>' +
      '</div>';
  }

  function listBody() {
    const list = CQReport.load();
    if (!list.length) return '<div class="cqr-body"><div class="cqr-dim">控えはまだありません。' +
      '「メールで送る」「コピー」を押すと、ここに残ります。</div></div>';
    return '<div class="cqr-body cqr-list">' + list.map(function (rep, i) {
      const head = (rep.comment || '（コメントなし）').split('\n')[0];
      return '<div class="cqr-row">' +
        '<div class="cqr-row-t">' +
          '<b>' + esc2(head.length > 40 ? head.slice(0, 40) + '…' : head) + '</b>' +
          '<small>' + esc2(String(rep.at || '').replace('T', ' ').slice(0, 16)) + '　' +
            esc2(CQReport.whereLine(rep.where || {})) + '</small>' +
        '</div>' +
        '<button class="tiny" data-cqr="share" data-i="' + i + '">📧</button>' +
        '<button class="tiny" data-cqr="copy" data-i="' + i + '">📋</button>' +
        '<button class="tiny del" data-cqr="del" data-i="' + i + '">✕</button>' +
      '</div>';
    }).join('') + '</div>';
  }

  /* ---- 操作 ---------------------------------------------------------------- */

  /** 送る対象のレポートを返す。i<0＝いま書いているもの（そのとき控えにも入れる）。
   * **同期で終わること**——このあと navigator.share をユーザー操作から途切れずに呼ぶため。 */
  function repFor(i) {
    if (i >= 0) return CQReport.load()[i] || null;
    if (current && currentFor === draft) return current;
    const rep = CQReport.build(draft);
    CQReport.save(rep);
    current = rep; currentFor = draft;
    return rep;
  }

  function onClick(ev) {
    const b = ev.target.closest('[data-cqr]');
    if (!b) { if (ev.target === ov) close(); return; }
    const act = b.dataset.cqr;
    const i = b.dataset.i === undefined ? -1 : +b.dataset.i;
    if (act === 'close') return close();
    if (act === 'list') { view = 'list'; msg = ''; return render(); }
    if (act === 'edit') { view = 'edit'; msg = ''; return render(); }
    if (act === 'del') { CQReport.removeAt(i); msg = '控えを1件消しました。'; return render(); }

    const rep = repFor(i);
    if (!rep) { msg = '⚠ その控えは見つかりませんでした。'; return render(); }

    if (act === 'share') {
      CQReport.share(rep).then(function (r) {
        msg = '✅ ' + esc2(r.how) + '　Ｇmailを選び、宛先を自分にして送ってください。';
        render();
      }, function (e) {
        msg = (e && e.name === 'AbortError')
          ? '共有をやめました（控えには残っています）。'
          : '⚠ 共有できませんでした：' + esc2(e && e.message ? e.message : e) +
            '　「✉ 宛先つきで開く」か「📋 コピー」をお使いください。';
        render();
      });
      msg = '共有シートを開いています…';
      return render();
    }
    if (act === 'mail') {
      const inline = CQReport.openMail(rep);
      msg = inline
        ? '✉ メールの下書きを開きました（宛先入り・盤面は本文の下にあります）。'
        : '✉ メールの下書きを開きました。盤面はクリップボードに入れたので、本文に貼り付けてください。';
      return render();
    }
    if (act === 'copy') {
      CQReport.copyText(CQReport.jsonOf(rep)).then(function (ok) {
        msg = ok ? '📋 ＪＳＯＮをコピーしました。' : '⚠ コピーできませんでした。';
        render();
      });
      return;
    }
  }

  CQReport.open = open;
  CQReport.close = close;
})();
