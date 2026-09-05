/* CardQuest — 盤面記述（デバッグ用の盤面セットアップ・2026-08-30）
 *
 * 「狙ったカードを相手が用意してくれる状況」を手で作れるようにするための、
 * **盤面を表すただのデータ**とその読み書き。考察『盤面セットアップのデバッグモード』§4 の形。
 *
 *   {
 *     "first": "self", "active": "self", "phase": "main", "win": "field",
 *     "lp":   { "self": 10, "enemy": 10 },
 *     "hand": { "self": [108, 113], "enemy": [] },
 *     "lanes": {
 *       "0": { "unit": 8,  "ch": [{ "id": 108, "up": false, "by": "self" }] },
 *       "3": { "unit": 70, "ch": [{ "id": 101, "up": false, "by": "enemy" },
 *                                 { "id": 172, "up": false, "by": "enemy" }] }
 *     }
 *   }
 *
 * ・レーン番号は 0〜2 が自陣、3〜5 が敵陣（js/engine/state.js の並びのまま）。
 * ・`by` は「そのＣＨを置いた側」（＝エンジンの `ch.mine`）。**省略時はそのレーンの持ち主**。
 *   113透視・25スケープゴート・憑依解除の元凶狙いなど、置いた側で挙動が変わるカードが
 *   立て続けに出たので（M6.7）、ここを指定できることがこの仕組みの肝になっている。
 * ・`win` は勝利条件。"field"＝敵の場を空にすれば勝ち（探索中の通常戦闘と同じ）、
 *   "lp"＝従来のＬＰ勝負（相手も手札から召還してくる）。
 *
 * **エンジンには一切触らない。** ここがするのは「作り終わった `M` の盤面を差し替えて
 * `recalc` を呼ぶ」だけで、ターン進行・効果処理には手を入れない。
 * DOMにも依存しないので、ブラウザ（js/layout.js のデバッグ画面）からも
 * Node（tests/run.js の盤面ビルダ）からも同じものが使える。
 */
