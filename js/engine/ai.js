/* CardQuest エンジン — 仮の相手ＡＩ（ランダム方策）
 *
 * その場で合法な手をランダムに選ぶだけの、いちばん単純な相手。
 * 実装計画M5で原作の評価関数（仕様書§11）に差し替える。それまでの動作確認用で、
 * 強さの評価には使えない。
 *
 * すべての関数は「1回の呼び出し＝1手だけ進める」形にしてある。
 * こうしておくと、途中でプレイヤーの入力（防御側のオープンフェイズ）が必要になったときに
 * 呼び出し側が止められる。乱数は必ず m.rng を通す（再現性のため）。
 * DOMには依存しない。
 */
'use strict';
(function (global) {

  const isNode = (typeof require === 'function' && typeof window === 'undefined');
  const S = isNode ? require('./state.js') : global.CQState;
  const Turn = isNode ? require('./turn.js') : global.CQTurn;
  const Combat = isNode ? require('./combat.js') : global.CQCombat;

  /** 手札上限オーバーの強制捨て：ランダムに1枚 */
  function discardStep(m) {
    const p = m.players[m.active];
    if (!p.hand.length) return false;
    return Turn.discardCard(m, m.rng.int(0, p.hand.length - 1)).ok;
  }

  /** 配置ステップの1手。何もできなければ false */
  function placementStep(m) {
    const p = m.players[m.active];
    const own = S.lanesOf(m.active);
    // 空きレーンがあれば、召還できるユニットを1体出す
    const empty = own.filter(function (i) { return m.board.lanes[i].unit == null; })[0];
    if (empty !== undefined) {
      const idx = p.hand.findIndex(function (id) {
        const c = m.cards[id];
        return c && c.t === 'U' && S.unitStats(c).lv <= 1;
      });
      if (idx >= 0 && Turn.summon(m, empty, idx).ok) return true;
    }
    // 半々でチャネル。ふだんは自陣、たまに敵ユニットへ置く（原作でも可能）
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

  /** 配置ステップを最後まで（最大4手） */
  function playPlacement(m) {
    let n = 0;
    while (n++ < 4 && m.phase === 'placement' && placementStep(m)) { /* 続ける */ }
  }

  /** メインステップの1手。攻撃 → デッキ攻撃 → リバース の順に、動けるユニットを1体だけ動かす。
   * 何もできなければ false（呼び出し側がターンを終える） */
  function mainStep(m) {
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
      // 特殊行動（Ｃ型固有能力。M4 v0.14）：持っていれば半々でリバースより先に試す
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

  /** 戦闘中のオープンフェイズを1手だけ進める（開く／開かずに終える） */
  function openStep(m) {
    if (!m.combat) return false;
    const layers = Combat.openableLayers(m);
    if (layers.length && m.rng.next() < 0.5) {
      return Combat.open(m, layers[m.rng.int(0, layers.length - 1)]).ok;
    }
    Combat.endOpen(m);
    return true;
  }

  /** 戦闘が終わるまでオープンフェイズを自動で進める（両側とも自動のとき用） */
  function finishCombat(m) {
    let guard = 0;
    while (m.combat && guard++ < 40) openStep(m);
  }

  const api = { discardStep, placementStep, playPlacement, mainStep, openStep, finishCombat };
  global.CQAi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
