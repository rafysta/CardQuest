/* CardQuest ラン — エリア定義（M6・M8.1で拡張）
 *
 * 『CardQuest マップ仕様書』§6「エリア選択画面」・§8「アセット」、
 * 『実装計画追補 M8』§1〜§3 に対応。
 *
 * 敵プールは手作業のリストを持たない。原作カードデータ（js/data.js の g テキスト＝
 * 戦利品ドロップ表の記載）にエリアの地形タグが含まれるものを拾う、データ駆動の方式にした
 * （実装計画の方針3「データ駆動」を踏襲）。
 *
 * M8.1（WP3）：山地・海辺・砂漠を追加。あわせて2つの型を一般化した：
 *   - `tags`（配列）：1エリアが複数の地形タグを束ねられるようにした（砂漠＋荒野の合流・§3-2）。
 *     旧来の単数 `tag` は廃止——DEFS は全エリア `tags` 配列で統一する。
 *   - `unlock`（オブジェクト）：`{ cleared: areaId }` ／ `{ level: N }` ／ `{ keys: N }` ／
 *     `{ card: cardId }` の4形（実装計画§4 WP3）。`isUnlocked(areaId, meta)` は meta 全体を
 *     見て判定する（旧来は cleared 配列だけを受け取っていた）。
 *   - `bossId` / `bossPool`：エリアのボスは「組」を持つ（実装計画§1-2 案B）。初回訪問
 *     （run.repeatVisit が false）は必ず `bossId`（顔＝肖像のある記録者）、2回目以降の
 *     周回は `bossPool` から抽選——選び方自体は js/run/run.js の bossMasterOf() が持つ
 *     （エリア定義はどのIDが組に居るかのデータだけ持てばよい）。
 *
 * DOMには依存しない。
 */
