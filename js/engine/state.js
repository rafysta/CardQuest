/* CardQuest エンジン — 盤面の状態モデル
 *
 * 『SOULGATE カードバトル仕様書』§2.1 のデータ構造に対応する。
 *   ・レーンは 0..5。0〜2 が自陣（self）、3〜5 が敵陣（enemy）
 *   ・チャンネルは配列 channels[0] が階層1（最下段）。必ず下から連続して詰まる
 *   ・カードの3属性を分けて持つ：
 *       mine     … 置いたのが自分（プレイヤー）か ＝ 所有者（原作 SW442 の逆論理）
 *       up       … 表か（原作 SW405 は ON=裏。ここでは up=true が表）
 *       revealed … 置いていない側にも中身が判明しているか（原作 SW481）
 * DOMには依存しない。
 */
'use strict';
(function (global) {

  const LANES = 6;
  const LAYERS = 6;

  /** レーン番号 → 陣営（'self' | 'enemy'） */
  function sideOf(lane) { return lane < 3 ? 'self' : 'enemy'; }
  /** 反対の陣営 */
  function otherSide(side) { return side === 'self' ? 'enemy' : 'self'; }
  /** その陣営のレーン番号の配列 */
  function lanesOf(side) { return side === 'self' ? [0, 1, 2] : [3, 4, 5]; }

  /** 傀儡(169)・カース92（傀儡化）で操作権が反転しているレーンの、実際の操作側（原作 SW568〜573）。
   * 持ち主・被弾側もこれと同じ側に反転する（`03_combat` §7.3／`destroy()` の ownerSide 参照）。
   * 物理的な場所（lane 0〜5）は動かさず、"どちらが操作できるか" だけを反転させる実装方針
   * （実装計画M4）。 */
  function controlSide(lane, laneIndex) {
    const phys = sideOf(laneIndex);
    return lane.flipped ? otherSide(phys) : phys;
  }
  /** side が操作できるレーン番号の配列（ユニットが居るレーンのみ。傀儡の反転を考慮） */
  function controlledLanesOf(lanes, side) {
    const res = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i].unit != null && controlSide(lanes[i], i) === side) res.push(i);
    }
    return res;
  }

  /** ユニットの素の数値（マスターズソウル(64)は固定値を持たないため既定値で埋める） */
  const MS_DEFAULT = { a: 200, d: 200, ch: 2, lv: 1 };
  function unitStats(card, override) {
    if (!card) return null;
    if (card.id === 64) {
      const o = override || {};
      return {
        a: numeric(o.a, MS_DEFAULT.a), d: numeric(o.d, MS_DEFAULT.d),
        ch: clamp(numeric(o.ch, MS_DEFAULT.ch), 0, 6), lv: Math.max(1, numeric(o.lv, MS_DEFAULT.lv))
      };
    }
    return { a: numeric(card.a, 0), d: numeric(card.d, 0), ch: numeric(card.ch, 0), lv: numeric(card.lv, 1) };
  }
  function numeric(v, fb) { return typeof v === 'number' && isFinite(v) ? v : fb; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /** 空のレーン
   *   stiff       … 硬直（原作 SW314〜319）
   *   channeled   … このターンにチャネリングされた（原作 SW583〜588。アタックできない）
   *   extraAttack … 連続攻撃(154)の2回目の権利（原作 SW526〜531。硬直をバイパスする）
   *   flipped     … 傀儡による所有者反転（原作 SW568〜573。持ち主と居る場がズレている＝M4）
   *   swapped     … 身転換(142)で入れ替えられた（以後そのユニットは戦利品にならない。原作 SW251＝M4）
   */
  function emptyLane() {
    return { unit: null, baseCh: 0, channels: [],
             stiff: false, reversePtr: 0,
             channeled: false, extraAttack: false, flipped: false, swapped: false,
             atk: 0, def: 0, cap: 0, count: 0, free: 0, acc: null };
  }

  /** ユニットの居るレーンを作る（テスト・セットアップ用）
   * chs: [{card, up, mine, revealed}] または カードIDの配列（裏向き・自分置き扱い） */
  function makeLane(unitId, chs, cards, opts) {
    const lane = emptyLane();
    if (unitId == null) return lane;
    const card = cards[unitId];
    if (!card) throw new Error('unknown card id: ' + unitId);
    const o = opts || {};
    lane.unit = unitId;
    lane.baseCh = unitStats(card, o.msEquip).ch;   // 素のＣＨ数（召還時に固定。原作 V260+L）
    lane.msEquip = o.msEquip;
    lane.channels = (chs || []).map(function (ch) {
      if (typeof ch === 'number') return { card: ch, up: false, mine: true, revealed: false };
      return { card: ch.card, up: !!ch.up,
               mine: ch.mine === undefined ? true : !!ch.mine,
               revealed: !!ch.revealed, st: ch.st };
    });
    lane.count = lane.channels.length;
    lane.cap = lane.baseCh;
    return lane;
  }

  /** 盤面。lanes[0..2]=自陣 / lanes[3..5]=敵陣。hand は手札の枚数 */
  function makeBoard(lanes, handSelf, handEnemy) {
    return {
      lanes: lanes,
      hand: { self: handSelf || 0, enemy: handEnemy || 0 },
      chainLocked: null            // 縛鎖：防御側が開けない階層の集合（戦闘中のみ）
    };
  }

  /* ---- UI（layout.js の G）との相互変換 -------------------------------- */

  /** layout.js の G {mine, enemy, hand, enemyHand} からエンジン盤面を作る。
   * UI側 own: true=自分のカード（未設定はその場の持ち主のもの） */
  function boardFromUI(G, cards) {
    const lanes = [];
    const conv = function (slot, side) {
      if (!slot) return emptyLane();
      const chs = (slot.chs || []).map(function (ch) {
        return { card: ch.cid, up: !!ch.up,
                 mine: ch.own === undefined ? side === 'm' : !!ch.own,
                 revealed: !!ch.up, st: ch.st };
      });
      return makeLane(slot.cid, chs, cards);
    };
    (G.mine || []).forEach(function (s) { lanes.push(conv(s, 'm')); });
    (G.enemy || []).forEach(function (s) { lanes.push(conv(s, 'e')); });
    while (lanes.length < LANES) lanes.push(emptyLane());
    return makeBoard(lanes, (G.hand || []).length, G.enemyHand || 0);
  }

  const api = { LANES, LAYERS, sideOf, otherSide, lanesOf, controlSide, controlledLanesOf,
                unitStats, emptyLane, makeLane, makeBoard, boardFromUI };
  global.CQState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
