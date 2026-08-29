/* CardQuest エンジン — 敵ＡＩ（実装計画M5／M5.7）
 *
 * 3つの方策を m.aiConfig[side].policy で切り替える（未設定＝ランダム方策のまま、
 * 既存のテスト・シミュレータは無改修で従来どおり動く）：
 *   'random' … M2〜M4のランダム方策（開発・ファズ用）
 *   'eval'   … M5で移植した §11.2 の評価関数方策（'heuristic' プリセット。比較較正・
 *              先読みのロールアウト代行用に温存）
 *   'search' … M5.7の本方策（決定化サンプリング＋先読み。js/engine/search.js）
 *
 * ■ §11.2 の中核（'eval' で忠実に再現した部分。'search' も評価の部品として流用する）
 *   ・すべての判断の入力は「仮想能力値」＝そのユニットの全ＣＨを表にした場合の攻撃力／
 *     裏にした場合の防御力（原作 EV0245／CE0285〜290）
 *   ・召還するか … スコア（基礎 rand 20〜60）≧ 30 で召還
 *   ・チャネリングするか … スコア（低いほど置く）≦ 75 で配置
 *   ・攻撃するか … rand(0..300) ＋ 序盤ペナルティ(最大+1000) と
 *     「仮想攻撃力 − 相手仮想防御力」を比べ、後者が大きければ攻撃
 *   ・「やけくそ」モード … 独立モードではなくルーチン切替。
 *     ①傀儡を受けた ②全ＣＨを裏にしても攻撃を止められない ③この1体でリーサル、で発動
 *
 * ■ 情報モデル（M5.7で透視率を撤廃。2026-08-25 本人確定）
 *   ・ＡＩが中身を知れるのは「自分が置いたカード」「公開済み（表・revealed）」だけ＝
 *     人間と完全対称（§11.3の原則だけを残す）。不明カードは『空白』(180) とみなして
 *     仮想能力値を計算する（＝枚数だけ数えて賭ける）
 *   ・原作§11.3の透過処理（相手の裏向きカードの中身が確率で漏れる：フリー19.6%〜Ａ36%）と
 *     例外2（魔力の盾等の周期検知）・例外3（手札を読むバグ）は再実装しない。
 *     難易度の本体は search 方策のサンプル数と読みの深さ（『実装計画追補 M5.7』参照）
 *
 * ■ 08_ai.md（詳細1,367行）が手元に無いための近似（要確認事項。開発メモ参照）
 *   ・配置13段階・メイン10段階の判断ブロックの内訳は不明のため、§11.2の閾値だけを
 *     使った簡略な手順にしてある（スコアへの加点条件・序盤ペナルティの減衰カーブ・
 *     戦闘中オープンの専用ルーチン・魔法対象の「重要度」走査は本実装の設計判断）
 *   ・魔法の発動対象は引き続き効果ハンドラ内の m.rng 自動選択（M4の設計のまま）
 *   ・追い詰められたときの「召還レベル改竄チート」は未実装
 *
 * すべての関数は「1回の呼び出し＝1手だけ進める」形（途中でプレイヤー入力が要るとき
 * 呼び出し側が止められる）。乱数は必ず m.rng を通す（再現性のため）。DOMには依存しない。
 */
