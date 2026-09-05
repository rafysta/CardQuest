/* CardQuest エンジン — 戦闘（アタック）
 *
 * 『SOULGATE 戦闘処理』（03_combat）と『カードバトル仕様書』§7 を移植する。
 * 原作の流れ（EV0006 page7→EV0152 page6→page9→page10→page11→EV0152 page7）をそのまま
 * 5つの段階に分ける：
 *
 *   ① 攻撃宣言   canAttack / canTarget / declareAttack
 *   ② 戦闘導入   甲殻の強制クローズ・帯電のＬＰドレイン・当事者以外の凍結
 *   ③ 攻撃側オープンフェイズ   open / endOpen（下から上への一方通行。クローズ不可）
 *   ④ 防御側オープンフェイズ   同上＋甲殻・硬直・縛鎖の制限
 *   ⑤ 判定と破壊             反射→迎撃の順。貫通で両方無効。不死なら生存して迎撃だけ走る
 *   ⑥ 戦闘終了               硬直・連続攻撃の権利・表向き魔法の消滅・爆殺の自爆・憑依の発動
 *
 * このモジュールも DOM に依存しない。UI はカーソル操作を open()/endOpen() の呼び出しに変換する。
 *
 * 通常攻撃フラグ（原作 SW550）は destroy() の opts.normalAttack として持ち回す。
 * これが「戦利品が入る／救済が効かない／憑依が発動する」の唯一の分岐点（仕様書§7.4）。
 */