'use strict';
(function (global) {

  const CQCollection = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('../meta/collection.js') : global.CQCollection;
  const CQOpponents = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('../opponents.js') : global.CQOpponents;

  /* 敵デッキの支援シェル（技能13＋魔法7）。js/layout.js の SAMPLE_DECK 後半と同じ構成を使う。
   * 敵陣ごとに違う支援デッキを用意するのは実装計画M8（マスターデッキ抽出）の仕事。
   * それまでの間、この共通シェルにエリアの「花形」ユニットを混ぜて敵デッキとする
   * （マスターに bossId が付いたエリアは js/run/run.js buildBossDeck() が本物のデッキを
   * 優先して使うので、このシェルはボスには出番が無くなる——通常戦闘とまだ bossId の
   * 無いエリアのフォールバックにだけ使われる）。 */
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

  /** マスターの表示名（『title』name）。opponents.js に居ないIDや、そもそも
   * bossId が無いエリアでは null を返す——呼び出し側がエリア名などにフォールバックする。 */
  function masterDisplayName(masterId) {
    return (CQOpponents && CQOpponents.displayName) ? CQOpponents.displayName(masterId) : null;
  }

  const DEFS = {
    grassland: {
      id: 'grassland', name: '草原', tags: ['草原'], order: 0, act: 1,
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
      bossLp: 20, bossPriceMax: 4000,
      bossName: masterDisplayName(11) || 'マスター・草原の門番',
      /* M8.1 WP3（実装計画§1-2 案B）：顔＝11『占星士』コルーニャ、客分＝7（部屋に属さない）。 */
      bossId: 11, bossPool: [11, 7],
      fieldRuleChance: 0.25,        // 戦闘マスに戦場ルールが付く確率（追補§6・初期値）
      bossRank: 'rankC',            // マスター戦のＡＩ強さ（M7.10 WP1・ゲーム仕様書§5の帯）
      enemyCount: { normal: [1, 1], strong: 2, elite: 3 }  // 通常戦闘の敵体数（M7.10 WP3）
    },
    forest: {
      id: 'forest', name: '森', tags: ['森'], order: 1, act: 1,
      bg: 'assets/map/bg_forest.png', master: 'assets/masters/m_forest.png',
      unlock: { cleared: 'grassland' },   // 草原クリアで解放
      /* 森は下生えが手前まで迫っていて、明るい地面が草原より上・かつ狭い。
       * 上段を少し下げ、下段を少し上げて、開けた地面の帯の中に2行を収める。 */
      layout: { up: 16, down: -18, mid: 0 },
      fightMoney: 500,              /* 森もＣ級（M6.6 WP6・§2-6） */
      fog: { chance: 0.5 },         // マップ仕様書§5：森は初期値50%
      priceMax: 4200,
      eliteMin: 1800,
      rareTier: 'starter',          // 森も草原と同じ帯（経済追補§3-4）
      bossLp: 24, bossPriceMax: 8000,
      bossName: masterDisplayName(1) || 'マスター・森の隠者',
      /* M8.1 WP3：顔＝1『放火魔』マグドラ。客分は無し（実装計画§1-2の配置案どおり）。 */
      bossId: 1, bossPool: [1],
      fieldRuleChance: 0.35,
      bossRank: 'rankC',            // マスター戦のＡＩ強さ（M7.10 WP1・草原・森は同じ帯）
      enemyCount: { normal: [1, 2], strong: 2, elite: 3 }  // 通常戦闘の敵体数（M7.10 WP3）
    },
    mountain: {
      id: 'mountain', name: '山地', tags: ['山地'], order: 2, act: 1,
      bg: 'assets/map/bg_mountain.png', master: 'assets/masters/m_mountain.png',
      unlock: { cleared: 'forest' },      // 森クリアで解放（実装計画§1-3）
      layout: { up: 0, down: 0, mid: 0 }, // WP5でスクショを見てから詰める（§4-1の注記どおり）
      fightMoney: 1000,             // ゲーム仕様書§5・実装計画§3-1
      fog: { chance: 0.25 },
      priceMax: 3500,                // 山地タグ10種の最高値（アイスエイジ3000）に余裕を足した値
      eliteMin: 1600,
      rareTier: 'mid',
      /* M8.1 WP7（実装計画§4・予備計測）：近似AI（node tools/simulate-run.js --area=mountain）
       * で顔＝ルピア(5)のボス勝率が53〜57%と、草原・森（45〜47%）より高く出た——原作の格
       * （ルピアは原作でも「室C」相当でグリンジより軽いデッキ）がそのまま出た形。
       * ★bossLpを26→32、さらに45まで上げて追試したが勝率はほぼ動かなかった
       * （53.7%→51.2%。同じ乱数種での通し比較で勝敗がほぼ入れ替わらない＝この近似ＡＩの
       * 対戦では**LPが効くほど拮抗した終盤まで行っていない**ということ）。§6リスク表は
       * 「ずれたらbossLpで合わせる」としているが、この組み合わせでは効かないと分かった
       * ので**元の26に戻した**——的外れな数値のまま置くより、原作準拠の値を保つほうが
       * 安全と判断（実測はWP7の本計測・実機・--realでの大規模計測にゆだねる）。 */
      bossLp: 26, bossPriceMax: 8000,
      bossName: masterDisplayName(5) || 'マスター・山地の女盗賊',
      /* 実装計画§1-2：顔＝5『女盗賊』ルピア、客分＝15『異教の使徒』グリンジ。 */
      bossId: 5, bossPool: [5, 15],
      fieldRuleChance: 0.4,
      bossRank: 'rankB',
      enemyCount: { normal: [1, 2], strong: 2, elite: 3 }
    },
    coast: {
      id: 'coast', name: '海辺', tags: ['海Ｌ'], order: 3, act: 1,
      bg: 'assets/map/bg_coast.png', master: 'assets/masters/m_coast.png',
      unlock: { level: 2 },               // マスターレベル2（記憶データ20種）で解放（実装計画§1-3）
      layout: { up: 0, down: 0, mid: 0 },
      fightMoney: 1000,
      fog: { chance: 0.5 },
      priceMax: 5500,                // 海Ｌタグ6種の最高値（シーホースナイト5000）に余裕を足した値
      eliteMin: 2200,
      rareTier: 'mid',
      bossLp: 26, bossPriceMax: 8000,
      bossName: masterDisplayName(3) || 'マスター・海辺の傭兵',
      /* 実装計画§1-2：顔＝3『傭兵』ラリー、客分＝6『鬼爺』シュケール・4『魔女』グローナ。 */
      bossId: 3, bossPool: [3, 6, 4],
      fieldRuleChance: 0.4,
      bossRank: 'rankB',
      enemyCount: { normal: [1, 2], strong: 2, elite: 3 }
    },
    desert: {
      id: 'desert', name: '砂漠', tags: ['砂漠', '荒野'], order: 4, act: 1,
      /* 実装計画§3-2：砂漠タグは3種しか無いため、隣接する地形の荒野を合流させる
       * （ブレードライダー19・アントロイド51の入手経路もこれで立つ）。 */
      bg: 'assets/map/bg_desert.png', master: 'assets/masters/m_desert.png',
      unlock: { cleared: 'mountain' },    // 山地クリアで解放（実装計画§1-3）
      layout: { up: 0, down: 0, mid: 0 },
      fightMoney: 1500,
      fog: { chance: 0.25 },
      /* 荒野タグにブレードライダー19（26000Ｇ）という原作の外れ値が混ざるため、
       * priceMaxはそれを含められる高さにする（この1枚だけのために帯全体を歪めない
       * ——eliteMin側の絞り込みで「滅多に出ない大物」の手触りにする。実測はWP7で詰める）。 */
      priceMax: 28000,
      eliteMin: 2200,
      rareTier: 'high',
      bossLp: 28, bossPriceMax: 12000,
      bossName: masterDisplayName(9) || 'マスター・砂漠の吟遊詩人',
      /* 実装計画§1-2：顔＝9『吟遊詩人』ペゼッタ、客分＝2『呪術士』ギルダ・10『哲学者』ディルハイム。 */
      bossId: 9, bossPool: [9, 2, 10],
      fieldRuleChance: 0.45,
      bossRank: 'rankA',
      enemyCount: { normal: [1, 2], strong: [2, 3], elite: 3 }
    }
,

    /* ---- 第二幕：七つのダンジョン（M8.2 WP8・実装計画§3-1） --------------------------
     * 深度プールは「Ｌk＋Ｌk+1」（cave7だけＬ7のみ）。ボス＝七罪人は WP9 で全滅戦として
     * 実装するので、ここではまだ bossId を付けない（付けるとマスター戦＝ＬＰ勝負になる）。
     * 解放は cave1 だけマスターレベル3、あとは1つ前の洞窟の踏破。鍵は WP10。 */
    cave1: {
      id: 'cave1', name: 'ウォーターケイブ', tags: ['ダンジョン内Ｌ１', 'ダンジョン内Ｌ２'], order: 5, act: 2,
      bg: 'assets/map/bg_cave_water.png', master: 'assets/masters/m_sin_gluttony.png',
      unlock: { level: 3 },          // マスターレベル3（記憶データ52種）で第二幕へ
      layout: { up: 0, down: 0, mid: 0 },
      fightMoney: 1500,
      /* 暗闇（実装計画§3-1）＝霧の常時版。仕組みは霧そのままで、払えない（dispel:false）。 */
      fog: { chance: 1, dispel: false },
      priceMax: 6000,
      eliteMin: 1200,   /* 精鋭枠の下限：この深度のプールの上位が入る値（実測はWP12） */
      rareTier: 'high',
      /* 七罪人『大食』（原作の対戦相手ID 191）。M8.2 WP9で全滅戦（mode:'field'・3体配置・
       * 逃走不可）に差し替える。それまではボスマスに立てない＝bossIdを付けない。 */
      sinId: 191, sinName: '大食',
      bossName: '七罪人『大食』',
      bossLp: 30, bossPriceMax: 20000,
      fieldRuleChance: 0.45,
      bossRank: 'rankA',
      enemyCount: { normal: 2, strong: [2, 3], elite: 3 }
    },
    cave2: {
      id: 'cave2', name: 'デザートケイブ', tags: ['ダンジョン内Ｌ２', 'ダンジョン内Ｌ３'], order: 6, act: 2,
      bg: 'assets/map/bg_cave_sand.png', master: 'assets/masters/m_sin_envy.png',
      unlock: { cleared: 'cave1' },          // ウォーターケイブ をクリアすると開く
      layout: { up: 0, down: 0, mid: 0 },
      fightMoney: 1500,
      /* 暗闇（実装計画§3-1）＝霧の常時版。仕組みは霧そのままで、払えない（dispel:false）。 */
      fog: { chance: 1, dispel: false },
      priceMax: 6000,
      eliteMin: 1200,   /* 精鋭枠の下限：この深度のプールの上位が入る値（実測はWP12） */
      rareTier: 'high',
      /* 七罪人『嫉妬』（原作の対戦相手ID 196）。M8.2 WP9で全滅戦（mode:'field'・3体配置・
       * 逃走不可）に差し替える。それまではボスマスに立てない＝bossIdを付けない。 */
      sinId: 196, sinName: '嫉妬',
      bossName: '七罪人『嫉妬』',
      bossLp: 30, bossPriceMax: 20000,
      fieldRuleChance: 0.45,
      bossRank: 'rankA',
      enemyCount: { normal: 2, strong: [2, 3], elite: 3 }
    },
    cave3: {
      id: 'cave3', name: 'サウスウェストケイブ', tags: ['ダンジョン内Ｌ３', 'ダンジョン内Ｌ４'], order: 7, act: 2,
      bg: 'assets/map/bg_cave_sw.png', master: 'assets/masters/m_sin_sloth.png',
      unlock: { cleared: 'cave2' },          // デザートケイブ をクリアすると開く
      layout: { up: 0, down: 0, mid: 0 },
      fightMoney: 1500,
      /* 暗闇（実装計画§3-1）＝霧の常時版。仕組みは霧そのままで、払えない（dispel:false）。 */
      fog: { chance: 1, dispel: false },
      priceMax: 6000,
      eliteMin: 2000,   /* 精鋭枠の下限：この深度のプールの上位が入る値（実測はWP12） */
      rareTier: 'high',
      /* 七罪人『怠惰』（原作の対戦相手ID 193）。M8.2 WP9で全滅戦（mode:'field'・3体配置・
       * 逃走不可）に差し替える。それまではボスマスに立てない＝bossIdを付けない。 */
      sinId: 193, sinName: '怠惰',
      bossName: '七罪人『怠惰』',
      bossLp: 30, bossPriceMax: 20000,
      fieldRuleChance: 0.45,
      bossRank: 'rankA',
      enemyCount: { normal: 2, strong: [2, 3], elite: 3 }
    },
    cave4: {
      id: 'cave4', name: 'エメラルドケイブ', tags: ['ダンジョン内Ｌ４', 'ダンジョン内Ｌ５'], order: 8, act: 2,
      bg: 'assets/map/bg_cave_emerald.png', master: 'assets/masters/m_sin_pride.png',
      unlock: { cleared: 'cave3' },          // サウスウェストケイブ をクリアすると開く
      layout: { up: 0, down: 0, mid: 0 },
      fightMoney: 1500,
      /* 暗闇（実装計画§3-1）＝霧の常時版。仕組みは霧そのままで、払えない（dispel:false）。 */
      fog: { chance: 1, dispel: false },
      priceMax: 8000,
      eliteMin: 2500,   /* 精鋭枠の下限：この深度のプールの上位が入る値（実測はWP12） */
      rareTier: 'high',
      /* 七罪人『傲慢』（原作の対戦相手ID 194）。M8.2 WP9で全滅戦（mode:'field'・3体配置・
       * 逃走不可）に差し替える。それまではボスマスに立てない＝bossIdを付けない。 */
      sinId: 194, sinName: '傲慢',
      bossName: '七罪人『傲慢』',
      bossLp: 30, bossPriceMax: 20000,
      fieldRuleChance: 0.45,
      bossRank: 'rankA',
      enemyCount: { normal: 2, strong: [2, 3], elite: 3 }
    },
    cave5: {
      id: 'cave5', name: 'ボルカニックケイブ', tags: ['ダンジョン内Ｌ５', 'ダンジョン内Ｌ６'], order: 9, act: 2,
      bg: 'assets/map/bg_cave_volcanic.png', master: 'assets/masters/m_sin_lust.png',
      unlock: { cleared: 'cave4' },          // エメラルドケイブ をクリアすると開く
      layout: { up: 0, down: 0, mid: 0 },
      fightMoney: 1500,
      /* 暗闇（実装計画§3-1）＝霧の常時版。仕組みは霧そのままで、払えない（dispel:false）。 */
      fog: { chance: 1, dispel: false },
      priceMax: 8000,
      eliteMin: 3000,   /* 精鋭枠の下限：この深度のプールの上位が入る値（実測はWP12） */
      rareTier: 'high',
      /* 七罪人『淫欲』（原作の対戦相手ID 195）。M8.2 WP9で全滅戦（mode:'field'・3体配置・
       * 逃走不可）に差し替える。それまではボスマスに立てない＝bossIdを付けない。 */
      sinId: 195, sinName: '淫欲',
      bossName: '七罪人『淫欲』',
      bossLp: 30, bossPriceMax: 20000,
      fieldRuleChance: 0.45,
      bossRank: 'rankA',
      enemyCount: { normal: 2, strong: [2, 3], elite: 3 }
    },
    cave6: {
      id: 'cave6', name: 'クリスタルケイブ', tags: ['ダンジョン内Ｌ６', 'ダンジョン内Ｌ７'], order: 10, act: 2,
      bg: 'assets/map/bg_cave_crystal.png', master: 'assets/masters/m_sin_greed.png',
      unlock: { cleared: 'cave5' },          // ボルカニックケイブ をクリアすると開く
      layout: { up: 0, down: 0, mid: 0 },
      fightMoney: 1500,
      /* 暗闇（実装計画§3-1）＝霧の常時版。仕組みは霧そのままで、払えない（dispel:false）。 */
      fog: { chance: 1, dispel: false },
      priceMax: 20000,
      eliteMin: 5000,   /* 精鋭枠の下限：この深度のプールの上位が入る値（実測はWP12） */
      rareTier: 'high',
      /* 七罪人『強欲』（原作の対戦相手ID 192）。M8.2 WP9で全滅戦（mode:'field'・3体配置・
       * 逃走不可）に差し替える。それまではボスマスに立てない＝bossIdを付けない。 */
      sinId: 192, sinName: '強欲',
      bossName: '七罪人『強欲』',
      bossLp: 30, bossPriceMax: 20000,
      fieldRuleChance: 0.45,
      bossRank: 'rankA',
      enemyCount: { normal: 2, strong: [2, 3], elite: 3 }
    },
    cave7: {
      id: 'cave7', name: 'サウスイーストケイブ', tags: ['ダンジョン内Ｌ７'], order: 11, act: 2,
      bg: 'assets/map/bg_cave_se.png', master: 'assets/masters/m_sin_wrath.png',
      unlock: { cleared: 'cave6' },          // クリスタルケイブ をクリアすると開く
      layout: { up: 0, down: 0, mid: 0 },
      fightMoney: 2000,
      /* 暗闇（実装計画§3-1）＝霧の常時版。仕組みは霧そのままで、払えない（dispel:false）。 */
      fog: { chance: 1, dispel: false },
      /* Ｌ7だけの深度。ネクロスフィア（300000Ｇ）はここの精鋭としてだけ出す
       * （実装計画§3-5「ダンジョンＬ7 の精鋭・神殿」。ほかの洞窟はpriceMaxで弾く）。 */
      priceMax: 300000,
      eliteMin: 20000,   /* 精鋭枠の下限：この深度のプールの上位が入る値（実測はWP12） */
      rareTier: 'high',
      /* 七罪人『憤怒』（原作の対戦相手ID 197）。M8.2 WP9で全滅戦（mode:'field'・3体配置・
       * 逃走不可）に差し替える。それまではボスマスに立てない＝bossIdを付けない。 */
      sinId: 197, sinName: '憤怒',
      bossName: '七罪人『憤怒』',
      bossLp: 30, bossPriceMax: 20000,
      fieldRuleChance: 0.45,
      bossRank: 'rankA',
      enemyCount: { normal: 2, strong: [2, 3], elite: 3 }
    },

    /* ---- 第三幕：門と審判（M8.3 WP13・実装計画追補§3-5/§4） --------------------------
     * 神殿は「封印（モニュメント）」を持つ最初のエリア。初回訪問はエグゼデグゼス（カード15・
     * 原作の対戦相手ID215）との1体勝負（全滅戦・逃走不可）——js/run/run.js の
     * battleSetup()／bossMasterOf() が area.monumentCard を見て枝分かれする。勝てば
     * 倒し方に関わらず確定でカード15が手に入る（実装計画§1-1「案Bの注意」）。
     * 2回目以降は下の bossId／bossPool（12『竜使い』リンフォート／14『異端審問官』ルード）
     * の通常マスター戦に切り替わる。 */
    temple: {
      id: 'temple', name: '神殿', tags: ['ダンジョン内Ｌ６', 'ダンジョン内Ｌ７', '荒野'], order: 12, act: 3,
      bg: 'assets/map/bg_temple.png', master: 'assets/cards/15.webp',
      unlock: { keys: 7 },              // 七つの鍵がすべて揃うと開く（実装計画§1-3）
      layout: { up: 0, down: 0, mid: 0 },
      fightMoney: 2000,
      fog: { chance: 0 },
      /* Ｌ6＋Ｌ7＋荒野の合流タグ（cave7と同じくネクロスフィア30万Ｇを含められる高さ）。 */
      priceMax: 300000,
      eliteMin: 20000,
      rareTier: 'final',
      monumentCard: 15,
      monumentOpponentId: 215,
      bossName: '魔神『エグゼデグゼス』',
      bossId: 12, bossPool: [12, 14],
      bossLp: 30, bossPriceMax: 20000,
      fieldRuleChance: 0.45,
      bossRank: 'rankA',
      enemyCount: { normal: 2, strong: 3, elite: 3 }
    },

    /* 外部教会（M8.3 WP14・実装計画追補§3-5/§4）。解放はカード15（エグゼデグゼス）の所持。
     * 敵プールは地形タグではなく「2000Ｇ以上の全ユニット」（神竜9体・エグゼデグゼスを除く。
     * マスターズソウル(64)はenemyPool側で常に除外済み）——poolMode:'priceRange' を使う。
     * ボスは初回が『神官』バルザミコス（bossId:99）、2回目以降は13『奴隷戦士』ギンリットも
     * 混ざる（bossPool:[99,13]）。ルームＳ①〜④(16〜19)はエンディング後だけ混ざる予定
     * （M8.3 WP17で bossPool に足す。それまでは endingOnly のマスターが選ばれることはない）。 */
    church: {
      id: 'church', name: '外部教会', tags: [], order: 13, act: 3,
      bg: 'assets/map/bg_church.png', master: 'assets/masters/m_balsamicos.png',
      unlock: { card: 15 },
      layout: { up: 0, down: 0, mid: 0 },
      fightMoney: 2000,
      fog: { chance: 0 },
      poolMode: 'priceRange', priceMin: 2000, priceMax: 300000,
      poolExclude: [10, 11, 12, 13, 14, 15, 16, 17, 18],
      eliteMin: 20000,
      rareTier: 'final',
      bossName: '『神官』バルザミコス',
      bossId: 99, bossPool: [99, 13],
      bossLp: 40, bossPriceMax: 20000,
      fieldRuleChance: 0.45,
      bossRank: 'rankA',
      enemyCount: { normal: 2, strong: 3, elite: 3 }
    },

    /* 神竜の間（M8.3 WP16・実装計画§1-4「第三幕」の3枚目）。マップも「ラン」も無い、
     * 9体（8神竜＋マスターズソウル）への単発の1体勝負だけの場——エリア選択のタイルには
     * 出すが、js/run/run.js の CQRun.start() は一切使わない（js/run-ui.js が
     * CQRun.dragonBattleSetup() で直接バトル画面へ渡す）。unlock/isUnlocked・
     * unlockLabel・byAct はふつうのエリアと同じ仕組みで扱えるので、タグ・敵プール・
     * bossId など戦闘マス特有のフィールドは持たない（無くても他の関数は安全に素通りする）。
     * monumentCards＝js/meta/routes.js が「封印（モニュメント）を解く」経路を立てる先。 */
    dragons: {
      id: 'dragons', name: '神竜の間', order: 14, act: 3,
      bg: 'assets/map/bg_dragon_hall.png', master: null,
      unlock: { cleared: 'temple' },
      noMap: true,
      /* rareTier：神竜の間には店・敵プールが無いので実際には使わないが、「エリアは
       * どれもRARE_TIERSにある帯を持つ」という他エリア共通の不変条件（貴重カード閾値の
       * テスト・実装計画経済追補§3-4）は満たしておく。第三幕の他2エリアと同じ帯。 */
      rareTier: 'final',
      monumentCards: [10, 11, 12, 13, 14, 16, 17, 18, 64]
    }
  };
  const ORDER = ['grassland', 'forest', 'mountain', 'coast', 'desert',
    'cave1', 'cave2', 'cave3', 'cave4', 'cave5', 'cave6', 'cave7', 'temple', 'church', 'dragons'];

  /* M8.1 WP5（実装計画§1-4）：エリア選択画面の「幕」見出し（世界観§4）。
   * 幕1＝白紙（草原〜砂漠）・幕2＝七つの罪（M8.2でダンジョンが増える）・
   * 幕3＝門と審判（M8.3で神殿・外部教会・神竜の間が増える）。
   * いまはDEFSに幕2・3のエリアが1つも無い——存在しないエリアの見出しをここで
   * 決め打ちで出すと、実際の解放条件が固まる前に間違った案内をしてしまうので、
   * byAct() は実在するエリアがある幕しか返さない（§1-4の3段レイアウトの入れ物だけ
   * 先に用意しておき、幕2・3の行そのものはM8.2・M8.3でエリアが増えたときに
   * 自然に出てくる）。 */
  const ACT_TITLES = { 1: '白紙', 2: '七つの罪', 3: '門と審判' };

  function list() { return ORDER.map(function (id) { return DEFS[id]; }); }
  function get(id) { return DEFS[id] || null; }

  /** エリアを幕（act）ごとにまとめる（M8.1 WP5）。戻り値は幕番号の昇順、
   * [{ act, title, areas: [...] }]。エリアが1つも無い幕は返さない。 */
  function byAct() {
    const groups = {};
    list().forEach(function (a) {
      const act = a.act || 1;
      if (!groups[act]) groups[act] = [];
      groups[act].push(a);
    });
    return Object.keys(groups).map(Number).sort(function (a, b) { return a - b; })
      .map(function (act) { return { act: act, title: ACT_TITLES[act] || ('第' + act + '幕'), areas: groups[act] }; });
  }

  /** そのエリアの座標補正（M6.5b）。未定義のエリア・未定義の行は 0 として扱う。 */
  function layout(areaId) {
    const def = DEFS[areaId];
    return Object.assign({}, LAYOUT_DEFAULT, (def && def.layout) || {});
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
   * 原作の戦利品ドロップ表(gテキスト)に、このエリアの地形タグ（tags配列）のどれかを含むもの）。
   * 価格昇順。M8.1 WP3：1エリアが複数タグを持てるようにした（砂漠＋荒野の合流・§3-2）。 */
  function enemyPool(cards, areaId) {
    const def = DEFS[areaId];
    if (!def) return [];
    const tags = def.tags || [];
    const exclude = def.poolExclude || [];
    const res = [];
    Object.keys(cards).forEach(function (k) {
      const c = cards[k];
      if (c.t !== 'U' || c.id === 64) return;
      if (typeof c.p !== 'number' || c.p <= 0 || c.p > def.priceMax) return;
      if (exclude.indexOf(c.id) >= 0) return;
      /* M8.3 WP14（実装計画§3-5・church）：地形タグではなく「価格帯だけ」で選ぶエリア。
       * poolExclude（神竜・エグゼデグゼスなど、モニュメント専用ユニット）と合わせて使う。 */
      if (def.poolMode === 'priceRange') {
        if (c.p < (def.priceMin || 0)) return;
        res.push({ id: c.id, price: c.p });
        return;
      }
      if (typeof c.g !== 'string') return;
      if (tags.some(function (t) { return c.g.indexOf(t) >= 0; })) res.push({ id: c.id, price: c.p });
    });
    res.sort(function (a, b) { return a.price - b.price; });
    return res;
  }

  /** そのエリアの解放条件を満たしているか（実装計画M8 §4 WP3）。
   * meta … js/meta/save.js の永続所持データ（cleared / known / keys / deck など）。
   * unlock の形：
   *   null                  … 常に解放
   *   { cleared: areaId }   … 指定エリアをクリア済み
   *   { level: N }          … マスターレベルがN以上（記憶データの種類数から算出）
   *   { keys: N }           … 鍵をN本以上所持（M8.2・meta.keys）
   *   { card: cardId }      … 指定カードを所持／入手済み（M8.3・meta.deck か meta.known）
   * 後方互換：旧来 isUnlocked(areaId, clearedArray) で呼ばれても動くよう、第2引数が配列なら
   * { cleared: [...] } 相当のmetaとして扱う（tests/run.js・既存呼び出し元の移行漏れ対策）。 */
  function isUnlocked(areaId, meta) {
    const def = DEFS[areaId];
    if (!def) return false;
    const u = def.unlock;
    if (!u) return true;
    const m = Array.isArray(meta) ? { cleared: meta } : (meta || {});
    if (u.cleared) return (m.cleared || []).indexOf(u.cleared) >= 0;
    if (u.level) return masterLevel((m.known || []).length) >= u.level;
    if (u.keys) return (m.keys || []).length >= u.keys;
    if (u.card) {
      if (m.deck && m.deck[u.card] > 0) return true;
      return (m.known || []).indexOf(u.card) >= 0;
    }
    return true;
  }

  /** 未解放エリアのタイル表示用に、解放条件を1行の文で返す（マップ仕様書§6）。
   * 実装計画§4 WP5：エリア選択画面の暗転タイルに出す文言をここに集約する
   * （UI側が unlock の形を直接読まなくて済むように）。 */
  function unlockLabel(areaId) {
    const def = DEFS[areaId];
    const u = def && def.unlock;
    if (!u) return '';
    if (u.cleared) {
      const c = DEFS[u.cleared];
      return (c ? c.name : u.cleared) + 'をクリアすると解放';
    }
    if (u.level) {
      const idx = u.level - 2;
      const need = (idx >= 0 && MASTER_LEVEL_STEPS[idx] != null) ? MASTER_LEVEL_STEPS[idx] : null;
      return 'マスターレベル' + u.level + (need != null ? '（記憶データ' + need + '種）' : '') + 'で解放';
    }
    if (u.keys) return '鍵を' + u.keys + '本集めると解放';
    if (u.card) return 'カード' + u.card + 'を入手すると解放';
    return '';
  }

  const api = {
    DEFS, ORDER, SUPPORT_SHELL, LAYOUT_DEFAULT, MASTER_LEVEL_STEPS,
    RARE_TIERS, RARE_TIER_DEFAULT,
    list, get, layout, isUnlocked, unlockLabel, enemyPool, masterLevel, shopSpellPool, rareThreshold,
    ACT_TITLES, byAct
  };
  global.CQAreas = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
