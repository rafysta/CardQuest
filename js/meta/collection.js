/* CardQuest メタ — 本とデッキの移動モデル（M6.6 WP3）
 *
 * 『実装計画追補M6.6』§2-3・§4 WP3 の実装。カードの実体は「本」か「デッキ」の
 * どちらか一方にだけある（複製ではなく移動）：
 *
 *   book  … 街に置いてある所持カード全部。枚数上限なし（同じカードを何枚でも）
 *   deck  … 本から持ち出した最大40枚。1つだけ保存され、ランをまたいで持ち越す。
 *           合計40以内・同種3枚まで（例外：ピッグマン(8)は無制限）
 *   known … 一度でも入手した種類（記憶データ）。売却しても減らない。
 *           レンタル（おまかせドラフト）は登録しない
 *
 * 不変条件：あるカードの総所持数 ＝ book[id] + deck[id]。
 * 移動（持ち出し／返却）は2つの間の足し引きだけで、合計は変わらない。
 * 増えるのは入手（addCard）だけ、減るのは売却（sellFromDeck）だけ。
 * 空白(180)は実体として持たない（デッキの不足分は表示・実戦闘時に自動補填）。
 * storage 非依存・DOM非依存。js/meta/save.js と同じ規約で Node からも読める。
 */
'use strict';
(function (global) {

  const DECK_MAX = 40;     /* デッキの合計上限（js/engine/turn.js の DECK_SIZE と同値） */
  const KIND_MAX = 3;      /* 同種の上限 */
  const PIG = 8;           /* ピッグマン：同種上限の例外（無制限） */
  const BLANK = 180;       /* 空白：実体として持たない */

  function countsTotal(counts) {
    let n = 0;
    Object.keys(counts || {}).forEach(function (k) { if (+k !== BLANK) n += counts[k] || 0; });
    return n;
  }

  /** デッキ（counts形式）にカード id をもう1枚入れられるか。
   * meta.deck だけでなくラン中の run.deck の検査にも使えるよう、counts を直接受ける。 */
  function canAddToDeck(deckCounts, id) {
    if (+id === BLANK) return { ok: false, reason: '空白は実体として持てません' };
    if (countsTotal(deckCounts) >= DECK_MAX) return { ok: false, reason: 'デッキは' + DECK_MAX + '枚までです' };
    if (+id !== PIG && (deckCounts[id] || 0) >= KIND_MAX) return { ok: false, reason: '同じカードは' + KIND_MAX + '枚までです' };
    return { ok: true };
  }

  /** メタデータに、あるべき入れ物が無ければ作る（旧セーブの読み込み経路もここを通る）。
   * M6.6 WP11 で titles／journal／day を追加した。**古いセーブには当然どれも無い**ので、
   * ここで空を用意しておかないと、称号の付与や日誌の追記が undefined への push になる。 */
  function ensure(meta) {
    if (!meta.book) meta.book = {};
    if (!meta.deck) meta.deck = {};
    if (!meta.known) meta.known = [];
    if (!meta.titles) meta.titles = [];       /* 獲得済みの称号キー（M6.6 WP11） */
    if (!meta.journal) meta.journal = [];     /* 日誌の行（新しいものを末尾に足す。M6.6 WP11） */
    if (typeof meta.day !== 'number') meta.day = 0;  /* 通算日数＝終えたランの数（同上） */
    return meta;
  }

  function registerKnown(meta, id) {
    ensure(meta);
    if (+id === BLANK) return;
    if (meta.known.indexOf(+id) < 0) meta.known.push(+id);
  }

  function deckTotal(meta) { return countsTotal(ensure(meta).deck); }
  function blankCount(meta) { return Math.max(0, DECK_MAX - deckTotal(meta)); }

  /** 本→デッキ（持ち出し）。移した分だけ本が減る。 */
  function moveToDeck(meta, id, n) {
    ensure(meta);
    n = n || 1;
    for (let i = 0; i < n; i++) {
      if ((meta.book[id] || 0) <= 0) return { ok: false, reason: '本にありません', moved: i };
      const chk = canAddToDeck(meta.deck, id);
      if (!chk.ok) return { ok: false, reason: chk.reason, moved: i };
      meta.book[id] -= 1;
      if (meta.book[id] === 0) delete meta.book[id];
      meta.deck[id] = (meta.deck[id] || 0) + 1;
    }
    return { ok: true, moved: n };
  }

  /** デッキ→本（返却）。 */
  function moveToBook(meta, id, n) {
    ensure(meta);
    n = n || 1;
    for (let i = 0; i < n; i++) {
      if ((meta.deck[id] || 0) <= 0) return { ok: false, reason: 'デッキにありません', moved: i };
      meta.deck[id] -= 1;
      if (meta.deck[id] === 0) delete meta.deck[id];
      meta.book[id] = (meta.book[id] || 0) + 1;
    }
    return { ok: true, moved: n };
  }

  /** 入手（戦利品・宝箱・購入・スターター）。known に登録し、dest（'deck'|'book'）へ入れる。
   * dest='deck' でデッキに入らないとき（満杯・同種上限）は本へ回す（カードは必ず貰える）。
   * 戻り値の dest は実際に入った先。空白(180)は実体を持たないため何もしない。 */
  function addCard(meta, id, dest) {
    ensure(meta);
    if (+id === BLANK) return { ok: false, dest: null, reason: '空白は実体として持てません' };
    registerKnown(meta, id);
    if (dest === 'deck' && canAddToDeck(meta.deck, id).ok) {
      meta.deck[id] = (meta.deck[id] || 0) + 1;
      return { ok: true, dest: 'deck' };
    }
    meta.book[id] = (meta.book[id] || 0) + 1;
    return { ok: true, dest: 'book' };
  }

  /** 売却：デッキから1枚消してＧを加算する。本には触らない＝実体が1つなので、
   * その1枚が世界から無くなるという意味（§2-8）。known からは消えない。
   * price は呼び出し側が計算して渡す（売却率は換金所側の仕事：WP9）。 */
  function sellFromDeck(meta, id, price) {
    ensure(meta);
    if (+id === BLANK) return { ok: false, reason: '空白は売れません' };
    if ((meta.deck[id] || 0) <= 0) return { ok: false, reason: 'デッキにありません' };
    meta.deck[id] -= 1;
    if (meta.deck[id] === 0) delete meta.deck[id];
    meta.gold = (meta.gold || 0) + (price || 0);
    return { ok: true, gold: price || 0 };
  }

  /* ==== コレクション段階・マスターレベル・ショップ母集団（M7 WP2） ==============
   *
   * 『CardQuest 実装計画追補_M7_カード入手経路の再配分.md』§2-1・§3 と
   * 『同 M7 作業パッケージ』WP2 の実装。ここが M7 の設計の要で、
   * **ラン中ショップ（WP3）とホームのログショップ（WP7）が同じ関数を共有する**ための場所。
   * 数字を2箇所に持たない——M6.6 WP9 の売値で一度踏んだ「表示と実装がズレる」事故の対策。
   */

  /* 記憶データ（known＝一度でも入手した種類）の数で決まる段階。原作準拠：
   * 0〜19→1／20〜51→2／52〜99→3／100〜167→4／168→5（ゲーム仕様書§6.2）。
   *
   * ★「コレクション段階」と「マスターレベル」は**同じ数字**である（原作のログショップの
   * 品揃え段階がマスターレベルと一致する）。呼ぶ文脈で名前が違うだけなので、
   * 実装は1本しか持たない——片方だけ直して数字が割れる事故を構造的に防ぐ。 */
  const STAGE_STEPS = [20, 52, 100, 168];
  const STAGE_MAX = STAGE_STEPS.length + 1;      /* ＝5 */

  /** 記憶データの種類数 → 段階（＝マスターレベル）1〜5 */
  function masterLevel(knownCount) {
    let lv = 1;
    STAGE_STEPS.forEach(function (need) { if ((knownCount || 0) >= need) lv += 1; });
    return lv;
  }
  /** masterLevel の別名。ショップの品揃えを語る文脈ではこちらで呼ぶ（同じ関数）。 */
  const stage = masterLevel;

  function masterLevelOf(meta) { return masterLevel(ensure(meta).known.length); }
  function stageOf(meta) { return masterLevelOf(meta); }

  /** 次の段階まであと何種類か（0＝もう最大段階）。コレクション図鑑（WP6）の表示用。 */
  function nextStageNeed(knownCount) {
    const n = knownCount || 0;
    for (let i = 0; i < STAGE_STEPS.length; i++) {
      if (n < STAGE_STEPS[i]) return STAGE_STEPS[i] - n;
    }
    return 0;
  }

  /* ---- マスターレベルの効果（ゲーム仕様書§6.2） ---------------------------- */

  /* ＬＰ初期値＝9＋マスターレベル（ゲーム仕様書§2.3）。上限15は「Lv5で14・実績の+1で15」
   * （§6.2）という原作の設計から来ている。**この値はランの出発ＬＰ（run.startLp）になり、
   * 清算のひっ算と称号「無傷の一日」の基準にもなる**ので、動かすと波及範囲が広い。 */
  const LP_BASE = 9;
  const LP_CAP = 15;
  function startLp(level) { return Math.min(LP_CAP, LP_BASE + (level || 1)); }
  function startLpOf(meta) { return startLp(masterLevelOf(meta)); }

  /* デッキ保存枠：既定3つ（ゲーム仕様書§3.2「複数デッキ（3つ程度）」）＋マスターレベル4で+1
   * （§6.2）。実際に複数デッキを持てるようにするのは WP9。ここは数だけを決める。 */
  const DECK_SLOTS_BASE = 3;
  const DECK_SLOTS_BONUS_LEVEL = 4;
  function deckSlots(level) {
    return DECK_SLOTS_BASE + ((level || 1) >= DECK_SLOTS_BONUS_LEVEL ? 1 : 0);
  }

  /* ---- 貴重カードとショップ母集団 ------------------------------------------ */

  /* ホームのログショップが使う一律の貴重閾値（経済追補§3-4末尾）。
   * **エリア別にするのはラン中ショップの品揃え判定と買い取り価格だけ**で、ホームは一律。
   * 二重の意味を持たせると事故るので、エリア別の表は js/run/areas.js（RARE_TIERS）に置き、
   * こちらには持たない。値はマップ仕様書§7の初期値そのまま（要調整のツマミ）。 */
  const RARE_THRESHOLD_HOME = 3000;

  /** 貴重カードか（定価が閾値**以上**。「ちょうど」は貴重に含む）。
   * 閾値の比較をこの1関数に閉じ込めておく——UI側で `p > 3000` と書き間違える余地を無くす。 */
  function isRare(card, threshold) {
    if (!card || typeof card.p !== 'number') return false;
    return card.p >= (threshold == null ? RARE_THRESHOLD_HOME : threshold);
  }

  /** そのカードがショップで解禁される段階（原作データの g テキスト「コレクション段階n〜」）。
   * 表記が無いカードは**ショップでは売られない**（戦利品・報酬でしか手に入らない）＝null。 */
  function shopStageOf(card) {
    if (!card || typeof card.g !== 'string') return null;
    const m = card.g.match(/コレクション段階(\d+)/);
    return m ? +m[1] : null;
  }

  /** ★ラン中ショップ（WP3）とホームのログショップ（WP7）が共有する母集団。
   *
   *   cards       … CARD_BY_ID
   *   stageLevel  … いまのコレクション段階（1〜5）
   *   opts.rareAt … 貴重カードの閾値（省略時はホームの一律値）
   *   opts.rare   … 'exclude'＝貴重を外す（ラン中ショップ）／'only'＝貴重だけ（ホームの限定枠）／
   *                 省略＝全部（おまかせドラフトの候補など）
   *
   * **モンスターは絶対に返さない**（経済追補§2-1「原作の7種すら再現しない」）。
   * 原作データには段階表記を持つモンスターが7種あるが、ここで種別を見て落としている。
   * 返り値は [{id, price}] の価格昇順（enemyPool と同じ形）。 */
  function shopPool(cards, stageLevel, opts) {
    const lv = stageLevel || 1;
    const o = opts || {};
    const threshold = o.rareAt == null ? RARE_THRESHOLD_HOME : o.rareAt;
    const res = [];
    Object.keys(cards || {}).forEach(function (k) {
      const c = cards[k];
      if (!c) return;
      if (c.t !== 'M' && c.t !== 'S') return;               /* 魔法・技能だけ（§2-1） */
      if (+c.id === BLANK) return;                          /* 空白は実体を持たない */
      if (typeof c.p !== 'number' || c.p <= 0) return;      /* 非売品（価格なし） */
      const st = shopStageOf(c);
      if (st === null || st > lv) return;                   /* まだ解禁されていない */
      if (o.rare === 'exclude' && isRare(c, threshold)) return;
      if (o.rare === 'only' && !isRare(c, threshold)) return;
      res.push({ id: c.id, price: c.p });
    });
    res.sort(function (a, b) { return a.price - b.price; });
    return res;
  }

  const api = {
    DECK_MAX, KIND_MAX, PIG, BLANK,
    countsTotal, canAddToDeck, ensure, registerKnown,
    deckTotal, blankCount, moveToDeck, moveToBook, addCard, sellFromDeck,
    /* M7 WP2 */
    STAGE_STEPS, STAGE_MAX, LP_BASE, LP_CAP, DECK_SLOTS_BASE, DECK_SLOTS_BONUS_LEVEL,
    RARE_THRESHOLD_HOME,
    masterLevel, stage, masterLevelOf, stageOf, nextStageNeed,
    startLp, startLpOf, deckSlots, isRare, shopStageOf, shopPool
  };
  global.CQCollection = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
