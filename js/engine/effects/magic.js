/* CardQuest エンジン — 魔法カード48種ディスパッチャ（実装計画 M4 v0.13）
 *
 * 『SOULGATE カードバトル仕様書』§8・カード一覧の魔法テーブルを移植する。
 * 詳細仕様書（05_magic.md、1650行）はプロジェクトに存在しないため、以下の資料から
 * 各カードの効果を再構成した：
 *   ・カード一覧.md の一行効果テキスト（正）
 *   ・カードバトル仕様書§8（発動レベル・魔道書・無効/抑制・連唱・戦闘中無効の共通機構）
 *   ・戦闘処理.md §5, §7.1（オープン処理・戦闘中無効リスト・SW550の分岐）
 *
 * 起動経路：js/engine/combat.js の onOpen() が魔法(101〜150)を開いたときに
 * m.hooks.onMagicOpen(m, laneIndex, layer, cardId, {nullified}) を呼ぶ。
 * この呼び出しは combat.js の攻撃側/防御側オープンフェイズからだけでなく、
 * js/engine/turn.js の reverseAction()（メインステップの手動リバース）からも行われる
 * ＝『オープンが唯一の起動トリガー』（仕様書§1.1）を両方の経路で守る（M4で修正した箇所）。
 *
 * 対象選択（どのＣＨ／どのユニットを対象にするか）は、原作ではカーソル操作で
 * プレイヤーが選ぶが、本実装ではまず「合法な対象からエンジンが選ぶ」（m.rng 経由）
 * 形で全カードを機能させることを優先した。対話的な対象選択ＵＩは今後の課題として
 * CardQuest_開発メモ.md に記載する。
 * （2026-08-24 追記）101憑依解除だけは本人の指定で対話的な対象選択に対応した。
 * 呼び出し元が opts.choice = {lane, idx} を渡すと、その対象が合法なら優先して使う
 * （不正・未指定・連唱2回目で対象が既に無い場合は従来どおり m.rng で自動選択）。
 * 他のカードも同じ仕組み（ctx.choice）で今後拡張できる。
 *
 * 明確にバグと分析されているカード（105歪曲・132殲滅・141思念波・148妄執）は、
 * 実装計画の既定方針（『明確なバグは直すが、個々のカードの原作特有の食い違いは
 * 原作実装に忠実に再現する』＝ stats.js の方針を踏襲）に従い、原作の挙動を
 * そのまま再現する。137潜行爆弾・121招来・138潜入・122予見・146口寄せなど、
 * 詳細仕様が不明で本エンジンのデータ構造（山札＝無順序の残枚数テーブル）とも
 * 相性が悪いカードは、簡略化した推測実装であることをコメントで明記する。
 */
