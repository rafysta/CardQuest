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
  const CQCollection = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('../meta/collection.js') : global.CQCollection;
  const DECK_SIZE = (CQTurnRef && CQTurnRef.DECK_SIZE) || 40;
  const BLANK = 180;
  /* おまかせドラフトの回数（マップ仕様書§1.2は3回だったが、実装計画追補M6.6 §2-4で
   * 最大2回に変更。1回目＝エリアの敵／2回目＝いま買える魔法・技能）。 */
  const DRAFT_ROUNDS = 2;
  /* フリーユニット戦の敵デッキの組成（M6.6 WP6・§7-5）。敵は召還できないので支援中心にし、
   * ユニットはチャネル弾として少量だけ混ぜる。合計は DECK_SIZE（40枚）ちょうどにする。
   * 旧構成は「ユニット20＋支援シェル20」だったが、召還が封じられた以上ユニット20枚は
   * ほぼ死に札だった（引くだけ手が詰まる）ため、この比率に取り直した。 */
  const FIELD_DECK_UNITS = 6;                                  /* チャネル弾としてのユニット */
  const FIELD_DECK_SHELL = DECK_SIZE - FIELD_DECK_UNITS;       /* 残りは魔法・技能 */

  /* ---- デッキ組み立て ---------------------------------------------------- */

  /** 敵の戦闘マス用デッキ：花形ユニット(node.enemy)＋プールの残りで20枚のユニット枠を埋め、
   * 支援シェル20枚（js/run/areas.js）を足して DECK_SIZE にする。
   * マスター固有の実デッキ抽出は実装計画M8。それまでの簡略版（開発メモに明記）。 */
  /** 通常戦闘（フリーユニット戦）の敵デッキ。
   * M6.6 WP6（§7-5）で組み直した：**敵は手札から召還できない**ので、デッキにユニットを
   * たくさん積む意味が無くなった（ユニットの使い道はチャネル＝強化弾としてだけ）。
   * そこで支援シェル（魔法・技能）を主にし、ユニットは少量だけ混ぜる。
   * ※ 場に立つ敵そのものは node.enemy の編成として battleSetup の enemyBoard で渡す。 */
  function buildBattleDeck(cards, area, node) {
    const pool = CQAreas.enemyPool(cards, area.id);
    const featured = node.enemy;
    const shell = CQAreas.SUPPORT_SHELL;
    const deck = [];
    /* 支援シェルを繰り返し積んで大半を埋める（チャネルで場のユニットを強化していく形） */
    let i = 0, guard = 0;
    while (deck.length < FIELD_DECK_SHELL && shell.length && guard < 400) {
      deck.push(shell[i % shell.length]); i++; guard++;
    }
    /* チャネル弾としてのユニットを少量。花形が居ればそれを軸にする */
    const units = [];
    if (featured) units.push(featured.id);
    let k = 0; guard = 0;
    while (units.length < FIELD_DECK_UNITS && pool.length && guard < 400) {
      const c = pool[k % pool.length];
      if (units.indexOf(c.id) < 0) units.push(c.id);
      k++; guard++;
    }
    while (units.length < FIELD_DECK_UNITS) units.push(featured ? featured.id : 8);
    return deck.concat(units.slice(0, FIELD_DECK_UNITS));
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

  /** cards: CARD_BY_ID / areaId / seed / meta: {book, deck, known, gold, cleared}（js/meta/save.js）
   * M6.6 WP3：run.deck は保存デッキ（持ち出し分）のコピー。ラン中の増減はランに閉じ、
   * 終了時に settle() でメタへ反映する。ラン中に「本」行きになったカードは run.bookAdd に
   * 貯めておく（中断・再開でも失われないよう run 自体に持たせる＝cq_run に保存される）。 */
  function start(cards, areaId, seed, meta) {
    const area = CQAreas.get(areaId);
    if (!area) throw new Error('unknown area: ' + areaId);
    /* ドラフトの「未入手優先」の基準は記憶データ（known）。旧形式のメタ（テスト・後方互換）では
     * 従来どおり deck の種類で代用する。 */
    const ownedIds = (meta.known && meta.known.length)
      ? meta.known.slice()
      : Object.keys(meta.deck).filter(function (k) { return meta.deck[k] > 0; }).map(Number);
    const map = CQMap.generate({ cards: cards, areaId: areaId, seed: seed, ownedIds: ownedIds });
    return {
      areaId: areaId, seed: seed, map: map,
      at: map.start,
      lp: 10, maxLp: 15,
      gold: meta.gold,
      deck: Object.assign({}, meta.deck),
      bookAdd: {},
      rentals: [],
      gainedCards: [],
      draftDone: 0, draftPending: null,
      log: [], outcome: null
    };
  }

  /** ラン中の入手（戦利品・宝箱・購入・？イベント）。デッキに空きがあればデッキへ、
   * 入らなければ（合計40・同種3枚制限）本行き＝run.bookAdd に貯める。どちらでも必ず貰える。
   * WP7で「その場でデッキ／本を選ぶ画面」に置き換わるまでの自動振り分け。
   * 戻り値は実際に入った先（'deck'|'book'）。 */
  function gainCard(run, id) {
    if (+id === BLANK) return null;
    if (!run.bookAdd) run.bookAdd = {};   /* 旧形式の cq_run（中断中のラン）を再開した場合の保険 */
    /* レンタルは空白の枠を埋めているので、空き枠の計算に数える（draftTarget と同じ理由） */
    const rentals = run.rentals ? run.rentals.length : 0;
    const hasSlot = CQCollection.countsTotal(run.deck) + rentals < DECK_SIZE;
    if (hasSlot && CQCollection.canAddToDeck(run.deck, id).ok) {
      run.deck[id] = (run.deck[id] || 0) + 1;
      run.gainedCards.push(id);
      return 'deck';
    }
    run.bookAdd[id] = (run.bookAdd[id] || 0) + 1;
    run.gainedCards.push(id);
    return 'book';
  }

  /* ---- おまかせドラフト（§1.2） -------------------------------------------- */

  /** 今すぐ置き換えるとしたら、どのカードが対象になるか（空白優先→定価の低い順）。
   * M6.6 WP3：空白は実体として持たなくなった（40枚に満たない分が空白）ので、
   * デッキ合計＋既に借りているレンタルが40未満なら空白が対象
   * （レンタルは空白の枠を埋めるカードなので、空きの計算に数えないと40枚を超えてしまう）。
   * 旧セーブに残る実体の空白(180)も同様に扱う。 */
  function draftTarget(run, cards) {
    if ((run.deck[BLANK] || 0) > 0) return BLANK;
    const rentals = run.rentals ? run.rentals.length : 0;
    if (CQCollection.countsTotal(run.deck) + rentals < DECK_SIZE) return BLANK;
    let best = null;
    Object.keys(run.deck).forEach(function (k) {
      const id = +k;
      if (id === BLANK) return;
      if ((run.deck[id] || 0) <= 0) return;
      const p = cards[id] ? cards[id].p : 0;
      if (best === null || p < (cards[best] ? cards[best].p : Infinity)) best = id;
    });
    return best;
  }

  /** 空白の枠が残っているか（＝おまかせドラフトが発生する条件。§2-4・WP4）。
   * 実体の空白(180)が旧セーブに残っている場合も、40枚に満たない仮想の空白も、どちらも見る。 */
  function hasBlankSlot(run) {
    if ((run.deck[BLANK] || 0) > 0) return true;
    const rentals = run.rentals ? run.rentals.length : 0;
    return CQCollection.countsTotal(run.deck) + rentals < DECK_SIZE;
  }

  /** 次のドラフトを始める。M6.6 WP4で **3回→最大2回**・**空白がある時だけ発生**に変更。
   * 空白が無ければ null を返す＝呼び出し側はドラフトを飛ばして出発する。
   * 「空白が1枚だけの時：1回目で埋めたら2回目は発生しない／空白を残したら2回目が発生」という
   * §4 WP4 の要求は、毎回ここで空きを見直すことで自然に満たされる。 */
  function beginDraftRound(run, cards) {
    if (run.draftDone >= DRAFT_ROUNDS) return null;
    if (!hasBlankSlot(run)) return null;
    const idx = run.draftDone;
    const options = (run.map.draftPools[idx] || []).slice();
    if (!options.length) return null;         /* 候補が用意できなかった回は飛ばす */
    const targetId = draftTarget(run, cards);
    run.draftPending = { round: idx, options: options, targetId: targetId };
    return run.draftPending;
  }

  /** pickedId が targetId と同じ＝「変更しない」。それ以外はレンタルとして入れ替える
   * （§1.2「所持済みが候補でも扱いはレンタルで統一」＝おまかせドラフトの入手は常にレンタル）。
   * cards はログ表示用（省略可・後方互換）：渡せばカード名で、渡さなければ従来どおりIDで出す。 */
  function applyDraft(run, pickedId, cards) {
    const dp = run.draftPending;
    if (!dp) return false;
    const name = function (id) { return cards && cards[id] ? cards[id].n : id; };
    if (pickedId !== dp.targetId) {
      if ((run.deck[dp.targetId] || 0) > 0) {
        run.deck[dp.targetId] -= 1;
        /* M6.6 WP3：実カードを押し出した場合は消滅ではなく本行き（settleでメタのbookへ）。
         * 空白(180)が対象のときは仮想の空きが埋まるだけなので何も足さない。 */
        if (dp.targetId !== BLANK) {
          if (!run.bookAdd) run.bookAdd = {};
          run.bookAdd[dp.targetId] = (run.bookAdd[dp.targetId] || 0) + 1;
        }
      }
      run.rentals.push(pickedId);
      run.log.push('おまかせドラフト：' + name(dp.targetId) + ' → ' + name(pickedId) + '（レンタル）');
    } else {
      run.log.push('おまかせドラフト：変更しない（' + name(dp.targetId) + '）');
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
  /** そのマスの敵編成を、実際に場へ立てる並びにする（M6.6 WP6）。
   * マップは「代表1体＋体数」で持っているので、体数ぶん同じユニットを並べる（最大3体＝敵レーン数）。 */
  function enemyBoardOf(n) {
    if (!n.enemy) return [];
    const out = [];
    for (let i = 0; i < Math.min(3, n.enemy.count || 1); i++) out.push(n.enemy.id);
    return out;
  }

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
      /* M6.6 WP6：通常戦闘はフリーユニット戦（敵は配置済み・召還不可・場が空になれば勝ち）。
       * マスター戦（ボス）だけは従来どおりのＬＰ勝負なので mode を付けない（§2-6）。 */
      mode: isBoss ? undefined : 'field',
      enemyBoard: isBoss ? undefined : enemyBoardOf(n),
      seed: battleSeed(run, n)
    };
  }

  /** 戦闘終了後（M.winner が確定した後）に呼ぶ。戦利品・Ｇ・ＬＰをランに反映する。
   * M6.6 WP6（§2-6）で報酬を変更した：
   *   通常戦闘（フリーユニット戦）＝**Ｇは出ない**。敵ユニットは金を落とさず、戦利品のカードだけ。
   *   マスター戦（ボス）＝**ファイトマネーは原作準拠**（areas.js の fightMoney。草原・森はＣ級500G）。
   *                       すでにクリア済みのエリアを周回しているときは50%。
   * ラン中の主収入は宝箱に寄る（マップ仕様書§7・追補§7-1の想定どおり）。 */
  function reportBattle(run, n, M, meta) {
    n.cleared = true;
    if (M.winner === 'self') {
      const loot = (M.loot || []).slice();
      loot.forEach(function (id) { gainCard(run, id); });
      const area = CQAreas.get(run.areaId);
      let gold = 0;
      if (n.type === 'boss') {
        const repeat = !!(meta && meta.cleared && meta.cleared.indexOf(run.areaId) >= 0);
        gold = Math.round((area.fightMoney || 0) * (repeat ? 0.5 : 1));
      }
      run.gold += gold;
      run.lp = M.players.self.lp;
      run.log.push((n.type === 'boss' ? 'ボス' : '戦闘') + 'に勝利（'
        + (gold ? 'Ｇ+' + gold + '・' : '') + '戦利品' + loot.length + '枚）');
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
    if (n.cardId != null) gainCard(run, n.cardId);
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
    gainCard(run, cardId);
    n.stock.splice(n.stock.indexOf(cardId), 1);
    run.log.push('購入：' + (cards[cardId] ? cards[cardId].n : cardId) + '（-' + cost + 'Ｇ）');
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
    run.log.push('換金：' + (cards[cardId] ? cards[cardId].n : cardId) + '（+' + gold + 'Ｇ）');
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
      gainCard(run, n.cardId);
      res.cardId = n.cardId;
    }
    run.log.push('？：' + ev.text);
    if (run.lp <= 0) run.outcome = 'lose';
    return res;
  }

  /* ---- 終了 ------------------------------------------------------------ */

  function retire(run) { run.outcome = 'retire'; }

  /** ランを終えて meta（永続所持データ）に反映する（M6.6 WP3：移動モデル）。
   *   deck   … run.deck の複製が保存デッキになる（次のランへそのまま持ち越し）。
   *            ラン中の売却で減った分は本に戻らない＝カードが世界から消える（§2-8）。
   *            旧セーブ由来の実体の空白(180)はここで捨てる（空白は実体で持たない）。
   *   book   … ラン中に本行きになった分（run.bookAdd）を加算。
   *   known  … ラン中に入手した種類（run.gainedCards）を登録。
   *            レンタル（run.rentals）は登録しない＝返却されて記憶にも残らない。 */
  function settle(run, meta) {
    CQCollection.ensure(meta);
    meta.deck = Object.assign({}, run.deck);
    delete meta.deck[BLANK];
    Object.keys(meta.deck).forEach(function (k) { if (meta.deck[k] <= 0) delete meta.deck[k]; });
    Object.keys(run.bookAdd || {}).forEach(function (k) {
      if (run.bookAdd[k] > 0) meta.book[k] = (meta.book[k] || 0) + run.bookAdd[k];
    });
    (run.gainedCards || []).forEach(function (id) { CQCollection.registerKnown(meta, id); });
    meta.gold = run.gold;
    if (run.outcome === 'win' && meta.cleared.indexOf(run.areaId) < 0) meta.cleared.push(run.areaId);
    return meta;
  }

  const api = {
    DECK_SIZE, BLANK, DRAFT_ROUNDS, buildBattleDeck, buildBossDeck, buildPlayerDeck,
    start, gainCard, beginDraftRound, applyDraft, draftTarget, hasBlankSlot, depart,
    node, currentNode, choices, advance,
    battleSeed, battleSetup, reportBattle,
    openChest, rest, shopPrice, shopBuy, shopHeal, shopClearFog, shopLeave,
    sell, exchangeLeave, resolveQuestion, retire, settle
  };
  global.CQRun = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
