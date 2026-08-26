/* CardQuest ラン — 進行管理（M6）
 *
 * 『CardQuest マップ仕様書』の状態遷移をここに集約する。js/run/map.js が作った
 * マップ（全マス確定済み）の上を進み、各マスの解決（戦闘以外）・おまかせドラフト・
 * 換金／購入／休憩・霧払いを行う。戦闘そのものは既存のバトルエンジン（js/engine/）を
 * そのまま使う——ここでは「その戦闘に何のデッキ・戦場ルールで臨むか」を組み立て、
 * 終わったら結果（戦利品・LP）をランに反映するだけ。DOMには依存しない。
 */
'use strict';
(function (global) {

  function need(name) {
    return (typeof require === 'function' && typeof module !== 'undefined')
      ? require('./' + name) : null;
  }
  const CQAreas = need('areas.js') || global.CQAreas;
  const CQMap = need('map.js') || global.CQMap;
  const CQTurnRef = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('../engine/turn.js') : global.CQTurn;
  const DECK_SIZE = (CQTurnRef && CQTurnRef.DECK_SIZE) || 40;
  const BLANK = 180;

  /* ---- デッキ組み立て ---------------------------------------------------- */

  /** 敵の戦闘マス用デッキ：花形ユニット(node.enemy)＋プールの残りで20枚のユニット枠を埋め、
   * 支援シェル20枚（js/run/areas.js）を足して DECK_SIZE にする。
   * マスター固有の実デッキ抽出は実装計画M8。それまでの簡略版（開発メモに明記）。 */
  function buildBattleDeck(cards, area, node) {
    const pool = CQAreas.enemyPool(cards, area.id);
    const featured = node.enemy;
    const units = [];
    if (featured) {
      /* 花形ユニットを積みすぎると「同じカードの連投」で安定しすぎ、プレイヤー側の単発構成の
       * デッキ（js/layout.js SAMPLE_DECK は各1枚）に対して不自然に勝ちやすくなることが
       * tools/simulate-run.js のファズで分かった（2026-08-26）。上限4枚に抑える。 */
      const featCount = Math.min(4, featured.count * 2);
      for (let i = 0; i < featCount; i++) units.push(featured.id);
    }
    let idx = 0, guard = 0;
    while (units.length < 20 && pool.length && guard < 400) {
      const c = pool[idx % pool.length];
      if (!featured || c.id !== featured.id) units.push(c.id);
      idx++; guard++;
    }
    while (units.length < 20) units.push(featured ? featured.id : 8);
    return units.slice(0, 20).concat(CQAreas.SUPPORT_SHELL);
  }

  /** ボスのデッキ：プール上位（価格上限area.bossPriceMax以下）を集めて組む */
  function buildBossDeck(cards, area) {
    const pool = CQAreas.enemyPool(cards, area.id).filter(function (e) { return e.price <= area.bossPriceMax; });
    const top = pool.slice(-8);   /* 上位8種を薄く混ぜる（1種に偏らせない。理由は buildBattleDeck 参照） */
    const units = [];
    let i = 0, guard = 0;
    while (units.length < 20 && top.length && guard < 400) { units.push(top[i % top.length].id); i++; guard++; }
    while (units.length < 20) units.push(pool.length ? pool[pool.length - 1].id : 8);
    return units.slice(0, 20).concat(CQAreas.SUPPORT_SHELL);
  }

  /** 所持デッキ（多重集合）＋このランのレンタルから、実戦闘に使う DECK_SIZE 枚の配列を作る。
   * 足りなければ空白(180)で埋め、多ければ切り詰める（切り詰めはデッキが大きく育った後の保険）。 */
  function buildPlayerDeck(run) {
    const ids = [];
    Object.keys(run.deck).forEach(function (k) {
      const n = run.deck[k];
      for (let i = 0; i < n; i++) ids.push(+k);
    });
    run.rentals.forEach(function (id) { ids.push(id); });
    while (ids.length < DECK_SIZE) ids.push(BLANK);
    return ids.slice(0, DECK_SIZE);
  }

  /* ---- ラン開始 ------------------------------------------------------------ */

  /** cards: CARD_BY_ID / areaId / seed / meta: {deck, gold, cleared}（js/meta/save.js） */
  function start(cards, areaId, seed, meta) {
    const area = CQAreas.get(areaId);
    if (!area) throw new Error('unknown area: ' + areaId);
    const ownedIds = Object.keys(meta.deck).filter(function (k) { return meta.deck[k] > 0; }).map(Number);
    const map = CQMap.generate({ cards: cards, areaId: areaId, seed: seed, ownedIds: ownedIds });
    return {
      areaId: areaId, seed: seed, map: map,
      at: map.start,
      lp: 10, maxLp: 15,
      gold: meta.gold,
      deck: Object.assign({}, meta.deck),
      rentals: [],
      gainedCards: [],
      draftDone: 0, draftPending: null,
      log: [], outcome: null
    };
  }

  /* ---- おまかせドラフト（§1.2） -------------------------------------------- */

  /** 今すぐ置き換えるとしたら、どのカードが対象になるか（空白優先→定価の低い順） */
  function draftTarget(run, cards) {
    if ((run.deck[BLANK] || 0) > 0) return BLANK;
    let best = null;
    Object.keys(run.deck).forEach(function (k) {
      const id = +k;
      if ((run.deck[id] || 0) <= 0) return;
      const p = cards[id] ? cards[id].p : 0;
      if (best === null || p < (cards[best] ? cards[best].p : Infinity)) best = id;
    });
    return best;
  }

  function beginDraftRound(run, cards) {
    if (run.draftDone >= 3) return null;
    const idx = run.draftDone;
    const options = (run.map.draftPools[idx] || []).slice();
    const targetId = draftTarget(run, cards);
    run.draftPending = { round: idx, options: options, targetId: targetId };
    return run.draftPending;
  }

  /** pickedId が targetId と同じ＝「変更しない」。それ以外はレンタルとして入れ替える
   * （§1.2「所持済みが候補でも扱いはレンタルで統一」＝おまかせドラフトの入手は常にレンタル） */
  function applyDraft(run, pickedId) {
    const dp = run.draftPending;
    if (!dp) return false;
    if (pickedId !== dp.targetId) {
      if ((run.deck[dp.targetId] || 0) > 0) run.deck[dp.targetId] -= 1;
      run.rentals.push(pickedId);
      run.log.push('draft: ' + dp.targetId + ' → ' + pickedId + '（レンタル）');
    } else {
      run.log.push('draft: 変更しない（' + dp.targetId + '）');
    }
    run.draftDone += 1;
    run.draftPending = null;
    return true;
  }

  /** 3回のドラフトを終え、開始マスから最初の分岐へ出発する。
   * 開始マスの「解決」は案内・ドラフトの時点で既に済んでいるので、ここで cleared にする
   * （さもないと choices()/advance() が「まだ解決していない」として先へ進めなくなる） */
  function depart(run) {
    run.map.nodes[run.map.start].cleared = true;
    run.at = run.map.start;
  }

  /* ---- 進行・分岐選択 -------------------------------------------------------- */

  function node(run, id) { return run.map.nodes[id || run.at]; }
  function currentNode(run) { return node(run, run.at); }

  /** いま選べる次のマス（現在のマスが解決済みのときだけ意味を持つ） */
  function choices(run) {
    const n = currentNode(run);
    if (!n || !n.cleared) return [];
    return n.connectsTo.map(function (id) { return run.map.nodes[id]; });
  }

  function advance(run, nextId) {
    const n = currentNode(run);
    if (!n || !n.cleared) return { ok: false, reason: 'このマスはまだ解決していません' };
    if (n.connectsTo.indexOf(nextId) < 0) return { ok: false, reason: 'そこへは進めません' };
    run.at = nextId;
    return { ok: true };
  }

  /* ---- 戦闘マス ------------------------------------------------------------ */

  /** run.seed とマスidから、その戦闘専用の決定的な乱数シードを作る（同じランは常に同じ結果になる） */
  function battleSeed(run, n) {
    let h = (run.seed >>> 0) ^ 0x9e3779b9;
    const s = String(n.id);
    for (let i = 0; i < s.length; i++) h = (Math.imul(h ^ s.charCodeAt(i), 16777619)) >>> 0;
    return h >>> 0;
  }

  /** CQTurn.createMatch にそのまま渡せる引数を作る（rng/hooksは呼び出し側＝layout.jsが足す） */
  function battleSetup(run, cards, n) {
    const area = CQAreas.get(run.areaId);
    const isBoss = n.type === 'boss';
    return {
      cards: cards,
      selfDeck: buildPlayerDeck(run),
      enemyDeck: isBoss ? buildBossDeck(cards, area) : buildBattleDeck(cards, area, n),
      first: 'self',
      opponentId: 900 + (n.seg == null ? 90 : n.seg * 10) + (n.slot || 0),
      fieldRules: n.fieldRules || [],
      selfOpts: { lp: run.lp, maxLp: run.maxLp },
      enemyOpts: isBoss ? { lp: area.bossLp, maxLp: area.bossLp } : undefined,
      seed: battleSeed(run, n)
    };
  }

  /** 戦闘終了後（M.winner が確定した後）に呼ぶ。戦利品・Ｇ・ＬＰをランに反映する */
  function reportBattle(run, n, M) {
    n.cleared = true;
    if (M.winner === 'self') {
      const loot = (M.loot || []).slice();
      loot.forEach(function (id) { run.deck[id] = (run.deck[id] || 0) + 1; run.gainedCards.push(id); });
      const base = n.enemy ? n.enemy.price : (CQAreas.get(run.areaId).bossPriceMax * 0.5);
      const mult = n.strength === 'strong' ? 1.25 : n.strength === 'elite' ? 1.5 : n.type === 'boss' ? 2 : 1;
      const gold = Math.round(base * 0.12 * mult) + loot.length * 10;
      run.gold += gold;
      run.lp = M.players.self.lp;
      run.log.push((n.type === 'boss' ? 'ボス' : '戦闘') + 'に勝利（Ｇ+' + gold + '・戦利品' + loot.length + '枚）');
      return { win: true, loot: loot, gold: gold };
    }
    run.lp = 0;
    run.outcome = 'lose';
    run.log.push((n.type === 'boss' ? 'ボス' : '戦闘') + 'に敗北');
    return { win: false };
  }

  /* ---- 宝箱・休憩・ショップ・換金・？イベント ------------------------------------- */

  function openChest(run, n) {
    if (n.opened) return { gold: 0, cardId: null };
    n.opened = true; n.cleared = true;
    run.gold += n.gold;
    if (n.cardId != null) { run.deck[n.cardId] = (run.deck[n.cardId] || 0) + 1; run.gainedCards.push(n.cardId); }
    run.log.push('宝箱：Ｇ+' + n.gold + (n.cardId != null ? '・カード獲得' : ''));
    return { gold: n.gold, cardId: n.cardId };
  }

  function rest(run, n) {
    n.cleared = true;
    const before = run.lp;
    run.lp = Math.min(run.maxLp, run.lp + 3);
    run.log.push('休憩：ＬＰ ' + before + '→' + run.lp);
    return { lp: run.lp };
  }

  const SHOP_RATE = 0.5;   /* ラン中ショップの割引率（初期値。ログショップ本体はM7） */
  function shopPrice(cards, cardId) {
    const c = cards[cardId];
    return c ? Math.max(50, Math.round(c.p * SHOP_RATE)) : 0;
  }
  function shopBuy(run, cards, n, cardId) {
    if (n.stock.indexOf(cardId) < 0) return { ok: false, reason: '品揃えにありません' };
    const cost = shopPrice(cards, cardId);
    if (run.gold < cost) return { ok: false, reason: 'Ｇが足りません' };
    run.gold -= cost;
    run.deck[cardId] = (run.deck[cardId] || 0) + 1;
    run.gainedCards.push(cardId);
    n.stock.splice(n.stock.indexOf(cardId), 1);
    run.log.push('購入：' + cardId + '（-' + cost + 'Ｇ）');
    return { ok: true, cost: cost };
  }
  function shopHeal(run, n) {
    if (run.gold < n.healCost) return { ok: false, reason: 'Ｇが足りません' };
    run.gold -= n.healCost;
    const before = run.lp;
    run.lp = Math.min(run.maxLp, run.lp + 3);
    run.log.push('ショップでＬＰ回復：' + before + '→' + run.lp + '（-' + n.healCost + 'Ｇ）');
    return { ok: true, lp: run.lp };
  }
  function shopClearFog(run, n) {
    if (!n.hasFogClear || run.map.fog.cleared) return { ok: false, reason: '霧払いはできません' };
    if (run.gold < n.fogClearCost) return { ok: false, reason: 'Ｇが足りません' };
    run.gold -= n.fogClearCost;
    run.map.fog.cleared = true;
    run.log.push('霧払い（-' + n.fogClearCost + 'Ｇ）');
    return { ok: true };
  }
  function shopLeave(run, n) { n.cleared = true; }

  const SELL_RATE = 0.4;
  function sell(run, cards, cardId) {
    if ((run.deck[cardId] || 0) <= 0) return { ok: false, reason: '所持していません' };
    if (cardId === BLANK) return { ok: false, reason: '空白は売れません' };
    const c = cards[cardId];
    const gold = c ? Math.max(10, Math.round(c.p * SELL_RATE)) : 0;
    run.deck[cardId] -= 1;
    run.gold += gold;
    run.log.push('換金：' + cardId + '（+' + gold + 'Ｇ）');
    return { ok: true, gold: gold };
  }
  function exchangeLeave(run, n) { n.cleared = true; }

  function resolveQuestion(run, n) {
    if (n.resolved) return null;
    n.resolved = true; n.cleared = true;
    const ev = n.event, eff = ev.effect || {};
    const res = { text: ev.text };
    if (eff.lp) { run.lp = Math.max(0, Math.min(run.maxLp, run.lp + eff.lp)); res.lp = eff.lp; }
    if (eff.gold) { run.gold = Math.max(0, run.gold + eff.gold); res.gold = eff.gold; }
    if (eff.draftCard && n.cardId != null) {
      run.deck[n.cardId] = (run.deck[n.cardId] || 0) + 1;
      run.gainedCards.push(n.cardId);
      res.cardId = n.cardId;
    }
    run.log.push('？：' + ev.text);
    if (run.lp <= 0) run.outcome = 'lose';
    return res;
  }

  /* ---- 終了 ------------------------------------------------------------ */

  function retire(run) { run.outcome = 'retire'; }

  /** ランを終えて meta（永続所持データ）に反映する。レンタルは消滅（返却）＝ deck には残っているが
   * run.deck 自体に混ぜていないので、そもそも meta に混入しない。 */
  function settle(run, meta) {
    meta.deck = Object.assign({}, run.deck);
    meta.gold = run.gold;
    if (run.outcome === 'win' && meta.cleared.indexOf(run.areaId) < 0) meta.cleared.push(run.areaId);
    return meta;
  }

  const api = {
    DECK_SIZE, BLANK, buildBattleDeck, buildBossDeck, buildPlayerDeck,
    start, beginDraftRound, applyDraft, draftTarget, depart,
    node, currentNode, choices, advance,
    battleSeed, battleSetup, reportBattle,
    openChest, rest, shopPrice, shopBuy, shopHeal, shopClearFog, shopLeave,
    sell, exchangeLeave, resolveQuestion, retire, settle
  };
  global.CQRun = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
