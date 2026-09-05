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

  const CQCollection = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('../meta/collection.js') : global.CQCollection;

  /* 敵デッキの支援シェル（技能13＋魔法7）。js/layout.js の SAMPLE_DECK 後半と同じ構成を使う。
   * 敵陣ごとに違う支援デッキを用意するのは実装計画M8（マスターデッキ抽出）の仕事。
   * それまでの間、この共通シェルにエリアの「花形」ユニットを混ぜて敵デッキとする。 */
  const SUPPORT_SHELL = [
    151, 158, 167, 169, 171, 172, 173, 177, 178, 179, 181, 183, 199,
    101, 104, 113, 117, 136, 143, 145
  ];

  /* 座標補正テーブル（M6.5b）。マップ仕様書§4の基準座標（js/run/map.js の COL_X／ROW_Y）に対する
   * エリアごとの微調整で、背景の1枚絵に描かれた道の高さへノード列を寄せるためのもの。
   * up／down／mid は各行のyに足すピクセル数（正＝下へ）。省略時は0。
   * 1画面固定（1280×800・スクロールなし）は不変で、ここで動かすのは数px〜数十pxの範囲だけ。
   * 新しいエリアを足すときは、まず 0 のまま出してスクショを見てから詰めるのがよい。 */
  const LAYOUT_DEFAULT = { up: 0, down: 0, mid: 0 };

  /* 貴重カード閾値のエリア帯（M7 WP2・経済追補§3-4）。
   *
   * 「定価がこの額以上のカードはラン中ショップの品揃えに出ない」という上限であり、
   * 買い取り所（WP8）の割増価格（定価×1.5）の判定にも同じ値を使う。
   * 案A（品揃えの母集団はコレクション段階で全エリア共通）を採ったうえで、
   * 「難しいエリアほど良い品が買える」という案Bの旨味だけをこのツマミ1つに吸収したもの。
   *
   * ★数値はこの表**1箇所**だけに持ち、各エリア定義は帯の名前（rareTier）で参照する。
   *   エリアを足すときは帯を選ぶだけでよく、数字を書き写さない
   *   （M6.6 WP9 の売値で踏んだ「表示と実装がズレる」事故の再発防止。tests/run.js で固定）。
   * ★ホームのログショップは一律値（CQCollection.RARE_THRESHOLD_HOME）を使う。
   *   同じランの中で「貴重」の定義が2つあると事故るため、エリア別はラン側だけ（§3-4末尾）。 */
  const RARE_TIERS = {
    starter: 3000,     /* 草原・森（現行のまま） */
    mid: 5000,         /* 山地・海辺 */
    high: 8000,        /* 砂漠・ダンジョン群 */
    final: 12000       /* 神殿・外部教会 */
  };
  const RARE_TIER_DEFAULT = 'starter';

  const DEFS = {
    grassland: {
      id: 'grassland', name: '草原', tag: '草原', order: 0,
      bg: 'assets/map/bg_grassland.png', master: 'assets/masters/m_grassland.png',
      unlock: null,                 // 常に解放
      /* 草原の背景は地平線が高く、手前の砂地が広い。基準座標のままでちょうど道に乗る。 */
      layout: { up: 0, down: 0, mid: 0 },
      /* マスター撃破のファイトマネー（M6.6 WP6・§2-6。原作の闘技場賞金Ｃ級＝500G）。
       * すでにクリア済みのエリアを周回しているときは50%（run.js の reportBattle）。 */
      fightMoney: 500,
      fog: { chance: 0 },           // マップ仕様書§5：草原は霧なし（初期値）
      priceMax: 2200,               // 通常・強敵プールの上限（このエリアの「入門」らしさの目安）
      eliteMin: 1200,               // 精鋭プールの下限
      rareTier: 'starter',          // 貴重カード閾値の帯（M7 WP2・経済追補§3-4）
      bossLp: 20, bossPriceMax: 4000, bossName: 'マスター・草原の門番',
      fieldRuleChance: 0.25,        // 戦闘マスに戦場ルールが付く確率（追補§6・初期値）
      bossRank: 'rankC',            // マスター戦のＡＩ強さ（M7.10 WP1・ゲーム仕様書§5の帯）
      enemyCount: { normal: [1, 1], strong: 2, elite: 3 }  // 通常戦闘の敵体数（M7.10 WP3）
    },
    forest: {
      id: 'forest', name: '森', tag: '森', order: 1,
      bg: 'assets/map/bg_forest.png', master: 'assets/masters/m_forest.png',
      unlock: 'grassland',          // 草原クリアで解放
      /* 森は下生えが手前まで迫っていて、明るい地面が草原より上・かつ狭い。
       * 上段を少し下げ、下段を少し上げて、開けた地面の帯の中に2行を収める。 */
      layout: { up: 16, down: -18, mid: 0 },
      fightMoney: 500,              /* 森もＣ級（M6.6 WP6・§2-6） */
      fog: { chance: 0.5 },         // マップ仕様書§5：森は初期値50%
      priceMax: 4200,
      eliteMin: 1800,
      rareTier: 'starter',          // 森も草原と同じ帯（経済追補§3-4）
      bossLp: 24, bossPriceMax: 8000, bossName: 'マスター・森の隠者',
      fieldRuleChance: 0.35,
      bossRank: 'rankC',            // マスター戦のＡＩ強さ（M7.10 WP1・草原・森は同じ帯）
      enemyCount: { normal: [1, 2], strong: 2, elite: 3 }  // 通常戦闘の敵体数（M7.10 WP3）
    }
  };
  const ORDER = ['grassland', 'forest'];

  function list() { return ORDER.map(function (id) { return DEFS[id]; }); }
  function get(id) { return DEFS[id] || null; }

  /** そのエリアの座標補正（M6.5b）。未定義のエリア・未定義の行は 0 として扱う。 */
  function layout(areaId) {
    const def = DEFS[areaId];
    return Object.assign({}, LAYOUT_DEFAULT, (def && def.layout) || {});
  }

  /** そのエリアの解放条件を満たしているか（cleared＝クリア済みエリアidの配列） */
  function isUnlocked(areaId, cleared) {
    const def = DEFS[areaId];
    if (!def) return false;
    if (!def.unlock) return true;
    return (cleared || []).indexOf(def.unlock) >= 0;
  }

  /* マスターレベル（ゲーム仕様書§6.2・原作準拠）。記憶データ＝一度でも入手した種類数で決まる。
   * 20種→Lv2・52種→Lv3・100種→Lv4・168種→Lv5。ショップの品揃え段階はこのレベルと同じ数字
   * （原作カードデータの g テキスト「コレクション段階n〜」の n がその段階）。
   *
   * ★M7 WP2 で**実装そのものは js/meta/collection.js へ移した**。記憶データから決まる値は
   *   ラン側だけのものではなく、ホーム（図鑑・ログショップ・デッキ編集）でも同じ数字が要るため。
   *   ここに残しているのは既存の呼び出し元（js/run/map.js のドラフト候補）のための転送だけで、
   *   計算は1箇所にしかない。 */
  const MASTER_LEVEL_STEPS = CQCollection.STAGE_STEPS;

  /** 記憶データ（known）の種類数からマスターレベルを出す（1〜5）。→ CQCollection へ委譲。 */
  function masterLevel(knownCount) { return CQCollection.masterLevel(knownCount); }

  /** いまショップで買える魔法・技能（M6.6 WP4・おまかせドラフト2回目の候補プール）。
   * → CQCollection.shopPool へ委譲。おまかせドラフトは貴重カードも候補に出てよい
   * （マップ仕様書§1.2）ので、貴重の絞り込みは掛けない。 */
  function shopSpellPool(cards, level) { return CQCollection.shopPool(cards, level); }

  /** そのエリアの貴重カード閾値（M7 WP2・経済追補§3-4）。定価がこの額以上なら貴重＝
   * ラン中ショップの品揃えに出ない／買い取り所では定価×1.5。
   * 未定義のエリアIDでも落ちないよう既定の帯（草原・森と同じ3000Ｇ）を返す。 */
  function rareThreshold(areaId) {
    const def = DEFS[areaId];
    const tier = (def && def.rareTier) || RARE_TIER_DEFAULT;
    return RARE_TIERS[tier] != null ? RARE_TIERS[tier] : RARE_TIERS[RARE_TIER_DEFAULT];
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

  const api = {
    DEFS, ORDER, SUPPORT_SHELL, LAYOUT_DEFAULT, MASTER_LEVEL_STEPS,
    RARE_TIERS, RARE_TIER_DEFAULT,
    list, get, layout, isUnlocked, enemyPool, masterLevel, shopSpellPool, rareThreshold
  };
  global.CQAreas = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
