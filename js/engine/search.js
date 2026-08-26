/* CardQuest エンジン — 探索方策（実装計画M5.7：決定化サンプリング＋先読み）
 *
 * 『CardQuest 実装計画 追補：M5.7』（2026-08-25 本人確定）の本実装。policy:'search'。
 * 透視率（原作§11.3の透過処理）は撤廃され、難易度の本体はこの方策の
 * 「サンプル数 N（samples）」と「読みの深さ D（depth）」になる。
 *
 * ■ 1手を選ぶ手順（追補§2）
 *   1. 候補手の列挙 … 現局面の合法手（召還／チャネリング／攻撃／デッキ攻撃／特殊行動／
 *      リバース／パス）。合法性の最終判定はエンジン任せ（summon() 等が却下する方式を踏襲）
 *   2. 世界の決定化 … 不明カード（相手の手札・裏向きＣＨ・相手の山札）に具体的なＩＤを
 *      割り当てた「あり得る世界」をサンプルする。母集団は全カードプールから
 *      この対局で公開済みのカードを差し引いたカウンティング分布（人間の上級者と同じ情報）。
 *      cfg.samplePool を渡すとその分布（エリアの敵プールなど）を使う
 *   3. 先読み評価 … 各世界のクローン上で候補手を適用し、いまの手番の残りを heuristic
 *      （M5の評価関数方策）で最後まで進め、さらに depth-1 手番ぶんロールアウトする。
 *      depth=1＝自分のこの手番の帰結まで／2＝相手の応手まで／3＝その次の自分の手番まで。
 *      末端局面はＬＰ差・盤面価値（能力値・ＣＨ枚数・素のＣＨ数）・手札差で採点する
 *   4. 集計 … 候補手ごとにＮ世界の平均スコアを取り最大の手を選ぶ。
 *      リーサル確定（全世界で適用直後に勝ち）は最優先
 *
 * ■ 時間予算（追補§3。ゲーム仕様書§4.4「ＡＩ思考は上限1秒」との整合）
 *   固定サンプル数ではなく budgetMs（既定600ms）内で回せるだけ回す。minSamples に
 *   届くまでは超過を許す。Web Worker化は保留（まず同期実装＋時間予算で出し、
 *   実機の体感を見てから移行してよい＝追補の段階導入方針）。
 *
 * ■ カンニングしない（恒久ガード）
 *   決定化は Ai.knownTo() を通った情報＝「自分が置いた」「表・公開済み」だけを残し、
 *   それ以外のカードＩＤは読まずに分布から引き直す。つまり未公開カードの実ＩＤは
 *   判断のどこにも入り込まない（tests/run.js のカンニング検出テストが監視する）。
 *   サンプリングは対局の m.rng とは別系統のＲＮＧ（worldRng）で行い、
 *   対局の再現性（同一シード＝同一進行）を守る。
 *
 * DOMには依存しない。Node単体で動く（Worker化する場合もそのまま載る設計）。
 */
