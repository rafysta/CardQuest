/* CardQuest エンジン — 戦場ルール（バトルモディファイア。実装計画 追補 M5.7 §M6追補）
 *
 * 一部の敵・マスとの戦闘に課す変則ルール。設計の大原則は3つ：
 *   ① マップ生成時に確定し、戦闘前に必ずマップ上で見える（裏の抽選・隠しルールは作らない）
 *   ② エンジン内のフックとして実装する。ＡＩ側の特別対応は一切書かない
 *      （M5.7の先読みＡＩがエンジンのシミュレーションで手を評価するため、
 *        エンジンに入れさえすれば爆弾も石も「先読み中に体験して」自然に回避する）
 *   ③ 既存機構の再利用を優先する（新しい不変条件を増やさない）
 *
 * 5種のルール：
 *   noHighCH  素のＣＨ数が max を超えるユニットは召還できない（両陣営）
 *   bomb      period ターンごとのターン終了時、全レーンの階層 layer のＣＨを敵味方問わず破壊
 *   pestCard  相手が period 手番ごとに、効果なし・チャネリング不可のカードを手札へ投げ込む
 *   laneCap   指定レーンのＣＨ上限を cap に制限する（＝「石詰まり」の見た目）
 *   laneLock  指定レーンが使用不可（召還・チャネリング・召還先として選べない）
 *
 * 状態の置き場所（クローン・シリアライズの都合で分けてある）：
 *   m.fieldRules … ルール定義の配列（正規化済み）。オートセーブ対象
 *   m.fieldState … 進行中のカウンタ（おじゃま虫の投入回数など）
 *   m.board.fieldCap / m.board.fieldLock … レーン別の派生データ（各6要素・不変）。
 *     能力値計算（stats.js）とレーン走査は board しか受け取らないためここに置く。
 *     バトル開始時に1度だけ作り、以後書き換えない＝JSONクローンで安全に複製できる
 *
 * DOMには依存しない。
 */