'use strict';
(function (global) {

  const isNode = (typeof require === 'function' && typeof window === 'undefined');
  const S = isNode ? require('../state.js') : global.CQState;
  const Stats = isNode ? require('../stats.js') : global.CQStats;
  const Field = isNode ? require('../fieldrules.js') : global.CQField;

  function other(side) { return side === 'self' ? 'enemy' : 'self'; }
  function jp(side) { return side === 'self' ? '自分' : '相手'; }
  function note(m, msg) { m.log.push(msg); }
  function nameOf(m, id) { const c = m.cards[id]; return c ? c.n : ('#' + id); }
  /** 循環参照を避けるため呼ぶ瞬間に解決する（turn.js の combatApi() と同じ方針） */
  function combatApi() { return isNode ? require('../combat.js') : global.CQCombat; }
  function turnApi() { return isNode ? require('../turn.js') : global.CQTurn; }
  function recalc(m) {
    const combat = m.combat ? { attacker: m.combat.attacker, defender: m.combat.defender } : null;
    Stats.recalc(m.board, { cards: m.cards, combat: combat });
  }
  function damage(m, side, n) { if (!n) return; m.players[side].lp -= n; }
  function heal(m, side, n) {
    const p = m.players[side]; p.lp += n; if (p.lp > p.maxLp) p.lp = p.maxLp;
  }

  /* 戦闘中は発動しない（原作 CE0354 戦闘時無効）。
   * ★M6.7：原作解析 `05_magic.md` §2 の一覧表と突き合わせ、**144還元・147治癒を外した**
   * （資料では両方とも「戦闘中○」。誤って塞いでいた）。 */
  const NO_COMBAT = { 107: 1, 108: 1, 109: 1, 119: 1, 124: 1, 131: 1, 132: 1, 139: 1, 140: 1, 141: 1 };
  /* 強制開放(108)・強制転回(109)の連鎖中は発動しない（原作 CE0355 強制発動時無効）。
   * 108/109 が入っているのは連鎖の多重起動を防ぐため。資料§2の「強」列と一致。 */
  /* ★M6.7 WP3：140時の渦をここから外した（2026-08-30 本人確定）。
   * 連鎖中に開かれたら**連鎖を止める**役目を持たせるため（h140 を参照）。
   * ターンのやり直しは連鎖中には起こさないので、「誰のターンか」の曖昧さは生じない。 */
  const NO_FORCED = { 108: 1, 109: 1, 144: 1 };
  /* 詠唱レベル（配置階層 ≧ 記載レベル。魔道書(186)が1枚につき-2＝ln.acc.tomeをそのまま引く）。
   * ★M6.7：141思念波を追加した（判断12・2026-08-29 本人確定）。
   * 原作は `V397==6` の分岐が存在せずレベル判定が働かないバグだったが、
   * 「防御力1000以下を無条件破壊」という強さに見合う制約として**本物にする**。
   * ここに載らないカードは詠唱Ｌｖ1＝どの階層でも使える（js/data.js 側には全48種に明記した）。 */
  const LEVEL_REQ = { 116: 4, 132: 5, 134: 3, 138: 3, 140: 4, 141: 6, 142: 3, 146: 3 };

  function levelOk(m, laneIndex, layer, cardId) {
    const req = LEVEL_REQ[cardId];
    if (req == null) return true;
    const ln = m.board.lanes[laneIndex];
    return layer >= req - (ln.acc ? ln.acc.tome : 0);
  }

  /* ---- 汎用ヘルパー ------------------------------------------------------- */
  function allUnitLanes(m) {
    const res = []; for (let i = 0; i < 6; i++) if (m.board.lanes[i].unit != null) res.push(i);
    return res;
  }
  function sideLanes(m, side) { return allUnitLanes(m).filter(function (i) { return S.sideOf(i) === side; }); }
  function pick(m, arr) { return arr.length ? arr[m.rng.int(0, arr.length - 1)] : null; }
  function allChannels(m, filter) {
    const res = [];
    m.board.lanes.forEach(function (ln, i) {
      if (ln.unit == null) return;
      ln.channels.forEach(function (ch, j) { if (!filter || filter(ch, i, j)) res.push({ lane: i, idx: j }); });
    });
    return res;
  }
  function dropChannelAt(m, laneIndex, idx) {
    const ln = m.board.lanes[laneIndex];
    const removed = ln.channels[idx];
    ln.channels.splice(idx, 1);
    ln.count = ln.channels.length;
    return removed;
  }
  function pushChannel(m, laneIndex, entry) {
    const ln = m.board.lanes[laneIndex];
    ln.channels.push(entry);
    ln.count = ln.channels.length;
  }
  /** 山札から1枚引いて手札を経由せず呼び出し元に返す（魂の門(181)と同じやり方）。
   * 山札が尽きていれば自動で再装填される（M5.5：draw の第3引数 m） */
  function drawDirect(m, side) {
    const Turn = turnApi(), p = m.players[side];
    const id = Turn.draw(m.rng, p, m);
    if (id == null) return null;
    p.hand.pop();
    return id;
  }
  /* ==== 効果の途中でプレイヤーの入力が要るカード（M6.7 WP3） =================
   *
   * 122予見（5枚引いて1枚もらう）と146口寄せ（1枚ずつ引いて採用するまで繰り返す）は、
   * **引いた結果を見てから決める**カード。引く前に選択肢が確定しないので、
   * WP1の `ctx.choice`（開く前に対象を選ぶ）方式では扱えない。
   *
   * そこで `m.pendingChoice` を置いて、いったんエンジンを抜ける：
   *   ＵＩ  … `opts.interactive` を渡す。pendingChoice が残るので、画面で選ばせて
   *            `CQMagic.resolvePending(m, action)` を呼ぶ。
   *   ＡＩ・シミュレータ … `interactive` を渡さない。**その場で自動解決**して
   *            pendingChoice を残さない＝**呼び出し側は無改修**でよい。
   *
   * この「interactive を渡した側だけが保留を受け取る」形は、
   * ＡＩ・`tools/simulate.js` を一切変えずに対話カードを足せるので、以後も踏襲すること。 */

  /** 自動解決の方針（ＡＩ・シミュレータ用）。乱数を使わず決定的にする。 */
  function autoResolve(m) {
    const pc = m.pendingChoice;
    if (!pc) return;
    if (pc.kind === 'foresee') {
      /* 5枚のうち「定価がいちばん高いもの」を採る。同値ならＩＤの小さいほう。 */
      let best = 0;
      pc.options.forEach(function (id, i) {
        const a = m.cards[id], b = m.cards[pc.options[best]];
        if (a && b && (a.p || 0) > (b.p || 0)) best = i;
      });
      resolvePending(m, { pick: best });
      return;
    }
    if (pc.kind === 'summon') {
      /* 空白(180)なら引き直し、それ以外は採用。山札を掘り尽くさないよう回数を制限する
       * （原作は山札が尽きると即敗北。ＡＩにそれをさせない）。 */
      const p = m.players[pc.caster];
      const keep = pc.options[0] !== 180 || pc.tries >= 4 || p.deckCount <= 5;   /* 180＝空白 */
      resolvePending(m, { keep: keep });
      return;
    }
    m.pendingChoice = null;
  }

  /** 保留中の選択を確定する。ＵＩは選ばせた結果をここへ渡す。
   *   予見 … { pick: 0..4 }（5枚のうち何番目をもらうか）
   *   口寄せ … { keep: true }（採用して終了）／{ keep: false }（捨ててもう1枚引く） */
  function resolvePending(m, action) {
    const pc = m.pendingChoice;
    if (!pc) return { ok: false, reason: '選択待ちではありません' };
    const a = action || {};
    if (pc.kind === 'foresee') {
      const i = Math.max(0, Math.min(pc.options.length - 1, a.pick | 0));
      const got = pc.options[i];
      const p = m.players[pc.caster];
      p.hand.push(got);
      capHand(m, pc.caster);
      /* もらわなかった4枚は山札へ戻す（＝山札の枚数は差し引き−1）。 */
      pc.options.forEach(function (id, k) {
        if (k === i) return;
        p.deck[id] = (p.deck[id] || 0) + 1; p.deckCount += 1;
      });
      note(m, '予見：' + nameOf(m, got) + ' を手に入れた（残りは山札へ戻した）');
      m.pendingChoice = null;
      return { ok: true, got: got };
    }
    if (pc.kind === 'summon') {
      const p = m.players[pc.caster];
      if (a.keep) {
        p.hand.push(pc.options[0]);
        capHand(m, pc.caster);
        note(m, '口寄せ：' + nameOf(m, pc.options[0]) + ' を手に入れた');
        m.pendingChoice = null;
        return { ok: true, got: pc.options[0] };
      }
      /* 捨てた札は山札に戻さない（原作どおり＝掘るコストが重い）。もう1枚引く。 */
      note(m, '口寄せ：' + nameOf(m, pc.options[0]) + ' を捨ててもう1枚引く');
      const id = drawDirect(m, pc.caster);
      if (id == null) {
        note(m, '口寄せ：山札が尽きた');
        m.pendingChoice = null;
        return { ok: true, got: null };
      }
      pc.options = [id]; pc.tries = (pc.tries || 1) + 1;
      return { ok: true, pending: true };
    }
    m.pendingChoice = null;
    return { ok: true };
  }

  /** 手札上限7枚を超えたら超過分を捨てる（原作§4.2：手札が7枚を超えた瞬間、強制的に1枚捨てる）。
   * ドローステップ以外（魔法カードによる手札増加）でも成り立たせるためのガード */
  function capHand(m, side) {
    const p = m.players[side];
    while (p.hand.length > 7) {
      const id = p.hand.pop();
      note(m, jp(side) + 'は手札上限を超え ' + nameOf(m, id) + ' を捨てた');
    }
  }

  /* ---- 実装済みの「フラグ型」魔法（爆殺・増幅・障壁・抑制・遮蔽・偽装・鏡身）は
   * stats.js の accMagicFlag が毎回の recalc() で処理する継続効果なので、
   * オープン時点でここでは何もしない */
  function noopFlag() { /* 継続効果。stats.js 側で処理済み */ }

  /* ================= 101〜110 ================= */

  function h101(m, ctx) {                                     // 憑依解除：ＣＨ１つを破壊
    // 発動中の自分自身は対象から除く（連唱で2回発動したときに自壊して不整合になるのを避ける）
    const pool = allChannels(m, function (ch, lane, idx) {
      return !(lane === ctx.laneIndex && idx === ctx.layer - 1);
    });
    // 本人操作時は破壊対象を選べる（2026-08-24 本人の指定）。ctx.choice はレイアウト側が
    // 発動前に選んでおいた {lane, idx}。連唱で2回目が発動するときは1回目の対象が既に
    // 破壊済みで pool に無いので、自動的に pick() へフォールバックする
    let t = null;
    if (ctx.choice) {
      t = pool.find(function (c) { return c.lane === ctx.choice.lane && c.idx === ctx.choice.idx; }) || null;
    }
    if (!t) t = pick(m, pool);
    if (!t) { note(m, '憑依解除：対象が無い'); return; }
    const removed = dropChannelAt(m, t.lane, t.idx);
    recalc(m);
    note(m, '憑依解除：' + nameOf(m, removed.card) + ' を破壊');
  }

  function h102(m, ctx) {                                     // 侵食：自デッキから他ユニットのＣＨを埋める
    const targets = allUnitLanes(m).filter(function (i) { return i !== ctx.laneIndex; });
    const t = pick(m, targets);
    if (t == null) { note(m, '侵食：対象が無い'); return; }
    let filled = 0;
    for (;;) {
      recalc(m);
      const ln = m.board.lanes[t];
      if (!ln || ln.unit == null || ln.count >= ln.cap) break;
      const id = drawDirect(m, ctx.caster);
      if (id == null) break;
      pushChannel(m, t, { card: id, up: false, mine: ctx.caster === 'self', revealed: false });
      filled += 1;
    }
    recalc(m);
    note(m, '侵食：自分の山札から' + filled + '枚のＣＨを埋め込んだ');
  }

  function h103(m, ctx) {                                     // 渇望：敵デッキから自分（このレーン）のＣＨを埋める
    const enemy = other(ctx.caster);
    let filled = 0;
    for (;;) {
      recalc(m);
      const ln = m.board.lanes[ctx.laneIndex];
      if (!ln || ln.unit == null || ln.count >= ln.cap) break;
      const id = drawDirect(m, enemy);
      if (id == null) break;
      pushChannel(m, ctx.laneIndex, { card: id, up: false, mine: ctx.caster === 'self', revealed: false });
      filled += 1;
    }
    recalc(m);
    note(m, '渇望：相手の山札から' + filled + '枚のＣＨを得た');
  }

  function h105(m, ctx) {                                     // 歪曲：ＣＨ位置を上下反転
    const ln = m.board.lanes[ctx.laneIndex];
    if (!ln || !ln.channels.length) return;
    ln.channels.reverse();
    // 原作バグ（仕様書§14.1・§8.4「105歪曲」）：レーン1・ＣＨ6枚のとき最上段のカードが消滅する
    if (ctx.laneIndex === 0 && ln.channels.length === 6) {
      const gone = ln.channels.pop();
      note(m, '歪曲：（原作バグ再現）最上段の ' + nameOf(m, gone.card) + ' が消滅した');
    }
    ln.count = ln.channels.length;
    ln.reversePtr = 0;
    recalc(m);
    note(m, '歪曲：' + nameOf(m, ln.unit) + ' のＣＨ位置を反転');
  }

  function h107(m, ctx) {                                     // 逃走：ＣＨ数4以下ならユニットを手札に戻す（戦闘中×）
    const ln = m.board.lanes[ctx.laneIndex];
    if (!ln || ln.unit == null) return;
    if (ln.count > 4) { note(m, '逃走：ＣＨが5枚以上のため戻せない'); return; }
    const side = S.sideOf(ctx.laneIndex), unitId = ln.unit;
    m.players[side].hand.push(unitId);
    capHand(m, side);
    m.board.lanes[ctx.laneIndex] = S.emptyLane();
    recalc(m);
    note(m, '逃走：' + nameOf(m, unitId) + ' が手札に戻った');
    return { consumed: true };
  }

  /* ==== 強制開放(108)・強制転回(109)＝「強制リバース連鎖」（M6.7 WP1） ==================
   *
   * 原作解析 `05_magic.md` §1-8 の再実装。**対象は選んだ他ユニット1体だけ**
   * （v0.16.21までは盤面の全レーンを一括で処理していた。これは実装の誤り）。
   *
   * 連鎖の骨格：
   *   ① 発動した 108/109 のカード自身が「連鎖マーカー」になる（原作の ID 149/150 に相当）。
   *      **このマーカーが連鎖の生命線**で、破壊されるか裏に戻されると連鎖はそこで止まる。
   *   ② 対象レーンのＣＨを**下から上へ1枚ずつ**処理する。
   *   ③ **1枚処理するたびにマーカーの生存を確認する。** 開いたカードの効果で
   *      マーカーのユニットが死ぬ（133呪爆）・マーカー自体が壊れる（101憑依解除）・
   *      閉じられる（110閉門）と、**そこで打ち切る**。
   *   ④ 開いたカードの効果は**その場・その順で**発動する。まとめて後から発動させないこと
   *      ——複数の効果が一度に起きると何が起きたのか読み取れない、というのが本人の指摘の趣旨。
   *
   * **なぜエンジンの中でループしてよいか**：連鎖を中断させるのは「連鎖中に開いた別のカードの
   * 効果」だけで、**プレイヤーの入力は割り込まない**（対象レーンは開始時に1回選ぶだけ）。
   * だからエンジンが最後まで解決してよく、ＵＩは戻り値の `steps` を順に再生すれば演出になる。
   * ＡＩ・`tools/simulate.js` は戻り値を無視するだけでよく、**無改修で動く**。
   * ——「一度に全部めくってから演出する」のは誤り。**1枚ごとに中断判定を挟む**のが要点。 */

  /** 108/109/110 の対象になれるレーン（原作§2「他ユニット1体」）。自分の居るレーンは除く。
   * 敵陣・自陣は問わない。needFaceUp は110用（表向きのＣＨが1枚以上あること）。 */
  function forcedTargets(m, ctx, needFaceUp) {
    return allUnitLanes(m).filter(function (i) {
      if (i === ctx.laneIndex) return false;
      const ln = m.board.lanes[i];
      if (!ln.channels.length) return false;
      return needFaceUp ? ln.channels.some(function (ch) { return ch.up; }) : true;
    });
  }

  /** ctx.choice で指定されたレーンが合法ならそれを、無ければ乱数で1つ選ぶ
   * （ＡＩ・シミュレータは choice を渡さないので従来どおり乱数になる）。 */
  function chooseTarget(m, ctx, pool) {
    if (ctx.choice && pool.indexOf(ctx.choice.lane) >= 0) return ctx.choice.lane;
    return pick(m, pool);
  }

  /** 連鎖マーカー（＝発動した108/109のカード自身）がまだ生きているか。
   * ユニットが居て、その階層に同じカードがあって、**表向きのまま**であること。 */
  function markerAlive(m, marker) {
    const ln = m.board.lanes[marker.lane];
    if (!ln || ln.unit == null) return false;
    const ch = ln.channels[marker.idx];
    return !!(ch && ch.card === marker.card && ch.up);
  }

  function forcedChain(m, ctx, kind) {
    const pool = forcedTargets(m, ctx, false);
    if (!pool.length) { note(m, nameOf(m, kind) + '：対象がいない'); return; }
    const target = chooseTarget(m, ctx, pool);
    const marker = { lane: ctx.laneIndex, idx: ctx.layer - 1, card: kind };
    const steps = [];
    /* 連鎖中に開いた 133呪爆・134呪念 は「仕掛けた側」を狙う（原作§1-8 の V970 分岐）
     * ＝**強制開放は撃った本人に跳ね返る**。h133/h134 がこれを見る。 */
    m.forcedCtx = { lane: marker.lane, side: ctx.caster };
    note(m, nameOf(m, kind) + '：' + nameOf(m, m.board.lanes[target].unit) + ' のＣＨを下から順に処理する');

    let aborted = null;
    for (let i = 0; ; i++) {
      if (!markerAlive(m, marker)) { aborted = 'マーカーが失われた'; break; }
      const ln = m.board.lanes[target];
      if (!ln || ln.unit == null) { aborted = '対象ユニットが場から消えた'; break; }
      if (i >= ln.channels.length) break;                  // 最上段まで到達＝正常終了
      const ch = ln.channels[i];
      if (kind === 108 && ch.up) { continue; }             // 強制開放は裏のものだけを開く
      const wasUp = ch.up;
      ch.up = !ch.up;
      if (ch.up) ch.revealed = true;
      recalc(m);
      steps.push({ lane: target, idx: i, card: ch.card, up: ch.up });
      if (ch.up) {
        /* 開いた瞬間に効果が発動する（forced: true ＝ NO_FORCED のカードはここで不発になる）。
         * ここで133呪爆が開けば、上の m.forcedCtx により**仕掛けた側**のユニットが死に、
         * 次のループ先頭の markerAlive() が false になって連鎖が止まる。 */
        onMagicOpen(m, target, i + 1, ch.card, { forced: true });
      }
      if (turnApi().checkResult(m)) { aborted = '決着した'; break; }
      /* 時の渦(140)のように「連鎖そのものを止める」カードが開いた場合の明示的な中断印。 */
      if (m.forcedAbort) { aborted = m.forcedAbort + 'で止められた'; break; }
      /* 効果で対象のＣＨが減った（押収・潜入など）場合、いま処理した階層がずれることがある。
       * 消えていたら次の周回でインデックスが自然に繰り上がるので、ここでは何もしない。 */
      void wasUp;
    }

    m.forcedCtx = null;
    m.forcedAbort = null;
    recalc(m);
    if (aborted) note(m, nameOf(m, kind) + '：' + aborted + 'ため連鎖が止まった（' + steps.length + '枚で中断）');
    else note(m, nameOf(m, kind) + '：' + steps.length + '枚を処理した');
    /* ＵＩが1枚ずつの演出に使う。エンジン・ＡＩ・シミュレータは見なくてよい。 */
    m.lastForcedChain = { kind: kind, target: target, steps: steps, aborted: aborted };
  }

  function h108(m, ctx) { forcedChain(m, ctx, 108); }         // 強制開放（戦闘中×強制中×）
  function h109(m, ctx) { forcedChain(m, ctx, 109); }         // 強制転回（戦闘中×強制中×）

  /* 閉門：**選んだ他ユニット1体**のＣＨを全部クローズする（原作§2「他ユニット1体（表ＣＨ1枚以上）」）。
   * 対象は自陣・敵陣を問わない——だから 119鎮静（700Ｇ・盤面全部）より高い800Ｇで、
   * 「狙って閉じられる」ぶん使い勝手がよい、という価格差の説明が付く（2026-08-29 本人の解釈）。
   * 強制開放(108)で開かれてしまったＣＨを閉じ直す対抗札としても機能する。
   * ——v0.16.21までは「自陣3レーン全部」を閉じていた。これは実装の誤り。
   * なお表向き技能の効果は recalc() が表向きのＣＨだけを集計するので、閉じれば自動的に消える
   * （原作の「魔力全消去」に相当する処理を別に書く必要はない）。 */
  function h110(m, ctx) {
    const pool = forcedTargets(m, ctx, true);
    if (!pool.length) { note(m, '閉門：閉じられるＣＨを持つユニットがいない'); return; }
    const target = chooseTarget(m, ctx, pool);
    let n = 0;
    m.board.lanes[target].channels.forEach(function (ch) { if (ch.up) { ch.up = false; n += 1; } });
    recalc(m);
    note(m, '閉門：' + nameOf(m, m.board.lanes[target].unit) + ' の' + n + '枚をクローズ');
  }

  /* ================= 111〜120 ================= */

  function h111(m, ctx) {                                     // 変換：手札を全て捨て新たに3枚引く
    const p = m.players[ctx.caster], Turn = turnApi();
    p.hand = [];
    for (let i = 0; i < 3; i++) { if (Turn.draw(m.rng, p, m) == null) break; }
    note(m, '変換：手札を入れ替えた');
  }

  function h112(m, ctx) {                                     // 抽出：手札を3枚得るがドロー毎にＬＰ1点を失う
    const p = m.players[ctx.caster], Turn = turnApi();
    for (let i = 0; i < 3; i++) {
      if (Turn.draw(m.rng, p, m) == null) break;
      damage(m, ctx.caster, 1);
    }
    capHand(m, ctx.caster);
    note(m, '抽出：手札を得てＬＰを消費した');
  }

  /** 透視：**相手が置いた**裏向きＣＨを2枚まで選んで中身を知る（原作§2「敵が置いた裏ＣＨ×2」）。
   * ——v0.16.21までは裏向きのＣＨ全部（自分が置いたものも含む）から乱数で2枚選んでいた。
   * 自分が置いたカードは元から中身が分かっているので、透視の対象にする意味がない。
   * ctx.choice.picks に [{lane,idx},…] を渡すと、そのうち合法なものを優先して見る
   * （**複数個の対象を選ぶ最初のカード**。118押収・125移送も同じ形を使う）。 */
  function h113(m, ctx) {
    const mine = ctx.caster === 'self';
    const pool = allChannels(m, function (ch) { return !ch.up && ch.mine !== mine && !ch.revealed; });
    const key = function (t) { return t.lane + ':' + t.idx; };
    const chosen = [];
    const picks = (ctx.choice && ctx.choice.picks) || [];
    picks.forEach(function (p) {
      if (chosen.length >= 2) return;
      const hit = pool.find(function (t) { return t.lane === p.lane && t.idx === p.idx; });
      if (hit && !chosen.some(function (c) { return key(c) === key(hit); })) chosen.push(hit);
    });
    while (chosen.length < 2 && pool.length) {                 // 足りない分は乱数（ＡＩ・シミュレータ経路）
      const t = pool.splice(m.rng.int(0, pool.length - 1), 1)[0];
      if (!chosen.some(function (c) { return key(c) === key(t); })) chosen.push(t);
    }
    if (!chosen.length) { note(m, '透視：相手が伏せているＣＨが無い'); return; }
    chosen.forEach(function (t) { m.board.lanes[t.lane].channels[t.idx].revealed = true; });
    note(m, '透視：相手が伏せた' + chosen.length + '枚の中身を確認した');
  }

  function h114(m, ctx) {                                     // 暗殺：敵マスター手札内のユニットを破壊＋ＬＰ1点
    const enemy = other(ctx.caster), p = m.players[enemy];
    const idxs = [];
    p.hand.forEach(function (id, i) { const c = m.cards[id]; if (c && c.t === 'U') idxs.push(i); });
    if (idxs.length) {
      const removed = p.hand.splice(pick(m, idxs), 1)[0];
      note(m, '暗殺：' + jp(enemy) + 'の手札の ' + nameOf(m, removed) + ' を破壊');
    }
    damage(m, enemy, 1);
    note(m, '暗殺：' + jp(enemy) + ' のＬＰ -1');
  }

  function attachFromHand(m, ctx, skillId, label) {
    const p = m.players[ctx.caster];
    const i = p.hand.indexOf(skillId);
    if (i < 0) { note(m, label + '：手札に無いため不発'); return; }
    p.hand.splice(i, 1);
    pushChannel(m, ctx.laneIndex, { card: skillId, up: true, mine: ctx.caster === 'self', revealed: true });
    recalc(m);
    note(m, label + '：' + nameOf(m, skillId) + ' を表状態で付加');
  }
  function h115(m, ctx) { attachFromHand(m, ctx, 155, '流行り病'); }   // 疫障(155)
  function h127(m, ctx) { attachFromHand(m, ctx, 167, '死の棘'); }     // 腐食(167)

  function h116(m, ctx) {                                     // 解析：ユニット1体のＣＨ内容を全て確認（レベル4）
    const t = pick(m, allUnitLanes(m));
    if (t == null) return;
    m.board.lanes[t].channels.forEach(function (ch) { ch.revealed = true; });
    note(m, '解析：' + nameOf(m, m.board.lanes[t].unit) + ' のＣＨを全て確認');
  }

  function h118(m, ctx) {                                     // 押収：裏状態のＣＨ１つをこのレーンへ奪う
    const pool = allChannels(m, function (ch, lane) { return !ch.up && lane !== ctx.laneIndex; });
    const t = pick(m, pool);
    if (!t) { note(m, '押収：対象が無い'); return; }
    const stolen = dropChannelAt(m, t.lane, t.idx);
    pushChannel(m, ctx.laneIndex, { card: stolen.card, up: false, mine: ctx.caster === 'self', revealed: false });
    recalc(m);
    note(m, '押収：裏向きのＣＨを1枚奪った');
  }

  function h119(m, ctx) {                                     // 鎮静：場にある全てのＣＨをクローズ（戦闘中×）
    let n = 0;
    m.board.lanes.forEach(function (ln) {
      ln.channels.forEach(function (ch) { if (ch.up) { ch.up = false; n += 1; } });
    });
    recalc(m);
    note(m, '鎮静：場の' + n + '枚をクローズ');
  }

  /* ================= 121〜130 ================= */

  function h121(m, ctx) {                                     // 招来：潜行しているユニット1つを自分の場に召還
    const pool = allChannels(m, function (ch) { const c = m.cards[ch.card]; return !ch.up && c && c.t === 'U'; });
    const t = pick(m, pool);
    if (!t) { note(m, '招来：潜行しているユニットが無い'); return; }
    // M6 戦場ルール：ふさがれたレーン（laneLock）は召還先にできず、
    // 素のＣＨ数が上限を超えるユニット（noHighCH）はそもそも出せない
    const dest = pick(m, Field.freeLanesOf(m, ctx.caster));
    if (dest == null) { note(m, '招来：召還先が無い'); return; }
    const hidden = m.board.lanes[t.lane].channels[t.idx];
    if (!Field.summonAllowed(m, hidden.card).ok) { note(m, '招来：戦場ルールで召還できない'); return; }
    const taken = dropChannelAt(m, t.lane, t.idx);
    m.board.lanes[dest] = S.makeLane(taken.card, [], m.cards);   // 召還されたユニットは硬直しない
    recalc(m);
    note(m, '招来：' + nameOf(m, taken.card) + ' を召還');
  }

  /** 予見：山札から5枚引き、その中の1枚をもらう（もらわなかった4枚は山札へ戻す）。
   *
   * ★M6.7 WP3（判断4）で効果を変更した。原作は「5枚引いて**任意の順番で山札の先頭に戻す**」
   * ＝次の5回のドローを完全に決められる、というカードだったが、**このエンジンの山札は
   * 「カードＩＤごとの残枚数」の無順序テーブル**（カードバトル仕様書§2.3・原作も同じ）で、
   * 「並べ替えて戻す」は表現できる状態が存在しない。
   * v0.16.22までは no-op（何も起きない）だったが、カードの説明文には「並べ替えられる」と
   * 書いてあったため、**プレイヤーからは不具合に見える**状態だった。
   * 「引きを選べる」という手触りは残しつつ実装できる形に置き換えてある。 */
  function h122(m, ctx) {
    const p = m.players[ctx.caster];
    const drawn = [];
    for (let k = 0; k < 5; k++) {
      const id = drawDirect(m, ctx.caster);
      if (id == null) break;
      drawn.push(id);
    }
    if (!drawn.length) { note(m, '予見：山札が空だった'); return; }
    note(m, '予見：山札から' + drawn.length + '枚を見た');
    m.pendingChoice = { kind: 'foresee', caster: ctx.caster, options: drawn };
    if (!ctx.interactive) autoResolve(m);
    void p;
  }

  function h123(m, ctx) {                                     // 発症：配置レベルと同数のＬＰを失う
    const side = S.sideOf(ctx.laneIndex);
    damage(m, side, ctx.layer);
    note(m, '発症：' + jp(side) + ' のＬＰ -' + ctx.layer);
  }

  function h124(m, ctx) {                                     // 凍結：場にあるユニット1体を硬直させる（戦闘中×）
    const pool = allUnitLanes(m).filter(function (i) { return !m.board.lanes[i].stiff; });
    const t = pick(m, pool);
    if (t == null) { note(m, '凍結：対象が無い'); return; }
    m.board.lanes[t].stiff = true;
    note(m, '凍結：' + nameOf(m, m.board.lanes[t].unit) + ' を硬直させた');
  }

  function h125(m, ctx) {                                     // 移送：最も高いレベルにあるＣＨを他ユニットへ移動
    const ln = m.board.lanes[ctx.laneIndex];
    if (!ln || ln.channels.length < 2) { note(m, '移送：移動できるＣＨが無い'); return; }
    let srcIdx = -1;
    for (let i = ln.channels.length - 1; i >= 0; i--) { if (i !== ctx.layer - 1) { srcIdx = i; break; } }
    if (srcIdx < 0) { note(m, '移送：移動できるＣＨが無い'); return; }
    const targets = allUnitLanes(m).filter(function (i) { return i !== ctx.laneIndex; });
    const t = pick(m, targets);
    if (t == null) { note(m, '移送：移動先が無い'); return; }
    const moved = dropChannelAt(m, ctx.laneIndex, srcIdx);
    pushChannel(m, t, moved);
    recalc(m);
    note(m, '移送：' + nameOf(m, moved.card) + ' を ' + nameOf(m, m.board.lanes[t].unit) + ' へ移動');
  }

  function h126(m, ctx) {                                     // 統合：ＣＨ付加の無いユニット1体をＣＨとして吸収
    const targets = allUnitLanes(m).filter(function (i) {
      return i !== ctx.laneIndex && m.board.lanes[i].channels.length === 0;
    });
    const t = pick(m, targets);
    if (t == null) { note(m, '統合：吸収できるユニットが無い'); return; }
    const absorbed = m.board.lanes[t].unit;
    m.board.lanes[t] = S.emptyLane();
    pushChannel(m, ctx.laneIndex, { card: absorbed, up: false, mine: ctx.caster === 'self', revealed: false });
    recalc(m);
    note(m, '統合：' + nameOf(m, absorbed) + ' をＣＨとして吸収した');
  }

  function h128(m, ctx) {                                     // 転写：手札の技能カードをこのカードの位置へ転送
    const p = m.players[ctx.caster];
    const i = p.hand.findIndex(function (id) { return id >= 151 && id <= 199; });
    if (i < 0) { note(m, '転写：手札に技能カードが無い'); return; }
    const id = p.hand.splice(i, 1)[0];
    pushChannel(m, ctx.laneIndex, { card: id, up: false, mine: ctx.caster === 'self', revealed: false });
    recalc(m);
    note(m, '転写：' + nameOf(m, id) + ' を付加した');
  }

  function h129(m, ctx) {                                     // 窃盗：敵マスターの手札1枚を奪う
    const enemy = other(ctx.caster), p = m.players[enemy];
    if (!p.hand.length) { note(m, '窃盗：相手の手札が無い'); return; }
    const id = p.hand.splice(m.rng.int(0, p.hand.length - 1), 1)[0];
    m.players[ctx.caster].hand.push(id);
    capHand(m, ctx.caster);
    note(m, '窃盗：' + jp(enemy) + 'の手札から1枚奪った');
  }

  function h130(m, ctx) {                                     // 漂着：山札から1枚を直に表状態で付加
    const id = drawDirect(m, ctx.caster);
    if (id == null) { note(m, '漂着：山札が無い'); return; }
    pushChannel(m, ctx.laneIndex, { card: id, up: true, mine: ctx.caster === 'self', revealed: true });
    recalc(m);
    note(m, '漂着：' + nameOf(m, id) + ' を表状態で付加した');
  }

  /* ================= 131〜140 ================= */

  function h131(m, ctx) {                                     // 菊一文字：全ユニットの同レベルのＣＨを全て破壊（戦闘中×）
    const n = ctx.layer;
    let cnt = 0;
    for (let i = 0; i < 6; i++) {
      const ln = m.board.lanes[i];
      if (!ln || ln.unit == null || !ln.channels[n - 1]) continue;
      ln.channels.splice(n - 1, 1); ln.count = ln.channels.length; cnt += 1;
    }
    recalc(m);
    note(m, '菊一文字：全ユニットの' + n + '階層目、計' + cnt + '枚を破壊');
    return { consumed: cnt > 0 };
  }

  function h132(m, ctx) {                                     // 殲滅：全てのユニットを場から取り除く（レベル5／戦闘中×）
    // 原作バグ（仕様書§8.4・§14.1）：destroy()相当の処理を通らないため、
    // ＬＰダメージ・憑依・不死・救済・戦利品が一切発生しない。そのまま再現する
    let cnt = 0;
    for (let i = 0; i < 6; i++) {
      if (m.board.lanes[i].unit != null) { m.board.lanes[i] = S.emptyLane(); cnt += 1; }
    }
    recalc(m);
    note(m, '殲滅：場の全ユニット(' + cnt + '体)を除去（原作バグ再現：ＬＰダメージ・憑依・戦利品は発生しない）');
    return { consumed: true };
  }

  /** 呪爆：このカードをオープンさせたユニットを破壊。
   * **強制リバース連鎖の最中に開いた場合は「連鎖を仕掛けた側」のユニットを狙う**
   * （原作§1-8 の V970 分岐）＝**強制開放は撃った本人に跳ね返る**。
   * これが連鎖の主な止め方になる——仕掛けたユニットが死ねばマーカーごと消えるので、
   * 次の1枚を処理する前の markerAlive() で連鎖が打ち切られる。 */
  function h133(m, ctx) {
    const at = m.forcedCtx ? m.forcedCtx.lane : ctx.laneIndex;
    const ln = m.board.lanes[at];
    const name = ln && ln.unit != null ? nameOf(m, ln.unit) : null;
    combatApi().destroy(m, at, { normalAttack: false });
    if (name) {
      note(m, '呪爆：' + name + ' が破壊された' + (m.forcedCtx ? '（強制開放を仕掛けた側に跳ね返った）' : ''));
    }
    /* 連鎖中は「このカードが乗っているレーン」と壊したレーンが別なので、
     * 自分自身が消えたわけではない＝consumed を立てない（階層のずれを起こさない）。 */
    return { consumed: !m.forcedCtx };
  }

  /** 呪念：オープンさせたマスターのＬＰ5点破壊（詠唱Ｌｖ3）。
   * 呪爆と同じく、**強制リバース連鎖中は「仕掛けた側」のマスターを狙う**（原作§1-8）。 */
  function h134(m, ctx) {
    const victim = m.forcedCtx ? m.forcedCtx.side : ctx.opener;
    damage(m, victim, 5);
    note(m, '呪念：' + jp(victim) + ' のＬＰ -5'
      + (m.forcedCtx ? '（強制開放を仕掛けた側に跳ね返った）' : ''));
  }

  function h135(m, ctx) {                                     // 雷撃：防御力550以下のユニット1つを無条件に破壊
    recalc(m);
    const pool = allUnitLanes(m).filter(function (i) { return m.board.lanes[i].def <= 550; });
    const t = pick(m, pool);
    if (t == null) { note(m, '雷撃：対象が無い'); return; }
    const name = nameOf(m, m.board.lanes[t].unit);
    combatApi().destroy(m, t, { normalAttack: false });
    note(m, '雷撃：' + name + ' を破壊');
  }

  /** 潜行爆弾：選んだ相手ユニットに、自分自身を裏向きの爆弾として仕掛け直す。
   * 仕掛けた爆弾が**表になった瞬間**、そのユニットに攻撃力600の一撃が入る
   * （防御力が600を超えるユニットなら、爆弾だけが壊れる）。
   *
   * ★M6.7 WP3（判断14）で本人案を採用した。原作は「自分を壊し、開かせた**相手の山札**へ
   * 潜り込んで約4枚後のドローで爆発する」時限爆弾だったが、ランの短い戦闘では遅すぎて
   * 何が起きたのか分かりにくい。**相手のユニットに仕掛ける**形にすると、
   * 強制開放(108)・強制転回(109)で「開かせて爆発させる」コンボが成立する。
   *
   * 実装：カードＩＤは137のまま、チャンネルに `armed` の印を付けて2つの状態を区別する。
   *   armed なし … 仕掛ける（このハンドラの前半）
   *   armed あり … 爆発する（後半）
   * 別のカードＩＤを増やさずに済むので、デッキ・図鑑・記憶データに影響しない。 */
  function h137(m, ctx) {
    const here = m.board.lanes[ctx.laneIndex];
    const self = here && here.channels[ctx.layer - 1];

    /* --- 後半：仕掛けられていた爆弾が開かれた --- */
    if (self && self.armed) {
      const def = here.def || 0;
      const name = here.unit != null ? nameOf(m, here.unit) : '？';
      dropChannelAt(m, ctx.laneIndex, ctx.layer - 1);          /* 爆弾は必ず壊れる */
      if (def <= 600) {
        combatApi().destroy(m, ctx.laneIndex, { normalAttack: false });
        note(m, '潜行爆弾：爆発して ' + name + '（防御力' + def + '）を破壊');
      } else {
        note(m, '潜行爆弾：爆発したが ' + name + '（防御力' + def + '）には効かず、爆弾だけが壊れた');
      }
      recalc(m);
      return { consumed: true };
    }

    /* --- 前半：相手のユニットへ仕掛ける --- */
    const enemy = other(ctx.caster);
    const pool = allUnitLanes(m).filter(function (i) {
      if (S.sideOf(i) !== enemy || i === ctx.laneIndex) return false;
      const ln = m.board.lanes[i];
      return ln.count < ln.cap;                                /* 空きが無いと仕掛けられない */
    });
    if (!pool.length) { note(m, '潜行爆弾：仕掛けられる相手のユニットがいない'); return; }
    const t = chooseTarget(m, ctx, pool);
    dropChannelAt(m, ctx.laneIndex, ctx.layer - 1);            /* 自分はこの位置から消える */
    pushChannel(m, t, { card: 137, up: false, mine: ctx.caster === 'self', revealed: false, armed: true });
    recalc(m);
    note(m, '潜行爆弾：' + nameOf(m, m.board.lanes[t].unit) + ' に爆弾を仕掛けた');
    return { consumed: true };
  }

  function h138(m, ctx) {                                     // 潜入：他ユニットにチャンネルとして潜行する（レベル3）
    const ln = m.board.lanes[ctx.laneIndex];
    const idx = ctx.layer - 1;
    if (!ln || !ln.channels[idx] || ln.channels[idx].card !== 138) return;
    const targets = allUnitLanes(m).filter(function (i) { return i !== ctx.laneIndex; });
    const t = pick(m, targets);
    if (t == null) { note(m, '潜入：潜行先が無い'); return; }
    const self = dropChannelAt(m, ctx.laneIndex, idx);
    self.up = false; self.revealed = false;
    pushChannel(m, t, self);
    recalc(m);
    note(m, '潜入：' + nameOf(m, m.board.lanes[t].unit) + ' へ潜行した');
    return { consumed: true };
  }

  function h139(m, ctx) {                                     // 爆雷：敵マスターのＬＰを3点減らす（戦闘中×）
    const enemy = other(ctx.caster);
    damage(m, enemy, 3);
    note(m, '爆雷：' + jp(enemy) + ' のＬＰ -3');
  }

  /** 時の渦：自分自身が壊れ、**そのターンをもう一度最初からやり直す**（詠唱Ｌｖ4／戦闘中×）。
   *
   * ★M6.7 WP3（判断5）。原作も「ドローステップへ戻る」＝硬直・チャネリング済み・リバースの
   * 各フラグを全部解除して配置ステップから再開、という効果だった（資料§140）。
   * v0.16.22までは「もう1枚ドローするだけ」の簡略実装だった。
   *
   * **連鎖中の扱い（2026-08-30 本人確定）**：強制リバース連鎖の最中に開かれた場合は
   * **連鎖を止めるだけ**で、ターンのやり直しは起こさない。
   * ——連鎖を仕掛けたのは相手で、カードの持ち主はこちら、という状況で
   * 「誰のターンをやり直すのか」が決まらないため。原作はこの曖昧さを避けて
   * 140を「強制中×」（連鎖中は不発）にしていたが、対抗札としての手触りを残すために
   * 「止めるところまではやる」形にしてある。 */
  function h140(m, ctx) {
    const side = ctx.caster;
    dropChannelAt(m, ctx.laneIndex, ctx.layer - 1);            /* まず自分が壊れる */
    recalc(m);
    if (m.forcedCtx) {
      /* 連鎖中：連鎖だけ止める。markerAlive() より確実に効くよう、専用の中断印を置く。 */
      m.forcedAbort = '時の渦';
      note(m, '時の渦：強制リバースの連鎖を止めた（ターンのやり直しは起きない）');
      return { consumed: true };
    }
    /* 通常時：自陣の硬直・リバース・チャネリング済みを解除して配置ステップからやり直す。 */
    S.lanesOf(side).forEach(function (i) {
      const ln = m.board.lanes[i];
      ln.stiff = false; ln.reversePtr = 0; ln.extraAttack = false; ln.channeled = false;
    });
    const p = m.players[side];
    p.actedThisTurn = false;
    p.fledThisTurn = false;
    m.phase = 'placement';
    m.timeWarp = true;              /* リバースのループを打ち切る印（turn.js が読む） */
    note(m, '時の渦：' + jp(side) + ' のターンが巻き戻り、配置ステップからやり直しになった');
    return { consumed: true };
  }

  /* ================= 141〜148 ================= */

  function h141(m, ctx) {                                     // 思念波：攻撃力1000の特殊攻撃（詠唱Ｌｖ6／戦闘中×）
    // ★M6.7（判断12）：原作は「レベル6」と書いてありながら `V397==6` の分岐が無く判定が
    // 働かないバグだったが、**CardQuestでは本物にする**（LEVEL_REQ に 141:6 を追加済み。
    // ここに来ている時点でレベル判定は通っている）。
    // 一方②の「防御力551〜1000のユニットしか対象と認識しない」は原作のまま残す
    // ——これは「防御力550以下は雷撃(135)の担当」という住み分けとして読めて、
    // 2枚の使い分けが生まれるので面白さに寄与する（§0-1の方針で採否を判断した）。
    const enemy = other(ctx.caster);
    recalc(m);
    const pool = sideLanes(m, enemy).filter(function (i) {
      const d = m.board.lanes[i].def; return d >= 551 && d <= 1000;
    });
    const t = pick(m, pool);
    if (t == null) { note(m, '思念波：（原作バグ再現）対象が見つからず不発'); return; }
    const name = nameOf(m, m.board.lanes[t].unit);
    combatApi().destroy(m, t, { normalAttack: false });
    note(m, '思念波：特殊攻撃1000で ' + name + ' を破壊');
  }

  function h142(m, ctx) {                                     // 身転換：戦闘防御時、ユニットが相手と入れ換わる（レベル3）
    if (!m.combat || ctx.laneIndex !== m.combat.defender) {
      note(m, '身転換：戦闘防御時以外は発動しない');
      return;
    }
    recalc(m);
    const A = m.board.lanes[m.combat.attacker], D = m.board.lanes[m.combat.defender];
    if (!A || !D || A.unit == null || D.unit == null) return;
    if (Math.abs(A.cap - D.cap) >= 3) { note(m, '身転換：ＣＨ数の差が3以上のため発動しない'); return; }
    const tu = A.unit, tb = A.baseCh, tm = A.msEquip;
    A.unit = D.unit; A.baseCh = D.baseCh; A.msEquip = D.msEquip;
    D.unit = tu; D.baseCh = tb; D.msEquip = tm;
    A.swapped = true; D.swapped = true;                       // 以後この2レーンは戦利品にならない（原作 SW251）
    recalc(m);
    note(m, '身転換：ユニット本体が入れ替わった');
  }

  function h144(m, ctx) {                                     // 還元：全ＣＨを破壊しその分だけ手札を得る（強制中×）
    const ln = m.board.lanes[ctx.laneIndex];
    if (!ln) return;
    const n = ln.channels.length;
    ln.channels = []; ln.count = 0;
    recalc(m);
    const Turn = turnApi();
    let got = 0;
    for (let i = 0; i < n; i++) { if (Turn.draw(m.rng, m.players[ctx.caster], m) == null) break; got += 1; }
    capHand(m, ctx.caster);
    note(m, '還元：ＣＨ' + n + '枚を破壊し' + got + '枚ドローした');
    return { consumed: true };
  }

  /** 口寄せ：山札から1枚めくり、要らなければ捨ててもう1枚——欲しい1枚が出るまで繰り返す
   * （詠唱Ｌｖ3）。**捨てた札は山札に戻らない**ので、掘るほど山札が減る。
   *
   * ★M6.7 WP3（判断5）。本人案が原作仕様とほぼ一致していたので、そのまま実装した。
   * v0.16.22までは「山札にあるいちばん若いＩＤのカードを1枚」という簡略実装で、
   * 毎回同じカードが出る不自然な挙動になっていた。 */
  function h146(m, ctx) {
    const id = drawDirect(m, ctx.caster);
    if (id == null) { note(m, '口寄せ：山札が空だった'); return; }
    note(m, '口寄せ：' + nameOf(m, id) + ' をめくった');
    m.pendingChoice = { kind: 'summon', caster: ctx.caster, options: [id], tries: 1 };
    if (!ctx.interactive) autoResolve(m);
  }

  function h147(m, ctx) {                                     // 治癒：手札を全て捨てその枚数と同値のＬＰを回復（戦闘中×）
    const p = m.players[ctx.caster];
    const n = p.hand.length;
    p.hand = [];
    heal(m, ctx.caster, n);
    note(m, '治癒：手札' + n + '枚を捨ててＬＰ +' + n);
  }

  function h148(m, ctx) {                                     // 妄執：自爆し任意のユニットに憑依する
    // 原作バグ（仕様書§14.1・§8.4「148妄執」）：救済チェックのレーン判定が重複・欠落しており、
    // レーン3（物理インデックス2）だけ救済が機能しない。ここでは destroy() に normalAttack を
    // 渡すことで、レーン3のときだけ救済ゲートを迂回して同じ結果を再現する
    const bugBypass = ctx.laneIndex === 2;
    const targets = allUnitLanes(m).filter(function (i) {
      return i !== ctx.laneIndex && m.board.lanes[i].cap > m.board.lanes[i].count;
    });
    const dest = pick(m, targets);
    combatApi().destroy(m, ctx.laneIndex, { normalAttack: bugBypass });
    note(m, '妄執：自爆した' + (bugBypass ? '（原作バグ再現：レーン3は救済が効かない）' : ''));
    if (dest != null && m.board.lanes[dest] && m.board.lanes[dest].unit != null) {
      pushChannel(m, dest, { card: 148, up: true, mine: ctx.caster === 'self', revealed: true, st: 'possess' });
      recalc(m);
      note(m, '妄執：' + nameOf(m, m.board.lanes[dest].unit) + ' に憑依した');
    }
    return { consumed: true };
  }

  /* ================= ディスパッチテーブル ================= */

  const HANDLERS = {
    101: h101, 102: h102, 103: h103, 104: noopFlag, 105: h105, 106: noopFlag, 107: h107, 108: h108,
    109: h109, 110: h110, 111: h111, 112: h112, 113: h113, 114: h114, 115: h115, 116: h116,
    117: noopFlag, 118: h118, 119: h119, 120: noopFlag, 121: h121, 122: h122, 123: h123, 124: h124,
    125: h125, 126: h126, 127: h127, 128: h128, 129: h129, 130: h130, 131: h131, 132: h132,
    133: h133, 134: h134, 135: h135, 136: noopFlag, 137: h137, 138: h138, 139: h139, 140: h140,
    141: h141, 142: h142, 143: noopFlag, 144: h144, 145: noopFlag, 146: h146, 147: h147, 148: h148
  };

  /** m.hooks.onMagicOpen として combat.js / turn.js から呼ばれる。
   * 無効・戦闘中無効・発動レベル不足はここで一括してゲートする。
   * 連唱(174)・ソウルイーター(39)・ウロボロス(12)・ブラックドッグ(52)による2回発動もここで扱う。
   * 戻り値 {consumed} … このカード自身がこの階層から移動・消滅した（押収・潜入・妄執・還元・
   * 逃走・菊一文字・殲滅・呪爆）ことを呼び出し元（オープンフェイズのカーソル制御）へ知らせる */
  function onMagicOpen(m, laneIndex, layer, cardId, opts) {
    const o = opts || {};
    if (o.nullified) { note(m, '無効：' + nameOf(m, cardId) + ' は発動しなかった'); return { consumed: false }; }
    if (m.combat && NO_COMBAT[cardId]) {
      note(m, nameOf(m, cardId) + '：戦闘中は発動しない');
      return { consumed: false };
    }
    /* 強制リバース連鎖の最中に開かれた（o.forced）カードのうち、
     * 108/109/140/144 は不発（原作 CE0355 強制発動時無効）。連鎖の多重起動を防ぐ。 */
    if (o.forced && NO_FORCED[cardId]) {
      note(m, nameOf(m, cardId) + '：強制リバースの最中は発動しない');
      return { consumed: false };
    }
    if (!levelOk(m, laneIndex, layer, cardId)) {
      note(m, nameOf(m, cardId) + '：詠唱レベルが足りず発動しない');
      return { consumed: false };
    }
    const handler = HANDLERS[cardId];
    if (!handler) return { consumed: false };

    const ln0 = m.board.lanes[laneIndex];
    const ch0 = ln0 && ln0.channels[layer - 1];
    const caster = ch0 ? (ch0.mine ? 'self' : 'enemy') : m.active;
    const opener = m.combat ? combatApi().openerSide(m) : m.active;
    const Turn = turnApi();

    const chant = ln0 && ln0.acc ? ln0.acc.chant >= 1 : false;   // 連唱・ソウルイーター・ウロボロス・ブラックドッグ
    const times = chant ? 2 : 1;
    let consumed = false;
    for (let t = 0; t < times; t++) {
      const ln = m.board.lanes[laneIndex];
      if (!ln || ln.unit == null) break;
      const ch = ln.channels[layer - 1];
      if (!ch || ch.card !== cardId) break;               // 既に自ら移動・消滅していたら2回目は発動しない
      const r = handler(m, { laneIndex: laneIndex, layer: layer, cardId: cardId, opener: opener,
        caster: caster, choice: o.choice, interactive: o.interactive }) || {};
      if (r.consumed) consumed = true;
      if (Turn.checkResult(m)) break;
      if (consumed) break;
    }
    return { consumed: consumed };
  }

  const api = { onMagicOpen, LEVEL_REQ, NO_COMBAT, NO_FORCED, resolvePending, autoResolve };
  global.CQMagic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