'use strict';
(function (global) {

  const isNode = (typeof require === 'function' && typeof window === 'undefined');
  const S = isNode ? require('./state.js') : global.CQState;
  const Stats = isNode ? require('./stats.js') : global.CQStats;
  const Turn = isNode ? require('./turn.js') : global.CQTurn;
  const Combat = isNode ? require('./combat.js') : global.CQCombat;
  const CQRng = isNode ? require('./rng.js') : global.CQRng;
  /** ai.js は相互参照になるため、呼ぶ瞬間に解決する（turn.js の combatApi() と同じ流儀） */
  function Ai() { return isNode ? require('./ai.js') : global.CQAi; }

  const BLANK = 180;
  const WIN = 1000000;

  function now() { return Date.now(); }

  /* ================= 世界の決定化（追補§2-2） ================= */

  /** サンプリング用ＲＮＧ。対局の m.rng とは別系統（状態は読むだけで消費しない）。
   * 同じ局面・同じ決定回数なら同じ列になる＝テスト・リプレイで再現可能 */
  function worldRng(m) {
    m._searchTick = ((m._searchTick || 0) + 1) >>> 0;
    const seed = (m.rng.state() ^ Math.imul(m._searchTick, 0x9E3779B9)) >>> 0;
    return CQRng.create(seed);
  }

  /** カウンティング分布：全カードプール（各ＩＤ×2）から、side に見えているカード
   * （場のユニット・中身既知のＣＨ・自分の手札）を1枚ずつ差し引いた多重集合。
   * 「この対局で既に公開されたカードを除いた残り」の近似（破壊済みカードの追跡は
   * エンジンに墓地が無いため行わない＝盤面から消えた時点で分布に戻る。設計判断）。
   * cfg.samplePool があればそれを母集団にする（エリアの敵プールなど） */
  function countingPool(m, side, cfg) {
    let base = [];
    if (cfg && cfg.samplePool && cfg.samplePool.length) {
      base = cfg.samplePool.slice();
    } else {
      Object.keys(m.cards).forEach(function (k) {
        const c = m.cards[k];
        if (!c || c.id == null) return;
        if (c.t === 'U' || c.t === 'M' || c.t === 'S') base.push(c.id, c.id);
      });
    }
    const remove = [];
    m.board.lanes.forEach(function (ln) {
      if (ln.unit != null) remove.push(ln.unit);
      ln.channels.forEach(function (ch) { if (Ai().knownTo(ch, side)) remove.push(ch.card); });
    });
    m.players[side].hand.forEach(function (id) { remove.push(id); });
    remove.forEach(function (id) {
      const i = base.indexOf(id);
      if (i >= 0) base.splice(i, 1);
    });
    if (!base.length) base.push(BLANK);
    return base;
  }

  function drawPool(rng, pool) { return pool[rng.int(0, pool.length - 1)]; }

  /** マッチの軽量クローン。cards・hooks は共有し、盤面・プレイヤー・戦闘状態を複製する。
   * rng は呼び出し側が渡す（世界ごとの別系統）。ロールアウトは両陣営とも heuristic で代行 */
  function cloneMatch(src, rng) {
    return {
      cards: src.cards,
      rng: rng,
      board: JSON.parse(JSON.stringify(src.board)),
      players: JSON.parse(JSON.stringify(src.players)),
      active: src.active, turn: src.turn, phase: src.phase, winner: src.winner,
      opponentId: src.opponentId,
      combat: src.combat ? JSON.parse(JSON.stringify(src.combat)) : null,
      reversing: src.reversing,
      pendingCurse: src.pendingCurse ? JSON.parse(JSON.stringify(src.pendingCurse)) : null,
      loot: (src.loot || []).slice(),
      lastBattle: null,
      hooks: src.hooks,
      aiConfig: { self: Ai().PRESETS.heuristic, enemy: Ai().PRESETS.heuristic },
      log: []
    };
  }

  /** クローン c の不明カードを分布から引き直す（決定化）。side の知識だけを残す。
   * 相手の手札・山札も構成ごとサンプルし直す（相手のデッキリストは知らない前提） */
  function determinize(c, side, rng, pool) {
    const foe = S.otherSide(side);
    c.board.lanes.forEach(function (ln) {
      ln.channels.forEach(function (ch) {
        if (!Ai().knownTo(ch, side)) ch.card = drawPool(rng, pool);
      });
    });
    const fp = c.players[foe];
    fp.hand = fp.hand.map(function () { return drawPool(rng, pool); });
    const n = Math.max(0, fp.deckCount);
    const deck = {};
    for (let i = 0; i < n; i++) {
      const id = drawPool(rng, pool);
      deck[id] = (deck[id] || 0) + 1;
    }
    fp.deck = deck;
    fp.deckCount = n;
    // 再装填（M5.5）用の初期リストもサンプル世界のもので置き換える（実リストは知らない前提。
    // 空にすると山札切れ時の終了保証が壊れるため、最低限 山札＋手札 相当を入れておく）
    const flat = [];
    Object.keys(deck).forEach(function (id) { for (let k = 0; k < deck[id]; k++) flat.push(+id); });
    fp.initial = flat.concat(fp.hand);
    if (!fp.initial.length) fp.initial = [BLANK, BLANK];
    return c;
  }

  /** 決定化済みの世界を1つ作る（クローン＋決定化）。候補手の評価はこの世界の
   * さらにクローン上で行う（＝全候補が同じ世界を見る：対の比較で分散を抑える） */
  function makeWorld(m, side, rng, pool) {
    const world = cloneMatch(m, null);
    determinize(world, side, rng, pool);
    return world;
  }

  /* ================= 評価（末端局面の採点） ================= */

  /** side から見た局面スコア。決定化された世界の中では全カードが具体的なので、
   * 実際の能力値で採点してよい（世界自体が side の知識から抽選された仮説であり、
   * 未公開情報のカンニングにはならない） */
  function score(c, side) {
    const foe = S.otherSide(side);
    if (c.winner === side) return WIN - c.turn * 100;      // 速い勝ちほど良い
    if (c.winner === foe) return -WIN + c.turn * 100;      // 遅い負けほどまし
    Stats.recalc(c.board, { cards: c.cards });
    let s = (c.players[side].lp - c.players[foe].lp) * 1000;
    for (let i = 0; i < c.board.lanes.length; i++) {
      const ln = c.board.lanes[i];
      if (ln.unit == null) continue;
      const v = 120 + Math.max(-2000, ln.atk + ln.def) / 10 + ln.count * 40 + ln.baseCh * 15;
      s += (S.controlSide(ln, i) === side) ? v : -v;
    }
    s += (c.players[side].hand.length - c.players[foe].hand.length) * 15;
    return s;
  }

  /* ================= ロールアウト（heuristic 代行） ================= */

  /** いまの手番の残りを最後まで進める。深さが残っていればさらに手番を進める。
   * depth＝この呼び出しで消化する手番（半ターン）の総数（いまの手番を1と数える）。
   * onStage を渡すと、各手番の境界ごとに1回呼ぶ（多段階採点用。下記 STAGE_DECAY 参照） */
  function rollout(c, depth, onStage) {
    let guard = 0;
    while (!c.winner && guard++ < 60) {
      if (c.combat) { Ai().finishCombat(c); continue; }
      if (c.phase === 'discard') { if (!Ai().discardStep(c)) break; continue; }
      if (c.phase === 'placement') { Ai().playPlacement(c); Turn.endPlacement(c); continue; }
      if (c.phase === 'main') {
        if (!Ai().mainStep(c)) { Turn.endTurn(c); break; }
        if (c.combat) Ai().finishCombat(c);
        continue;
      }
      break;                                   // 'draw'（次の手番の境界）または 'over'
    }
    if (onStage) onStage();
    for (let d = 1; d < depth; d++) {
      if (!c.winner) halfTurn(c);
      if (onStage) onStage();                  // 決着後も呼ぶ＝早い勝ち/負けが後段にも効く
    }
  }

  /** 多段階採点の減衰率。深い手番の局面ほど（相手の手札をこちらが想像で
   * サンプルしている分）当てにならないので、重みを段ごとに半減させる。
   * 末端だけを採点すると「想像上の強い相手の応手」への悲観が支配して
   * 深い読みほど消極的になる逆転が起きる（較正 2026-08-25 で実測）ための対策 */
  const STAGE_DECAY = 0.5;

  /** 1手番（ドロー→配置→メイン→ターン終了）を heuristic で消化する */
  function halfTurn(c) {
    Turn.beginTurn(c);
    if (c.winner) return;
    let g = 0;
    while (c.phase === 'discard' && g++ < 20) Ai().discardStep(c);
    if (c.phase === 'placement') { Ai().playPlacement(c); Turn.endPlacement(c); }
    g = 0;
    while (c.phase === 'main' && g++ < 20) {
      if (!Ai().mainStep(c)) break;
      Ai().finishCombat(c);
    }
    if (c.phase === 'main') Turn.endTurn(c);
  }

  /* ================= 候補手の適用 ================= */

  /** 候補手をエンジンの公開ＡＰＩで適用する（実対局・クローンの両方で使う）。
   * 戦闘の続き（オープンフェイズ）はここでは進めない：実対局では呼び出し側（ＵＩ／
   * シミュレータ）が対話的に進め、クローンでは rollout() の finishCombat が引き受ける */
  function applyMove(c, cand) {
    switch (cand.type) {
      case 'summon': return Turn.summon(c, cand.lane, cand.hand).ok;
      case 'channel': return Turn.channel(c, cand.lane, cand.hand).ok;
      case 'attack': return Combat.declareAttack(c, cand.lane, cand.target).ok;
      case 'deck': { const r = Combat.deckAttack(c, cand.lane); return !r || r.ok !== false; }
      case 'special': return Turn.specialAction(c, cand.lane).ok;
      case 'reverse': return Turn.reverseAction(c, cand.lane, cand.layers).ok;
      case 'open': return Combat.open(c, cand.layer).ok;
      case 'end': { const r = Combat.endOpen(c); return !r || r.ok !== false; }
      case 'pass':
        // クローン上では「ここで手を止める」を実際に演じる（配置を終える／ターンを終える）。
        // これをしないと、ロールアウトの heuristic が残りの配置をやり直してしまい、
        // 「パス」が実際の手と区別できなくなる（実対局では呼び出し側が false を受けて処理する）
        if (cand.end === 'placement') { Turn.endPlacement(c); }
        else if (cand.end === 'main') { Turn.endTurn(c); }
        return true;
      default: return false;
    }
  }

  /* ================= 決定化サンプリング＋先読みの本体（追補§2〜§3） ================= */

  /** 候補手から1つ選ぶ。時間予算（budgetMs）内でＮ世界（samples）まで回し、
   * 平均スコア最大の手を返す。全世界で適用直後に勝つ手（リーサル確定）は最優先。
   * 計測値は m._searchStats に、選んだ手は m._lastChoice に残す（テスト・較正用） */
  function decide(m, side, cands) {
    const cfg = Ai().cfgFor(m, side);
    const stats = { samples: 0, ms: 0, cands: cands.length };
    m._searchStats = stats;
    if (!cands.length) { m._lastChoice = null; return null; }
    if (cands.length === 1) { m._lastChoice = cands[0]; return cands[0]; }

    const maxN = Math.max(1, cfg.samples || 10);
    const minN = Math.min(Math.max(1, cfg.minSamples || 2), maxN);
    const budget = cfg.budgetMs === undefined ? 600 : cfg.budgetMs;
    const depth = Math.max(1, cfg.depth || 1);
    const rng = worldRng(m);
    const pool = countingPool(m, side, cfg);
    const totals = new Array(cands.length).fill(0);
    const wins = new Array(cands.length).fill(0);
    const t0 = now();
    let n = 0;
    while (n < maxN) {
      if (n >= minN && now() - t0 >= budget) break;         // 時間予算の打ち切り（追補§3）
      const world = makeWorld(m, side, rng, pool);
      // 世界ごとに1つの乱数シードを全候補で共有する（common random numbers）。
      // 候補間の差を「行動の差」だけにして比較の分散を抑える（各候補で乱数まで
      // 変えると、深い読みほど乱数ノイズが候補間の差を覆い隠してしまう）
      const worldSeed = rng.int(0, 0x7fffffff);
      for (let k = 0; k < cands.length; k++) {
        const c = cloneMatch(world, CQRng.create(worldSeed));
        let s;
        try {
          const ok = applyMove(c, cands[k]);
          if (!ok) { s = -WIN * 2; }                        // 適用できない手は選ばない
          else {
            if (c.winner === side) wins[k] += 1;            // 適用直後の勝ち＝リーサル
            // 多段階採点：各手番境界のスコアを減衰付きで合成する（STAGE_DECAY 参照）
            let acc = 0, wsum = 0, w = 1;
            rollout(c, depth, function () { acc += w * score(c, side); wsum += w; w *= STAGE_DECAY; });
            s = acc / (wsum || 1);
          }
        } catch (e) { s = -WIN * 2; }                       // 例外を出す手も選ばない（保険）
        totals[k] += s;
      }
      n += 1;
    }
    stats.samples = n;
    stats.ms = now() - t0;

    // リーサル確定（全世界で適用直後に勝ち）は最優先（追補§2-4。ノイズの影響を受けない）
    let best = -1;
    for (let k = 0; k < cands.length; k++) {
      if (n > 0 && wins[k] === n) { best = k; break; }
    }
    if (best < 0) {
      // 決定ノイズ（cfg.noise：較正 2026-08-25 で追加した難易度ノブ）。
      // サンプル数・読み深度はＣ相当（N≈10・D1）で強さが飽和することが較正で判明したため、
      // 下位ランクは平均スコアに乱数を混ぜて「ときどき次善手を選ぶ弱さ」を作る。
      // 未公開情報は一切読まない（カンニングにはならない）。0＝最善のみ（ランクＡ）
      const noiseAmp = (cfg.noise || 0) * 800;
      let bestScore = -Infinity;
      for (let k = 0; k < cands.length; k++) {
        const v = totals[k] / Math.max(1, n) + (noiseAmp ? (rng.next() * 2 - 1) * noiseAmp : 0);
        if (v > bestScore) { bestScore = v; best = k; }
      }
    }
    m._lastChoice = cands[best];
    return cands[best];
  }

  /* ================= 候補手の列挙 ================= */

  /** 配置ステップの候補手。分岐爆発を抑えるため、チャネル先は
   * 「自陣の最適1レーン（召還Ｌｖ2以上は開けば召還が成功する階層に届くレーン優先）＋
   *   敵陣の空きのある先頭1レーン」に絞る（どちらに置く価値があるかは先読みが判定する） */
  function enumeratePlacement(m) {
    const side = m.active, cfg = Ai().cfgFor(m, side);
    Stats.recalc(m.board, { cards: m.cards });
    const p = m.players[side];
    const slots = Math.min(p.hand.length, cfg.handSlots || 7);
    const lanes = m.board.lanes;
    const ownLanes = S.lanesOf(side);
    const foeLanes = S.lanesOf(S.otherSide(side));
    const roomOf = function (i) {
      const ln = lanes[i];
      return ln.unit != null && ln.cap > ln.count && !(ln.acc && ln.acc.closedSkill >= 1);
    };
    const emptyOwn = ownLanes.filter(function (i) { return lanes[i].unit == null; })[0];
    const ownRoom = ownLanes.filter(roomOf);
    const foeRoom = foeLanes.filter(roomOf);
    const cands = [];
    const seen = {};
    for (let h = 0; h < slots; h++) {
      const id = p.hand[h];
      if (id == null || seen[id]) continue;
      seen[id] = 1;
      const card = m.cards[id];
      if (!card) continue;
      if (card.t === 'U' && emptyOwn !== undefined) {
        cands.push({ type: 'summon', lane: emptyOwn, hand: h, id: id });
      }
      if (ownRoom.length) {
        let best = ownRoom[0];
        if (card.t === 'U') {
          const lv = S.unitStats(card).lv;
          if (lv >= 2) {
            const fit = ownRoom.filter(function (i) { return lanes[i].count + 1 >= lv; });
            if (fit.length) best = fit[0];
          }
        }
        cands.push({ type: 'channel', lane: best, hand: h, id: id });
      }
      // 相手のユニットへのチャネル。ただし召還Ｌｖ2以上のユニットカードは、相手の場では
      // 生贄を用意できず必ず召還失敗＝捨てるのと同じなので候補にしない（v0.15.3）
      if (foeRoom.length && !(card.t === 'U' && S.unitStats(card).lv >= 2)) {
        cands.push({ type: 'channel', lane: foeRoom[0], hand: h, id: id });
      }
    }
    cands.push({ type: 'pass', end: 'placement' });
    return cands;
  }

  /** メインステップの候補手。フリーユニットの行動制限（noAttackTurns：最初の2手番は
   * 攻撃しない＝§11.4）はここで候補から外す（透視率撤廃後も維持する敵の個性） */
  function enumerateMain(m) {
    const side = m.active, cfg = Ai().cfgFor(m, side);
    Stats.recalc(m.board, { cards: m.cards });
    const mine = S.controlledLanesOf(m.board.lanes, side);
    const noAttack = (m.players[side].turnsTaken || 1) <= (cfg.noAttackTurns || 0);
    const cands = [];
    for (let k = 0; k < mine.length; k++) {
      const i = mine[k];
      if (!noAttack) {
        Combat.attackTargets(m, i).forEach(function (t) {
          cands.push({ type: 'attack', lane: i, target: t });
        });
        if (Combat.canDeckAttack(m, i).ok) cands.push({ type: 'deck', lane: i });
      }
      if (Turn.canSpecialAction(m, i).ok) cands.push({ type: 'special', lane: i });
      const layers = Ai().mainReverseLayers(m, side, i);
      if (layers.length) cands.push({ type: 'reverse', lane: i, layers: layers });
    }
    cands.push({ type: 'pass', end: 'main' });
    return cands;
  }

  /* ================= 公開ＡＰＩ（ai.js の policy:'search' から呼ばれる） ================= */

  /** 配置ステップの1手。何もしなければ false（呼び出し側が配置を終える） */
  function placementStep(m) {
    const side = m.active, cfg = Ai().cfgFor(m, side);
    Stats.recalc(m.board, { cards: m.cards });
    const p = m.players[side];
    // マリガン（§4.1。heuristic と同じ規則：召還できるユニットが無い初手は引き直す）
    if (cfg.mulligan) {
      const slots = Math.min(p.hand.length, cfg.handSlots || 7);
      const ownUnits = S.lanesOf(side).filter(function (i) { return m.board.lanes[i].unit != null; });
      if (ownUnits.length === 0) {
        const anySummonable = p.hand.slice(0, slots).some(function (id) {
          const c = m.cards[id];
          return c && c.t === 'U' && S.unitStats(c).lv <= 1;
        });
        if (!anySummonable && Turn.change(m).ok) return true;
      }
    }
    const choice = decide(m, side, enumeratePlacement(m));
    if (!choice || choice.type === 'pass') return false;
    return !!applyMove(m, choice);
  }

  /** メインステップの1手。何もしなければ false（呼び出し側がターンを終える） */
  function mainStep(m) {
    const side = m.active;
    const choice = decide(m, side, enumerateMain(m));
    if (!choice || choice.type === 'pass') return false;
    return !!applyMove(m, choice);
    // 攻撃を選んだ場合、以降のオープンフェイズは呼び出し側が openStep で進める（従来どおり）
  }

  /** 戦闘中のオープンフェイズの1手（開く階層を選ぶ／開かずに終える） */
  function openStep(m) {
    if (!m.combat) return false;
    const side = Combat.openerSide(m);
    const ln = m.board.lanes[Combat.openerLane(m)];
    let layers = Combat.openableLayers(m);
    if (!layers.length) { Combat.endOpen(m); return true; }
    // 戦闘中に「中身を知っている召還Ｌｖ2以上のユニットカード」を開くのは、生贄の儀式が
    // できないぶん確実に破壊されるだけの手（v0.15.3）。得が一切無いので候補から外す。
    // 中身を知らないカードは対象外＝カンニングにはならない（Ai().knownTo を通す）
    const safe = layers.filter(function (n) {
      const ch = ln && ln.channels[n - 1];
      if (!ch || !Ai().knownTo(ch, side)) return true;
      const card = m.cards[ch.card];
      return !(card && card.t === 'U' && S.unitStats(card).lv >= 2);
    });
    layers = safe;   // 全部が該当するなら「開かずに終える」だけが残る（開く得が無いので正しい）
    const cands = layers.map(function (n) { return { type: 'open', layer: n }; });
    cands.push({ type: 'end' });
    const choice = decide(m, side, cands);
    if (!choice || choice.type === 'end') { Combat.endOpen(m); return true; }
    if (Combat.open(m, choice.layer).ok) return true;
    Combat.endOpen(m);
    return true;
  }

  const api = { placementStep, mainStep, openStep,
                /* テスト・較正用に内部も公開する */
                decide, enumeratePlacement, enumerateMain, countingPool, determinize,
                makeWorld, cloneMatch, rollout, score, worldRng };
  global.CQSearch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
