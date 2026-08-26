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

  /* ---- 座標（§4：1280×800・1画面固定） --------------------------------- */
  const COL_X = [90, 280, 450, 620, 790, 960, 1130, 1170 + 100];   /* 開始…関門2マス目・ボスは後で上書き */
  COL_X[7] = 1210;
  const ROW_Y = { up: 415, down: 675, mid: 545 };

  function place(node, col, row) {
    node.col = col; node.row = row;
    node.x = COL_X[col]; node.y = ROW_Y[row];
    return node;
  }

  /* ---- 敵編成のロール ---------------------------------------------------- */
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
    const count = strength === 'elite' ? 3 : strength === 'strong' ? 3 : 2;
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

  function rollChest(rng, pool, rare) {
    const gold = rare ? rng.int(300, 500) : rng.int(80, 200);
    let cardId = null;
    if (rare || rng.next() < 0.6) {
      const cut = rare ? Math.max(1, Math.floor(pool.length * 0.5)) : 0;
      const cand = pool.slice(cut);
      if (cand.length) cardId = rng.pick(cand).id;
    }
    return { type: 'chest', rare: !!rare, gold: gold, cardId: cardId, opened: false };
  }

  function rollShop(rng, pool, area, fogActive) {
    const stock = [];
    const n = Math.min(4, pool.length);
    const bag = pool.slice();
    for (let i = 0; i < n && bag.length; i++) {
      const idx = rng.int(0, bag.length - 1);
      stock.push(bag.splice(idx, 1)[0].id);
    }
    return { type: 'shop', stock: stock, healCost: 100, fogClearCost: 100, hasFogClear: fogActive };
  }

  function makeNode(rng, area, pool, spec, fogActive) {
    if (spec.type === 'battle') return makeBattleNode(rng, area, pool, spec.strength);
    if (spec.type === 'chest') return rollChest(rng, pool, spec.rare);
    if (spec.type === 'shop') return rollShop(rng, pool, area, fogActive);
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

  /** おまかせドラフト3回分の新規候補（3枚ずつ・重複なし）。実際の置換対象・確定は
   * ラン開始マスで手番ごとに js/run/nodes.js が生きたデッキ状態から決める（§1.2）。 */
  function pickDraftPools(rng, pool, ownedIds) {
    const owned = ownedIds || [];
    const unowned = pool.filter(function (e) { return owned.indexOf(e.id) < 0; });
    const bag = (unowned.length >= 3 ? unowned : pool).slice();
    const used = {};
    const rounds = [];
    for (let r = 0; r < 3; r++) {
      const picks = [];
      const local = bag.filter(function (e) { return !used[e.id]; });
      const src = local.length >= 3 ? local : bag;
      for (let i = 0; i < 3 && src.length; i++) {
        const idx = rng.int(0, src.length - 1);
        const chosen = src.splice(idx, 1)[0];
        used[chosen.id] = true;
        picks.push(chosen.id);
      }
      rounds.push(picks);
    }
    return rounds;
  }

  /** ラン用の分岐マップを1つ生成する。
   * opts: { cards, areaId, seed, ownedIds } */
  function generate(opts) {
    const area = CQAreas.get(opts.areaId);
    if (!area) throw new Error('unknown area: ' + opts.areaId);
    const rng = (typeof require === 'function' && typeof module !== 'undefined' ? require('../engine/rng.js') : global.CQRng)
      .create(opts.seed);
    const pool = CQAreas.enemyPool(opts.cards, area.id);
    const fogActive = rng.next() < area.fog.chance;

    const [tplA, tplB] = pickSegTemplates(rng);
    const segTemplates = [tplA.key, tplB.key, GATE_TEMPLATE.key];

    const nodes = {};
    let autoId = 0;
    function add(spec, seg, branch, slot, col, row) {
      const id = 'n' + (autoId++);
      const n = makeNode(rng, area, pool, spec, fogActive);
      n.id = id; n.seg = seg; n.branch = branch; n.slot = slot;
      n.fog = fogActive && seg !== null && seg >= 1;   // §5：開始と第1セグメントは常に見える
      n.connectsTo = [];
      place(n, col, row);
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
        Object.assign(target, rollShop(rng, pool, area, true));
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

    return {
      seed: opts.seed, areaId: area.id, segTemplates: segTemplates,
      nodes: nodes, order: order, start: start, boss: boss,
      fog: { active: fogActive, cleared: !fogActive },
      draftPools: pickDraftPools(rng, pool, opts.ownedIds)
    };
  }

  const api = { TEMPLATES, GATE_TEMPLATE, EVENTS, generate, rollFieldRules, rollEnemy };
  global.CQMap = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
