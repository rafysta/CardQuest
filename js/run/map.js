/* CardQuest ラン — 分岐マップ生成器（M6）
 *
 * 『CardQuest マップ仕様書』§1〜§5 に対応する専用生成器。confquest の genMap() は移植しない
 * （2026-08-25 本人確定）。シード付きRNG（js/engine/rng.js）で決定的に生成し、
 * 全マスの中身（敵編成・宝箱・ショップ在庫・？イベント・霧）をこの時点で確定する（§3）。
 * DOMには依存しない。座標だけは1280×800固定画面（§4）向けに計算して持たせる。
 */
'use strict';
(function (global) {

  const CQAreas = typeof require === 'function' && typeof module !== 'undefined'
    ? require('./areas.js') : global.CQAreas;
  const CQCollection = typeof require === 'function' && typeof module !== 'undefined'
    ? require('../meta/collection.js') : global.CQCollection;

  /* ---- §1.3 セグメントのペアテンプレート ------------------------------- */
  /* 表記は「1マス目→2マス目」。type は battle(strength) / chest(rare?) / shop / rest / exchange / question */
  const TEMPLATES = [
    { key: 'T1', A: [{ type: 'battle', strength: 'strong' }, { type: 'chest' }],
                 B: [{ type: 'battle', strength: 'normal' }, { type: 'rest' }] },
    { key: 'T2', A: [{ type: 'chest' }, { type: 'battle', strength: 'strong' }],
                 B: [{ type: 'rest' }, { type: 'battle', strength: 'normal' }] },
    { key: 'T3', A: [{ type: 'shop' }, { type: 'battle', strength: 'normal' }],
                 B: [{ type: 'battle', strength: 'normal' }, { type: 'question' }] },
    { key: 'T4', A: [{ type: 'exchange' }, { type: 'battle', strength: 'normal' }],
                 B: [{ type: 'battle', strength: 'normal' }, { type: 'chest' }] },
    { key: 'T5', A: [{ type: 'battle', strength: 'normal' }, { type: 'shop' }],
                 B: [{ type: 'battle', strength: 'strong' }, { type: 'exchange' }] },
    { key: 'T6', A: [{ type: 'question' }, { type: 'battle', strength: 'normal' }],
                 B: [{ type: 'chest' }, { type: 'battle', strength: 'strong' }] }
  ];
  /* 関門（第3セグメント固定）：精鋭は1ランに1つまで、という構造保証がここから生まれる */
  const GATE_TEMPLATE = {
    key: 'GATE', A: [{ type: 'battle', strength: 'elite' }, { type: 'chest', rare: true }],
                 B: [{ type: 'battle', strength: 'normal' }, { type: 'rest' }]
  };

  /* ？イベント（まず5種で開始。マップ仕様書§2「その他」・実装計画M6） */
  const EVENTS = [
    { id: 'spring', text: '澄んだ泉を見つけた。喉を潤すと、少しだけ力が湧いた気がする。', effect: { lp: 1 } },
    { id: 'trap', text: '足元の落とし穴に気づかず踏み抜いた。ケガをした。', effect: { lp: -1 } },
    { id: 'coin', text: '道端で誰かの落とし物の巾着を拾った。', effect: { gold: 150 } },
    { id: 'toll', text: '通行料を要求する怪しい門番がいた。仕方なく払った。', effect: { gold: -100 } },
    { id: 'stray', text: '迷い込んだログの欠片を回収した。手ごろな一枚が手に入りそうだ。', effect: { draftCard: true } }
  ];

  /* ---- 座標（§4：1280×800・1画面固定） ---------------------------------
   * 列ピッチは仕様の「約160px」に合わせて等間隔に取り直した（M6.5b）。
   * 旧配置は関門2マス目(1130)とボス(1210)が80pxしか離れておらず、ボスの絵（158px幅）が
   * 隣のマスと重なったうえ右端で見切れていた。ボスは 1186 まで戻し、他の列を詰めて
   * 均等な7区間にしてある。ノード幅の半分（ボス79px）を足しても画面内に収まる。
   * 行yは基準値。エリアごとの微調整は js/run/areas.js の layout（背景の道に合わせる補正）で行う。 */
  const COL_X = [76, 240, 398, 556, 714, 872, 1030, 1186];   /* 開始・S1×2・S2×2・関門×2・ボス */
  const ROW_Y = { up: 415, down: 675, mid: 545 };

  function place(node, col, row, layout) {
    node.col = col; node.row = row;
    node.x = COL_X[col]; node.y = ROW_Y[row] + ((layout && layout[row]) || 0);
    return node;
  }

  /* ---- 敵編成のロール ---------------------------------------------------- */
  /* 体数の既定（area.enemyCount が無いエリア用の後方互換値）。M7.10 WP3 以前と同じ。 */
  const DEFAULT_ENEMY_COUNT = { normal: 2, strong: 3, elite: 3 };

  /** その強さの体数を決める（M7.10 WP3・経済追補§5-4）。area.enemyCount にエリアごとの設定を持つ
   * （js/run/areas.js）。値が配列なら [下限, 上限] の範囲から rng で抽選（rngを1回消費する）、
   * 数値ならその体数で固定。未設定のエリアは DEFAULT_ENEMY_COUNT にフォールバックする。 */
  function enemyCountFor(rng, area, strength) {
    const spec = (area && area.enemyCount && area.enemyCount[strength] != null)
      ? area.enemyCount[strength] : DEFAULT_ENEMY_COUNT[strength];
    if (Array.isArray(spec)) return rng.int(spec[0], spec[1]);
    return spec;
  }

  /** strength に応じてプールから1体選ぶ（normal＝下位6割・strong＝上位4割・elite＝eliteMin以上） */
  function rollEnemy(rng, pool, area, strength) {
    if (!pool.length) return null;
    let cand;
    if (strength === 'elite') {
      cand = pool.filter(function (e) { return e.price >= area.eliteMin; });
      if (!cand.length) cand = pool.slice(-1);
    } else if (strength === 'strong') {
      const cut = Math.max(1, Math.floor(pool.length * 0.6));
      cand = pool.slice(cut);
      if (!cand.length) cand = pool.slice(-1);
    } else {
      const cut = Math.max(1, Math.ceil(pool.length * 0.6));
      cand = pool.slice(0, cut);
    }
    const pick = rng.pick(cand);
    const count = enemyCountFor(rng, area, strength);
    return { id: pick.id, price: pick.price, count: count };
  }

  /** 追補§6：戦闘マスに戦場ルールを1つだけ付ける（付けない場合が多い。精鋭・ボスは確定で付く） */
  function rollFieldRules(rng, area, strength) {
    const forced = strength === 'elite' || strength === 'boss';
    if (!forced && rng.next() >= area.fieldRuleChance) return [];
    const pool = ['noHighCH', 'bomb', 'laneCap', 'laneLock', 'pestCard'];
    const id = rng.pick(pool);
    if (id === 'noHighCH') return [{ id: id, max: rng.int(4, 5) }];
    if (id === 'bomb') return [{ id: id, period: rng.int(4, 6), layer: rng.int(3, 5) }];
    if (id === 'laneCap') return [{ id: id, cap: rng.int(2, 3), lanes: [rng.pick([0, 1, 2])] }];
    if (id === 'laneLock') return [{ id: id, lanes: [rng.pick([0, 1, 2])] }];
    return [{ id: id, period: rng.int(3, 4), target: 'self' }];
  }

  function makeBattleNode(rng, area, pool, strength) {
    const enemy = rollEnemy(rng, pool, area, strength);
    return {
      type: strength === 'elite' ? 'battle' : 'battle', strength: strength,
      enemy: enemy, fieldRules: rollFieldRules(rng, area, strength), cleared: false
    };
  }

  /** M6.6 WP8：宝箱の金額は「このマップに配置された敵編成から1体を選び、その定価の50%」
   * （10G単位に丸め・マップ生成時に確定＝決定的。§7-1）に変更した。ただし生成はマスを
   * 順番に作っていく途中で行われるため、この時点ではまだ他の敵が出揃っていない。
   * そのためここでは仮に0を入れておき、全ノードが揃った後（generate() の末尾）で
   * まとめて確定させる（fixChestGold 参照）。
   *
   * M7 WP3（経済追補§2-2）：宝箱のカード抽選テーブルから**モンスターを除外**した。
   * カードが出るときは必ず魔法・技能（spellPool＝ショップと同じ母集団。§2-1「戦利品・宝箱・
   * ショップ全体でモンスターに寄りすぎ」への対策）。rare時の上位半分ロジックは変更していない
   * （母集団を敵プールから魔法・技能プールへ差し替えただけ）。
   *
   * M7 WP4（第1段の効果測定）：非rare宝箱のカード出現確率を **0.6→0.8** に上げた。
   * `tools/simulate-run.js`（3000キャリア）の診断で、真のボトルネックは確率ではなく
   * **宝箱に到達できる回数そのもの**だと分かったため（1ランあたり平均0.38回しか宝箱を
   * 開けられておらず、67.5%のランは1回も開けられていない。これは戦闘の生存率——
   * つまりM7の範囲外の課題——に起因する）。確率を0.6→1.0まで振っても「魔法・技能0枚ラン」は
   * 77.3%→67.1%までしか下がらず（宝箱ゼロ回のランの下限に漸近する）、1.0では非rare宝箱の
   * Ｇ演出（§2-2が両方の演出を活かす理由に挙げていた「金貨がはじける」）が完全に消えてしまう。
   * 0.8は0.6比で0-枚ランを77.3%→72.4%まで改善しつつ、Ｇ演出を2割残す妥協点として選んだ
   * （経済追補§5-2に詳細記録）。**根本原因（宝箱到達率の低さ）はWP4の範囲外**——戦闘の
   * 生存率・先攻後攻差などバトルバランスの話（§5の対象外表）で、別途の版で扱うこと。 */
  function rollChest(rng, spellPool, rare) {
    let cardId = null;
    if (rare || rng.next() < 0.8) {
      const cut = rare ? Math.max(1, Math.floor(spellPool.length * 0.5)) : 0;
      const cand = spellPool.slice(cut);
      if (cand.length) cardId = rng.pick(cand).id;
    }
    return { type: 'chest', rare: !!rare, gold: 0, cardId: cardId, opened: false };
  }

  /** 全ノードが出揃った後、宝箱の金額をまとめて確定する（M6.6 WP8・§7-1）。
   * 対象は「このマップに実際に配置された敵編成」＝type==='battle' で敵が居るノード全部
   * （ボスは enemy が null なので自動的に除外される）。1体をランダムに選び、
   * その定価の50%を10G単位に丸めた額にする。配置された敵が万一0体のとき
   * （理論上は起きない）だけ、rare かどうかで控えめな既定額にフォールバックする。 */
  function fixChestGold(rng, nodes) {
    const roster = Object.keys(nodes)
      .map(function (id) { return nodes[id]; })
      .filter(function (nd) { return nd.type === 'battle' && nd.enemy; })
      .map(function (nd) { return nd.enemy; });
    Object.keys(nodes).forEach(function (id) {
      const nd = nodes[id];
      if (nd.type !== 'chest') return;
      const price = roster.length ? rng.pick(roster).price : (nd.rare ? 800 : 400);
      nd.gold = Math.round(price * 0.5 / 10) * 10;
    });
  }

  /** M7 WP3（経済追補§2-1・§3）：ショップ在庫は原作ドロップ表（敵プール）参照をやめ、
   * `CQCollection.shopPool()` からの抽選にした。母集団はラン開始時に一度だけ確定し
   * （generate() 側で計算した spellPool を毎回渡すだけ）、抽選そのものはシードで決定的。
   * モンスターは絶対に混ざらない（shopPool 自体がモンスターを返さないため）。 */
  function rollShop(rng, spellPool, fogActive) {
    const stock = [];
    const n = Math.min(4, spellPool.length);
    const bag = spellPool.slice();
    for (let i = 0; i < n && bag.length; i++) {
      const idx = rng.int(0, bag.length - 1);
      stock.push(bag.splice(idx, 1)[0].id);
    }
    return { type: 'shop', stock: stock, healCost: 100, fogClearCost: 100, hasFogClear: fogActive };
  }

  function makeNode(rng, area, pool, spellPool, spec, fogActive) {
    if (spec.type === 'battle') return makeBattleNode(rng, area, pool, spec.strength);
    if (spec.type === 'chest') return rollChest(rng, spellPool, spec.rare);
    if (spec.type === 'shop') return rollShop(rng, spellPool, fogActive);
    if (spec.type === 'rest') return { type: 'rest', cleared: false };
    if (spec.type === 'exchange') return { type: 'exchange', cleared: false };
    if (spec.type === 'question') {
      const ev = rng.pick(EVENTS);
      const n = { type: 'question', event: ev, resolved: false };
      if (ev.effect && ev.effect.draftCard && pool.length) n.cardId = rng.pick(pool).id;
      return n;
    }
    return { type: spec.type };
  }

  /** T3B・T6A は？を含む。1ランに最大1回にするため、片方が引かれたらもう片方の候補から外す */
  function pickSegTemplates(rng) {
    const hasQ = function (tpl) {
      return tpl.A.concat(tpl.B).some(function (n) { return n.type === 'question'; });
    };
    const first = rng.pick(TEMPLATES);
    let restPool = TEMPLATES.filter(function (t) { return t.key !== first.key; });
    if (hasQ(first)) restPool = restPool.filter(function (t) { return !hasQ(t); });
    const second = rng.pick(restPool.length ? restPool : TEMPLATES.filter(function (t) { return t.key !== first.key; }));
    return [first, second];
  }

  /** 1つのプールから候補3枚を引く。未入手（known に無い）を優先し、未入手だけでは
   * 3枚に満たないときだけ入手済みで補う（§1.2「未入手カードを優先」）。 */
  function pickThree(rng, pool, owned) {
    const unowned = pool.filter(function (e) { return owned.indexOf(e.id) < 0; });
    const bag = unowned.slice();
    if (bag.length < 3) {
      pool.forEach(function (e) {
        if (bag.length >= 3) return;
        if (bag.some(function (x) { return x.id === e.id; })) return;
        bag.push(e);
      });
    }
    const picks = [];
    const src = bag.slice();
    for (let i = 0; i < 3 && src.length; i++) {
      picks.push(src.splice(rng.int(0, src.length - 1), 1)[0].id);
    }
    return picks;
  }

  /** おまかせドラフトの新規候補（M6.6 WP4で3回→最大2回・回ごとに違うプールに変更）。
   *   1回目 … このエリアの敵プール（＝そのランで実際に狩れるモンスター。
   *            「試して気に入ったら狩りに行ける」ループがそのランの中で閉じる）
   *   2回目 … いまのマスターレベルで買える魔法・技能（＝街に戻れば手が届くもの）
   * どちらも未入手優先。実際に発生するかは開始マスで空白の有無を見て決まる（run.js）。
   * ※ 版を跨いで cq_run を再開したときのため、run.js 側は round が範囲外でも落ちないようにしてある。 */
  function pickDraftPools(rng, enemies, spells, ownedIds) {
    const owned = ownedIds || [];
    return [pickThree(rng, enemies, owned), pickThree(rng, spells, owned)];
  }

  /** ラン用の分岐マップを1つ生成する。
   * opts: { cards, areaId, seed, ownedIds } */
  function generate(opts) {
    const area = CQAreas.get(opts.areaId);
    if (!area) throw new Error('unknown area: ' + opts.areaId);
    const rng = (typeof require === 'function' && typeof module !== 'undefined' ? require('../engine/rng.js') : global.CQRng)
      .create(opts.seed);
    const pool = CQAreas.enemyPool(opts.cards, area.id);
    /* M7 WP3（経済追補§2-1・§3-3・§3-4）：ショップ在庫・宝箱カードの母集団。
     * ラン開始時のマスターレベル・そのエリアの貴重閾値で一度だけ確定する（決定的）。
     * 貴重（閾値以上）はラン中ショップ・宝箱には出さない（rare:'exclude'）——
     * 貴重カードの入手経路は買い取り所／ホームのログショップ限定枠／ボス報酬（経済追補§6-1）。 */
    const level = CQAreas.masterLevel((opts.ownedIds || []).length);
    const spellPool = CQCollection.shopPool(opts.cards, level,
      { rareAt: CQAreas.rareThreshold(area.id), rare: 'exclude' });
    const layout = CQAreas.layout(area.id);   /* 背景の道に合わせた行yの補正（M6.5b・§4） */
    const fogActive = rng.next() < area.fog.chance;

    const [tplA, tplB] = pickSegTemplates(rng);
    const segTemplates = [tplA.key, tplB.key, GATE_TEMPLATE.key];

    const nodes = {};
    let autoId = 0;
    function add(spec, seg, branch, slot, col, row) {
      const id = 'n' + (autoId++);
      const n = makeNode(rng, area, pool, spellPool, spec, fogActive);
      n.id = id; n.seg = seg; n.branch = branch; n.slot = slot;
      n.fog = fogActive && seg !== null && seg >= 1;   // §5：開始と第1セグメントは常に見える
      n.connectsTo = [];
      place(n, col, row, layout);
      nodes[id] = n;
      return id;
    }

    const start = add({ type: 'start' }, null, null, null, 0, 'mid');
    nodes[start].fog = false;

    const segDefs = [tplA, tplB, GATE_TEMPLATE];
    const segIds = [];
    for (let s = 0; s < 3; s++) {
      const tpl = segDefs[s];
      const colBase = 1 + s * 2;
      const a0 = add(tpl.A[0], s, 'A', 0, colBase, 'up');
      const a1 = add(tpl.A[1], s, 'A', 1, colBase + 1, 'up');
      const b0 = add(tpl.B[0], s, 'B', 0, colBase, 'down');
      const b1 = add(tpl.B[1], s, 'B', 1, colBase + 1, 'down');
      nodes[a0].connectsTo = [a1]; nodes[b0].connectsTo = [b1];
      segIds.push({ a0, a1, b0, b1 });
    }
    const boss = add({ type: 'boss' }, null, null, null, 7, 'mid');
    nodes[boss].enemy = null;
    nodes[boss].fieldRules = rollFieldRules(rng, area, 'boss');
    nodes[boss].fog = fogActive;

    /* 霧マップ制約（§5）：第1セグメントの片方の非戦闘マスを必ずショップにする */
    if (fogActive) {
      const seg0 = segDefs[0], ids0 = segIds[0];
      const nonBattleIds = [ids0.a0, ids0.a1, ids0.b0, ids0.b1].filter(function (id) { return nodes[id].type !== 'battle'; });
      const hasShop = nonBattleIds.some(function (id) { return nodes[id].type === 'shop'; });
      if (!hasShop && nonBattleIds.length) {
        const target = nodes[nonBattleIds[0]];
        Object.assign(target, rollShop(rng, spellPool, true));
        target.type = 'shop';
      }
    }

    /* 連結：開始→セグメント1の両分岐入口／各分岐の出口→次セグメントの両分岐入口（常に合流）／
       セグメント3の出口→ボス */
    nodes[start].connectsTo = [segIds[0].a0, segIds[0].b0];
    nodes[segIds[0].a1].connectsTo = [segIds[1].a0, segIds[1].b0];
    nodes[segIds[0].b1].connectsTo = [segIds[1].a0, segIds[1].b0];
    nodes[segIds[1].a1].connectsTo = [segIds[2].a0, segIds[2].b0];
    nodes[segIds[1].b1].connectsTo = [segIds[2].a0, segIds[2].b0];
    nodes[segIds[2].a1].connectsTo = [boss];
    nodes[segIds[2].b1].connectsTo = [boss];

    const order = [start];
    segIds.forEach(function (s) { order.push(s.a0, s.a1, s.b0, s.b1); });
    order.push(boss);

    /* M6.6 WP8：ここで全ノードの敵編成が出揃っているので、宝箱の金額を確定する。
     * fog対策（霧マップの片方を強制ショップにする処理）より後・returnより前に置く
     * ことで、ショップへ変わったノードは type!=='chest' として自然に除外される。 */
    fixChestGold(rng, nodes);

    return {
      seed: opts.seed, areaId: area.id, segTemplates: segTemplates,
      nodes: nodes, order: order, start: start, boss: boss,
      fog: { active: fogActive, cleared: !fogActive },
      /* ドラフト候補は「1回目＝このエリアの敵／2回目＝いま買える魔法・技能」（WP4）。
       * マスターレベルは記憶データの種類数から決まる（ゲーム仕様書§6.2）。 */
      draftPools: pickDraftPools(
        rng, pool,
        CQAreas.shopSpellPool(opts.cards, CQAreas.masterLevel((opts.ownedIds || []).length)),
        opts.ownedIds)
    };
  }

  const api = { TEMPLATES, GATE_TEMPLATE, EVENTS, generate, rollFieldRules, rollEnemy, enemyCountFor, DEFAULT_ENEMY_COUNT };
  global.CQMap = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
