/* CardQuest ラン — エリア定義（M6）
 *
 * 『CardQuest マップ仕様書』§6「エリア選択画面」・§8「アセット」に対応。
 * M6先行リリースの2エリア（草原・森）だけを定義する。以降のエリア追加は
 * このファイルにオブジェクトを1つ足すだけで済むようにしてある。
 *
 * 敵プールは手作業のリストを持たない。原作カードデータ（js/data.js の g テキスト＝
 * 戦利品ドロップ表の記載）にエリア名が含まれるものを拾う、データ駆動の方式にした
 * （実装計画の方針3「データ駆動」を踏襲）。マスター固有の実デッキ抽出（実装計画M8）が
 * 済むまでは、このプールと共通支援シェルを組み合わせて敵デッキを作る（js/run/nodes.js）。
 * DOMには依存しない。
 */
'use strict';
(function (global) {

  /* 敵デッキの支援シェル（技能13＋魔法7）。js/layout.js の SAMPLE_DECK 後半と同じ構成を使う。
   * 敵陣ごとに違う支援デッキを用意するのは実装計画M8（マスターデッキ抽出）の仕事。
   * それまでの間、この共通シェルにエリアの「花形」ユニットを混ぜて敵デッキとする。 */
  const SUPPORT_SHELL = [
    151, 158, 167, 169, 171, 172, 173, 177, 178, 179, 181, 183, 199,
    101, 104, 113, 117, 136, 143, 145
  ];

  const DEFS = {
    grassland: {
      id: 'grassland', name: '草原', tag: '草原', order: 0,
      bg: 'assets/map/bg_grassland.png', master: 'assets/masters/m_grassland.png',
      unlock: null,                 // 常に解放
      fog: { chance: 0 },           // マップ仕様書§5：草原は霧なし（初期値）
      priceMax: 2200,               // 通常・強敵プールの上限（このエリアの「入門」らしさの目安）
      eliteMin: 1200,               // 精鋭プールの下限
      bossLp: 20, bossPriceMax: 4000, bossName: 'マスター・草原の門番',
      fieldRuleChance: 0.25         // 戦闘マスに戦場ルールが付く確率（追補§6・初期値）
    },
    forest: {
      id: 'forest', name: '森', tag: '森', order: 1,
      bg: 'assets/map/bg_forest.png', master: 'assets/masters/m_forest.png',
      unlock: 'grassland',          // 草原クリアで解放
      fog: { chance: 0.5 },         // マップ仕様書§5：森は初期値50%
      priceMax: 4200,
      eliteMin: 1800,
      bossLp: 24, bossPriceMax: 8000, bossName: 'マスター・森の隠者',
      fieldRuleChance: 0.35
    }
  };
  const ORDER = ['grassland', 'forest'];

  function list() { return ORDER.map(function (id) { return DEFS[id]; }); }
  function get(id) { return DEFS[id] || null; }

  /** そのエリアの解放条件を満たしているか（cleared＝クリア済みエリアidの配列） */
  function isUnlocked(areaId, cleared) {
    const def = DEFS[areaId];
    if (!def) return false;
    if (!def.unlock) return true;
    return (cleared || []).indexOf(def.unlock) >= 0;
  }

  /** そのエリアの敵プール（type='U'・マスターズソウル(64)を除く・定価がこのエリアの上限以下・
   * 原作の戦利品ドロップ表(gテキスト)にエリア名を含むもの）。価格昇順。 */
  function enemyPool(cards, areaId) {
    const def = DEFS[areaId];
    if (!def) return [];
    const res = [];
    Object.keys(cards).forEach(function (k) {
      const c = cards[k];
      if (c.t !== 'U' || c.id === 64) return;
      if (typeof c.p !== 'number' || c.p <= 0 || c.p > def.priceMax) return;
      if (typeof c.g === 'string' && c.g.indexOf(def.tag) >= 0) res.push({ id: c.id, price: c.p });
    });
    res.sort(function (a, b) { return a.price - b.price; });
    return res;
  }

  const api = { DEFS, ORDER, SUPPORT_SHELL, list, get, isUnlocked, enemyPool };
  global.CQAreas = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