'use strict';
(function (global) {

  const isNode = (typeof require === 'function' && typeof window === 'undefined');
  const S = isNode ? require('./state.js') : global.CQState;
  const Stats = isNode ? require('./stats.js') : global.CQStats;
  const Turn = isNode ? require('./turn.js') : global.CQTurn;
  const Combat = isNode ? require('./combat.js') : global.CQCombat;
  const Magic = isNode ? require('./effects/magic.js') : global.CQMagic;
  const Field = isNode ? require('./fieldrules.js') : global.CQField;

  const BLANK = 180;

  /* ================= 難易度プリセット（M5.7：透視率撤廃・2026-08-25 本人確定） =================
   * 強さの差は search 方策の「サンプル数 N（samples）」と「決定ノイズ（noise）」で作る。
   *   較正の結果（開発メモ参照）：読み深度（depth）は2以上にすると想像上の相手への悲観で
   *   かえって弱くなり、サンプル数もＮ≈10で強さが飽和した。そこで上位＝最善のみ・
   *   下位ほどノイズで次善手が混ざる、という段差に設計し直した（追補§4の数値からの変更。
   *   noise はスコアに混ぜる乱数の振幅で、未公開情報は読まない＝カンニングではない）。
   * depth＝先読みする手番（半ターン）の数。全ランク1（自分のこの手番の帰結まで）。
   * budgetMs は1手の思考時間予算（ゲーム仕様書§4.4「上限1秒」との整合。search.js 参照）。
   * フリーユニットの弱体化（§11.4）：マリガン無し・最初の2手番は攻撃しない。
   * 手札スロット7は全難易度で使わない（原作のＡＩは全ループが1〜6まで＝実質6枚運用）。
   * 'heuristic'＝M5の評価関数方策そのもの（比較較正・ロールアウト代行用に温存。ＵＩには出さない） */
  const PRESETS = {
    random: { policy: 'random', label: 'ランダム' },
    heuristic: { policy: 'eval', noAttackTurns: 0, mulligan: true, handSlots: 6, label: '旧Ｃ' },
    free: { policy: 'search', samples: 5, depth: 1, noise: 0.6, budgetMs: 600, minSamples: 2,
            noAttackTurns: 2, mulligan: false, handSlots: 6, label: 'フリー' },
    rankC: { policy: 'search', samples: 8, depth: 1, noise: 0.6, budgetMs: 600, minSamples: 3,
             noAttackTurns: 0, mulligan: true, handSlots: 6, label: 'Ｃ' },
    rankB: { policy: 'search', samples: 16, depth: 1, noise: 0.25, budgetMs: 600, minSamples: 3,
             noAttackTurns: 0, mulligan: true, handSlots: 6, label: 'Ｂ' },
    rankA: { policy: 'search', samples: 30, depth: 1, noise: 0, budgetMs: 600, minSamples: 4,
             noAttackTurns: 0, mulligan: true, handSlots: 6, label: 'Ａ' }
  };
  function cfgFor(m, side) {
    return (m.aiConfig && m.aiConfig[side]) || PRESETS.random;
  }

  /* ================= 情報モデル（§11.3の原則のみ。透視率はM5.7で撤廃） ================= */

  function placedBy(ch) { return ch.mine ? 'self' : 'enemy'; }
  /** side がそのチャンネルの中身を知っているか（表・公開済み・自分が置いた）＝人間と完全対称。
   * ＡＩの判断はこの関数を通った情報にしか依存してはならない（カンニング禁止。
   * tests/run.js のカンニング検出ガードが恒久的に監視する） */
  function knownTo(ch, side) {
    return !!(ch.up || ch.revealed || placedBy(ch) === side);
  }

  function cloneBoard(b) { return JSON.parse(JSON.stringify(b)); }
  /** side の視点の盤面：中身を知らないカードは『空白』(180) とみなす（＝±100の枚数としてだけ数える） */
  function believedBoard(m, side) {
    const b = cloneBoard(m.board);
    b.lanes.forEach(function (ln) {
      ln.channels.forEach(function (ch) { if (!knownTo(ch, side)) ch.card = BLANK; });
    });
    return b;
  }

  /* ================= 仮想能力値（§11.2 の入力。原作 EV0245） ================= */

  /** 戦闘中に side が実際に開く気になるカードか（自レーン用）。
   * 中身を知らないカード（＝相手の仕込み）・潜行ユニット（開いても攻撃力にならない）・
   * 開くと害のあるカードは開かない。仮想攻撃力もこの基準で数える（判断と実行を一致させる） */
  function wouldOpenInCombat(m, side, ch) {
    if (!knownTo(ch, side)) return false;
    if (isUnit(ch.card) || (ch.card >= 91 && ch.card <= 99)) return false;
    if (OPEN_BAD_MAGIC[ch.card] || OPEN_BAD_SKILL[ch.card]) return false;
    return true;
  }

  /** そのレーンの仮想能力値を、side の知識の範囲で（不明カード＝空白として）
   * 本物の能力値計算で求める。
   *   atk … 自分の操作レーンなら「戦闘中に実際に開く気になるカードだけを表にした」攻撃力
   *          （＝実現できる値）。相手のレーンなら「全部表にした」攻撃力（最悪ケース）。
   *   def … 「閉じられるものを全部裏にした」防御力。カース(91〜99)は実際に
   *          クローズできないため表のままにする */
  function virtualStats(m, side, laneIndex) {
    const ln = m.board.lanes[laneIndex];
    if (!ln || ln.unit == null) return { atk: 0, def: 0 };
    const controlled = S.controlSide(ln, laneIndex) === side;
    const base = believedBoard(m, side);
    const open = cloneBoard(base);
    open.lanes[laneIndex].channels.forEach(function (ch, j) {
      if (ch.up) return;
      if (!controlled) { ch.up = true; return; }
      if (wouldOpenInCombat(m, side, m.board.lanes[laneIndex].channels[j])) ch.up = true;
    });
    Stats.recalc(open, { cards: m.cards });
    base.lanes[laneIndex].channels.forEach(function (ch) {
      if (!(ch.card >= 91 && ch.card <= 99)) ch.up = false;
    });
    Stats.recalc(base, { cards: m.cards });
    return { atk: open.lanes[laneIndex].atk, def: base.lanes[laneIndex].def };
  }

  /* ================= カード分類（本実装の設計判断。08_ai.md 未入手のため近似） ================= */

  /* 自分のレーンで開くと持ち主に害がある（開かない）：
   * 104爆殺(飽和で自爆)・110閉門(自陣を閉じる)・120抑制・123発症(ＬＰ喪失)・
   * 133呪爆(ホスト破壊)・134呪念(開けた側ＬＰ-5)・148妄執(自爆) */
  const OPEN_BAD_MAGIC = { 104: 1, 110: 1, 120: 1, 123: 1, 133: 1, 134: 1, 148: 1 };
  /* 開くと持ち主に害がある技能（開かない。開いていたら閉じにいく）：
   * 155疫障・159固定・167腐食・168石化・169傀儡・184閉鎖・196黒の邪霊陣 */
  const OPEN_BAD_SKILL = { 155: 1, 159: 1, 167: 1, 168: 1, 169: 1, 184: 1, 196: 1 };
  /* メインステップで自発的に開いて得をする魔法（発動レベルは別途チェック） */
  const MAIN_GOOD_MAGIC = { 101: 1, 103: 1, 106: 1, 111: 1, 112: 1, 113: 1, 114: 1, 116: 1,
    117: 1, 129: 1, 135: 1, 136: 1, 141: 1, 143: 1, 145: 1, 146: 1 };
  /* 戦闘中（攻撃側）に開いて得をする魔法 */
  const COMBAT_GOOD_MAGIC = { 101: 1, 106: 1, 117: 1, 135: 1, 143: 1 };
  /* 防御側が死に際に開く価値のある技能（迎撃・反射・不死） */
  const DEFENSE_SKILL = { 171: 1, 172: 1, 177: 1 };
  /* メインステップで開く価値のある常時系技能（膨張・魔道書・無効・霊陣・白・光臨） */
  const UTIL_SKILL = { 158: 1, 186: 1, 190: 1, 193: 1, 194: 1, 195: 1, 199: 1 };
  /* 相手のユニットに仕込む「罠」カード（呪爆・呪念・疫障・腐食・石化・発症） */
  const TRAP_CARDS = { 133: 1, 134: 1, 155: 1, 167: 1, 168: 1, 123: 1 };

  function isUnit(id) { return id >= 1 && id <= 73; }
  function isMagic(id) { return id >= 101 && id <= 150; }
  function isSkill(id) { return id >= 151 && id <= 199 && id !== BLANK; }

  /** 魔法の発動レベルを満たすか（magic.js の LEVEL_REQ ＋魔道書の軽減をそのまま使う） */
  function magicLevelOk(m, laneIndex, layer, cardId) {
    const req = Magic.LEVEL_REQ[cardId];
    if (req == null) return true;
    const ln = m.board.lanes[laneIndex];
    return layer >= req - (ln.acc ? ln.acc.tome : 0);
  }

  /** 潜行ユニットをこの階層で開くとリバース召還が成功するか（side の場に出るものだけ）。
   * v0.15.3：召還Ｌｖ2以上は「生贄の儀式」（メインステップ・自分が操作するホスト・救済なし・
   * 置き場所あり）が要る。combat.js の ritualCheck と同じ条件をここでも見ておかないと、
   * ＡＩが成立しない召還を選んで切り札を自滅させる（逆に条件を厳しくしすぎると使わなくなる） */
  function reverseSummonable(m, side, laneIndex, layer, ch) {
    if (!isUnit(ch.card)) return false;
    if (placedBy(ch) !== side) return false;              // 相手のユニットを出してやる義理はない
    const ln = m.board.lanes[laneIndex];
    const printedLv = S.unitStats(m.cards[ch.card]).lv;
    if (layer < printedLv - (ln.acc ? ln.acc.tome : 0)) return false;
    // M6 戦場ルール：ふさがれたレーン（laneLock）は召還先として数えない。
    // 素のＣＨ数が上限を超えるユニット（noHighCH）はそもそも場に出られない
    if (!Field.summonAllowed(m, ch.card).ok) return false;
    const hasRoom = function () { return Field.freeLanesOf(m, side).length > 0; };
    if (printedLv < 2) return hasRoom();                  // 従来どおり
    if (m.combat) return false;                           // 戦闘中は儀式ができない
    if (S.controlSide(ln, laneIndex) !== side) return false;          // 生贄にできるユニットが無い
    if (ln.acc && ln.acc.salvation >= 1) return false;                // 救済に守られている
    return S.sideOf(laneIndex) === side ? true : hasRoom();           // ふつうはホストの跡地に立つ
  }

  /* ================= やけくそモード（§11.2） ================= */

  /** ①傀儡を受けた ②全ＣＨを裏にしても相手の攻撃を止められない ③この1体でリーサル */
  function isDesperate(m, side, vstat) {
    const foe = S.otherSide(side);
    // ① 物理的には自陣なのに操作権を奪われているレーンがある
    const phys = S.lanesOf(side);
    for (let k = 0; k < phys.length; k++) {
      const ln = m.board.lanes[phys[k]];
      if (ln.unit != null && S.controlSide(ln, phys[k]) !== side) return true;
    }
    const mine = S.controlledLanesOf(m.board.lanes, side);
    const theirs = S.controlledLanesOf(m.board.lanes, foe);
    // ③ この1体でリーサル：ＣＨ数 ≧ 相手ＬＰ のユニットを倒せる見込みがある
    const foeLp = m.players[foe].lp;
    for (let a = 0; a < mine.length; a++) {
      for (let d = 0; d < theirs.length; d++) {
        if (m.board.lanes[theirs[d]].baseCh >= foeLp &&
            vstat(mine[a]).atk >= vstat(theirs[d]).def) return true;
      }
    }
    // ② どう裏を向けても止まらない：敵の最強仮想攻撃力が自軍全ユニットの仮想防御力を上回る
    if (mine.length && theirs.length) {
      let maxAtk = -Infinity;
      theirs.forEach(function (i) { const a = vstat(i).atk; if (a > maxAtk) maxAtk = a; });
      const allDie = mine.every(function (i) { return vstat(i).def < maxAtk; });
      if (allDie) return true;
    }
    return false;
  }

  /* ================= ランダム方策（従来のM2〜M4実装そのまま。ファズ・開発用） ================= */

  function randomDiscard(m) {
    const p = m.players[m.active];
    if (!p.hand.length) return false;
    return Turn.discardCard(m, m.rng.int(0, p.hand.length - 1)).ok;
  }

  function randomPlacement(m) {
    const p = m.players[m.active];
    const own = S.lanesOf(m.active);
    /* M6.6 WP6：召還が封じられている側（フリーユニット戦の敵）は召還を試さない。
     * エンジン側でも summon() が弾くが、ここで見ておかないと配置ステップの1手を無駄に使う。 */
    const empty = Turn.canSummonSide(m, m.active) ? Field.freeLanesOf(m, m.active)[0] : undefined;
    if (empty !== undefined) {
      const idx = p.hand.findIndex(function (id) {
        const c = m.cards[id];
        return c && c.t === 'U' && S.unitStats(c).lv <= 1;
      });
      if (idx >= 0 && Turn.summon(m, empty, idx).ok) return true;
    }
    if (!p.hand.length || m.rng.next() < 0.4) return false;
    const foe = S.lanesOf(m.active === 'self' ? 'enemy' : 'self');
    const pool = (m.rng.next() < 0.2 ? foe : own)
      .filter(function (i) { return m.board.lanes[i].unit != null; });
    if (!pool.length) return false;
    const target = pool[m.rng.int(0, pool.length - 1)];
    const lane = m.board.lanes[target];
    const opts = lane.count >= lane.cap && lane.channels.length
      ? { layer: m.rng.int(1, lane.channels.length) } : undefined;
    return Turn.channel(m, target, m.rng.int(0, p.hand.length - 1), opts).ok;
  }

  function randomMain(m) {
    const own = S.lanesOf(m.active);
    for (let k = 0; k < own.length; k++) {
      const i = own[k];
      if (m.board.lanes[i].unit == null) continue;
      const targets = Combat.attackTargets(m, i);
      if (targets.length) {
        Combat.declareAttack(m, i, targets[m.rng.int(0, targets.length - 1)]);
        return true;
      }
      if (Combat.canDeckAttack(m, i).ok) { Combat.deckAttack(m, i); return true; }
      if (Turn.canSpecialAction(m, i).ok && m.rng.next() < 0.5) {
        if (Turn.specialAction(m, i).ok) return true;
      }
      const lane = m.board.lanes[i];
      if (!lane.stiff && lane.reversePtr < lane.channels.length) {
        if (Turn.reverseAction(m, i, [lane.reversePtr + 1]).ok) return true;
      }
      if (Turn.canSpecialAction(m, i).ok) {
        if (Turn.specialAction(m, i).ok) return true;
      }
    }
    return false;
  }

  function randomOpen(m) {
    if (!m.combat) return false;
    const layers = Combat.openableLayers(m);
    if (layers.length && m.rng.next() < 0.5) {
      return Combat.open(m, layers[m.rng.int(0, layers.length - 1)]).ok;
    }
    Combat.endOpen(m);
    return true;
  }

  /* ================= 評価関数方策：捨て札・配置ステップ ================= */

  function evalDiscard(m) {
    const p = m.players[m.active];
    if (!p.hand.length) return false;
    // おじゃま虫（M6 戦場ルール）＞『空白』(180) ＞ 末尾（＝原作のＡＩが使えない手札スロット7）の順に捨てる
    let idx = p.hand.findIndex(function (id) { return Field.isPest(id); });
    if (idx < 0) idx = p.hand.indexOf(BLANK);
    if (idx < 0) idx = p.hand.length - 1;
    return Turn.discardCard(m, idx).ok;
  }

  /** 配置ステップの1手（マリガン → 召還 → チャネリング の順）。何もしなければ false */
  function evalPlacement(m) {
    const side = m.active, cfg = cfgFor(m, side);
    Stats.recalc(m.board, { cards: m.cards });
    const p = m.players[side];
    const slots = Math.min(p.hand.length, cfg.handSlots || 7);
    const ownLanes = S.lanesOf(side);
    const ownUnits = ownLanes.filter(function (i) { return m.board.lanes[i].unit != null; });
    const foeSide = S.otherSide(side);
    const foeUnits = S.lanesOf(foeSide).filter(function (i) { return m.board.lanes[i].unit != null; });

    // --- 0. おじゃま虫（M6 戦場ルール）を捨てる ---
    // 置くことも召還することもできない純ペナルティなので、捨てられるなら迷う余地が無い。
    // 1ターン1枚・行動済み扱いというコストはエンジン側が見ている
    const pestIdx = p.hand.findIndex(function (id) { return Field.isPest(id); });
    if (pestIdx >= 0 && Turn.discardPest(m, pestIdx).ok) return true;

    /* M6.6 WP6：フリーユニット戦の敵は召還できない。マリガン（召還できる札を探す引き直し）も
     * 召還そのものも意味が無いので、まとめて飛ばす。 */
    const canSummon = Turn.canSummonSide(m, side);

    // --- 1. マリガン（§4.1：敵ＡＩも同等のマリガンを持つ。フリーユニットは無し） ---
    if (canSummon && cfg.mulligan && ownUnits.length === 0) {
      const anySummonable = p.hand.slice(0, slots).some(function (id) {
        const c = m.cards[id];
        return c && c.t === 'U' && S.unitStats(c).lv <= 1;
      });
      if (!anySummonable && Turn.change(m).ok) return true;
    }

    // --- 2. 召還（§11.2：スコア基礎 rand 20〜60、閾値 ≧30） ---
    const empty = canSummon ? Field.freeLanesOf(m, side)[0] : undefined;
    if (empty !== undefined) {
      let score = m.rng.int(20, 60);
      if (ownUnits.length === 0) score += 999;          // 場が空なら必ず出す（近似）
      else score += (3 - ownUnits.length) * 8;          // 空きが多いほど出したい（近似）
      if (ownUnits.length < foeUnits.length) score += 10;   // 数で負けていれば出したい（近似）
      if (score >= 30) {
        // 素の攻防合計が高い順に試す（召還レベル不足＝光臨の有無などはエンジンの検証に任せ、
        // 却下されたら次の候補へ。最初に通ったものを出す）
        const cands = [];
        for (let h = 0; h < slots; h++) {
          const c = m.cards[p.hand[h]];
          if (!c || c.t !== 'U') continue;
          const st = S.unitStats(c);
          cands.push({ h: h, val: st.a + st.d });
        }
        cands.sort(function (a, b) { return b.val - a.val; });
        for (let k = 0; k < cands.length; k++) {
          if (Turn.summon(m, empty, cands[k].h).ok) return true;
        }
      }
    }

    // --- 3. チャネリング（§11.2：スコアが低いほど置く、閾値 ≦75） ---
    if (m.rng.int(0, 100) <= 75 && p.hand.length) {
      const roomOf = function (i) { const ln = m.board.lanes[i]; return ln.unit != null && ln.cap > ln.count; };
      const ownRoom = ownLanes.filter(roomOf);
      const foeRoom = S.lanesOf(foeSide).filter(roomOf);
      // (a) 罠カードは相手のユニットに仕込む
      for (let h = 0; h < slots; h++) {
        if (TRAP_CARDS[p.hand[h]] && foeRoom.length) {
          const t = foeRoom[m.rng.int(0, foeRoom.length - 1)];
          if (Turn.channel(m, t, h).ok) return true;
        }
      }
      if (ownRoom.length) {
        // (b) 召還レベル2以上のユニットは、開けば召還が成功する階層（count+1 ≧ lv）に潜らせる
        for (let h = 0; h < slots; h++) {
          const c = m.cards[p.hand[h]];
          if (!c || c.t !== 'U') continue;
          const lv = S.unitStats(c).lv;
          if (lv < 2) continue;
          const fit = ownRoom.filter(function (i) { return m.board.lanes[i].count + 1 >= lv; });
          if (fit.length && Turn.channel(m, fit[m.rng.int(0, fit.length - 1)], h).ok) return true;
        }
        // (c) それ以外（技能・魔法・空白・下級ユニット）は自陣の空きに置く（＋100の枚数価値）
        for (let h = 0; h < slots; h++) {
          const id = p.hand[h];
          if (TRAP_CARDS[id]) continue;                  // 罠を自陣に置かない
          if (OPEN_BAD_SKILL[id] || OPEN_BAD_MAGIC[id]) continue;
          const t = ownRoom[m.rng.int(0, ownRoom.length - 1)];
          if (Turn.channel(m, t, h).ok) return true;
        }
      }
    }
    return false;
  }

  /* ================= 評価関数方策：メインステップ（§11.2） ================= */

  /** 序盤ペナルティ（最大+1000）。ターン数（原作 V335＝両者の手番で+1）で減衰させる
   * （減衰カーブは近似。自分の2巡目＝通算3ターン目あたりでほぼ消える） */
  function earlyPenalty(m) {
    const pen = 1000 - 300 * (m.turn - 1);
    return pen > 0 ? pen : 0;
  }

  /** メインステップでこのレーンに対して行う価値のあるリバース（開閉）階層の一覧（昇順） */
  function mainReverseLayers(m, side, laneIndex) {
    const ln = m.board.lanes[laneIndex];
    if (ln.stiff || (ln.acc && ln.acc.lock >= 1)) return [];
    const res = [];
    for (let n = ln.reversePtr + 1; n <= ln.channels.length; n++) {
      const ch = ln.channels[n - 1];
      if (ch.up) {
        // 開いている有害な技能は閉じる（腐食は封印が無いと閉じられない）
        if (OPEN_BAD_SKILL[ch.card] && ch.card >= 151 &&
            !(ch.card === 167 && (!ln.acc || ln.acc.seal === 0))) res.push(n);
        continue;
      }
      if (!knownTo(ch, side)) continue;                  // 不明カード（＝相手の仕込み）は開けない
      if (isUnit(ch.card)) {
        if (reverseSummonable(m, side, laneIndex, n, ch)) res.push(n);
      } else if (isMagic(ch.card)) {
        if (MAIN_GOOD_MAGIC[ch.card] && !OPEN_BAD_MAGIC[ch.card] &&
            magicLevelOk(m, laneIndex, n, ch.card)) res.push(n);
      } else if (isSkill(ch.card)) {
        if (UTIL_SKILL[ch.card]) res.push(n);
      }
    }
    return res;
  }

  /** Ｃ型特殊行動を使う価値があるか（カードごとの簡易判断。近似） */
  function specialWorth(m, side, laneIndex) {
    const id = m.board.lanes[laneIndex].unit;
    const foe = S.otherSide(side);
    const foeLanes = S.controlledLanesOf(m.board.lanes, foe);
    const foeRoom = foeLanes.filter(function (i) { const ln = m.board.lanes[i]; return ln.cap > ln.count; });
    switch (id) {
      case 10: case 32: case 36:                        // Ａ５５０雷撃・烈風
        return foeLanes.some(function (i) { return m.board.lanes[i].def <= 550; });
      case 3: case 6: case 45:                          // 石化・疫障・腐食の付加
        return foeRoom.length > 0 && m.rng.next() < 0.7;
      case 38:                                          // 手札＋１入手
        return m.players[side].hand.length <= 5;
      case 44: {                                        // クローズ×１：相手の表向き技能があれば
        const t = foeLanes.some(function (i) {
          return m.board.lanes[i].channels.some(function (ch) { return ch.up && ch.card >= 151 && ch.card !== BLANK; });
        });
        return t && m.rng.next() < 0.6;
      }
      case 9:                                           // ＬＰ消費ＣＨ１破壊（対象は自陣も含む乱択＝リスクあり）
        return m.players[side].lp > 3 &&
          foeLanes.some(function (i) { return m.board.lanes[i].count > 0; }) && m.rng.next() < 0.4;
      case 48: case 49: return m.rng.next() < 0.3;      // ＣＨ確認
      case 35: return m.rng.next() < 0.2;               // 自己ＣＨシャッフル
      case 34: return m.rng.next() < 0.15;              // 潜入
      case 70: return false;                            // 妄執（自爆）はやけくそ時のみ（呼び出し側で判断）
      default: return m.rng.next() < 0.3;
    }
  }

  /** 攻撃対象のスタックに「こちらが中身を知っている反撃カード」が潜んでいないか読む。
   * 中身既知＝表・公開済み・自分が置いたカードのみ（M5.7で透視率を撤廃。人間と対称）。
   *   trap    … 防御側が開くと攻撃側が破壊されうるカード（135雷撃・141思念波）
   *   undying … 不死(177)。倒し切れず反撃を受ける */
  function believedThreat(m, side, t) {
    let trap = 0, undying = 0;
    m.board.lanes[t].channels.forEach(function (ch) {
      if (ch.up) { if (ch.card === 177) undying = 1; return; }    // 表は誰でも見える
      if (!knownTo(ch, side)) return;
      if (ch.card === 135 || ch.card === 141) trap = 1;
      if (ch.card === 177) undying = 1;
    });
    return { trap: trap, undying: undying };
  }

  /** メインステップの1手。①攻撃 ②デッキ攻撃 ③特殊行動 ④リバース の順に評価する。
   * 何もできなければ false（呼び出し側がターンを終える） */
  function evalMain(m) {
    const side = m.active, cfg = cfgFor(m, side);
    Stats.recalc(m.board, { cards: m.cards });
    const V = {};
    const vstat = function (i) { return V[i] || (V[i] = virtualStats(m, side, i)); };
    const desperate = isDesperate(m, side, vstat);
    const noAttack = (m.players[side].turnsTaken || 1) <= (cfg.noAttackTurns || 0);
    const mine = S.controlledLanesOf(m.board.lanes, side);

    // --- ① 攻撃（§11.2：rand(0..300)+序盤ペナルティ vs 仮想攻撃力−相手防御力） ---
    // 相手の防御力は「現在の値」を使う（§11.2は仮想防御力だが、攻撃はいま起きるもので、
    // 戦闘中に防御側が防御力を上げる手段は無い＝現在値のほうが正確。設計判断）
    if (!noAttack) {
      for (let k = 0; k < mine.length; k++) {
        const i = mine[k];
        const targets = Combat.attackTargets(m, i);
        if (!targets.length) continue;
        // 狙いの選び方：倒せる相手の中ではＬＰダメージ（素のＣＨ数）が大きい方を、
        // リーサル（ＣＨ数 ≧ 相手ＬＰ）なら最優先で選ぶ（§11.2 やけくそ条件③と同じ視点）
        const foeLp = m.players[S.otherSide(side)].lp;
        let best = -1, bestScore = -Infinity, bestMargin = -Infinity;
        targets.forEach(function (t) {
          const margin = vstat(i).atk - m.board.lanes[t].def;
          const kill = margin >= 0;
          const lethal = kill && m.board.lanes[t].baseCh >= foeLp;
          const threat = believedThreat(m, side, t);
          let score = (lethal ? 100000 : 0) + (kill ? 1000 + m.board.lanes[t].baseCh * 10 : margin);
          if (threat.trap) score -= 1500;                // 雷撃系の罠を知っていれば避ける
          if (threat.undying) score -= 600;              // 不死は倒し切れない
          if (score > bestScore) { bestScore = score; best = t; bestMargin = margin; }
        });
        if (bestScore < 0 && !desperate) continue;       // 罠が読めている相手にしか攻められないなら見送る
        // 攻撃判定は margin ≧ 0 で成功（同値も成功）なので、margin ≧ 0 は「確実に勝てる攻撃」。
        // 原作ＡＩの評価スコアには +999999 のような強制加点の痕跡があり（状態モデル V317）、
        // 確実な勝ち筋には別枠の判断があったと推定して、序盤ペナルティが消えた後は必ず実行する。
        // 不確実な攻撃（margin < 0 は判定上必ず失敗するため、やけくそ時の博打だけ）は§11.2の式
        let go;
        if (desperate) go = bestMargin > m.rng.int(0, 60) - 60;
        else if (bestMargin >= 0) go = m.turn >= 3 || earlyPenalty(m) <= m.rng.int(0, 300);
        else go = bestMargin > m.rng.int(0, 300) + earlyPenalty(m);
        if (go) {
          if (Combat.declareAttack(m, i, best).ok) return true;
        }
      }
    }
    // --- ② デッキ攻撃（撃てるなら常に得） ---
    if (!noAttack) {
      for (let k = 0; k < mine.length; k++) {
        if (Combat.canDeckAttack(m, mine[k]).ok) { Combat.deckAttack(m, mine[k]); return true; }
      }
    }
    // --- ③ Ｃ型特殊行動 ---
    for (let k = 0; k < mine.length; k++) {
      const i = mine[k];
      if (!Turn.canSpecialAction(m, i).ok) continue;
      const id = m.board.lanes[i].unit;
      const worth = (id === 70) ? desperate : specialWorth(m, side, i);
      if (worth && Turn.specialAction(m, i).ok) return true;
    }
    // --- ④ リバース（リバース召還・自陣に有益な魔法/技能・有害な表技能のクローズ） ---
    for (let k = 0; k < mine.length; k++) {
      const i = mine[k];
      const layers = mainReverseLayers(m, side, i);
      if (layers.length && Turn.reverseAction(m, i, layers).ok) return true;
    }
    return false;
  }

  /* ================= 評価関数方策：戦闘中のオープンフェイズ（§11.2） ================= */

  /** 攻撃側：攻撃力が足りるまで、中身を知っている安全なカードを下から開く。
   * 防御側：閉じたままで守れるなら開かない。死ぬなら迎撃・反射・不死・対抗魔法を開き、
   * それも無ければ不明カードに賭ける（やけくそ＝§11.2の条件②が戦闘内で成立した状態）。 */
  function evalOpen(m) {
    if (!m.combat) return false;
    const c = m.combat;
    const side = Combat.openerSide(m);
    const attacker = c.opener === 'attacker';
    const myLane = attacker ? c.attacker : c.defender;
    const foeLane = attacker ? c.defender : c.attacker;
    const layers = Combat.openableLayers(m);
    if (!layers.length) { Combat.endOpen(m); return true; }
    const ln = m.board.lanes[myLane], foe = m.board.lanes[foeLane];

    const pickLayer = function (pred) {
      for (let k = 0; k < layers.length; k++) {
        const ch = ln.channels[layers[k] - 1];
        if (ch && pred(layers[k], ch)) return layers[k];
      }
      return null;
    };
    // 仮想攻撃力の算定基準（wouldOpenInCombat）と同じ判定＝判断と実行を一致させる。
    // 発動レベルに届かない魔法も「不発だが+100攻撃力の頭数」として開いてよい
    const safeKnown = function (n, ch) { return wouldOpenInCombat(m, side, ch); };

    if (attacker) {
      // 攻撃側：現在の攻撃力が相手の防御力に届いていなければ開き続ける
      if (ln.atk >= foe.def) { Combat.endOpen(m); return true; }
      const n = pickLayer(safeKnown);
      if (n != null) return Combat.open(m, n).ok;
      Combat.endOpen(m);
      return true;
    }
    // 防御側：閉じたままで守れるなら開かない（開けば防御力は下がる一方）
    if (foe.atk < ln.def) { Combat.endOpen(m); return true; }
    // このままでは死ぬ：迎撃・反射・不死・対抗魔法を優先して開く
    let n = pickLayer(function (nn, ch) {
      if (!knownTo(ch, side)) return false;
      if (DEFENSE_SKILL[ch.card]) return true;
      if (isMagic(ch.card)) return COMBAT_GOOD_MAGIC[ch.card] && magicLevelOk(m, myLane, nn, ch.card);
      return false;
    });
    // 迎撃・反射が生きているなら、反撃を通すために攻撃力の頭数も開く
    if (n == null && ln.acc && (ln.acc.counter >= 1 || ln.acc.reflect >= 1) && ln.atk < foe.def) {
      n = pickLayer(safeKnown);
    }
    // それも無ければ不明カードに賭ける（どうせ死ぬ＝失うものが無い）
    if (n == null) n = pickLayer(function (nn, ch) { return !knownTo(ch, side); });
    if (n != null) return Combat.open(m, n).ok;
    Combat.endOpen(m);
    return true;
  }

  /* ================= 公開ＡＰＩ（方策で分岐） ================= */

  /** 探索方策モジュール（M5.7）。循環参照を避けるため、呼ぶ瞬間に解決する */
  function searchApi() {
    return (typeof require === 'function' && typeof window === 'undefined')
      ? require('./search.js') : global.CQSearch;
  }

  /** 手札上限オーバーの強制捨て（search も evalDiscard を共用する：空白→末尾の単純規則） */
  function discardStep(m) {
    const p = cfgFor(m, m.active).policy;
    return (p === 'eval' || p === 'search') ? evalDiscard(m) : randomDiscard(m);
  }
  /** 配置ステップの1手。何もできなければ false */
  function placementStep(m) {
    const p = cfgFor(m, m.active).policy;
    if (p === 'search') return searchApi().placementStep(m);
    return p === 'eval' ? evalPlacement(m) : randomPlacement(m);
  }
  /** 配置ステップを最後まで（最大6手） */
  function playPlacement(m) {
    let n = 0;
    while (n++ < 6 && m.phase === 'placement' && placementStep(m)) { /* 続ける */ }
  }
  /** メインステップの1手。何もできなければ false */
  function mainStep(m) {
    const p = cfgFor(m, m.active).policy;
    if (p === 'search') return searchApi().mainStep(m);
    return p === 'eval' ? evalMain(m) : randomMain(m);
  }
  /** 戦闘中のオープンフェイズを1手だけ進める（開く／開かずに終える） */
  function openStep(m) {
    if (!m.combat) return false;
    const side = Combat.openerSide(m);
    const p = cfgFor(m, side).policy;
    if (p === 'search') return searchApi().openStep(m);
    return p === 'eval' ? evalOpen(m) : randomOpen(m);
  }
  /** 戦闘が終わるまでオープンフェイズを自動で進める（両側とも自動のとき用） */
  function finishCombat(m) {
    let guard = 0;
    while (m.combat && guard++ < 40) openStep(m);
  }

  const api = { discardStep, placementStep, playPlacement, mainStep, openStep, finishCombat,
                PRESETS, virtualStats, knownTo, isDesperate,
                /* search.js（M5.7）が評価の部品として使う内部関数（設計原則：
                 * 「仮想値の算定基準＝オープン判断の基準を同じ関数に揃える」を維持するため公開） */
                cfgFor, mainReverseLayers, wouldOpenInCombat, believedThreat };
  global.CQAi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
