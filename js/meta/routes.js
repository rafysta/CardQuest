/* CardQuest — カードの入手経路（M8.1 WP1）
 *
 * 『CardQuest 実装計画追補 M8』§1 結論3・§3-5・WP1 に対応。
 * 全169種（ユニット・魔法・技能。憑依カースと空白180、戦場ルール専用の「おじゃま虫」200は
 * 数えない）について、いまの実装で実際に届く経路（real:true）と、原作の記述はあるが
 * まだ実装していないエリア・仕組みに紐付く経路（real:false＝予定）を洗い出す。
 *
 * tools/coverage.js（CLI）が経路0本のカードをFAILとして検査するのに使うほか、
 * 将来のコレクション画面（入手ヒント表示・§2-4「g を表示に使うのをやめる」）からも
 * 同じ関数を呼ぶ想定——判定を2箇所に持たない。
 *
 * DOMには依存しない。
 */
'use strict';
(function (global) {

  function need(relPath) {
    return (typeof require === 'function' && typeof module !== 'undefined')
      ? require(relPath) : null;
  }
  const CQCollection = need('./collection.js') || global.CQCollection;
  const CQAreas = need('../run/areas.js') || global.CQAreas;
  const CQOpponents = need('../opponents.js') || global.CQOpponents;

  /* まだ実装していない地形タグ（実装計画M8 §3-2の地形タグ表）。カードの g テキストに
   * これが含まれていれば「原作の記述はある＝経路の見込みがある」が、対応するエリア・
   * 敵がまだ無いので real:false（予定）にする。milestone は実装予定の版（表示用）。
   * 山地・海Ｌ・砂漠・荒野は M8.1、沼地・ダンジョン内Ｌ・七罪人は M8.2、
   * 神殿モニュメントは M8.3（実装計画§0結論2・§3-1）。 */
  const PLANNED_TAGS = [
    { tag: '山地', milestone: 'M8.1' },
    { tag: '海Ｌ', milestone: 'M8.1' },
    { tag: '砂漠', milestone: 'M8.1' },
    { tag: '荒野', milestone: 'M8.1' },
    { tag: '沼地', milestone: 'M8.2' },
    { tag: 'ダンジョン内Ｌ', milestone: 'M8.2' },
    { tag: '七罪人', milestone: 'M8.2' },
    { tag: '神殿モニュメント', milestone: 'M8.3' }
  ];

  /* 原作でもどこからも入手できなかった2種（実装計画M8 §3-4・§3-5＝原作の詰み）。
   * CardQuest では神竜討伐報酬に置き換える（ニドヘッグ→連続攻撃・キリン→修練の拳）。
   * 神竜の間ができるまで（M8.3）は real:false（予定）。 */
  const DRAGON_FIX = {
    154: { label: 'ニドヘッグ討伐報酬（M8.3で実装予定・原作は入手不可だった穴埋め）' },
    187: { label: 'キリン討伐報酬（M8.3で実装予定・原作は入手不可だった穴埋め）' }
  };

  /** そのエリアが実装済みか（js/run/areas.js の DEFS にあるか）。 */
  function isRealArea(areaId) {
    return !!(CQAreas && CQAreas.get(areaId));
  }

  /** そのエリアのボスが「本物のマスターデッキ」まで配線済みか（M8.1 WP3・area.bossId）。
   * まだのうちはマスター報酬もルーム報酬も「予定」のまま——報酬を渡す仕組み自体が
   * まだ無い（WP4の仕事）ため。 */
  function bossWired(areaId) {
    const def = CQAreas && CQAreas.get(areaId);
    return !!(def && def.bossId);
  }

  /** その「部屋」（Ｃ／Ｂ／Ａ／Ｓ）の累計クリア報酬が実際に出るか（M8.1 WP4）。
   * 部屋はエリアの bossRank（'rankC'など）から取り出す——js/run/run.js の roomOf() と
   * 同じ規則だが、routes.js は run.js に依存させたくない（run.js は逆にareas.jsに依存する
   * だけの一方向にしておきたい）ので、1行のロジックをここでも独立して持つ。
   * その部屋に属する実装済みエリア（bossIdが付いている）が1つでもあれば real:true。 */
  function roomWired(room) {
    return !!(CQAreas && CQAreas.list().some(function (def) {
      return def.bossId && typeof def.bossRank === 'string' && def.bossRank.replace('rank', '') === room;
    }));
  }

  /** カード1枚ぶんの入手経路一覧。real:true が1つでもあれば現在の実装で到達できる。 */
  function routesFor(card, cards) {
    const routes = [];
    if (!card) return routes;

    /* ショップ（js/meta/collection.js shopPool と同じ判定＝魔法・技能だけ。
     * ユニットカードの g テキストにも「コレクション段階」の記載が残っている場合が
     * あるが、shopPool は種別で弾いているので実際には売られない＝経路として数えない）。 */
    if ((card.t === 'M' || card.t === 'S') && CQCollection && CQCollection.shopStageOf) {
      const stage = CQCollection.shopStageOf(card);
      if (stage != null) routes.push({ type: 'shop', real: true, label: `ログショップ（段階${stage}〜）` });
    }

    /* エリア戦利品（実装済みのエリアだけ real:true）。 */
    if (CQAreas) {
      CQAreas.list().forEach(function (def) {
        const pool = CQAreas.enemyPool(cards, def.id);
        if (pool.some(function (e) { return e.id === card.id; })) {
          routes.push({ type: 'area', real: true, area: def.id, label: `エリア戦利品：${def.name}` });
        }
      });
    }

    /* マスター初回撃破の固有報酬・部屋の累計クリア報酬（js/opponents.js §3-3）。
     * マスターがそのエリアの本物のボスとして配線される（bossWired）までは予定。 */
    if (CQOpponents) {
      Object.keys(CQOpponents.MASTERS).forEach(function (mid) {
        const m = CQOpponents.MASTERS[mid];
        if (m.reward !== card.id) return;
        const real = bossWired(m.area);
        const disp = (m.title ? '『' + m.title + '』' : '') + (m.name || `（マスター${mid}）`);
        routes.push({
          type: 'boss-reward', real: real, master: +mid, area: m.area,
          label: `マスター初回撃破：${disp}${real ? '' : '（' + m.area + 'のボス配線後）'}`
        });
      });
      Object.keys(CQOpponents.ROOM_REWARDS).forEach(function (room) {
        const idx = CQOpponents.ROOM_REWARDS[room].indexOf(card.id);
        if (idx < 0) return;
        const real = roomWired(room);
        routes.push({
          type: 'room-reward', real: real, room: room,
          label: `闘技場ルーム${room} 累計${[3, 5, 7][idx]}クリア報酬${real ? '' : '（未実装・予定）'}`
        });
      });
    }

    /* 原作の詰みの穴埋め（連続攻撃・修練の拳）。 */
    if (DRAGON_FIX[card.id]) routes.push(Object.assign({ type: 'dragon-fix', real: false }, DRAGON_FIX[card.id]));

    /* まだ実装していない地形タグ（原作の記述はある＝予定）。 */
    if (typeof card.g === 'string') {
      PLANNED_TAGS.forEach(function (p) {
        if (card.g.indexOf(p.tag) >= 0) {
          routes.push({ type: 'tag-planned', real: false, tag: p.tag, label: `${p.tag}（${p.milestone}で実装予定）` });
        }
      });
    }

    return routes;
  }

  /** 全169種（ユニット・魔法・技能。カース／空白／おじゃま虫は数えない）の一覧。id昇順。 */
  function realCardList(cards) {
    return Object.keys(cards || {}).map(function (k) { return cards[k]; })
      .filter(function (c) { return c && (c.t === 'U' || c.t === 'M' || c.t === 'S') && c.id !== 180 && c.id <= 199; })
      .sort(function (a, b) { return a.id - b.id; });
  }

  /** 網羅表本体。{ rows:[{id,name,status,routes}], summary:{total,ok,planned,fail} }。
   * status: 'OK'（実際に届く経路が1本以上）／'PLANNED'（予定の経路はある）／
   *         'FAIL'（経路が1本も無い＝設計の穴。実装計画§4 WP18でこれを0にする）。 */
  function coverageReport(cards) {
    const rows = realCardList(cards).map(function (c) {
      const routes = routesFor(c, cards);
      const real = routes.some(function (r) { return r.real; });
      const status = real ? 'OK' : (routes.length ? 'PLANNED' : 'FAIL');
      return { id: c.id, name: c.n, status: status, routes: routes };
    });
    const summary = {
      total: rows.length,
      ok: rows.filter(function (r) { return r.status === 'OK'; }).length,
      planned: rows.filter(function (r) { return r.status === 'PLANNED'; }).length,
      fail: rows.filter(function (r) { return r.status === 'FAIL'; }).length
    };
    return { rows: rows, summary: summary };
  }

  const api = { PLANNED_TAGS, DRAGON_FIX, isRealArea, bossWired, roomWired, routesFor, realCardList, coverageReport };
  global.CQRoutes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
