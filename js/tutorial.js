/* CardQuest — チュートリアルの進行台本（M8.5 改訂・2026-09-07）
 *
 * 【なぜ作り直したか】
 * 初版は「初期条件だけ固定して、進行はプレイヤーに任せる」設計だった。
 * 実際に遊んでもらったところ——**次に何をすればよいか分からず手番を送り続け、その間に相手が
 * カードをチャネルして攻撃してきて、理由も分からないまま倒された**。チュートリアルとして
 * 成立していなかった（2026-09-07 本人報告）。
 *
 * 【作り直しの方針（本人指示）】
 *   ① 指示は**やり終えるまで画面に出しっぱなし**にする（タップで消える形をやめる）
 *   ② **やり終えたら次の指示が自動で出る**（1ステップ＝1操作）
 *   ③ 何をすべきかを**完全に**指示する
 *   ④ **相手の動きも100%こちらで決める**（js/engine/ai.js の 'idle' 方策＝何もしない相手）
 *   ⑤ そのうえで戦闘を最後まで終わらせる
 *
 * 【この部品の役割】
 *   ・いまのステップの指示を、バトル画面の上に**出しっぱなし**で描く
 *   ・ステップの「完了条件」を毎描画ごとに見て、満たされたら次へ進める
 *   ・指示以外の操作を**やんわり止める**（置く先・開く階層・攻撃の可否）＝手順から外れて詰まない
 *
 * **エンジンには触らない。** 読むのは渡された M / UI だけで、盤面も乱数も動かさない。
 * 文面は js/lore.js（LORE.tutorial）が持つ＝推敲でコードを触らない。
 */
'use strict';

