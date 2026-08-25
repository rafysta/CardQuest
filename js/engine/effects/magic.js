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

  /* 戦闘中は発動しない（原作 CE0354 戦闘時無効。仕様書§8.4・§7.1・カード一覧の「戦闘中×」表記の合算） */
  const NO_COMBAT = { 107: 1, 108: 1, 109: 1, 119: 1, 124: 1, 131: 1, 132: 1, 139: 1, 140: 1, 141: 1, 144: 1, 147: 1 };
  /* 強制開放(108)・強制転回(109)で連鎖的に起動しない（原作 CE0355 強制発動時無効） */
  const NO_FORCED = { 108: 1, 109: 1, 140: 1, 144: 1 };
  /* 発動レベル（配置階層 ≧ 記載レベル。魔道書(186)が1枚につき-2＝ln.acc.tomeをそのまま引く）。
   * 141思念波はカード一覧に「レベル6」とあるが、原作はこの判定が機能していないバグなので
   * ここには含めない（h141 で理由付きで未実施） */
  const LEVEL_REQ = { 116: 4, 132: 5, 134: 3, 138: 3, 140: 4, 142: 3, 146: 3 };

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

  function h108(m, ctx) {                                     // 強制開放：ＣＨ全てを強制オープン（戦闘中×強制中×）
    let n = 0;
    m.board.lanes.forEach(function (ln) {
      if (ln.unit == null) return;
      ln.channels.forEach(function (ch) {
        if (ch.up || NO_FORCED[ch.card]) return;
        ch.up = true; ch.revealed = true; n += 1;
        // NOTE: 連鎖的な再オープン処理（新たに開いたカードの効果再発動）は無限ループ回避のため
        // 本実装では行わない（簡略化。CardQuest_開発メモ.md に既知の簡略化として記載）
      });
    });
    recalc(m);
    note(m, '強制開放：場の' + n + '枚を強制オープン');
  }

  function h109(m, ctx) {                                     // 強制転回：ＣＨ全てを強制リバース（戦闘中×強制中×）
    let n = 0;
    m.board.lanes.forEach(function (ln) {
      if (ln.unit == null) return;
      ln.channels.forEach(function (ch) {
        if (NO_FORCED[ch.card]) return;
        ch.up = !ch.up;
        if (ch.up) ch.revealed = true;
        n += 1;
      });
    });
    recalc(m);
    note(m, '強制転回：場の' + n + '枚を強制リバース');
  }

  function h110(m, ctx) {                                     // 閉門：自陣のＣＨ全てを同時にクローズ
    let n = 0;
    sideLanes(m, ctx.caster).forEach(function (i) {
      m.board.lanes[i].channels.forEach(function (ch) { if (ch.up) { ch.up = false; n += 1; } });
    });
    recalc(m);
    note(m, '閉門：自陣の' + n + '枚をクローズ');
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

  function h113(m, ctx) {                                     // 透視：ＣＨ2つの内容を確認
    const pool = allChannels(m, function (ch) { return !ch.up; });
    for (let k = 0; k < 2 && pool.length; k++) {
      const idx = m.rng.int(0, pool.length - 1);
      const t = pool.splice(idx, 1)[0];
      m.board.lanes[t.lane].channels[t.idx].revealed = true;
    }
    note(m, '透視：裏向きのＣＨの中身を確認した');
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
    const dest = pick(m, S.lanesOf(ctx.caster).filter(function (i) { return m.board.lanes[i].unit == null; }));
    if (dest == null) { note(m, '招来：召還先が無い'); return; }
    const taken = dropChannelAt(m, t.lane, t.idx);
    m.board.lanes[dest] = S.makeLane(taken.card, [], m.cards);   // 召還されたユニットは硬直しない
    recalc(m);
    note(m, '招来：' + nameOf(m, taken.card) + ' を召還');
  }

  function h122(m, ctx) {                                     // 予見：山札から5枚引き任意の順番で戻す
    // 本エンジンの山札は「カードIDごとの残枚数」の無順序テーブル（実装計画・カードバトル仕様書§2.3）
    // のため、「見て並べ替える」という効果は表現できる状態を持たない。安全な no-op として実装する
    note(m, '予見：山札の中身を確認した（このエンジンでは山札が無順序のため並べ替えの効果は無い）');
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

  function h133(m, ctx) {                                     // 呪爆：このカードをオープンさせたユニットを破壊
    const ln = m.board.lanes[ctx.laneIndex];
    const name = ln && ln.unit != null ? nameOf(m, ln.unit) : null;
    combatApi().destroy(m, ctx.laneIndex, { normalAttack: false });
    if (name) note(m, '呪爆：' + name + ' が破壊された');
    return { consumed: true };
  }

  function h134(m, ctx) {                                     // 呪念：オープンさせたマスターのＬＰ5点破壊（レベル3）
    damage(m, ctx.opener, 5);
    note(m, '呪念：' + jp(ctx.opener) + ' のＬＰ -5');
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

  function h137(m, ctx) {                                     // 潜行爆弾：敵デッキに攻撃力600の爆弾を仕込む
    // 05_magic.md が無く、原作の「戦闘中はほぼ不発」バグの原因（カーソル変数の参照ずれ）も
    // 本エンジンには存在しないため再現できない。簡略化した推測実装：敵の山札を即座に1枚破壊する
    // （CardQuest_開発メモ.md に要見直し事項として記載）
    const enemy = other(ctx.caster);
    const lost = combatApi().destroyDeckCard(m, enemy);
    note(m, '潜行爆弾：（簡略実装）' + jp(enemy) + ' の山札を1枚破壊' + (lost == null ? '（山札切れ）' : ''));
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

  function h140(m, ctx) {                                     // 時の渦：ドローステップへ戻る（レベル4／戦闘中×強制中×）
    // 「ドローステップへ戻る」をフェイズ遷移として厳密に再現すると m.phase の不変条件が崩れやすいため、
    // 簡略化：手番側がもう1枚ドローする（実質的にターン中の追加ドローとして再現）
    const id = turnApi().draw(m.rng, m.players[m.active], m);
    capHand(m, m.active);
    note(m, '時の渦：（簡略実装）' + jp(m.active) + ' がもう1枚ドロー' + (id == null ? '（山札なし）' : ''));
  }

  /* ================= 141〜148 ================= */

  function h141(m, ctx) {                                     // 思念波：攻撃力1000の特殊攻撃（レベル6／戦闘中×）
    // 原作バグ（仕様書§8.4・§14.1）：①レベル6制限が機能していない ②対象存在判定が
    // 防御力551〜1000のユニットしか対象と認識しない（＝それ以外しか居ないと不発）。
    // 両方をそのまま再現する（レベルチェックを行わない／対象を551〜1000の範囲に限定する）
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

  function h146(m, ctx) {                                     // 口寄せ：何度でもドローし1枚を入手できる（レベル3）
    // 無順序デッキのための簡略実装：山札に実在する最小IDのカードを1枚探して直接手札に加える
    // （「引き続けて欲しい1枚を得る」の結果だけを再現する）
    const p = m.players[ctx.caster];
    for (let id = 1; id <= 199; id++) {
      if ((p.deck[id] || 0) > 0) {
        p.deck[id] -= 1; p.deckCount -= 1; p.hand.push(id);
        capHand(m, ctx.caster);
        note(m, '口寄せ：（簡略実装）' + nameOf(m, id) + ' を入手');
        return;
      }
    }
    note(m, '口寄せ：山札が空だった');
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
    if (!levelOk(m, laneIndex, layer, cardId)) {
      note(m, nameOf(m, cardId) + '：発動レベルが不足しており発動しない');
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
      const r = handler(m, { laneIndex: laneIndex, layer: layer, cardId: cardId, opener: opener, caster: caster, choice: o.choice }) || {};
      if (r.consumed) consumed = true;
      if (Turn.checkResult(m)) break;
      if (consumed) break;
    }
    return { consumed: consumed };
  }

  const api = { onMagicOpen, LEVEL_REQ, NO_COMBAT, NO_FORCED };
  global.CQMagic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