'use strict';
(function (global) {

  const isNode = (typeof require === 'function' && typeof window === 'undefined');
  const S = isNode ? require('./state.js') : global.CQState;

  /** おじゃま虫カードのＩＤ（js/data.js が CARDS / CARD_BY_ID に追加する。
   * 効果なし・チャネリング不可・召還不可・山札には絶対に入らない） */
  const PEST_CARD = 200;

  /** ルールの既定値。マップ生成側（run/areas.js。M6）は必要な値だけ上書きすればよい */
  const DEFAULTS = {
    noHighCH: { max: 4 },
    bomb: { period: 5, layer: 4 },
    pestCard: { period: 3, target: 'self' },
    laneCap: { cap: 3, lanes: [0, 1, 2, 3, 4, 5] },
    laneLock: { lanes: [] }
  };

  /** ＵＩ表示用のメタ情報（アイコン・名前・1行説明）。説明文の数値は describe() が埋める */
  const META = {
    noHighCH: { icon: '⛰', name: '高ＣＨ禁止' },
    bomb: { icon: '💣', name: '定期爆撃' },
    pestCard: { icon: '🐛', name: 'おじゃま虫' },
    laneCap: { icon: '🪨', name: '岩でふさがれた列' },
    laneLock: { icon: '🚧', name: '使えない列' }
  };

  function intOr(v, fb) { return typeof v === 'number' && isFinite(v) ? Math.floor(v) : fb; }

  /** レーン指定を 0〜5 の重複なし昇順の配列に整える */
  function normLanes(v) {
    if (!Array.isArray(v)) return [];
    const seen = {}, res = [];
    v.forEach(function (x) {
      const i = intOr(x, -1);
      if (i >= 0 && i < S.LANES && !seen[i]) { seen[i] = 1; res.push(i); }
    });
    return res.sort(function (a, b) { return a - b; });
  }

  /** ルール定義の配列を正規化する。未知のＩＤ・壊れた指定は黙って捨てる
   * （マップ生成のデータ不備でバトルが始まらないほうが困るため） */
  function normalize(rules) {
    const res = [];
    (rules || []).forEach(function (r) {
      if (!r || !DEFAULTS[r.id]) return;
      const d = DEFAULTS[r.id];
      switch (r.id) {
        case 'noHighCH':
          res.push({ id: 'noHighCH', max: Math.max(0, intOr(r.max, d.max)) });
          break;
        case 'bomb':
          res.push({ id: 'bomb',
            period: Math.max(1, intOr(r.period, d.period)),
            layer: Math.min(S.LAYERS, Math.max(1, intOr(r.layer, d.layer))) });
          break;
        case 'pestCard':
          res.push({ id: 'pestCard',
            period: Math.max(1, intOr(r.period, d.period)),
            target: r.target === 'enemy' ? 'enemy' : 'self' });
          break;
        case 'laneCap': {
          const lanes = normLanes(r.lanes === undefined ? d.lanes : r.lanes);
          if (!lanes.length) return;
          res.push({ id: 'laneCap', cap: Math.max(0, intOr(r.cap, d.cap)), lanes: lanes });
          break;
        }
        case 'laneLock': {
          let lanes = normLanes(r.lanes);
          if (!lanes.length) return;
          // 片陣営の3レーンを全部ロックすると、その側は召還もチャネリングもできず対局が成立しない。
          // 生成側のデータ不備で詰むのを防ぐため、各陣営に最低1レーンは必ず残す
          ['self', 'enemy'].forEach(function (side) {
            const own = lanes.filter(function (i) { return S.sideOf(i) === side; });
            if (own.length >= 3) {
              const drop = own[own.length - 1];
              lanes = lanes.filter(function (i) { return i !== drop; });
            }
          });
          res.push({ id: 'laneLock', lanes: lanes });
          break;
        }
      }
    });
    return res;
  }

  /** バトル開始時の初期化。createMatch から呼ぶ。
   * 正規化した定義を m.fieldRules に、レーン別の派生データを m.board に置く */
  function init(m, rules) {
    m.fieldRules = normalize(rules);
    m.fieldState = { pest: 0 };
    const cap = [], lock = [];
    for (let i = 0; i < S.LANES; i++) { cap.push(null); lock.push(false); }
    m.fieldRules.forEach(function (r) {
      if (r.id === 'laneCap') r.lanes.forEach(function (i) {
        cap[i] = (cap[i] == null) ? r.cap : Math.min(cap[i], r.cap);
      });
      if (r.id === 'laneLock') r.lanes.forEach(function (i) { lock[i] = true; });
    });
    m.board.fieldCap = cap;
    m.board.fieldLock = lock;
    return m;
  }

  function rulesOf(m) { return (m && m.fieldRules) || []; }
  /** そのルールが有効なら定義オブジェクトを返す（無ければ null） */
  function get(m, id) {
    const rs = rulesOf(m);
    for (let i = 0; i < rs.length; i++) if (rs[i].id === id) return rs[i];
    return null;
  }
  function has(m, id) { return !!get(m, id); }

  /* ================= laneLock ================= */

  /** そのレーンが使えるか。ユニットを置く／置き場所として選ぶ全ての箇所はここを通すこと。
   * 盤面（board）だけで判定できるようにしてある（クローン・凍結中の盤面でも使える） */
  function laneUsable(board, laneIndex) {
    return !(board && board.fieldLock && board.fieldLock[laneIndex]);
  }
  /** side の陣営で「使えて空いている」レーンの配列（召還先の探索はすべてこれを使う） */
  function freeLanesOf(m, side) {
    return S.lanesOf(side).filter(function (i) {
      return m.board.lanes[i].unit == null && laneUsable(m.board, i);
    });
  }

  /* ================= noHighCH ================= */

  /** そのユニットカードを場に出せるか。素のＣＨ数（＝カード記載の値）で判定する。
   * 通常召還・リバース召還（生贄の儀式を含む）・光臨(199)の特例、すべてここを通す（例外なし）。
   * ＬＰダメージ＝素のＣＨ数という仕様のため、このルールは
   * 「一撃のリーサル圧の封印」＝長期戦を強いる敵の個性になる */
  function summonAllowed(m, cardId) {
    const r = get(m, 'noHighCH');
    if (!r) return { ok: true };
    const card = m.cards[cardId];
    if (!card || card.t !== 'U') return { ok: true };
    const ch = S.unitStats(card).ch;
    if (ch <= r.max) return { ok: true };
    return { ok: false, reason: '戦場ルール：素のＣＨ数が' + r.max + 'を超えるユニットは召還できません' };
  }

  /* ================= pestCard ================= */

  function isPest(cardId) { return cardId === PEST_CARD; }

  /** そのカードをチャネリングできるか。おじゃま虫は純ペナルティ＝チャネル枠を埋める
   * 間接価値（空白(180)の防御+100）すら持たせない（本人確認済みの調整方針） */
  function channelAllowed(m, cardId) {
    if (isPest(cardId)) return { ok: false, reason: 'おじゃま虫はチャネリングできません' };
    return { ok: true };
  }

  /** おじゃま虫を1枚 target の手札へ投げ込む。手札が満杯なら不発（＝裏で増やさない）。
   * 山札は経由しない＝再装填リストにも入らないので、捨てれば二度と戻ってこない */
  function throwPest(m, target) {
    const p = m.players[target];
    if (p.hand.length >= 7) {
      m.log.push('おじゃま虫：手札が一杯で投げ込めなかった');
      return false;
    }
    p.hand.push(PEST_CARD);
    m.log.push('おじゃま虫が投げ込まれた（' + (target === 'self' ? '自分' : '相手') + 'の手札 +1）');
    return true;
  }

  /* ================= bomb ================= */

  /** 着弾までの残りターン数（ＵＩのカウントダウン用）。0＝このターンの終了時に落ちる */
  function bombCountdown(m) {
    const r = get(m, 'bomb');
    if (!r) return null;
    const t = Math.max(0, m.turn || 0);
    if (t === 0) return r.period;                 // まだ1手番も始まっていない
    return r.period - (t % r.period === 0 ? r.period : t % r.period);
  }

  /** 全レーンの階層 layer のＣＨを敵味方問わず破壊する。
   * 破壊は既存のＣＨ破壊系（魔法・特殊行動）と同じ経路＝配列から抜いて詰めるだけ。
   * 裏のまま消えたカードのオープン時効果（呪爆など）は発動しない（既存のＣＨ破壊魔法と同じ扱い）。
   * ユニット本体は対象外。該当階層が空のレーンでは何も起きない */
  function dropLayer(m, layer) {
    const hit = [];
    m.board.lanes.forEach(function (ln, i) {
      if (ln.unit == null) return;
      const ch = ln.channels[layer - 1];
      if (!ch) return;                            // その階層が空＝no-op
      ln.channels.splice(layer - 1, 1);
      ln.count = ln.channels.length;
      if (ln.reversePtr >= layer) ln.reversePtr = layer - 1;   // 抜けたぶんポインタを繰り下げる
      hit.push({ lane: i, card: ch.card });
    });
    return hit;
  }

  /* ================= ターン終了フック ================= */

  /** ターン終了処理から呼ぶ。side＝いまターンを終える側。
   * recalc は呼び出し側（turn.js）が直後に行う */
  function onTurnEnd(m, side) {
    const res = { bomb: null, pest: false };
    const bomb = get(m, 'bomb');
    if (bomb && m.turn > 0 && m.turn % bomb.period === 0) {
      const hit = dropLayer(m, bomb.layer);
      m.log.push('定期爆撃：' + bomb.layer + '階層目のカード ' + hit.length + '枚が吹き飛んだ');
      res.bomb = hit;
    }
    const pest = get(m, 'pestCard');
    if (pest && side !== pest.target) {           // 投げ込むのは対象の「相手」の手番
      if (!m.fieldState) m.fieldState = { pest: 0 };
      m.fieldState.pest = (m.fieldState.pest || 0) + 1;
      if (m.fieldState.pest % pest.period === 0) res.pest = throwPest(m, pest.target);
    }
    return res;
  }

  /* ================= ＵＩ表示用 ================= */

  /** アイコン・名前・説明（1行）。バトル画面上部とマップの吹き出しで共用する */
  function describe(r) {
    const meta = META[r.id] || { icon: '？', name: r.id };
    let text = '';
    switch (r.id) {
      case 'noHighCH':
        text = '素のＣＨ数が' + r.max + 'を超えるモンスターは、どちらの側も召還できません。'
             + '（リバース召還・光臨も同じです）'; break;
      case 'bomb':
        text = r.period + 'ターンごとに、両陣営すべての列の' + r.layer
             + '階層目のチャネリングカードが吹き飛びます。モンスター本体は無事です'; break;
      case 'pestCard':
        text = '相手が' + r.period + '手番ごとに「おじゃま虫」をあなたの手札へ投げ込みます。'
             + 'チャネリングも召還もできず、捨てるしかありません'; break;
      case 'laneCap':
        text = '列 ' + r.lanes.map(laneLabel).join('・') + ' は岩でふさがれ、'
             + 'チャネリングが' + r.cap + '階層までに制限されます'; break;
      case 'laneLock':
        text = '列 ' + r.lanes.map(laneLabel).join('・') + ' は使えません（召還もチャネリングも不可）'; break;
    }
    return { id: r.id, icon: meta.icon, name: meta.name, text: text };
  }
  function laneLabel(i) {
    return (i < 3 ? '自陣' : '敵陣') + (i % 3 + 1);
  }

  const api = { PEST_CARD, DEFAULTS, META,
                normalize, init, get, has, rulesOf,
                laneUsable, freeLanesOf, summonAllowed, channelAllowed, isPest,
                throwPest, bombCountdown, dropLayer, onTurnEnd, describe };
  global.CQField = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