const CQTutorial = (function () {

  /* 実行中の台本。{ stage, steps, i, snap, ctx } */
  var RUN = null;

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function lore() { return (typeof CQLore !== 'undefined' && CQLore.LORE) ? CQLore.LORE : null; }
  function screenEl() {
    return (typeof document !== 'undefined') ? document.getElementById('screen-battle') : null;
  }

  /* ================= 盤面を読むだけの小道具 ================= */
  function selfLanes(M) { return [M.board.lanes[0], M.board.lanes[1], M.board.lanes[2]]; }
  function foeLanes(M) { return [M.board.lanes[3], M.board.lanes[4], M.board.lanes[5]]; }
  function selfUnitLane(M) {
    for (var i = 0; i < 3; i++) if (M.board.lanes[i].unit != null) return i;
    return -1;
  }
  function selfHasUnit(M) { return selfUnitLane(M) >= 0; }
  function selfChCount(M) {
    return selfLanes(M).reduce(function (n, ln) { return n + (ln.channels ? ln.channels.length : 0); }, 0);
  }
  /** 自陣のどこかに、そのカードがチャネルされているか（表裏を問わない）。 */
  function selfHasCh(M, id) {
    return selfLanes(M).some(function (ln) {
      return (ln.channels || []).some(function (c) { return c.card === id; });
    });
  }
  /** 自陣のそのカードの居場所 {lane, layer}（無ければ null）。 */
  function findSelfCh(M, id) {
    for (var i = 0; i < 3; i++) {
      var ln = M.board.lanes[i];
      for (var k = 0; k < (ln.channels || []).length; k++) {
        if (ln.channels[k].card === id) return { lane: i, layer: k + 1 };
      }
    }
    return null;
  }
  function foeHasCh(M, id) {
    return foeLanes(M).some(function (ln) {
      return (ln.channels || []).some(function (c) { return c.card === id; });
    });
  }
  function myTurns(M) { return (M.players && M.players.self && M.players.self.turnsTaken) || 0; }

  /* ================= ステップの「動き」＝完了条件と制限 =================
   * 文面（アンバーの台詞・ＵＩの一行）は js/lore.js の LORE.tutorial[stage] が持つ。
   * ここはキーが同じ入れ物で、「いつ終わりか」「何を許すか」だけを持つ。
   *
   *   info      … 操作を待たない案内。「次へ」で進む
   *   done(M,UI,snap) … true になったら次のステップへ
   *   glow      … 光らせる要素（セレクタ／関数）
   *   dropId    … このカードだけ場に置ける（他は断る）
   *   dropKind  … 'MS'＝モンスター以外だけ置ける
   *   flipCard  … 自分の手番に開けるのは、このカードが乗っている階層だけ
   *   pickCard  … 対象選択の候補を、このカードだけに絞る
   *   canAttack … true のときだけ攻撃できる
   */
  var RULES = {
    1: {
      intro:    { info: true },
      place:    { dropId: 8,
                  glow: ['#hand .hand-card[data-card="8"]', '#half-m .empty-unit'],
                  done: function (M) { return selfHasUnit(M); } },
      channel:  { dropKind: 'MS',
                  glow: ['#hand .hand-card.M', '#hand .hand-card.S', '#half-m .card.unit'],
                  done: function (M) { return selfChCount(M) >= 1; } },
      endPlace: { glow: ['#acts .act-btn'],
                  done: function (M) { return M.phase === 'main' || !!M.combat || !!M.winner; } },
      /* 置いた（＝召還した）ユニットはその手番は硬直している。攻めるには一度ターンを跨ぐ。
       * 「ターンを終了する」→（相手は何もしない）→「配置を終える」の2押しを1ステップで案内する。 */
      nextTurn: { glow: ['#acts .act-btn'],
                  enter: function (M) { return { turns: myTurns(M) }; },
                  done: function (M, UI, snap) {
                    return myTurns(M) > (snap ? snap.turns : 0) && (M.phase === 'main' || !!M.combat);
                  } },
      attack:   { canAttack: true,
                  glow: ['#half-m .card.unit', '#half-e .card.unit'],
                  done: function (M) { return !!M.combat || !!M.winner; } },
      open:     { glow: ['#board .card.ch.openable', '#acts .act-btn'],
                  done: function (M) { return !M.combat; } },
      finish:   { info: true, last: true }
    },
    2: {
      intro:    { info: true },
      intro2:   { info: true },
      place:    { dropId: 8,
                  glow: ['#hand .hand-card[data-card="8"]', '#half-m .empty-unit'],
                  done: function (M) { return selfHasUnit(M); } },
      setForce: { dropId: 108,
                  glow: ['#hand .hand-card[data-card="108"]', '#half-m .card.unit'],
                  done: function (M) { return selfHasCh(M, 108); } },
      setUnposs:{ dropId: 101,
                  glow: ['#hand .hand-card[data-card="101"]', '#half-m .card.unit'],
                  done: function (M) { return selfHasCh(M, 101); } },
      endPlace: { glow: ['#acts .act-btn'],
                  done: function (M) { return M.phase === 'main' || !!M.winner; } },
      /* 伏せた（＝チャネルした）ユニットも硬直する。開くのは次の手番から。 */
      nextTurn: { glow: ['#acts .act-btn'],
                  enter: function (M) { return { turns: myTurns(M) }; },
                  done: function (M, UI, snap) {
                    return myTurns(M) > (snap ? snap.turns : 0) && M.phase === 'main';
                  } },
      openForce:{ flipCard: 108,
                  glow: function (M) {
                    var at = findSelfCh(M, 108);
                    return at ? ['#board .card.ch[data-lane="' + at.lane + '"][data-layer="' + at.layer + '"]'] : [];
                  },
                  done: function (M) {
                    return !!(M.lastForcedChain && M.lastForcedChain.kind === 108) || !selfHasCh(M, 108);
                  } },
      openUnposs:{ flipCard: 101, pickCard: 153,
                  glow: function (M) {
                    var at = findSelfCh(M, 101);
                    return at ? ['#board .card.ch[data-lane="' + at.lane + '"][data-layer="' + at.layer + '"]'] : [];
                  },
                  done: function (M) { return !foeHasCh(M, 153); } },
      /* 開いた（＝リバースした）ユニットも硬直する。攻めるのはさらに次の手番から。 */
      nextTurn2:{ glow: ['#acts .act-btn'],
                  enter: function (M) { return { turns: myTurns(M) }; },
                  done: function (M, UI, snap) {
                    return myTurns(M) > (snap ? snap.turns : 0) && (M.phase === 'main' || !!M.combat);
                  } },
      attack:   { canAttack: true,
                  glow: ['#half-m .card.unit', '#half-e .card.unit'],
                  done: function (M) { return !!M.combat || !!M.winner; } },
      open2:    { glow: ['#board .card.ch.openable', '#acts .act-btn'],
                  done: function (M) { return !M.combat; } },
      finish:   { info: true, last: true }
    }
  };

  /* ================= 開始・終了 ================= */

  /** 台本を始める。ctx = { onFinish() } */
  function begin(stage, ctx) {
    end();
    var script = (lore() && lore().tutorial) ? lore().tutorial[stage] : null;
    if (!script || !script.length || !RULES[stage]) return false;
    RUN = { stage: stage, steps: script, i: 0, snap: null, ctx: ctx || {} };
    enterStep();
    return true;
  }

  function end() {
    clearGlow();
    var el = screenEl() && screenEl().querySelector('.tut-strip');
    if (el) el.remove();
    RUN = null;
  }

  function active() { return !!RUN; }
  function stage() { return RUN ? RUN.stage : 0; }
  function stepKey() { return RUN ? RUN.steps[RUN.i].key : null; }
  function rule() { return RUN ? (RULES[RUN.stage][RUN.steps[RUN.i].key] || {}) : {}; }

  function enterStep() {
    if (!RUN) return;
    var r = rule();
    RUN.snap = (typeof r.enter === 'function' && typeof M !== 'undefined' && M) ? r.enter(M) : null;
    paint();
    /* 「次へ」で進んだ直後は盤面を描き直さないので、ここでも光らせ直しておく
     * （そうしないと、次の指示が出ているのにハイライトが1手遅れる）。 */
    applyGlow(typeof M !== 'undefined' ? M : null);
  }

  /** 案内だけのステップを「次へ」で送る。 */
  function next() {
    if (!RUN) return;
    advance();
  }

  function advance() {
    if (!RUN) return;
    if (RUN.i >= RUN.steps.length - 1) {
      var cb = RUN.ctx && RUN.ctx.onFinish;
      end();
      if (typeof cb === 'function') { try { cb(); } catch (e) { /* 失敗しても進行は止めない */ } }
      return;
    }
    RUN.i += 1;
    enterStep();
  }

  /* ================= 毎描画ごとの点検 =================
   * js/layout.js の renderAll() の最後から呼ばれる。**盤面には触らない**。
   * ここでやるのは「完了条件を見て進める」「指示を描き直す」「光らせ直す」の3つだけ。 */
  function tick(M, UI) {
    if (!RUN || !M) return;
    var guard = 0;
    while (RUN && guard++ < 8) {
      var r = rule();
      if (r.info || typeof r.done !== 'function') break;
      var ok = false;
      try { ok = !!r.done(M, UI, RUN.snap); } catch (e) { ok = false; }
      if (!ok) break;
      advance();
    }
    if (!RUN) return;
    paint();
    applyGlow(M);
  }

  /* ================= 手順から外れる操作を止める ================= */

  /** 場に置けるか（配置ステップ）。戻り値 { ok, reason } */
  function checkDrop(cardId, laneIdx) {
    if (!RUN) return { ok: true };
    if (laneIdx > 2) {
      return { ok: false, reason: 'チュートリアルの間は、自分の場（下側）にだけ置いてください。' };
    }
    var r = rule();
    if (r.dropId != null) {
      if (cardId === r.dropId) return { ok: true };
      return { ok: false, reason: '案内に出ているカードを置いてください。' };
    }
    if (r.dropKind === 'MS') {
      var c = (typeof CARD_BY_ID !== 'undefined') ? CARD_BY_ID[cardId] : null;
      if (c && c.t !== 'U') return { ok: true };
      return { ok: false, reason: 'ここでは魔法か技能を、モンスターの上に重ねてください。' };
    }
    return { ok: false, reason: 'いまは案内のとおりに進めてください。' };
  }

  /** 自分の手番にその階層を開けるか（戦闘中のオープンには関係しない）。 */
  function allowFlip(laneIdx, layer) {
    if (!RUN) return true;
    var r = rule();
    if (r.flipCard == null) return false;
    var at = (typeof M !== 'undefined' && M) ? findSelfCh(M, r.flipCard) : null;
    return !!(at && at.lane === laneIdx && at.layer === layer);
  }

  /** 攻撃してよいか。 */
  function allowAttack() { return !RUN || !!rule().canAttack; }

  /** 案内が「この札を砕け」と決めている段では、対象を**こちらで決めてしまう**。
   * 候補を1つに絞るだけでは足りない——候補が1つになると選択画面が出ず、
   * エンジンが自分で（無作為に）選んでしまうため（2026-09-07 実機相当の確認で判明）。
   * spec は js/engine/effects/magic.js の targetsFor が返した形。書き換えずに読むだけ。
   * 戻り値：決めた対象 {lane, idx}／決めないときは null。 */
  function forcedPick(M2, spec) {
    if (!RUN || !spec || !M2) return null;
    var want = rule().pickCard;
    if (want == null || spec.kind !== 'ch' || !Array.isArray(spec.targets)) return null;
    var hit = null;
    spec.targets.forEach(function (t) {
      if (hit) return;
      var ln = M2.board.lanes[t.lane];
      var ch = ln && ln.channels[t.idx];
      if (ch && ch.card === want) hit = t;
    });
    return hit ? { lane: hit.lane, idx: hit.idx } : null;
  }

  /* ================= 描画（出しっぱなし） ================= */

  function paint() {
    var host = screenEl();
    if (!host || !RUN) return;
    var step = RUN.steps[RUN.i], r = rule();
    var el = host.querySelector('.tut-strip');
    if (!el) {
      el = document.createElement('div');
      el.className = 'tut-strip';
      el.addEventListener('click', function (ev) {
        if (ev.target.closest('[data-tut-next]')) next();
      });
      host.appendChild(el);
    }
    var sig = RUN.stage + ':' + RUN.i;
    if (el.dataset.sig === sig) return;              /* 同じステップなら描き直さない（ちらつき防止） */
    el.dataset.sig = sig;
    var face = (step.face === 'down') ? 'amber_down' : 'amber_calm';
    var lines = (step.lines || []).map(esc).join('<br>');
    var n = RUN.steps.length;
    el.innerHTML =
      '<img class="tut-face" src="assets/chars/' + face + '.png" alt="" draggable="false"'
      + ' onerror="this.remove()">'
      + '<div class="tut-body">'
      + (lines ? '<div class="tut-lines">' + lines + '</div>' : '')
      + (step.ui ? '<div class="tut-ui">' + esc(step.ui) + '</div>' : '')
      + '</div>'
      + '<div class="tut-side">'
      + '<div class="tut-count">' + (RUN.i + 1) + ' / ' + n + '</div>'
      + (r.info && !r.last ? '<button class="tut-next" data-tut-next="1">次へ</button>' : '')
      + '</div>';
  }

  function applyGlow(M) {
    clearGlow();
    if (!RUN) return;
    var g = rule().glow;
    if (typeof g === 'function') { try { g = g(M); } catch (e) { g = null; } }
    if (!g || !g.length) return;
    g.forEach(function (sel) {
      var list;
      try { list = document.querySelectorAll(sel); } catch (e) { return; }
      Array.prototype.forEach.call(list, function (node) { node.classList.add('tut-glow'); });
    });
  }
  function clearGlow() {
    if (typeof document === 'undefined') return;
    var list = document.querySelectorAll('.tut-glow');
    Array.prototype.forEach.call(list, function (n) { n.classList.remove('tut-glow'); });
  }

  return { begin: begin, end: end, active: active, stage: stage, stepKey: stepKey,
           tick: tick, next: next, checkDrop: checkDrop, allowFlip: allowFlip,
           allowAttack: allowAttack, forcedPick: forcedPick, RULES: RULES };
})();

/* Node（tests/）からも完了条件を確かめられるようにしておく。ＤＯＭには触らない部分だけを使う。 */
if (typeof module !== 'undefined' && module.exports) module.exports = CQTutorial;