'use strict';
(function (global) {

  const isNode = (typeof require === 'function' && typeof window === 'undefined');
  const S = isNode ? require('./state.js') : global.CQState;
  const Stats = isNode ? require('./stats.js') : global.CQStats;
  const Turn = isNode ? require('./turn.js') : global.CQTurn;
  const Field = isNode ? require('./fieldrules.js') : global.CQField;

  const LOOT_MAX = 7;                       // 原作 V979 の上限

  function other(side) { return side === 'self' ? 'enemy' : 'self'; }
  function jp(side) { return side === 'self' ? '自分' : '相手'; }
  function note(m, msg) { m.log.push(msg); }
  function nameOf(m, id) { const c = m.cards[id]; return c ? c.n : ('#' + id); }

  /** 戦闘中は当事者以外のレーンの能力値を凍結する（原作 EV0171 page1 冒頭） */
  function combatOpt(m) {
    return m.combat ? { attacker: m.combat.attacker, defender: m.combat.defender } : null;
  }
  function recalc(m) {
    Stats.recalc(m.board, { cards: m.cards, combat: combatOpt(m) });
    enforcePost(m);          /* M7.8 WP1：緊急抵抗・融合解除（再入は enforcePost 側で防ぐ） */
  }

  /** ＬＰダメージ。M6.6 WP6：フリーユニット戦の敵にはＬＰの概念が無いので、敵側への
   * ＬＰダメージは丸ごと無視する（§2-6「敵はLP表示なし」／勝敗は場が空になるかで決まる）。
   * 自分側は従来どおり——プレイヤーの敗北条件はＬＰ0のままである。 */
  function damage(m, side, n) {
    if (!n) return;
    if (m.mode === 'field' && side === 'enemy') return;
    m.players[side].lp -= n;
  }
  function heal(m, side, n) {
    const p = m.players[side];
    p.lp += n; if (p.lp > p.maxLp) p.lp = p.maxLp;
  }

  /* ================= ① 攻撃宣言 ================= */

  /** 攻撃側としての適格性（原作 EV0006 page7 → SW357）。
   * 操作側＝居る場の陣営（S.controlSide）。傀儡(169)・カース92で奪ったユニットは
   * ★M7.8 WP6 で自分の場へ物理的に移ってくるので、自陣のユニットとして普通に動かせる */
  function canAttack(m, laneIndex) {
    if (m.winner) return { ok: false, reason: '対局は終了しています' };
    if (m.phase !== 'main') return { ok: false, reason: 'メインステップではありません' };
    if (laneIndex < 0 || laneIndex >= 6) return { ok: false, reason: '不正なレーンです' };
    const ln = m.board.lanes[laneIndex];
    if (ln.unit == null) return { ok: false, reason: 'ユニットが居ません' };
    recalc(m);                                              // acc（と傀儡の移動）を最新化してから判定
    if (S.controlSide(ln, laneIndex) !== m.active) return { ok: false, reason: '自陣のユニットだけが攻撃できます' };
    if (ln.channeled) return { ok: false, reason: 'このターンにチャネリングしたユニットは攻撃できません' };
    if (m.reversing === laneIndex) return { ok: false, reason: 'リバースしたユニットはこのターン攻撃できません' };  // 原作 SW322
    if (ln.stiff && !ln.extraAttack) return { ok: false, reason: 'そのユニットは行動済みです' };
    if (ln.acc.vapor >= 1) return { ok: false, reason: '気化しているユニットは攻撃できません' };
    return { ok: true };
  }

  /** 防御側としての適格性（原作 EV0006 page7 → SW358）。追跡は制限をすべて無視する。
   * 対象になりうるのは「相手側のレーン」（傀儡で移されたユニットも、いま居る場の陣営で扱う） */
  function canTarget(m, atkLane, defLane) {
    const a = canAttack(m, atkLane);
    if (!a.ok) return a;
    const foeSide = other(m.active);
    if (defLane < 0 || defLane >= 6) return { ok: false, reason: '相手のレーンではありません' };
    const D = m.board.lanes[defLane];
    if (D.unit == null) return { ok: false, reason: 'そのレーンにユニットは居ません' };
    if (S.controlSide(D, defLane) !== foeSide) return { ok: false, reason: '相手のレーンではありません' };
    const A = m.board.lanes[atkLane];
    recalc(m);
    if (A.acc.pursuit >= 1) return { ok: true };                       // 追跡：制限を無視
    if (D.acc.vapor >= 1) return { ok: false, reason: '気化しているユニットは攻撃対象になりません' };
    const foes = S.controlledLanesOf(m.board.lanes, foeSide).map(function (i) { return m.board.lanes[i]; });
    const hidden = foes.filter(function (l) { return l.acc.hide >= 1; }).length;
    if (D.acc.hide >= 1 && foes.length > hidden)
      return { ok: false, reason: '隠遁：隠遁していないユニットが居る間は狙えません' };
    const magnets = foes.filter(function (l) { return l.acc.magnet >= 1; }).length;
    if (magnets >= 1 && D.acc.magnet === 0)
      return { ok: false, reason: '磁力：磁力を持つユニットしか狙えません' };
    return { ok: true };
  }

  /** 攻撃できる相手レーンの一覧（ＵＩ・ＡＩ用）。全6レーンを走査する
   * （canTarget が陣営を判定するので、ここで絞らない） */
  function attackTargets(m, atkLane) {
    const res = [];
    if (!canAttack(m, atkLane).ok) return res;
    for (let i = 0; i < 6; i++) {
      if (canTarget(m, atkLane, i).ok) res.push(i);
    }
    return res;
  }

  /* ================= ② 戦闘導入 ================= */

  /** 甲殻(183)：防御側になった瞬間に全チャンネルを強制クローズする（原作 CE0257）。
   * 甲殻カード自身(183)は閉じない。ただし固有能力由来（値10＝エグゼデグゼス）なら183も閉じる */
  function applyShell(m) {
    const D = m.board.lanes[m.combat.defender];
    if (!D || D.unit == null || D.acc.shell < 1) return;
    const innate = D.acc.shell >= 10;
    D.channels.forEach(function (ch) {
      if (!ch.up) return;
      if (ch.card === 183 && !innate) return;
      ch.up = false;
    });
    note(m, '甲殻：' + nameOf(m, D.unit) + ' のチャンネルが閉じた');
  }

  /** 攻撃を宣言して戦闘に入る。成功すると m.combat が立ち、攻撃側のオープンフェイズが始まる。
   * 開けるカードが無ければ自動的に次の段階へ進み、そのまま判定まで走ることもある。 */
  function declareAttack(m, atkLane, defLane) {
    const chk = canTarget(m, atkLane, defLane);
    if (!chk.ok) return chk;
    Turn.finalizeReverse(m, null);     // 別レーンでリバース継続中なら、攻撃を始めた時点で確定（硬直）
    const A = m.board.lanes[atkLane], D = m.board.lanes[defLane];
    const pierce = A.acc.pierce >= 1;

    // 帯電（ニドヘッグ／原作 V813〜）：防御側の値だけ攻撃側マスターのＬＰが減る。貫通で無効。
    //   [修正5] 原作は対象制限で攻撃が成立しなかった場合にもＬＰを奪うが、
    //           宣言し放題になるため「戦闘が実際に始まったときだけ」に限定した
    if (!pierce && D.acc.drain >= 1) {
      damage(m, m.active, D.acc.drain);
      note(m, '帯電：' + jp(m.active) + ' のＬＰ -' + D.acc.drain);
      if (Turn.checkResult(m)) return { ok: true, aborted: true, result: null };
    }

    m.combat = {
      attacker: atkLane, defender: defLane,
      attackerSide: m.active, defenderSide: other(m.active),
      opener: 'attacker', phase: 'attackerOpen', cursor: 1,
      opened: [], result: null
    };
    m.phase = 'battle';
    note(m, jp(m.active) + ' の ' + nameOf(m, A.unit) + ' が ' + nameOf(m, D.unit) + ' に攻撃');
    recalc(m);
    applyShell(m);
    recalc(m);
    return startOpenPhase(m);
  }

  /* ================= ③④ オープンフェイズ ================= */

  function openerLane(m) { return m.combat.opener === 'attacker' ? m.combat.attacker : m.combat.defender; }
  /** いまオープンフェイズを行っている側（'self'|'enemy'） */
  function openerSide(m) {
    if (!m.combat) return null;
    return m.combat.opener === 'attacker' ? m.combat.attackerSide : m.combat.defenderSide;
  }

  /** そもそもオープンフェイズが成立するか（成立しなければ丸ごとスキップ） */
  function canOpenPhase(m) {
    const c = m.combat, ln = m.board.lanes[openerLane(m)];
    if (!ln || ln.unit == null || ln.count === 0) return false;
    if (ln.acc.lock >= 1) return false;                    // 固定(159)・石化(168)
    if (c.opener === 'defender') {
      if (ln.acc.shell >= 1 && ln.acc.shell !== 10) return false;   // 甲殻（固有の10だけ例外）
      if (ln.stiff) return false;                                   // 硬直（防御時のみ効く）
    }
    return true;
  }

  /** いま開ける階層の一覧（三角カーソル位置以上・裏向き・縛鎖でない） */
  function openableLayers(m) {
    if (!m.combat || !canOpenPhase(m)) return [];
    const c = m.combat, ln = m.board.lanes[openerLane(m)], res = [];
    for (let n = c.cursor; n <= ln.count; n++) {
      const ch = ln.channels[n - 1];
      if (!ch || ch.up) continue;
      if (c.opener === 'defender' && m.board.chainLocked && m.board.chainLocked.indexOf(n) >= 0) continue;
      res.push(n);
    }
    return res;
  }

  function startOpenPhase(m) {
    m.combat.cursor = 1;
    m.combat.phase = m.combat.opener === 'attacker' ? 'attackerOpen' : 'defenderOpen';
    if (openableLayers(m).length === 0) return endOpenPhase(m);
    return { ok: true, phase: m.combat.phase };
  }

  /** 開かずにこのフェイズを終える（Ｂキーで最上段まで飛ばしたのと同じ） */
  function endOpenPhase(m) {
    const c = m.combat;
    c.cursor = 0;
    if (c.opener === 'attacker') { c.opener = 'defender'; return startOpenPhase(m); }
    c.phase = 'judge';
    return resolve(m);
  }
  function endOpen(m) {
    if (!m.combat || (m.combat.phase !== 'attackerOpen' && m.combat.phase !== 'defenderOpen'))
      return { ok: false, reason: 'オープンフェイズではありません' };
    return endOpenPhase(m);
  }

  /** 指定した階層をオープンする。カーソルより下の階層は選べない（下から上への一方通行）。
   * 開いた瞬間に魔法（M4でフック）とリバース召還が起動する。
   * opts.choice … 対話的な対象選択に対応した魔法（101憑依解除など）向けに、レイアウト側が
   * 事前に選んでおいた対象 {lane, idx} を渡せる（2026-08-24 本人の指定）。 */
  function open(m, layer, opts) {
    if (!m.combat || (m.combat.phase !== 'attackerOpen' && m.combat.phase !== 'defenderOpen'))
      return { ok: false, reason: 'オープンフェイズではありません' };
    if (openableLayers(m).indexOf(layer) < 0) return { ok: false, reason: 'その階層は開けません' };
    const c = m.combat, laneIndex = openerLane(m), ln = m.board.lanes[laneIndex];
    const ch = ln.channels[layer - 1];

    ch.up = true;
    ch.revealed = true;                                   // 開いた瞬間に全員に見える
    ch.opened = true;                                     // この戦闘で開けた印（原作のリング表示）
    c.opened.push({ lane: laneIndex, layer: layer, card: ch.card });
    note(m, jp(openerSide(m)) + ' が ' + layer + '階層目の ' + nameOf(m, ch.card) + ' をオープン');
    recalc(m);

    const eff = onOpen(m, laneIndex, layer, ch, opts);

    // 階層が1枚減ったときはカーソルを進めない（上のカードが1段落ちてくるので相殺される）
    if (!eff.consumed) c.cursor = layer + 1;
    recalc(m);

    if (!m.combat) return { ok: true, effect: eff };       // 魔法の効果などで戦闘が終わっていた
    if (m.winner) { return { ok: true, effect: eff }; }
    if (openableLayers(m).length === 0) {
      const r = endOpenPhase(m);
      return { ok: true, effect: eff, result: r && r.result };
    }
    return { ok: true, effect: eff };
  }

  /** オープンによる割り込み処理（原作 EV0182 ＣＨオープン処理） */
  function onOpen(m, laneIndex, layer, ch, opts) {
    /* ★M7.8 WP6：効果の処理中は傀儡の物理移動を待たせる（処理の途中でレーンが動くと、
     * laneIndex を握っている効果処理が別のユニットを触ってしまう）。抜けるときに移動する。 */
    holdSettle(m);
    try { return onOpenBody(m, laneIndex, layer, ch, opts); }
    finally { releaseSettle(m); }
  }
  function onOpenBody(m, laneIndex, layer, ch, opts) {
    const id = ch.card;
    if (id >= 1 && id <= 100) {
      // ユニット固有能力「開：」型（M4 v0.14）：リバース召還より前に解決し、無効・抑制を迂回する
      // （カードバトル仕様書§10.2）。js/engine/effects/units.js の B_HANDLERS に無いＩＤ
      // （通常ユニット・カース）は onUnitOpen() が即 {consumed:false} を返すだけで実質ノーオペ
      if (m.hooks && typeof m.hooks.onUnitOpen === 'function') {
        const r = m.hooks.onUnitOpen(m, laneIndex, layer, id,
          { choice: opts && opts.choice }) || {};   /* M6.7 WP6：対象の指定を通す */
        /* M6.7 WP3：consumed（階層が無くなった）と handled（効果は済んだ）を分けた。
         * 摩り替り(25)は階層を残したまま効果だけ済ませるので handled のみ立つ。
         * ここで返さないと、開いたユニットカードがそのままリバース召還されてしまう。 */
        if (r.consumed || r.handled) return { consumed: !!r.consumed, result: 'unitAbility' };
      }
      return reverseSummon(m, laneIndex, layer, ch);
    }
    // 魔法(101〜150)の発動は js/engine/effects/magic.js（M4 v0.13）。無効(190)・抑制(120)による
    // ガードもそちらで扱う。押収(118)・潜入(138)・妄執(148)のようにカード自身がこの階層から
    // 移動・消滅する効果は、hook の戻り値 consumed で知らせてもらいカーソル制御に反映する
    let consumed = false;
    if (m.hooks && typeof m.hooks.onMagicOpen === 'function') {
      const nullified = m.board.lanes[laneIndex].acc.nullify >= 1;
      const r = m.hooks.onMagicOpen(m, laneIndex, layer, id,
        { nullified: nullified, choice: opts && opts.choice,
          /* M6.7 WP3：効果の途中で選ばせるカード（122予見・146口寄せ）向け。
           * ＵＩだけが true を渡し、ＡＩ・シミュレータは渡さない＝その場で自動解決される。 */
          interactive: opts && opts.interactive });
      consumed = !!(r && r.consumed);
    }
    return { consumed: consumed, result: 'magic' };
  }

  /** 生贄の儀式が成立するか（召還Ｌｖ2以上のリバース召還。v0.15.3）。
   * destSide＝そのユニットカードを置いた人の陣営。成立時は dest（新ユニットが立つレーン）を返す */
  function ritualCheck(m, laneIndex, destSide) {
    const ln = m.board.lanes[laneIndex];
    // ① 戦闘中は儀式ができない（オープンフェイズでのリバース召還は必ず失敗する）
    if (m.combat) return { ok: false, result: 'ritualCombat', reason: '戦闘中は生贄を捧げられず、' };
    // ② 生贄にできるのは「そのカードを置いた本人が操作している」ユニットだけ。
    //    敵のユニットに仕込んだ場合は生贄を用意できない。傀儡で奪ったユニットは
    //    （★M7.8 WP6 で自分の場へ物理的に移ってくるので）自陣のユニットとして生贄にできる
    if (S.controlSide(ln, laneIndex) !== destSide)
      return { ok: false, result: 'ritualFoe', reason: '生贄にできるユニットが無く、' };
    // ③ 救済(179)／救済能力（11 ケツァルコアトル固有）で守られたユニットは生贄にできない
    if (ln.acc.salvation >= 1)
      return { ok: false, result: 'ritualSalvation', reason: '救済に守られたユニットは生贄にできず、' };
    // ④ 置き場所：ホストの跡地（操作側＝居る場の陣営なので、ここは常に成立する）。
    //    下の「空きレーンを探す」経路は M4 の flipped 方式（操作権だけ反転）の名残で、
    //    いまは通らないが安全のため残してある
    if (S.sideOf(laneIndex) === destSide) return { ok: true, dest: laneIndex };
    // M6 戦場ルール laneLock：ふさがれたレーンは召還先にできない（Field.freeLanesOf に集約）
    const dest = Field.freeLanesOf(m, destSide)[0];
    if (dest === undefined) return { ok: false, result: 'nospace', reason: '召還先が無く、' };
    return { ok: true, dest: dest };
  }

  /** リバース召還（原作 EV0182 [C]）。潜行ユニットがオープンされて場に出る */
  /* ==== 集計のあとに走る強制処理（M7.8 WP1・原作 EV0244 page7/page8） ==============
   *
   * 原作は能力値の再計算のたびに、集計の直後で次の2つを走らせている。
   * どちらも「盤面を見て条件が揃っていたらカードを動かす」処理なので、純粋な計算である
   * Stats.recalc() の中には置けない——各モジュールの recalc(m) ラッパから呼ぶ形にした
   * （ＡＩの評価は Stats.recalc を直に呼ぶので、この強制処理は走らない＝評価用の複製を壊さない）。
   *
   *   ① 緊急抵抗（page7）：抵抗(178)のあるレーンの**表向きのID 1〜100**を1枚ずつ破壊する。
   *      カースは最初から表向きで貼られるので、「裏を開いた瞬間」しか見ていなかった
   *      従来の実装では**抵抗が一度もカースを壊せなかった**（M7.8 で判明）。
   *   ② 融合解除（page8）：融合(162)が封印やクローズで失われたレーンに、表向きのまま
   *      潜行しているユニット(1〜89)が残っていたら、1体ずつ分離召還する。
   *
   * 順序は原作どおり ①→②。破壊は通常攻撃ではない扱い＝救済(179)で守られ、戦利品にもならない。
   *
   *   ③ 傀儡の移動（★M7.8 WP6・原作 EV0019 page4／page5）：傀儡(169)・カース92が表向きで
   *      付いたユニットを**レーンごと相手陣営の空きレーンへ移す**。傀儡が失われたら元の陣営へ戻す。
   *      原作はこれを「戦闘中でも魔法処理中でもないとき」だけ走らせる（EV0019 page3 ⑱）ので、
   *      戦闘中（m.combat）・強制リバース連鎖中（m.forcedChain）・カード効果の処理中
   *      （m._openHold＞0。onOpen が立てる）・憑依の予約が残っている間（m.pendingCurse）は
   *      動かさない。戦闘中に開かれた傀儡は、戦闘終了の recalc で移動する。 */
  function enforcePost(m) {
    if (!m || !m.board || m._enforcing) return;      /* 再入防止（destroy が recalc を呼ぶため） */
    m._enforcing = true;
    try {
      let guard = 0;
      let again = true;
      while (again && guard++ < 24) {
        again = false;
        // ③ 傀儡の移動・帰還（M7.8 WP6）。①②より先に見る——移動先で集計が変わるので、
        //    緊急抵抗・融合解除は移動後の盤面で判定させる
        if (puppetSettle(m)) { recalc(m); again = true; continue; }
        // ① 緊急抵抗
        for (let i = 0; i < m.board.lanes.length; i++) {
          const ln = m.board.lanes[i];
          if (ln.unit == null || !ln.acc || ln.acc.resist < 1) continue;
          const at = ln.channels.findIndex(function (ch) { return ch.up && ch.card >= 1 && ch.card <= 100; });
          if (at < 0) continue;
          const id = ln.channels[at].card;
          /* 救済(179)は「通常攻撃でない破壊」を無効化する＝抵抗でも壊せない */
          if (ln.acc.salvation >= 1) continue;
          ln.channels.splice(at, 1);
          ln.count = ln.channels.length;
          note(m, '抵抗：' + nameOf(m, id) + ' は破壊された');
          recalc(m);
          again = true;
          break;
        }
        if (again) continue;
        // ② 融合解除
        for (let i = 0; i < m.board.lanes.length; i++) {
          const ln = m.board.lanes[i];
          if (ln.unit == null || !ln.acc) continue;
          if (ln.acc.fusion >= 1 || ln.acc.resist >= 1) continue;
          const at = ln.channels.findIndex(function (ch) { return ch.sunk && ch.up; });
          if (at < 0) continue;
          const ch = ln.channels[at];
          ch.sunk = false;
          note(m, '融合が解けた：' + nameOf(m, ch.card) + ' が分離召還される');
          reverseSummon(m, i, at + 1, ch);
          recalc(m);
          again = true;
          break;
        }
      }
    } finally {
      m._enforcing = false;
    }
  }

  /* ==== 傀儡の物理移動（★M7.8 WP6・原作 06_skill.md §4-19 `EV0019 page4/page5`） ==========
   *
   * 原作：
   *   page4（発動）… ユニットが居て S(613,L)≧1 で、まだ移っていない（SW[567+L]=OFF）レーンを、
   *     相手陣営の空きレーン（若い順）へ**ユニット本体＋階層1〜6を丸ごと**移送する。
   *     裏／所有者／既知の3フラグは保持。移動先に空きが無ければ（相手ユニット3体）**破壊**
   *     ——ただし SW574=ON なので**ＬＰダメージも憑依も発生しない**（SW550=ON＝通常攻撃扱いで
   *     救済(179)には守られない）。相手のターン中に移ったなら硬直させる。
   *   page5（解除）… 傀儡が失われた（S(613,L)=0）のに移されたまま（SW[567+L]=ON）のレーンを
   *     同じ手順で元の陣営へ戻す。
   *
   * CardQuest での置き換え：
   *   ・「移されている」の印は `lane.puppeted`（元の陣営。null＝自前の場）。
   *   ・移動先の候補は Field.freeLanesOf（M6 戦場ルールでふさがれたレーンは使わない）。
   *   ・移動失敗の破壊は destroy(normalAttack:true, suppress:true, noLoot:true)＝
   *     救済を迂回・ＬＰと憑依を抑止・戦利品も出さない（原作の SW571 条件は移動元レーンの
   *     フラグを見ていて解釈が割れるため、**戦利品は通常攻撃で倒したときだけ**という
   *     CardQuest の規則のほうに揃えた）。
   *   ・移った先で `channeled`／`extraAttack`／`reversePtr` は消す（原作「元レーンのステータス
   *     変数を全消去」）。硬直は「受け取る側のターン中に移った」ときだけ付ける＝その場で
   *     ただちに攻撃に使えない。それ以外は次の自分のターン開始で解除されるので付けない。
   *   ・帰還も同じ手順。元の陣営に空きが無ければ、やはりＬＰなしで破壊される。
   * 1回の呼び出しで1レーンだけ動かし、動いたら true を返す（enforcePost が recalc して回し直す）。 */
  function puppetSettle(m) {
    if (m.combat || m.forcedChain || m.pendingCurse) return false;
    if (m._openHold > 0) return false;
    const lanes = m.board.lanes;
    for (let i = 0; i < lanes.length; i++) {
      const ln = lanes[i];
      if (ln.unit == null || !ln.acc) continue;
      const here = S.sideOf(i);
      const held = ln.acc.puppet >= 1;
      if (held && !ln.puppeted) {                              // page4：相手陣営へ
        puppetMove(m, i, other(here), here, '傀儡');
        return true;
      }
      if (!held && ln.puppeted) {                              // page5：元の陣営へ
        /* 元の陣営に居るのに印が残っている（セーブの復元など）＝印だけ消す */
        if (ln.puppeted === here) { ln.puppeted = null; return true; }
        puppetMove(m, i, ln.puppeted, null, '傀儡が解けた');
        return true;
      }
    }
    return false;
  }

  /** レーン from のユニットを destSide の空きレーンへ移す。mark＝移動後に付ける puppeted の値
   * （相手陣営へ行くときは元の陣営、帰るときは null）。空きが無ければ破壊する。 */
  function puppetMove(m, from, destSide, mark, label) {
    const ln = m.board.lanes[from];
    const unitId = ln.unit;
    const dest = Field.freeLanesOf(m, destSide)[0];
    if (dest === undefined) {
      note(m, label + '：' + nameOf(m, unitId) + ' は' + jp(destSide) + 'の場に空きが無く破壊された（ＬＰは減らない）');
      destroy(m, from, { normalAttack: true, suppress: true, noLoot: true });
      return;
    }
    m.board.lanes[from] = S.emptyLane();
    ln.puppeted = mark;
    ln.channeled = false;
    ln.extraAttack = false;
    ln.reversePtr = 0;
    ln.stiff = (m.active === destSide);                        // 受け取る側のターン中なら硬直
    m.board.lanes[dest] = ln;
    if (m.reversing === from) m.reversing = null;              // 続きのリバースはもうできない
    /* ＵＩの演出用：どのレーンからどこへ移ったかを控える（破壊ではなく「移動」として見せる。
     * 2026-09-05 本人指定）。js/layout.js の animateFx が読んで空にする。読まれない環境
     * （ＡＩ・シミュレータ）で溜まらないよう、末尾8件だけ残す */
    m.fxMoves = (m.fxMoves || []).concat([{ from: from, to: dest, unit: unitId, kind: 'puppet' }]).slice(-8);
    note(m, label + '：' + nameOf(m, unitId) + ' が' + jp(destSide) + 'の場（レーン' + dest + '）へ移った');
    Turn.checkResult(m);                                       // フリーユニット戦：敵の場が空になれば勝ち
  }

  /** カード効果の処理中は傀儡の移動を待たせる（onOpen・強制リバース連鎖の後始末が使う）。
   * release で 0 に戻ったとき recalc して、待たせていた移動をその場で行う。 */
  function holdSettle(m) { m._openHold = (m._openHold || 0) + 1; }
  function releaseSettle(m) {
    m._openHold = Math.max(0, (m._openHold || 0) - 1);
    if (m._openHold === 0) recalc(m);
  }

  function reverseSummon(m, laneIndex, layer, ch) {
    const ln = m.board.lanes[laneIndex], id = ch.card;
    const drop = function () {
      ln.channels.splice(layer - 1, 1);
      ln.count = ln.channels.length;
      recalc(m);
    };
    // (2) 抵抗(178)：出てこようとしたカードを破壊する（カースも壊せる）
    if (ln.acc.resist >= 1) {
      drop();
      note(m, '抵抗：' + nameOf(m, id) + ' は破壊された');
      return { consumed: true, result: 'resist' };
    }
    // (3) カース(90〜100)：何も起きない（表のまま残る）
    if (id >= 90) return { consumed: false, result: 'curse' };
    // (4) 融合(162)：分離せずチャンネルのまま留まる（潜行継続）
    if (ln.acc.fusion >= 1) {
      /* M7.8 WP1：**潜行中の印**を付ける（原作の潜行枚数 S(353,L) に相当）。
       * 融合が失われたときに分離召還する対象を、この印で見分ける——印を使わずに
       * 「表向きのユニットカード」を対象にすると、開いた直後でまだ処理中のカード
       * （強制開放の連鎖・スケープゴートの入れ替えなど）まで巻き込んでしまう。 */
      ch.sunk = true;
      note(m, '融合：' + nameOf(m, id) + ' は潜行したまま');
      return { consumed: false, result: 'fusion' };
    }
    // (4.5) M6 戦場ルール noHighCH：素のＣＨ数が上限を超えるユニットは場に出られない。
    //   通常召還・リバース召還・生贄の儀式・光臨(199)、すべて同じゲートを通す（例外なし）。
    //   召還レベル不足と同じく、出てこようとしたカードは破壊される
    const fgate = Field.summonAllowed(m, id);
    if (!fgate.ok) {
      drop();
      note(m, nameOf(m, id) + ' は戦場ルールで召還できず破壊された');
      return { consumed: true, result: 'fieldRule' };
    }
    // (5) 召還レベル：配置階層 >= 召還レベル で成功。
    //     魔道書(186)はこのレーンに付いている枚数×2ぶん要求レベルを下げる（メインステップ中のみ有効。
    //     『能力値計算とチャンネル』確定事項#12）
    const printedLv = S.unitStats(m.cards[id]).lv;        // 印字の召還レベル（魔道書で下がる前）
    const lv = printedLv - ln.acc.tome;
    if (layer < lv) {
      drop();
      note(m, nameOf(m, id) + ' は召還レベルが足りず破壊された');
      return { consumed: true, result: 'level' };
    }
    const destSide = ch.mine ? 'self' : 'enemy';

    // (5.5) 生贄の儀式（v0.15.3／M5.8。2026-08-26 本人の指定）
    //   召還Ｌｖ2以上のユニットは、ホストを生贄に捧げないと場に出られない。
    //   儀式が成立しなければ召還失敗＝出てこようとしたカードを破壊する（下のカードはそのまま残る）。
    //   成立すると、そのユニットより下に積まれていたカードをそのまま引き継ぎ（敵が仕込んだカードも
    //   含む）、上に積まれていたカードはホストと一緒に消え、跡地にそのまま立つ。
    //   ※ 召還Ｌｖ1は従来どおり（生贄なし・引き継ぎなし・空きレーンへ）
    if (printedLv >= 2) {
      const rit = ritualCheck(m, laneIndex, destSide);
      if (!rit.ok) {
        drop();
        note(m, nameOf(m, id) + ' は' + rit.reason + '召還に失敗し破壊された');
        return { consumed: true, result: rit.result };
      }
      const carried = ln.channels.slice(0, layer - 1);     // 下に積まれていたカード＝引き継ぐ
      ln.channels = ln.channels.slice(layer);              // 上に積まれていたカード＝ホストと共に消える
      ln.count = ln.channels.length;
      note(m, nameOf(m, ln.unit) + ' を生贄に ' + nameOf(m, id) + ' を召還（ＣＨ' + carried.length + '枚を引き継ぎ）');
      // 生贄はＬＰダメージを伴わない（suppress。ＬＰを払うと逆転の切り札にならないため）
      destroy(m, laneIndex, { normalAttack: false, suppress: true });
      m.board.lanes[rit.dest] = S.makeLane(id, carried, m.cards);   // 召還されたユニットは硬直しない
      recalc(m);
      return { consumed: true, result: 'ritual', lane: rit.dest };
    }

    // (6) 召還先＝そのカードを置いたマスターの場。空きが無ければ破壊
    //     （M6 戦場ルール laneLock でふさがれたレーンは空きとして数えない）
    const dest = Field.freeLanesOf(m, destSide)[0];
    if (dest === undefined) {
      drop();
      note(m, nameOf(m, id) + ' は召還先が無く破壊された');
      return { consumed: true, result: 'nospace' };
    }
    ln.channels.splice(layer - 1, 1);
    ln.count = ln.channels.length;
    m.board.lanes[dest] = S.makeLane(id, [], m.cards);    // (7) 召還されたユニットは硬直しない
    recalc(m);
    note(m, 'リバース召還：' + nameOf(m, id));
    return { consumed: true, result: 'summon', lane: dest };
  }

  /* ================= ⑤ 判定 ================= */

  function resolve(m) {
    const c = m.combat;
    recalc(m);
    const A = m.board.lanes[c.attacker], D = m.board.lanes[c.defender];
    const result = {
      attacker: c.attacker, defender: c.defender,
      attackerSide: c.attackerSide, defenderSide: c.defenderSide,
      atk: A.atk, def: D.def, dAtk: D.atk, aDef: A.def,
      success: false, destroyed: [], survived: [], lp: { self: 0, enemy: 0 }, loot: []
    };
    // 呪爆などで戦闘中に当事者が消えていたら判定しない
    if (A.unit == null || D.unit == null) { c.result = result; return endBattle(m, result); }

    const ATK = A.atk, DEF = D.def, dATK = D.atk, aDEF = A.def;
    const pierce = A.acc.pierce >= 1;                     // 貫通：迎撃・反射を完全無効化
    const intercept = !pierce && D.acc.counter >= 1;
    const reflect = !pierce && D.acc.reflect >= 1;
    result.pierce = pierce;

    if (ATK < DEF) {
      // ---- 攻撃失敗 ----
      if (reflect) {
        const r = (D.unit === 63) ? ATK * 2 : ATK;        // インフェルノは反射2倍
        result.reflect = r;
        if (r >= aDEF) {
          note(m, '反射：攻撃側が破壊された');
          destroyIn(m, c.attacker, result, { normalAttack: true });
          return endBattle(m, result);
        }
      }
      if (intercept) {
        result.intercept = dATK;
        if (dATK >= aDEF) {
          note(m, '迎撃：攻撃側が破壊された');
          destroyIn(m, c.attacker, result, { normalAttack: true });
          return endBattle(m, result);
        }
      }
      note(m, '攻撃失敗（' + ATK + ' < ' + DEF + '）');
      return endBattle(m, result);
    }

    // ---- 攻撃成功（同値も成功）----
    result.success = true;
    note(m, '攻撃成功（' + ATK + ' ≧ ' + DEF + '）');
    const d = destroyIn(m, c.defender, result, { normalAttack: true });
    if (d.survived === 'undying' && intercept && dATK >= aDEF) {
      note(m, '不死で耐えた ' + nameOf(m, D.unit) + ' の迎撃：攻撃側が破壊された');
      destroyIn(m, c.attacker, result, { normalAttack: true });
    }
    return endBattle(m, result);
  }

  /** 戦闘の中で破壊する（憑依の取り憑き先＝相手側の当事者レーンを渡す） */
  function destroyIn(m, laneIndex, result, opts) {
    const c = m.combat;
    const foe = laneIndex === c.attacker ? c.defender : c.attacker;
    const r = destroy(m, laneIndex, Object.assign({ curseTarget: foe }, opts || {}));
    if (r.survived) result.survived.push({ lane: laneIndex, by: r.survived });
    else if (r.ok) result.destroyed.push({ lane: laneIndex, unit: r.unit, lp: r.lp, side: r.ownerSide });
    if (r.lp) result.lp[r.ownerSide] += r.lp;
    return r;
  }

  /* ================= ⑥ 破壊処理（原作 CE0167〜0172 死亡1〜6） ================= */

  /** ユニットを破壊する。opts:
   *   normalAttack … 通常攻撃による破壊か（原作 SW550）。戦利品・救済・憑依の唯一の分岐点
   *   suppress     … ＬＰダメージと憑依を抑止（原作 SW574。傀儡の強制排除など）
   *   curseTarget  … 憑依の取り憑き先レーン
   *   magic        … 魔法処理中（不死・ゾンビ帰還・戦利品が働かない。原作 SW325） */
  function destroy(m, laneIndex, opts) {
    const o = opts || {}, ln = m.board.lanes[laneIndex];
    if (!ln || ln.unit == null) return { ok: false };
    if (!ln.acc) recalc(m);                              // 一度も集計していない盤面から呼ばれた場合
    const normal = !!o.normalAttack;
    const inBattle = !!m.combat && !o.magic;
    const side = S.sideOf(laneIndex);
    /* ★M7.8 WP6：被弾側＝**居る場の陣営**。傀儡で相手陣営に移されたユニットが倒されれば、
     * 移動先の陣営のＬＰが減る（原作 CE0167 の SW568〜573 と同じ結果。従来の flipped 方式でも
     * 結果は同じだったが、いまは物理的に移っているので陣営をそのまま見ればよい）。 */
    const ownerSide = side;
    const unitId = ln.unit, chDmg = ln.baseCh;            // ＬＰダメージ＝カード記載の素のＣＨ数

    // [1] 不死(177)：戦闘中かつ魔法処理中でなければ、ＬＰダメージだけ受けて生き残る
    if (inBattle && ln.acc.undying >= 1) {
      if (!o.suppress) damage(m, ownerSide, chDmg);
      note(m, '不死：' + nameOf(m, unitId) + ' は破壊されない（ＬＰ -' + chDmg + '）');
      recalc(m);
      return { ok: true, survived: 'undying', unit: unitId, lp: o.suppress ? 0 : chDmg, ownerSide: ownerSide };
    }
    // [2] 救済(179)：通常攻撃“以外”の破壊だけを無効化する。ＬＰダメージも無し
    if (!normal && ln.acc.salvation >= 1) {
      note(m, '救済：' + nameOf(m, unitId) + ' は破壊されない');
      return { ok: true, survived: 'salvation', unit: unitId, lp: 0, ownerSide: ownerSide };
    }

    // [3] 憑依の予約（封印(156)があると残せない）
    if (!o.suppress && normal && ln.acc.seal === 0 && o.curseTarget != null) {
      const cards = [];
      if (unitId >= 65 && unitId <= 74) cards.push(unitId + 26);       // カースID＝元ID+26
      for (let i = 0; i < ln.acc.curseChain; i++) cards.push(97);      // カース97の連鎖
      if (cards.length) m.pendingCurse = { cards: cards, target: o.curseTarget, ownerSide: ownerSide };
    }
    // [4] ＬＰダメージ
    if (!o.suppress) {
      damage(m, ownerSide, chDmg);
      if (chDmg) note(m, jp(ownerSide) + ' のＬＰ -' + chDmg + '（' + nameOf(m, unitId) + ' 破壊）');
    }
    // [5] ゾンビ帰還：スネイルリキッド(28)は持ち主の手札が5枚以下なら手札に戻る
    if (!o.magic && unitId === 28 && m.players[ownerSide].hand.length <= 5) {
      m.players[ownerSide].hand.push(28);
      note(m, nameOf(m, 28) + ' は手札に戻った');
    }
    // [6] 戦利品：フリーユニット戦で、敵陣のユニットを通常攻撃で倒したときだけ。
    //     傀儡で移されているユニット（puppeted）は取れない（原作 CE0170〜0172 の SW571 条件。
    //     ★M7.8 WP6：自分のユニットが敵陣に移されて自分で倒した場合も、敵のユニットが自陣に
    //     移されて敵に倒された場合も、どちらも戦利品にはならない）。noLoot は傀儡の移動失敗
    //     （移動先が満杯）による破壊で使う
    if (!o.magic && normal && side === 'enemy' && !ln.puppeted && !ln.swapped && !o.noLoot &&
        m.opponentId >= 101 && m.loot.length < LOOT_MAX) {
      m.loot.push(unitId);
      note(m, '戦利品：' + nameOf(m, unitId));
    }
    // [7] 除去。付いていたチャンネルは全て消滅する（手札にもデッキにも戻らない）
    const lost = ln.channels.map(function (ch) { return ch.card; });
    m.board.lanes[laneIndex] = S.emptyLane();
    recalc(m);
    Turn.checkResult(m);
    return { ok: true, unit: unitId, lp: o.suppress ? 0 : chDmg, ownerSide: ownerSide, lostChannels: lost };
  }

  /* ================= ⑦ 戦闘終了（原作 EV0152 page7） ================= */

  function endBattle(m, result) {
    const c = m.combat;
    const A = m.board.lanes[c.attacker];
    m.combat = null;
    recalc(m);

    if (A.unit != null) {
      A.stiff = true;                                     // 硬直するのは攻撃側だけ
      if (A.extraAttack) A.extraAttack = false;           // 連続攻撃の2回目を消費した
      else if (A.acc.petrify === 0 && A.acc.multiAtk >= 1) A.extraAttack = true;
    }
    applyPendingCurse(m);
    expireMagic(m);
    m.players[result.attackerSide || m.active].actedThisTurn = true;

    result.loot = m.loot.slice();
    m.lastBattle = result;
    m.phase = m.winner ? 'over' : 'main';
    Turn.checkResult(m);
    note(m, '戦闘終了');
    return { ok: true, result: result };
  }

  /** 憑依（カース）の付着。原作 CE0279。戦闘が完全に終わってから走る */
  function applyPendingCurse(m) {
    const pc = m.pendingCurse;
    m.pendingCurse = null;
    if (!pc) return;
    const ln = m.board.lanes[pc.target];
    if (!ln || ln.unit == null) return;
    pc.cards.forEach(function (cid) {
      recalc(m);
      if (!(ln.cap > ln.count)) return;                   // 空きが無ければ発動しない
      ln.channels.push({ card: cid, up: true, revealed: true, mine: pc.ownerSide === 'self', st: 'possess' });
      ln.count = ln.channels.length;
      note(m, '憑依：' + nameOf(m, cid) + ' が ' + nameOf(m, ln.unit) + ' に取り憑いた');
    });
    recalc(m);
  }

  /** 表向き魔法カードの消滅（原作 EV0049 魔法消去）。戦闘終了時とターン終了時に走る。
   *   ・爆殺(104)が飽和状態で開いていたら自爆（通常攻撃ではないので救済が効く）
   *   ・停滞(151)があるレーンの魔法は消えない
   *   ・放出(160)があるレーンは表向きの技能も一緒に消える */
  function expireMagic(m) {
    recalc(m);
    m.board.lanes.forEach(function (ln, i) {
      // M7.8 WP2：停滞(151)があるレーンは爆殺の自爆が止まる（原作 06_skill.md §4-1・EV0049 page1 冒頭
      // `if (S(301,L)==0 && SW[700+L] && …)`）。停滞自身は表向き魔法(101〜150)ではないので
      // この判定より後のクローズ処理でも消えない。
      if (ln.unit != null && ln.acc.swBomb && ln.cap === ln.count && !(ln.acc.stasis >= 1)) {
        note(m, '爆殺：' + nameOf(m, ln.unit) + ' が自爆');
        destroy(m, i, { normalAttack: false });
      }
    });
    recalc(m);
    m.board.lanes.forEach(function (ln) {
      if (ln.unit == null) return;
      if (ln.acc.stasis >= 1) return;                     // 停滞
      const release = ln.channels.some(function (ch) { return ch.up && ch.card === 160; });
      ln.channels = ln.channels.filter(function (ch) {
        if (!ch.up) return true;
        if (ch.card >= 101 && ch.card <= 150) return false;
        // 放出(160)：同レーンの表向き技能を魔法と一緒に消す。
        // ★M7.8 WP4：**放出自身は絶対に消えない**（原作 06_skill.md §4-10 の `card != 160`）。
        // 消えてしまうと1回使い切りになり、「相手が付けた技能を消し続ける」という
        // このカードの役目が果たせなかった。カース(91〜99)は151未満なので元から消えない
        if (release && ch.card >= 151 && ch.card !== 160) return false;
        return true;
      });
      ln.count = ln.channels.length;
    });
    recalc(m);
  }

  /* ================= デッキ攻撃（直接攻撃） ================= */

  /** 山札から1枚を破壊する（ドローと同じ抽選で1枚減らす。原作 CE0346）。
   * M5.5：山札が空なら先に再装填してから破壊する（「デッキからカードを取る操作の直前に
   * ensureDeck を通る」の統一ルール）。山札を空にしても敗北は発生しない */
  function destroyDeckCard(m, side) {
    const p = m.players[side];
    if (p.deckCount <= 0) turnApi2().ensureDeck(m, side);
    if (p.deckCount <= 0) return null;                 // 初期リストが空の異常系のみ
    for (;;) {
      for (let id = 1; id <= 200; id++) {
        const n = p.deck[id] || 0;
        if (n > 0 && m.rng.int(1, 50) <= n) {
          p.deck[id] = n - 1; p.deckCount -= 1;
          return id;
        }
      }
    }
  }
  /** ターン進行モジュール。循環参照を避けるため、呼ぶ瞬間に解決する（turn.js 側と同じ手法） */
  function turnApi2() {
    return (typeof require === 'function' && typeof window === 'undefined')
      ? require('./turn.js') : global.CQTurn;
  }

  /** デッキ攻撃の可否。攻撃対象にできる敵ユニットが0体のとき。跳躍(163)なら2体以下でも可 */
  function canDeckAttack(m, laneIndex) {
    const a = canAttack(m, laneIndex);
    if (!a.ok) return a;
    const foeSide = other(m.active);
    const foes = S.controlledLanesOf(m.board.lanes, foeSide).map(function (i) { return m.board.lanes[i]; });
    const targetable = foes.filter(function (l) { return l.acc.vapor === 0; }).length;
    if (m.board.lanes[laneIndex].acc.leap >= 1) {
      if (foes.length <= 2) return { ok: true, byLeap: true };
      return { ok: false, reason: '跳躍でも敵ユニットが3体居ると通れません' };
    }
    if (targetable > 0) return { ok: false, reason: '攻撃できる敵ユニットが居ます' };
    return { ok: true };
  }

  /** デッキ攻撃：相手ＬＰ -1 ＋ 相手の山札を1枚破壊 */
  function deckAttack(m, laneIndex) {
    const chk = canDeckAttack(m, laneIndex);
    if (!chk.ok) return chk;
    Turn.finalizeReverse(m, null);     // 別レーンでリバース継続中なら、攻撃を始めた時点で確定（硬直）
    const ln = m.board.lanes[laneIndex], foeSide = other(m.active);
    damage(m, foeSide, 1);
    if (ln.unit === 22) heal(m, m.active, 1);             // ビッグモスキート
    const lostCard = destroyDeckCard(m, foeSide);
    if (ln.acc.multiAtk >= 1) ln.extraAttack = !ln.extraAttack;
    ln.stiff = true;
    m.players[m.active].actedThisTurn = true;
    note(m, jp(m.active) + ' のデッキ攻撃：' + jp(foeSide) + ' のＬＰ -1、山札1枚破壊');
    recalc(m);
    const result = Turn.checkResult(m);
    if (result) m.phase = 'over';
    return { ok: true, lostCard: lostCard, result: result };
  }

  /* ================= 戦闘の途中終了（原作 EV0154） ================= */

  /** デッキ切れなどで戦闘を打ち切る。憑依は発動しない */
  function abortBattle(m) {
    if (!m.combat) return { ok: false };
    const c = m.combat, A = m.board.lanes[c.attacker];
    m.combat = null;
    m.pendingCurse = null;
    recalc(m);
    if (A.unit != null) {
      A.stiff = true;
      if (A.extraAttack) A.extraAttack = false;
      else if (A.acc.petrify === 0 && A.acc.multiAtk >= 1) A.extraAttack = true;
    }
    m.phase = m.winner ? 'over' : 'main';
    note(m, '戦闘が途中で終了した');
    return { ok: true };
  }

  const api = {
    enforcePost, holdSettle, releaseSettle, recalc,
    canAttack, canTarget, attackTargets, declareAttack,
    canOpenPhase, openableLayers, openerLane, openerSide, open, endOpen, onOpen, ritualCheck,
    destroy, expireMagic, applyPendingCurse,
    canDeckAttack, deckAttack, destroyDeckCard, abortBattle
  };
  global.CQCombat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
