/* CardQuest ラン — 対戦相手データ（M8.1 WP2）
 *
 * 『CardQuest 実装計画追補 M8』§2-2・§3-3 に対応。原作『SOUL GATE ver1.16』の
 * 闘技場マスター18人＋ラスボス『神官バルザミコス』のデッキ（`09_setup_decks.md` から
 * 抽出済み・原作どおり50枚）を、CardQuest のデッキ規則（40枚）に変換して持つ。
 *
 * このファイルは js/data.js から `DECKS`（原作50枚デッキ・王手データ）を引き取った
 * ——data.js 側では誰にも参照されていなかった生データで、変換して使うのはここが最初で
 * 唯一の場所のため、二重管理を避けてこちらへ丸ごと移した。
 *
 * DOMには依存しない。cards（CARD_BY_ID）は変換時の定価参照にだけ使う（省略可）。
 */
'use strict';
(function (global) {

  /* ---- 原作の対戦相手データ（09_setup_decks.md §2-1・§2-2 から抽出・50枚） --------
   * キー＝V340（対戦相手ID）。1〜7・9〜19＝闘技場マスター（8番は原作でも未使用・
   * デッキ定義が無い＝到達不能枠）。99＝ラスボス『神官バルザミコス』。
   * 116・119・129・144・161・163・164・166・171・172＝原作フリーユニット戦（相手ID≧101）の
   * 敵デッキで、M8.1 では未使用（WP6 で通常戦闘の敵デッキの種として使う予定・任意）。 */
  const RAW_DECKS = {"16":{"38":3,"39":3,"40":2,"30":2,"46":2,"101":3,"108":3,"109":1,"153":2,"139":2,"124":2,"133":2,"102":3,"111":2,"143":2,"117":3,"152":2,"158":2,"181":2,"192":2,"151":3,"155":2},"17":{"72":3,"58":3,"51":3,"24":3,"32":2,"73":2,"101":3,"108":3,"109":1,"153":3,"133":2,"118":2,"117":2,"126":3,"182":2,"197":2,"162":3,"170":3,"167":2,"190":3},"18":{"55":3,"62":3,"36":2,"25":2,"10":1,"11":1,"12":1,"101":3,"108":2,"153":3,"133":2,"134":2,"123":1,"103":3,"138":2,"111":2,"102":2,"135":1,"165":2,"168":2,"188":2,"175":3,"193":3,"199":2},"19":{"63":3,"42":2,"66":1,"44":2,"31":2,"16":2,"101":3,"108":3,"109":1,"153":3,"133":2,"123":1,"134":2,"102":2,"117":3,"120":2,"116":2,"169":2,"154":1,"177":2,"165":2,"168":2,"172":2,"152":3},"99":{"38":1,"39":1,"58":1,"55":1,"62":1,"63":1,"72":3,"57":1,"60":1,"15":1,"18":1,"11":1,"101":3,"30":3,"108":2,"153":2,"102":2,"143":3,"117":3,"120":2,"134":1,"135":1,"198":1,"190":2,"169":2,"151":1,"175":1,"154":2,"187":2,"158":2,"177":1},"15":{"24":3,"20":3,"73":2,"28":2,"51":3,"34":2,"46":2,"30":2,"101":3,"108":3,"109":2,"153":3,"114":1,"117":3,"135":2,"104":1,"126":1,"169":3,"190":1,"197":2,"170":3,"162":2,"180":1},"14":{"16":3,"40":2,"46":2,"57":3,"60":3,"30":2,"101":3,"134":1,"108":3,"109":1,"153":3,"111":1,"117":3,"102":3,"120":2,"143":2,"123":2,"181":1,"187":2,"167":1,"177":2,"165":2,"193":2,"180":1},"13":{"42":3,"71":2,"69":3,"67":2,"66":2,"40":2,"101":3,"133":2,"134":3,"108":3,"109":3,"153":2,"102":2,"117":2,"135":1,"118":3,"111":2,"187":3,"169":3,"167":3,"180":1},"12":{"35":3,"27":2,"11":1,"10":1,"13":2,"59":3,"25":1,"30":2,"40":2,"101":3,"108":3,"133":1,"134":2,"153":3,"117":2,"118":1,"102":2,"121":2,"112":2,"135":1,"152":2,"168":2,"185":1,"154":2,"183":1,"167":2,"180":1},"11":{"50":2,"32":3,"23":2,"1":3,"33":2,"101":3,"108":3,"109":1,"133":3,"153":3,"117":2,"110":2,"113":2,"124":1,"114":2,"157":1,"160":2,"172":3,"165":2,"193":2,"159":2,"180":4},"10":{"17":2,"61":3,"5":2,"25":1,"21":2,"26":2,"101":3,"108":3,"153":3,"117":2,"134":3,"30":1,"184":3,"154":3,"152":2,"183":3,"165":2,"191":2,"187":2,"175":2,"190":2,"158":1,"180":1},"9":{"40":2,"51":3,"5":2,"19":3,"24":2,"56":1,"30":1,"101":3,"108":3,"109":2,"153":3,"117":2,"133":1,"111":2,"118":2,"143":2,"123":2,"158":2,"190":2,"175":2,"170":3,"152":2,"192":2,"180":1},"7":{"160":2,"104":2,"47":2,"46":2,"73":2,"23":1,"27":2,"28":2,"51":3,"30":2,"101":3,"108":2,"133":2,"109":2,"153":2,"117":2,"135":3,"140":2,"154":1,"170":3,"175":3,"176":3,"185":3},"6":{"30":2,"71":3,"40":2,"20":3,"37":3,"33":2,"101":3,"108":3,"109":3,"104":2,"123":2,"115":3,"130":3,"112":1,"156":2,"155":3,"169":3,"160":1,"167":3,"190":2,"180":1},"5":{"48":3,"27":2,"40":3,"31":2,"49":3,"101":3,"108":3,"133":2,"109":2,"153":3,"129":3,"111":2,"113":3,"117":2,"155":2,"193":2,"157":2,"165":2,"197":3,"180":4},"4":{"59":3,"43":2,"37":2,"33":3,"52":3,"30":3,"101":3,"108":1,"134":2,"153":3,"129":2,"117":3,"111":2,"102":3,"135":2,"120":3,"143":2,"116":2,"138":1,"174":2,"151":2,"180":1},"3":{"42":2,"41":3,"40":2,"36":2,"20":2,"7":2,"33":2,"101":3,"108":3,"133":3,"109":1,"111":1,"153":3,"104":2,"118":1,"102":2,"134":1,"117":2,"158":1,"169":2,"162":2,"154":2,"151":1,"183":2,"193":2,"180":1},"2":{"71":2,"68":2,"25":2,"65":1,"69":2,"66":2,"28":2,"101":3,"108":3,"109":2,"133":3,"111":2,"143":2,"115":2,"118":3,"103":2,"136":2,"104":2,"155":2,"175":1,"167":2,"178":2,"164":1,"152":2,"180":1},"1":{"5":3,"56":2,"3":2,"40":3,"27":1,"46":2,"101":3,"108":3,"109":2,"133":3,"153":2,"117":3,"111":2,"112":1,"106":2,"104":2,"155":2,"157":3,"170":2,"197":3,"180":4},"161":{"8":3,"22":5,"5":5,"180":4,"7":5,"101":2,"112":1,"133":3,"108":3,"109":2,"136":2,"105":2,"111":2,"117":2,"113":2,"155":3,"153":2,"171":2,"172":1,"170":1,"164":2,"165":2,"193":2,"194":2},"163":{"44":3,"3":3,"28":3,"101":3,"112":1,"119":2,"133":3,"108":3,"131":2,"104":2,"107":2,"144":2,"117":2,"113":1,"155":3,"153":3,"157":2,"161":3,"167":1,"163":2,"165":2,"193":2,"172":2,"171":2,"175":2},"164":{"56":5,"30":3,"101":3,"109":2,"114":2,"133":3,"108":3,"102":1,"104":2,"118":1,"135":3,"117":2,"113":1,"110":3,"103":2,"134":1,"112":3,"153":3,"151":2,"161":3,"186":2,"176":2},"166":{"68":2,"71":3,"65":2,"66":1,"30":2,"73":3,"70":2,"69":1,"101":3,"112":2,"102":1,"133":3,"108":3,"109":2,"148":3,"136":2,"145":2,"117":2,"137":2,"178":3,"153":3,"198":2,"158":2,"152":1,"154":2,"196":2,"182":2},"116":{"23":5,"31":2,"33":2,"101":3,"112":3,"126":3,"117":3,"133":3,"110":2,"108":3,"109":2,"114":1,"155":1,"153":3,"159":2,"193":2,"164":3,"173":1,"168":1,"161":1,"175":2,"160":2},"119":{"65":3,"68":3,"5":3,"101":3,"112":3,"117":3,"133":3,"113":2,"108":3,"109":2,"148":3,"124":3,"153":3,"160":2,"152":1,"198":2,"161":2,"163":1,"175":2,"197":2},"129":{"47":1,"26":2,"9":5,"101":3,"112":3,"147":2,"117":3,"133":3,"108":3,"110":3,"136":3,"192":3,"153":3,"170":3,"193":2,"175":3,"183":2,"176":3,"169":1},"144":{"67":4,"30":6,"101":3,"117":2,"133":3,"104":2,"118":2,"108":3,"131":3,"129":3,"153":3,"198":3,"159":2,"192":2,"185":2,"164":2,"196":1,"182":1,"188":1},"171":{"46":3,"33":5,"195":2,"188":3,"163":3,"157":2,"194":3,"183":2,"193":3,"153":3,"198":3,"179":2,"192":2,"165":3,"197":3},"172":{"51":8,"101":3,"117":2,"133":3,"110":3,"109":2,"108":3,"135":3,"153":3,"160":3,"181":1,"185":2,"164":2,"170":3,"154":1,"168":1,"187":1}};

  const DECK_SIZE = 40;
  const BLANK = 180;

  /* ---- 50枚→40枚の変換（実装計画M8 §2-2の規則） -----------------------------
   * ①空白(180)は除く（そもそも埋め草なので変換前に丸ごと捨てる）
   * ②ユニット（id 1〜100）は全部残す（デッキの骨格＝相手の「顔」を保つ）
   * ③魔法・技能（id 101以上）は、いま一番多く入っている種類から1枚ずつ削って
   *   40枚に揃える（種類は減らさず枚数を削る＝デッキの色を保つ）。
   *   同数タイの場合は定価の安いほう（＝より汎用的な脇役）から削る。
   * cards（CARD_BY_ID）は定価参照専用。省略すると全カード定価0扱い＝id順のタイ
   * 崩れになるだけで、変換結果の総枚数・ユニット温存には影響しない。 */
  function convert50to40(deck, cards) {
    const priceOf = cards || {};
    const entries = {};
    Object.keys(deck || {}).forEach(function (k) {
      const id = Number(k);
      if (id === BLANK) return;              /* ①空白を除く */
      entries[id] = deck[k];
    });
    let total = 0;
    Object.keys(entries).forEach(function (id) { total += entries[id]; });
    let excess = total - DECK_SIZE;
    let guard = 0;
    while (excess > 0 && guard < 1000) {
      guard++;
      let bestId = null, bestCount = -1, bestPrice = Infinity;
      Object.keys(entries).forEach(function (k) {
        const id = Number(k);
        if (id < 101) return;                /* ②ユニットは削らない */
        const count = entries[id];
        if (count <= 0) return;
        const price = (priceOf[id] && typeof priceOf[id].p === 'number') ? priceOf[id].p : 0;
        if (count > bestCount || (count === bestCount && price < bestPrice)) {
          bestCount = count; bestPrice = price; bestId = id;
        }
      });
      if (bestId == null) break;             /* 安全弁：魔法・技能が尽きたら止める */
      entries[bestId] -= 1;
      if (entries[bestId] <= 0) delete entries[bestId];
      excess -= 1;
    }
    return entries;
  }

  /** {id:count} → カードIDの配列（id昇順に展開。戦闘エンジンはただの多重集合として扱うので順序に意味はない）。 */
  function toIdArray(deckMap) {
    const out = [];
    Object.keys(deckMap).map(Number).sort(function (a, b) { return a - b; }).forEach(function (id) {
      for (let i = 0; i < deckMap[id]; i++) out.push(id);
    });
    return out;
  }

  /* ---- マスター表（実装計画M8 §3-3・§1-2） -----------------------------------
   * id: 原作 V340。name/title: 原作の表示名（『title』name）。
   * room: 闘技場の部屋（C/B/A/S）。7 と 16〜19 は原作でも名前が無い枠。
   * area: このマスターが登場するエリアid（§1-2 案B の配置案）。
   * role: 'face'（エリア初回訪問で必ず出る顔）／'guest'（2回目以降の周回で抽選に混ざる客分）／
   *        'final'（そのエリアの物語上のボス。周回鑑賞では出ない）。
   * reward: そのマスターを初めて降したときに渡す固有カードID（§3-3表）。
   *          原作に無い場合（7・15・13）は原作の別経路（発掘限定・ショップ限定など）の
   *          カードをここで割り当てて、入手経路の穴を塞ぐ（M8実装計画§3-5）。
   * origLp: 原作のＬＰ（09_setup_decks.md §2-1、V1415相当）。参考値——CardQuest 側の
   *          実際のＬＰはエリア定義（js/run/areas.js の bossLp）が持つ独自の値を使う。 */
  const MASTERS = {
    11: { name: 'コルーニャ', title: '占星士', room: 'C', area: 'grassland', role: 'face', reward: 117, origLp: 10 },
    1: { name: 'マグドラ', title: '放火魔', room: 'C', area: 'forest', role: 'face', reward: 160, origLp: 10 },
    5: { name: 'ルピア', title: '女盗賊', room: 'C', area: 'mountain', role: 'face', reward: 129, origLp: 10 },
    15: { name: 'グリンジ', title: '異教の使徒', room: 'B', area: 'mountain', role: 'guest', reward: 157, origLp: 13 },
    3: { name: 'ラリー', title: '傭兵', room: 'B', area: 'coast', role: 'face', reward: 182, origLp: 13 },
    6: { name: 'シュケール', title: '鬼爺', room: 'B', area: 'coast', role: 'guest', reward: 167, origLp: 13 },
    4: { name: 'グローナ', title: '魔女', room: 'A', area: 'coast', role: 'guest', reward: 186, origLp: 14 },
    9: { name: 'ペゼッタ', title: '吟遊詩人', room: 'A', area: 'desert', role: 'face', reward: 183, origLp: 14 },
    2: { name: 'ギルダ', title: '呪術士', room: 'B', area: 'desert', role: 'guest', reward: 188, origLp: 13 },
    10: { name: 'ディルハイム', title: '哲学者', room: 'A', area: 'desert', role: 'guest', reward: 151, origLp: 15 },
    12: { name: 'リンフォート', title: '竜使い', room: 'A', area: 'temple', role: 'guest', reward: 103, origLp: 15 },
    14: { name: 'ルード', title: '異端審問官', room: 'A', area: 'temple', role: 'guest', reward: 179, origLp: 15 },
    13: { name: 'ギンリット', title: '奴隷戦士', room: 'A', area: 'church', role: 'guest', reward: 61, origLp: 15 },
    16: { name: 'ルームＳ①', title: null, room: 'S', area: 'church', role: 'guest', endingOnly: true, reward: 137, origLp: 15 },
    17: { name: 'ルームＳ②', title: null, room: 'S', area: 'church', role: 'guest', endingOnly: true, reward: 184, origLp: 15 },
    18: { name: 'ルームＳ③', title: null, room: 'S', area: 'church', role: 'guest', endingOnly: true, reward: 141, origLp: 15 },
    19: { name: 'ルームＳ④', title: null, room: 'S', area: 'church', role: 'guest', endingOnly: true, reward: 120, origLp: 15 },
    7: { name: null, title: null, room: null, area: 'grassland', role: 'guest', reward: 147, origLp: 13 },
    99: { name: 'バルザミコス', title: '神官', room: 'final', area: 'church', role: 'final', reward: 199, origLp: 15 }
  };

  /* 部屋の累計クリア報酬（実装計画M8 §3-3・エリアの累計クリア3／5／7回で渡す）。
   * 実際の付与（meta.clears の加算とタイミング）はWP4の仕事。ここはデータだけ持つ。
   * 3枚目が無い部屋（S帯の2枚目＝原作でもクローン無し）は null。 */
  const ROOM_REWARDS = {
    C: [110, 196, 143],
    B: [123, 157, 177],
    A: [135, 102, 174],
    S: [199, null, 60]
  };

  /* 神竜の間（実装計画M8.3 §3-4・M8.3 WP16）。8神竜＋マスターズソウルの9体。
   * キーは**カードid**（10〜18・64）——MASTERS のキー（闘技場マスターのopponentId）とは
   * 別の namespace なので、13（ニドヘッグのカードid）と MASTERS[13]（ギンリット）が
   * 数字として重なっても混線しない（meta側もmeta.dragonWinsをmeta.bossWinsと別に持つ）。
   * opponentId は 500+カードid（既存の範囲＝マスター1〜99・900番台のフリーユニット・
   * 神殿モニュメントの215と重ならない専用の帯）。
   * sacrifice：{id,n}の配列。本にある分だけを見る（デッキ分は対象外＝実装計画§3-4の注意）。
   * first：初めて倒したときだけ追加で渡すカード（原作の詰みの穴埋め・実装計画§3-4）。
   * requireLevel：マスターズソウルだけ、捧げ物に加えてマスターレベルも見る。
   * trueEnding：マスターズソウルだけ。初めて倒すと台本§13.9「真の結末」を見せる。 */
  const DRAGONS = {
    10: { name: 'ヨルムンガンド', foeName: '神竜『ヨルムンガンド』', opponentId: 510,
      sacrifice: [{ id: 174, n: 1 }, { id: 120, n: 1 }, { id: 169, n: 1 }] },
    11: { name: 'ケツァルコアトル', foeName: '神竜『ケツァルコアトル』', opponentId: 511,
      sacrifice: [{ id: 191, n: 1 }, { id: 188, n: 1 }, { id: 187, n: 1 }] },
    12: { name: 'ウロボロス', foeName: '神竜『ウロボロス』', opponentId: 512,
      sacrifice: [{ id: 177, n: 1 }, { id: 154, n: 1 }, { id: 143, n: 1 }] },
    13: { name: 'ニドヘッグ', foeName: '神竜『ニドヘッグ』', opponentId: 513,
      sacrifice: [{ id: 101, n: 3 }], first: 154 },
    14: { name: 'スフィンクス', foeName: '神竜『スフィンクス』', opponentId: 514,
      sacrifice: [{ id: 183, n: 1 }, { id: 143, n: 1 }, { id: 102, n: 1 }] },
    16: { name: 'レッドレックス', foeName: '神竜『レッドレックス』', opponentId: 516,
      sacrifice: [{ id: 158, n: 1 }, { id: 139, n: 1 }, { id: 181, n: 1 }] },
    17: { name: 'アバドーン', foeName: '神竜『アバドーン』', opponentId: 517,
      sacrifice: [{ id: 154, n: 1 }, { id: 190, n: 1 }, { id: 102, n: 1 }] },
    18: { name: 'キリン', foeName: '神竜『キリン』', opponentId: 518,
      sacrifice: [{ id: 102, n: 3 }], first: 187 },
    64: { name: 'マスターズソウル', foeName: '『マスターズソウル』', opponentId: 564,
      sacrifice: [{ id: 199, n: 1 }], requireLevel: 5, trueEnding: true }
  };
  function dragonIds() { return Object.keys(DRAGONS).map(Number).sort(function (a, b) { return a - b; }); }
  function dragonOf(cardId) { return DRAGONS[cardId] || null; }

  function ids() { return Object.keys(MASTERS).map(Number); }
  function get(masterId) { return MASTERS[masterId] || null; }

  /** マスターの表示名（『title』name）。原作でも無名の枠（7・16〜19は name はあるが
   * title が無い／7 はどちらも無い）はそのまま素直に組み立てる。MASTERS に無いIDや、
   * name も無い枠（7）は null——呼び出し側がエリア名などにフォールバックする。 */
  function displayName(masterId) {
    const m = MASTERS[masterId];
    if (!m || !m.name) return null;
    return (m.title ? '『' + m.title + '』' : '') + m.name;
  }

  /** マスターの40枚デッキ（{id:count}形式）。RAW_DECKS に無いIDは null。 */
  function deck40(masterId, cards) {
    const raw = RAW_DECKS[masterId];
    if (!raw) return null;
    return convert50to40(raw, cards);
  }

  /** js/run/run.js buildBossDeck() にそのまま渡せる形（カードIDの配列）。 */
  function bossDeckArray(masterId, cards) {
    const map = deck40(masterId, cards);
    return map ? toIdArray(map) : null;
  }

  /* ---- 七罪人（M8.2 WP9・実装計画§1-1 案B／§3-4） --------------------------------
   * 原作の七罪人は闘技場のマスターではなく**フリーユニット戦の相手**（対戦相手ID 191〜197）。
   * 場に3体立って始まり、全部倒せば勝ち。ここにはその「誰が立つか」と「どんな支援を撃つか」
   * だけを置く（配置・戦闘そのものは js/run/run.js と js/engine/turn.js）。
   *
   * units … その罪の固有ユニット（実装計画§3-2の対応表）。**先頭は七罪人からしか出ない種**で、
   *         場に必ず立つ＝原作と同じく「七罪人を倒さないと手に入らない」7種の入手経路になる。
   *         2種に満たない罪（憤怒）は、その洞窟の深度プールの上位で3体まで埋める。 */
  const SINS = {
    191: { name: '大食', units: [39, 27] },   /* ソウルイーター・メガゾエア */
    196: { name: '嫉妬', units: [58, 5] },    /* リヴァイバー・ベヒーモス */
    193: { name: '怠惰', units: [38, 44] },   /* デモングローブ・ブレインサッカー */
    194: { name: '傲慢', units: [55, 30] },   /* アッシュメイカー・イビルアイ */
    195: { name: '淫欲', units: [62, 73] },   /* ラクシュミー・アースバウンド */
    192: { name: '強欲', units: [72, 70, 68] }, /* デスワーム・ポルターガイスト・マッドシックル */
    197: { name: '憤怒', units: [63] }        /* インフェルノ（原作でもここだけ1種） */
  };
  const SIN_BOARD_SIZE = 3;        /* 場に立つ体数（§3-4）。強すぎるときはここを2に落とす（§6リスク表） */
  const SIN_SHELL_SIZE = 34;       /* 支援（魔法・技能）の枚数。残り6枚はチャネル弾のユニット */
  const SIN_KIND_MAX = 3;          /* 同種3枚まで（プレイヤーのデッキ規則と同じ） */
  const FINAL_MASTER = 99;         /* 支援の型を借りる相手＝神官バルザミコス（§3-4の方針） */

  function sinOf(sinId) { return SINS[sinId] || null; }

  /** 支援デッキの共通の型（M8.2 WP9・M8.3 WP13で共用）：バルザミコスの40枚から魔法・技能
   * だけを借り、同種3枚を上限にID順で増やして SIN_SHELL_SIZE 枚の「型」にする。
   * 七罪人（3体）も神殿のモニュメント（1体）も、場に立つユニットが違うだけで支援の型は同じ。
   * 戻り値の counts／ids は「まだ足りないときに支援側で埋め戻す」ための作業用。 */
  function shellDeck(cards) {
    const base = deck40(FINAL_MASTER, cards) || {};
    const counts = {};
    Object.keys(base).forEach(function (k) { if (+k >= 101) counts[+k] = base[k]; });
    const ids = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });
    let total = ids.reduce(function (n, id) { return n + counts[id]; }, 0);
    let i = 0, guard = 0;
    while (total < SIN_SHELL_SIZE && ids.length && guard < 1000) {
      const id = ids[i % ids.length];
      if (counts[id] < SIN_KIND_MAX) { counts[id] += 1; total += 1; }
      i++; guard++;
    }
    return { deck: toIdArray(counts).slice(0, SIN_SHELL_SIZE), counts: counts, ids: ids };
  }

  /** deck（支援シェルの配列。書き換えて返す）に、fodder（チャネル弾にするユニットidの並び）を
   * 同種3枚まで・順に回しながら DECK_SIZE 枚まで積む。 */
  function fillWithFodder(deck, fodder) {
    const used = {};
    for (let k = 0; deck.length < DECK_SIZE && fodder.length; k++) {
      const id = fodder[k % fodder.length];
      if ((used[id] || 0) >= SIN_KIND_MAX) { if (k > fodder.length * SIN_KIND_MAX) break; continue; }
      used[id] = (used[id] || 0) + 1;
      deck.push(id);
    }
    return deck;
  }

  /** シェルだけでは40枚に届かない（チャネル弾が薄い）とき、支援側を同種3枚まで増やして埋める。 */
  function topUpShell(deck, shell) {
    let g = 0;
    while (deck.length < DECK_SIZE && shell.ids.length && g < 100) {
      const id = shell.ids[g % shell.ids.length];
      if ((shell.counts[id] || 0) < SIN_KIND_MAX) { shell.counts[id] = (shell.counts[id] || 0) + 1; deck.push(id); }
      g++;
    }
    return deck;
  }

  /** 七罪人の支援デッキ（40枚）。差し色は最後の6枚＝**場に立つ3体をそれぞれ2枚ずつ**
   * （敵は召還できないのでチャネル弾になる。固有ユニットが1種しかない憤怒でも同種3枚の
   * 規則を破らないよう、場の編成から取る）。poolIds を省略すると固有ユニットだけで埋める
   * （テスト用）。 */
  function sinDeck(sinId, cards, poolIds) {
    const sin = sinOf(sinId);
    if (!sin) return null;
    const shell = shellDeck(cards);
    const deck = shell.deck.slice();
    const fodder = (poolIds ? sinBoard(sinId, poolIds) : sin.units).slice();
    fillWithFodder(deck, fodder);
    topUpShell(deck, shell);
    return deck;
  }

  /** 神殿モニュメント（1体勝負・M8.3 WP13）の支援デッキ。同じ支援の型に、盤面の1体
   * （unitId・最大3枚）＋そのエリアの敵プール上位（poolIds・価格の高い順）で残りを埋める
   * （固有ユニットが1体しかないので、七罪人のように3体ぶんの差し色は作れないため）。
   * 神竜9体・マスターズソウル（M8.3 WP16）もこの関数を使う。 */
  function monumentDeck(unitId, cards, poolIds) {
    const shell = shellDeck(cards);
    const deck = shell.deck.slice();
    const fodder = [unitId].concat((poolIds || []).slice().reverse());
    fillWithFodder(deck, fodder);
    topUpShell(deck, shell);
    return deck;
  }

  /** 開始時に場へ立つ3体。固有ユニット（最大2種）＋その洞窟の深度プールの上位で埋める。
   * poolIds … 価格の**昇順**で並んだそのエリアの敵プール（js/run/areas.js enemyPool の id 列）。 */
  function sinBoard(sinId, poolIds) {
    const sin = sinOf(sinId);
    if (!sin) return null;
    const board = sin.units.slice(0, 2);
    const rest = (poolIds || []).slice().reverse();        /* 高い＝強い順 */
    for (let i = 0; i < rest.length && board.length < SIN_BOARD_SIZE; i++) {
      if (board.indexOf(rest[i]) < 0) board.push(rest[i]);
    }
    /* プールが薄くて埋まらないときは固有ユニットを繰り返す（体数だけは必ず揃える）。 */
    for (let k = 0; board.length < SIN_BOARD_SIZE; k++) board.push(sin.units[k % sin.units.length]);
    return board;
  }

  const api = {
    RAW_DECKS, DECK_SIZE, BLANK, MASTERS, ROOM_REWARDS, DRAGONS,
    SINS, SIN_BOARD_SIZE, SIN_SHELL_SIZE, sinOf, sinDeck, sinBoard, monumentDeck,
    dragonIds, dragonOf,
    convert50to40, toIdArray, deck40, bossDeckArray, get, ids, displayName
  };
  global.CQOpponents = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