'use strict';
(function (global) {

  const isNode = (typeof require === 'function' && typeof window === 'undefined');
  const S = isNode ? require('./engine/state.js') : global.CQState;
  const Stats = isNode ? require('./engine/stats.js') : global.CQStats;

  const SIDES = { self: 1, enemy: 1 };
  const PHASES = { placement: 1, main: 1 };

  /** 何も置かれていない既定の盤面。 */
  function blank() {
    return { first: 'self', active: 'self', phase: 'main', win: 'field',
             lp: { self: 10, enemy: 10 }, hand: { self: [], enemy: [] }, lanes: {} };
  }

  /** レーン番号から既定の持ち主を返す（0〜2＝自陣／3〜5＝敵陣）。 */
  function ownerOf(i) { return i < 3 ? 'self' : 'enemy'; }

  /* ---- 検証つき正規化 ------------------------------------------------------ */

  /** 人が書いた（あるいは貼り付けた）記述を、抜けを埋めた正しい形にする。
   * 戻り値 { spec, errors }。errors が空でなければ spec は使わないこと。
   * cards … CARD_BY_ID（カードＩＤの実在確認と種別チェックに使う。省略可） */
  function normalize(input, cards) {
    const errors = [];
    const src = (input && typeof input === 'object') ? input : {};
    const out = blank();

    const side = function (v, def, where) {
      if (v === undefined || v === null) return def;
      if (!SIDES[v]) { errors.push(where + ' は "self" か "enemy" で書いてください（いまは ' + JSON.stringify(v) + '）'); return def; }
      return v;
    };
    out.first = side(src.first, 'self', 'first');
    out.active = side(src.active, out.first, 'active');
    if (src.phase !== undefined && src.phase !== null) {
      if (!PHASES[src.phase]) errors.push('phase は "placement"（配置から）か "main"（メインから）です（いまは ' + JSON.stringify(src.phase) + '）');
      else out.phase = src.phase;
    }
    if (src.win !== undefined && src.win !== null) {
      if (src.win !== 'field' && src.win !== 'lp') errors.push('win は "field"（敵の場を空に）か "lp"（ＬＰ勝負）です');
      else out.win = src.win;
    }

    const lp = src.lp || {};
    ['self', 'enemy'].forEach(function (s) {
      const v = lp[s];
      if (v === undefined || v === null) return;
      const n = Math.round(Number(v));
      if (!isFinite(n)) { errors.push('lp.' + s + ' は 1〜99 の数で書いてください'); return; }
      /* 範囲外は丸める（エラーにしない）。「盤面を報告」は決着した直後の盤面（ＬＰ0以下）も
       * 封筒に入れるので、それをそのまま取り込めるようにする（2026-09-05 本人報告）。 */
      out.lp[s] = Math.max(1, Math.min(99, n));
    });

    const known = function (id, where) {
      const n = Math.round(Number(id));
      if (!isFinite(n)) { errors.push(where + ' のカードＩＤが数ではありません（' + JSON.stringify(id) + '）'); return null; }
      if (cards && !cards[n]) { errors.push(where + ' のカードＩＤ ' + n + ' は存在しません'); return null; }
      return n;
    };

    const hand = src.hand || {};
    ['self', 'enemy'].forEach(function (s) {
      const list = hand[s];
      if (list === undefined || list === null) return;
      if (!Array.isArray(list)) { errors.push('hand.' + s + ' はカードＩＤの配列です'); return; }
      if (list.length > 7) errors.push('hand.' + s + ' は7枚までです（いま ' + list.length + '枚）');
      list.slice(0, 7).forEach(function (id) {
        const n = known(id, 'hand.' + s);
        if (n != null) out.hand[s].push(n);
      });
    });

    const lanes = src.lanes || {};
    Object.keys(lanes).forEach(function (k) {
      const i = Math.round(Number(k));
      if (!isFinite(i) || i < 0 || i > 5) { errors.push('レーン番号 ' + JSON.stringify(k) + ' は 0〜5 です'); return; }
      const raw = lanes[k];
      if (!raw || typeof raw !== 'object') return;
      const where = 'レーン' + i;
      const unit = known(raw.unit, where + '.unit');
      if (unit == null) return;                      /* ユニットが居ないレーンは空きレーン扱い */
      if (cards && cards[unit] && cards[unit].t !== 'U') { errors.push(where + '.unit の ' + unit + ' はモンスターではありません'); return; }
      const cap = cards && cards[unit] ? (S.unitStats(cards[unit]).ch || 0) : 6;
      const chs = [];
      (Array.isArray(raw.ch) ? raw.ch : []).forEach(function (c, idx) {
        const e = (c && typeof c === 'object') ? c : { id: c };
        const id = known(e.id, where + ' の第' + (idx + 1) + '階層');
        if (id == null) return;
        /* モンスターも階層に置ける（＝リバース召還。開かれるとその場に立つ。原作どおり）。
         * 2026-08-30 本人指定でここを開けた。おじゃま虫(200)だけは置けない。 */
        if (cards && cards[id] && cards[id].t === 'X') { errors.push(where + ' の第' + (idx + 1) + '階層の ' + cards[id].n + ' はチャネリングできません'); return; }
        const by = e.by === undefined ? ownerOf(i) : e.by;
        if (!SIDES[by]) { errors.push(where + ' の第' + (idx + 1) + '階層の by は "self" か "enemy" です'); return; }
        /* カース(91〜99)＝憑依。取り憑いたカースは常に表向き（裏にはできない）なので up は
         * 強制的に true（2026-09-05 本人指定：傀儡化(92)などの検証のために置けるようにした） */
        const curse = !!(cards && cards[id] && cards[id].t === 'C');
        chs.push({ id: id, up: curse ? true : !!e.up, by: by });
      });
      if (chs.length > cap) errors.push(where + ' の ' + (cards ? cards[unit].n : unit) + ' はＣＨ' + cap + 'までです（いま ' + chs.length + '枚）');
      const ln = { unit: unit, ch: chs.slice(0, cap) };
      if (raw.stiff) ln.stiff = true;                /* 硬直（このターン動けない）。省略時は動ける */
      /* M7.8 WP6：傀儡で相手陣営へ移されたユニットの元の陣営。これを運ばないと、
       * 報告や巻き戻しから盤面を作り直したときに「傀儡が表なのに印が無い」＝もう一度
       * 移動してしまう（2026-09-05 に巻き戻しの実装で判明） */
      if (raw.puppeted === 'self' || raw.puppeted === 'enemy') ln.puppeted = raw.puppeted;
      out.lanes[String(i)] = ln;
    });

    return { spec: out, errors: errors };
  }

  /* ---- 記述 → 対戦 --------------------------------------------------------- */

  /** できあがっている対戦 `m` の盤面・手札・ＬＰ・手番を、記述どおりに差し替える。
   * `m` は呼び出し側が `CQTurn.createMatch` で作っておくこと
   * （hooks の配線を忘れると魔法が一切発動しないので、作る側の責任にしてある）。 */
  function apply(m, spec) {
    const s = normalize(spec, m.cards).spec;
    const lanes = [];
    for (let i = 0; i < S.LANES; i++) {
      const d = s.lanes[String(i)];
      if (!d) { lanes.push(S.emptyLane()); continue; }
      const ln = S.makeLane(d.unit, d.ch.map(function (c) {
        /* revealed:true ＝「一度は見られた札」。デバッグで置いた札は
         * 相手の透視・予見の対象から外れないよう、伏せたままにしておく（revealed は付けない）。
         * ただしカース(91〜99)は**憑依として**置く（表・公開済み・st:'possess'）＝戦闘で
         * 憑依ユニットを倒したときに付くものと同じ形（combat.js applyPendingCurse）。 */
        const card = m.cards[c.id];
        if (card && card.t === 'C') return { card: c.id, up: true, mine: c.by === 'self', revealed: true, st: 'possess' };
        return { card: c.id, up: c.up, mine: c.by === 'self' };
      }), m.cards, { puppeted: d.puppeted });
      ln.stiff = !!d.stiff;
      lanes.push(ln);
    }
    m.board.lanes = lanes;

    ['self', 'enemy'].forEach(function (side) {
      const p = m.players[side];
      p.lp = s.lp[side];
      if (p.maxLp < p.lp) p.maxLp = p.lp;
      p.hand = s.hand[side].slice();
      p.turnsTaken = 1;                 /* 初手のドロー（6枚）を起こさせない */
      p.actedThisTurn = false;
      p.fledThisTurn = false;
    });
    m.board.hand.self = m.players.self.hand.length;
    m.board.hand.enemy = m.players.enemy.hand.length;

    m.first = s.first;
    m.active = s.active;
    m.phase = s.phase;
    m.turn = 1;
    m.winner = null;
    m.combat = null;
    m.reversing = null;
    m.pendingCurse = null;
    m.forcedChain = null;
    m.forcedCtx = null;
    m.pendingChoice = null;
    if (m.mode === 'field') m.fieldReady = true;   /* 敵が0体なら即勝ちになる。承知のうえ */

    Stats.recalc(m.board, { cards: m.cards });
    /* 集計後の強制処理（M7.8 WP1・WP6：緊急抵抗・融合解除・**傀儡の物理移動**）も通しておく。
     * 表向きの傀儡やカース92を置いた盤面は、始めた瞬間にそのユニットが相手の場へ移った状態になる
     * （ゲーム中に起きるのと同じ盤面から始められる） */
    const Combat = isNode ? require('./engine/combat.js') : global.CQCombat;
    if (Combat && typeof Combat.enforcePost === 'function') Combat.enforcePost(m);
    return m;
  }

  /* ---- 対戦 → 記述 --------------------------------------------------------- */

  /** いまの対戦の盤面を記述として取り出す（編集画面の初期値・Claudeへの受け渡しに使う）。 */
  function dump(m) {
    const out = blank();
    out.first = m.first || 'self';
    out.active = m.active || 'self';
    out.phase = (m.phase === 'placement') ? 'placement' : 'main';
    out.win = m.mode === 'field' ? 'field' : 'lp';
    out.lp = { self: m.players.self.lp, enemy: m.players.enemy.lp };
    out.hand = { self: m.players.self.hand.slice(), enemy: m.players.enemy.hand.slice() };
    for (let i = 0; i < S.LANES; i++) {
      const ln = m.board.lanes[i];
      if (!ln || ln.unit == null) continue;
      const d = { unit: ln.unit, ch: ln.channels.map(function (ch) {
        return { id: ch.card, up: !!ch.up, by: ch.mine ? 'self' : 'enemy' };
      }) };
      if (ln.stiff) d.stiff = true;
      if (ln.puppeted) d.puppeted = ln.puppeted;
      out.lanes[String(i)] = d;
    }
    return out;
  }

  /* ---- 文字列との相互変換（Claudeとの受け渡し口） --------------------------- */

  /** 読める形の JSON にする（レーン1行ずつ）。 */
  function stringify(spec) {
    const s = normalize(spec).spec;
    const lines = Object.keys(s.lanes).sort(function (a, b) { return a - b; }).map(function (k) {
      const d = s.lanes[k];
      const ch = d.ch.map(function (c) {
        return '{ "id": ' + c.id + ', "up": ' + c.up + ', "by": "' + c.by + '" }';
      }).join(', ');
      return '    "' + k + '": { "unit": ' + d.unit + (d.stiff ? ', "stiff": true' : '')
        + (d.puppeted ? ', "puppeted": "' + d.puppeted + '"' : '') + ', "ch": [' + ch + '] }';
    });
    return '{\n'
      + '  "first": "' + s.first + '", "active": "' + s.active + '", "phase": "' + s.phase + '", "win": "' + s.win + '",\n'
      + '  "lp": { "self": ' + s.lp.self + ', "enemy": ' + s.lp.enemy + ' },\n'
      + '  "hand": { "self": [' + s.hand.self.join(', ') + '], "enemy": [' + s.hand.enemy.join(', ') + '] },\n'
      + '  "lanes": {\n' + lines.join(',\n') + (lines.length ? '\n' : '') + '  }\n}';
  }

  /* ---- 「盤面を報告」の封筒をほどく（2026-08-31 本人指定） --------------------
   * js/report.js が作るメール用のＪＳＯＮは、盤面そのものではなく**封筒**である：
   *   { kind:'cardquest-board-report', comment, where, board:{…この形…}, history:[…], … }
   * 直した後に「同じ場面をもう一度」を確かめたいので、その封筒をそのまま貼り付けても
   * 中の盤面を取り出せるようにする。中身は結局この形なので、ほどくだけでよい。
   *
   * 戻り値 null … 封筒ではない（＝ふつうの盤面記述）。
   *        それ以外 … { board, history:[{ label, log, board }], comment, at, app, where }
   *        history は古い順（label は「−5手」…「−1手」）。board は「いま」の盤面。 */
  function unwrap(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const looksLikeReport = raw.kind === 'cardquest-board-report'
      || (raw.board && typeof raw.board === 'object' && !raw.lanes);
    if (!looksLikeReport) return null;
    const hist = Array.isArray(raw.history) ? raw.history : [];
    return {
      board: (raw.board && typeof raw.board === 'object') ? raw.board : null,
      history: hist.map(function (h, i) {
        return { label: '−' + (hist.length - i) + '手',
                 log: Array.isArray(h && h.log) ? h.log.slice() : [],
                 board: (h && h.board && typeof h.board === 'object') ? h.board : null };
      }).filter(function (h) { return !!h.board; }),
      comment: typeof raw.comment === 'string' ? raw.comment : '',
      at: typeof raw.at === 'string' ? raw.at : '',
      app: typeof raw.app === 'string' ? raw.app : '',
      where: (raw.where && typeof raw.where === 'object') ? raw.where : {}
    };
  }

  /** 貼り付けられた文字列を読む。戻り値 { spec, errors, report }。
   * report … 「盤面を報告」の封筒だったときだけ入る（unwrap の戻り値）。呼び出し側は
   * これを見て「どの手の盤面を取り込むか」を選ばせられる。ふつうの盤面記述なら null。 */
  function parse(text, cards) {
    let raw;
    try { raw = JSON.parse(String(text)); }
    catch (e) { return { spec: blank(), errors: ['ＪＳＯＮとして読めません：' + e.message], report: null }; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { spec: blank(), errors: ['いちばん外側は { } で囲んでください'], report: null };
    const rep = unwrap(raw);
    if (rep) {
      if (!rep.board) return { spec: blank(), errors: ['報告のＪＳＯＮですが、盤面が入っていません（戦闘中ではないときの報告かもしれません）'], report: rep };
      const r = normalize(rep.board, cards);
      return { spec: r.spec, errors: r.errors, report: rep };
    }
    const r = normalize(raw, cards);
    return { spec: r.spec, errors: r.errors, report: null };
  }

  const api = { blank, ownerOf, normalize, apply, dump, stringify, parse, unwrap };
  global.CQBoardSpec = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
