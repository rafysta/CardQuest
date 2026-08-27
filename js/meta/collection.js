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

  function ensure(meta) {
    if (!meta.book) meta.book = {};
    if (!meta.deck) meta.deck = {};
    if (!meta.known) meta.known = [];
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

  const api = {
    DECK_MAX, KIND_MAX, PIG, BLANK,
    countsTotal, canAddToDeck, ensure, registerKnown,
    deckTotal, blankCount, moveToDeck, moveToBook, addCard, sellFromDeck
  };
  global.CQCollection = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
