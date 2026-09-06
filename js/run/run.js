/* CardQuest ラン — 進行管理（M6）
 *
 * 『CardQuest マップ仕様書』の状態遷移をここに集約する。js/run/map.js が作った
 * マップ（全マス確定済み）の上を進み、各マスの解決（戦闘以外）・おまかせドラフト・
 * 換金／購入／休憩・霧払いを行う。戦闘そのものは既存のバトルエンジン（js/engine/）を
 * そのまま使う——ここでは「その戦闘に何のデッキ・戦場ルールで臨むか」を組み立て、
 * 終わったら結果（戦利品・LP）をランに反映するだけ。DOMには依存しない。
 */
'use strict';
(function (global) {

  function need(name) {
    return (typeof require === 'function' && typeof module !== 'undefined')
      ? require('./' + name) : null;
  }
  const CQAreas = need('areas.js') || global.CQAreas;
  const CQMap = need('map.js') || global.CQMap;
  const CQOpponents = need('../opponents.js') || global.CQOpponents;
  const CQTurnRef = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('../engine/turn.js') : global.CQTurn;
  const CQCollection = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('../meta/collection.js') : global.CQCollection;
  const CQRng = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('../engine/rng.js') : global.CQRng;
  const DECK_SIZE = (CQTurnRef && CQTurnRef.DECK_SIZE) || 40;
  const BLANK = 180;
  /* コレクション対象（U/M/S・空白180を除く）の総数。js/run-ui.js の COLLECTION_TOTAL と
   * 同じ式（169）——run.js は cards 配列を受け取らない純関数群なので数だけ複製する
   * （BLANKの二重管理と同じ理由）。tests/run.js に両者が一致することを確認する固定テストがある。 */
  const COLLECTION_TOTAL = 169;
  /* おまかせドラフトの回数（マップ仕様書§1.2は3回だったが、実装計画追補M6.6 §2-4で
   * 最大2回に変更。1回目＝エリアの敵／2回目＝いま買える魔法・技能）。 */
  const DRAFT_ROUNDS = 2;
  /* M7 WP3.5（マップ仕様書§1.2・経済追補§4-5 の案B・2026-09-01本人確定）：
   * レンタルは「デッキ40枚の枠外」。ホームでデッキ編集ができるようになると本が40枚を超え、
   * デッキを常に40枚きっちり組めてしまう——旧仕様（レンタルは空白の枠を埋める＝40枚の内側）
   * のままだと、その瞬間おまかせドラフトが二度と発生しなくなり、買い取り所（WP8）が
   * 常に空振りになる構造上の欠陥があった（M7 WP2で発見）。
   * 案Bはこれを「レンタルは常に別枠」にすることで解消する：戦闘デッキは実質
   * 40枚（本人のデッキ）＋レンタル最大 RENTAL_MAX 枚＝最大42枚になる。
   * ラウンド数と上限が同じ概念なので RENTAL_MAX は DRAFT_ROUNDS をそのまま使う
   * （1ラウンドにつき増えるレンタルは最大1枚のため）。 */
  const RENTAL_MAX = DRAFT_ROUNDS;
  /* フリーユニット戦の敵デッキの組成（M6.6 WP6・§7-5）。敵は召還できないので支援中心にし、
   * ユニットはチャネル弾として少量だけ混ぜる。合計は DECK_SIZE（40枚）ちょうどにする。
   * 旧構成は「ユニット20＋支援シェル20」だったが、召還が封じられた以上ユニット20枚は
   * ほぼ死に札だった（引くだけ手が詰まる）ため、この比率に取り直した。 */
  const FIELD_DECK_UNITS = 6;                                  /* チャネル弾としてのユニット */
  const FIELD_DECK_SHELL = DECK_SIZE - FIELD_DECK_UNITS;       /* 残りは魔法・技能 */

  /* ---- デッキ組み立て ---------------------------------------------------- */

  /** 敵の戦闘マス用デッキ：花形ユニット(node.enemy)＋プールの残りで20枚のユニット枠を埋め、
   * 支援シェル20枚（js/run/areas.js）を足して DECK_SIZE にする。
   * マスター固有の実デッキ抽出は実装計画M8。それまでの簡略版（開発メモに明記）。 */
  /** 通常戦闘（フリーユニット戦）の敵デッキ。
   * M6.6 WP6（§7-5）で組み直した：**敵は手札から召還できない**ので、デッキにユニットを
   * たくさん積む意味が無くなった（ユニットの使い道はチャネル＝強化弾としてだけ）。
   * そこで支援シェル（魔法・技能）を主にし、ユニットは少量だけ混ぜる。
   * ※ 場に立つ敵そのものは node.enemy の編成として battleSetup の enemyBoard で渡す。 */
  function buildBattleDeck(cards, area, node) {
    const pool = CQAreas.enemyPool(cards, area.id);
    const featured = node.enemy;
    const shell = CQAreas.SUPPORT_SHELL;
    const deck = [];
    /* 支援シェルを繰り返し積んで大半を埋める（チャネルで場のユニットを強化していく形） */
    let i = 0, guard = 0;
    while (deck.length < FIELD_DECK_SHELL && shell.length && guard < 400) {
      deck.push(shell[i % shell.length]); i++; guard++;
    }
    /* チャネル弾としてのユニットを少量。花形が居ればそれを軸にする */
    const units = [];
    if (featured) units.push(featured.id);
    let k = 0; guard = 0;
    while (units.length < FIELD_DECK_UNITS && pool.length && guard < 400) {
      const c = pool[k % pool.length];
      if (units.indexOf(c.id) < 0) units.push(c.id);
      k++; guard++;
    }
    while (units.length < FIELD_DECK_UNITS) units.push(featured ? featured.id : 8);
    return deck.concat(units.slice(0, FIELD_DECK_UNITS));
  }

  /** ボスのデッキ：プール上位（価格上限area.bossPriceMax以下）を集めて組む */
  /** そのボス戦で実際に相手をするマスターのID（実装計画M8 §1-2 案B）。
   * bossPool が無い／1人しかいないエリアは常に bossId（後方互換・草原以外もこれで安全）。
   * 初回訪問（run.repeatVisit が false）は必ず顔（bossId）。2回目以降の周回だけ、
   * run.seed から確定的に組（bossPool）の中から1人を選ぶ——同じランなら常に同じ結果になる
   * （マップ生成のロールと同じ考え方。js/run/map.js rollEnemy 参照）。 */
  /** そのエリアの報酬「部屋」（実装計画M8 §3-3：エリアの帯＝部屋）。C/B/A/S。
   * area.bossRank（'rankC'など）からそのまま取り出す——エリアのAI帯＝原作の闘技場ルームの
   * 呼び名を流用しているので、部屋報酬の判定にもこれを使う（マスター個々の原作の部屋とは無関係。
   * 山地はルピア＝原作C・グリンジ＝原作Bが同居するが、エリアとしての部屋はBに統一）。 */
  function roomOf(area) {
    if (!area || typeof area.bossRank !== 'string') return null;
    return area.bossRank.replace('rank', '');
  }
  const HIGH_ROOMS = { A: true, S: true };            /* 「Ａ帯以上」＝速攻実績の対象 */
  const ROOM_CLEAR_THRESHOLDS = [3, 5, 7];

  /** M8.1 WP4（実装計画§3-3）：ボスを降した瞬間に貰える追加報酬を判定する（読み取り専用・
   * meta は書き換えない）。実際の meta.bossWins／meta.clears への加算は settle() が行う——
   * ここで見ているのはまだ加算される前の値＝「これで何回目になるか」の先取り判定。
   * 戻り値：{ masterId, masterName, masterCard, room, threshold, roomCard }
   *   masterCard：そのマスターを初めて降した記録（meta.bossWinsに無い）ときだけ非null
   *   roomCard  ：このランでエリアの累計クリアが3／5／7回目になる、かつ原作にその枠の
   *              報酬があるときだけ非null（Ｓ帯の5回目など、原作に無い枠はnullのまま） */
  function bossBonusOf(run, area, meta) {
    const masterId = bossMasterOf(run, area);
    const m = CQOpponents.get(masterId);
    const masterName = (CQOpponents.displayName && CQOpponents.displayName(masterId)) || (m && m.name) || 'マスター';
    const bossWins = (meta && meta.bossWins) || {};
    const masterCard = (!bossWins[masterId] && m && m.reward != null) ? m.reward : null;
    const room = roomOf(area);
    const clears = (meta && meta.clears) || {};
    const nextCount = (clears[run.areaId] || 0) + 1;
    const idx = ROOM_CLEAR_THRESHOLDS.indexOf(nextCount);
    let roomCard = null, threshold = null;
    if (idx >= 0 && room && CQOpponents.ROOM_REWARDS[room]) {
      const c = CQOpponents.ROOM_REWARDS[room][idx];
      if (c != null) { roomCard = c; threshold = ROOM_CLEAR_THRESHOLDS[idx]; }
    }
    return { masterId: masterId, masterName: masterName, masterCard: masterCard,
      room: room, threshold: threshold, roomCard: roomCard };
  }

  /** area.bossPool から、そのランで実際に抽選対象になる組を作る（M8.3 WP17）。
   * ルームＳ①〜④(16〜19)のような endingOnly のマスターは、area.bossPool には
   * **静的に**含めておく（js/meta/routes.js の bossWired は配列の有無だけを見るので、
   * これで「機構としては存在する」real:trueになる）が、meta.endingSeen が立つ前は
   * 抽選から除く——エンディングを見る前にルームＳの4人と当たってしまう事故を防ぐ。
   * start() が一度だけ確定させ run.bossPool に持たせる（run.repeatVisit と同じ考え方）。 */
  function effectiveBossPool(area, meta) {
    const base = area && area.bossPool;
    if (!base) return base;
    if (meta && meta.endingSeen) return base;
    return base.filter(function (id) {
      const m = CQOpponents.get(id);
      return !(m && m.endingOnly);
    });
  }

  function bossMasterOf(run, area) {
    if (!area || area.bossId == null) return null;
    /* run.bossPool（start()が meta.endingSeen を見て確定させた組）があればそれを使う。
     * テストなどで run を直接組み立てた場合（bossPool が無い）は area.bossPool へフォールバック
     * ——挙動は従来どおり。 */
    const pool = (run && run.bossPool) || area.bossPool;
    /* 開発用（js/devpresets.js「ボス戦へ直行」）：組の中のidを直接指定できる。
     * 組に無いidは無視する（デバッグメニュー以外からは決して立たないフィールド）。 */
    if (run && run.bossMasterOverride != null
        && (pool || [area.bossId]).indexOf(+run.bossMasterOverride) >= 0) return +run.bossMasterOverride;
    /* M8.3 WP13（実装計画§4 WP13）：封印（モニュメント）を持つエリア（神殿・神竜の間）は、
     * 初回訪問だけ area.bossId／bossPool とは別の相手（area.monumentCard）と戦う。
     * ここで null を返すことで、bossBonusOf／bossDisplayName／buildBossDeck／settle() の
     * どれも「闘技場マスターは居ない」（七罪人と同じ扱い）になり、初回封印戦で
     * area.bossId のマスターへ実績や初回撃破報酬を誤って付けてしまう事故を防ぐ。 */
    if (area.monumentCard != null && !(run && run.repeatVisit)) return null;
    if (!pool || pool.length <= 1) return area.bossId;
    if (!run || !run.repeatVisit) return area.bossId;
    const r = CQRng.create((run.seed >>> 0) ^ 0x8f1bbcdc);
    return r.pick(pool);
  }

  /** ボスの表示名（バトル導入カットイン・日誌）。bossMasterOf() が選んだ相手を
   * opponents.js の表示名で出す。名前の無い枠（7）や opponents.js 未参照時は
   * area.bossName（エリア定義の既定表示）にフォールバックする。 */
  function bossDisplayName(run, area) {
    if (!area) return 'マスター';
    const masterId = bossMasterOf(run, area);
    const name = (masterId != null && CQOpponents && CQOpponents.displayName) ? CQOpponents.displayName(masterId) : null;
    return name || area.bossName || 'マスター';
  }

  function buildBossDeck(cards, area, run) {
    /* M8.1 WP2・WP3：エリアの「組」（bossPool）から選ばれたマスターの本物のデッキ
     * （js/opponents.js・原作50枚を40枚化したもの）を使う。まだ bossId が付いていない
     * エリアは、従来どおりの簡易生成にフォールバックする——挙動を変えずに済むための
     * 互換パスであり、恒久的な仕様ではない。 */
    const masterId = bossMasterOf(run, area);
    if (masterId != null && CQOpponents) {
      const real = CQOpponents.bossDeckArray(masterId, cards);
      if (real && real.length) return real;
    }
    const pool = CQAreas.enemyPool(cards, area.id).filter(function (e) { return e.price <= area.bossPriceMax; });
    const top = pool.slice(-8);   /* 上位8種を薄く混ぜる（1種に偏らせない。理由は buildBattleDeck 参照） */
    const units = [];
    let i = 0, guard = 0;
    while (units.length < 20 && top.length && guard < 400) { units.push(top[i % top.length].id); i++; guard++; }
    while (units.length < 20) units.push(pool.length ? pool[pool.length - 1].id : 8);
    return units.slice(0, 20).concat(CQAreas.SUPPORT_SHELL);
  }

  /** 所持デッキ（多重集合）＋このランのレンタルから、実戦闘に使う配列を作る。
   * M7 WP3.5（案B）：**レンタルはデッキ40枚の枠外**。本人のデッキは DECK_SIZE（40枚。
   * 足りなければ空白(180)で埋める・多ければ切り詰める＝デッキが大きく育った後の保険）に
   * 固定したうえで、レンタル（最大 RENTAL_MAX 枚）をその後ろに足す。戦闘エンジン
   * （js/engine/turn.js）はカードID配列の長さに制約が無い多重集合実装なので、
   * 40枚を超える配列（最大42枚）をそのまま渡してよい（山札切れ・再装填のロジックも
   * 「残り枚数」ベースで動くため影響しない）。 */
  function buildPlayerDeck(run) {
    const ids = [];
    Object.keys(run.deck).forEach(function (k) {
      const n = run.deck[k];
      for (let i = 0; i < n; i++) ids.push(+k);
    });
    while (ids.length < DECK_SIZE) ids.push(BLANK);
    const deck = ids.slice(0, DECK_SIZE);
    (run.rentals || []).forEach(function (id) { deck.push(id); });
    /* M7 WP8：買い取ったカードのうち**本行きになったぶん**（デッキ40枚に空きが無かった場合）は、
     * そのランの間はレンタルと同じく枠外のまま使い続けられる。買った瞬間に場から消えると
     * 「気に入ったから買ったのに使えなくなる」という逆の体験になるため。 */
    (run.bought || []).forEach(function (id) { deck.push(id); });
    return deck;
  }

  /* ---- ラン開始 ------------------------------------------------------------ */

  /** cards: CARD_BY_ID / areaId / seed / meta: {book, deck, known, gold, cleared}（js/meta/save.js）
   * M6.6 WP3：run.deck は保存デッキ（持ち出し分）のコピー。ラン中の増減はランに閉じ、
   * 終了時に settle() でメタへ反映する。ラン中に「本」行きになったカードは run.bookAdd に
   * 貯めておく（中断・再開でも失われないよう run 自体に持たせる＝cq_run に保存される）。 */
  function start(cards, areaId, seed, meta) {
    const area = CQAreas.get(areaId);
    if (!area) throw new Error('unknown area: ' + areaId);
    /* ドラフトの「未入手優先」の基準は記憶データ（known）。旧形式のメタ（テスト・後方互換）では
     * 従来どおり deck の種類で代用する。 */
    const ownedIds = (meta.known && meta.known.length)
      ? meta.known.slice()
      : Object.keys(meta.deck).filter(function (k) { return meta.deck[k] > 0; }).map(Number);
    const map = CQMap.generate({ cards: cards, areaId: areaId, seed: seed, ownedIds: ownedIds });
    /* M7 WP2：ＬＰ初期値＝9＋マスターレベル（ゲーム仕様書§2.3・§6.2）。
     * 記憶データが増えるほど1点ずつ増える＝収集そのものが探索の余力になる。
     * 段階1では10で、M6.6までのハードコード値と同じ（新規プレイヤーの体験は変わらない）。
     * この値は startLp としてそのまま清算のひっ算と称号「無傷の一日」の基準になる。 */
    const level = CQCollection.masterLevel((meta.known || []).length);
    const lp0 = CQCollection.startLp(level);
    return {
      areaId: areaId, seed: seed, map: map,
      at: map.start,
      /* M8.1 WP3（実装計画§1-2 案B）：このエリアを過去にクリアしたことがあるか。
       * ラン開始時に一度だけ確定させ、run自体に持たせる（cq_runに保存されるので
       * 中断・再開しても変わらない）。ボスの「組」からの抽選（bossMasterOf）は
       * これを見て、初回は必ず顔、2回目以降だけ抽選にする。 */
      repeatVisit: (meta.cleared || []).indexOf(areaId) >= 0,
      /* M8.3 WP17：このランで実際に抽選対象になるボスの組（endingOnlyの除外込み）を
       * ここで一度だけ確定させる。bossMasterOf はこれを見る（無ければ area.bossPool）。 */
      bossPool: effectiveBossPool(area, meta),
      lp: lp0, maxLp: CQCollection.LP_CAP,
      gold: meta.gold,
      /* M6.6 WP11：清算のひっ算（持ち込み／今日の獲得／減額）と称号「無傷の一日」の判定に、
       * 出発時点の値が要る。run.gold は買い物で減りも増えもするので、後から復元できない。 */
      startGold: meta.gold, startLp: lp0,
      deck: Object.assign({}, meta.deck),
      bookAdd: {},
      rentals: [],
      /* M7 WP8：買い取り所で買ったが、デッキ40枚に空きが無く本行きになったカード。
       * ランの間だけ枠外で使い続けるための一時的な入れ物（所持そのものは bookAdd 側が持つ）。 */
      bought: [],
      gainedCards: [],
      lootPending: [],
      draftDone: 0, draftPending: null,
      log: [], outcome: null
    };
  }

  /** ラン中の入手（戦利品・宝箱・購入・？イベント）。デッキに空きがあればデッキへ、
   * 入らなければ（合計40・同種3枚制限）本行き＝run.bookAdd に貯める。どちらでも必ず貰える。
   * WP7で「その場でデッキ／本を選ぶ画面」に置き換わるまでの自動振り分け。
   * 戻り値は実際に入った先（'deck'|'book'）。
   * M7 WP3.5（案B）：レンタルはデッキ40枚の枠外になったので、空き枠の計算に**数えない**
   * （以前はレンタルが仮想の空白を埋めている扱いだったが、いまは別枠なので無関係）。 */
  function gainCard(run, id) {
    if (+id === BLANK) return null;
    if (!run.bookAdd) run.bookAdd = {};   /* 旧形式の cq_run（中断中のラン）を再開した場合の保険 */
    const hasSlot = CQCollection.countsTotal(run.deck) < DECK_SIZE;
    if (hasSlot && CQCollection.canAddToDeck(run.deck, id).ok) {
      run.deck[id] = (run.deck[id] || 0) + 1;
      run.gainedCards.push(id);
      return 'deck';
    }
    run.bookAdd[id] = (run.bookAdd[id] || 0) + 1;
    run.gainedCards.push(id);
    return 'book';
  }

  /* ---- おまかせドラフト（§1.2） -------------------------------------------- */

  /** おまかせドラフトで「変更しない」を選んだときに残る対象（＝レンタルを受け取らない場合）。
   * M7 WP3.5（案B）より前は「デッキが満杯なら実カードを1枚押し出す（定価の低い順）」だったが、
   * **案Bではレンタルがデッキ40枚の枠外になったため、実カードを押し出す必要が無くなった**。
   * つまり通常は常に BLANK（180＝「借りない」の意味の見張り値。draftKeepCardHTML が
   * 「変更しない」の絵として使う）を返す。唯一の例外は**旧セーブ互換**：M6.6 WP3の移動モデル
   * より前の cq_run を再開した場合、run.deck に実体の空白(180)がそのまま残っていることがあり、
   * その場合はそれ自体が対象になる（applyDraft側で自然に片付く。実質は同じ「空白」なので
   * 処理を分ける必要が無い）。 */
  function draftTarget(run) {
    if ((run.deck[BLANK] || 0) > 0) return BLANK;
    return BLANK;
  }

  /** レンタルをもう1枠借りられるか（＝おまかせドラフトが発生する条件。§2-4 WP4・
   * M7 WP3.5 案B）。**デッキ（本人の40枚）が満杯かどうかはもう関係ない**——
   * レンタルは40枚の枠外なので、上限はレンタルの本数そのもの（RENTAL_MAX＝DRAFT_ROUNDS）。
   * 旧セーブ互換：run.deck に実体の空白(180)が残っている場合はそちらを優先して埋める。 */
  function hasBlankSlot(run) {
    if ((run.deck[BLANK] || 0) > 0) return true;
    const rentals = run.rentals ? run.rentals.length : 0;
    return rentals < RENTAL_MAX;
  }

  /** 次のドラフトを始める。M6.6 WP4で **3回→最大2回**・**レンタルの空き枠がある時だけ発生**
   * に変更（M7 WP3.5・案Bでは「レンタルの空き枠」＝デッキの空白ではなくレンタル本数の余地）。
   * 空きが無ければ null を返す＝呼び出し側はドラフトを飛ばして出発する。
   * 「1枚だけ空きがある時：1回目で埋めたら2回目は発生しない／変更しなければ2回目が発生」という
   * §4 WP4 の要求は、毎回ここで空きを見直すことで自然に満たされる。 */
  function beginDraftRound(run, cards) {
    if (run.draftDone >= DRAFT_ROUNDS) return null;
    if (!hasBlankSlot(run)) return null;
    const idx = run.draftDone;
    const options = (run.map.draftPools[idx] || []).slice();
    if (!options.length) return null;         /* 候補が用意できなかった回は飛ばす */
    const targetId = draftTarget(run, cards);
    run.draftPending = { round: idx, options: options, targetId: targetId };
    return run.draftPending;
  }

  /** pickedId が targetId と同じ＝「変更しない」（＝そのレンタル枠を借りない）。それ以外は
   * レンタルとして追加する（§1.2「所持済みが候補でも扱いはレンタルで統一」＝おまかせドラフトの
   * 入手は常にレンタル）。M7 WP3.5（案B）：targetId は通常つねに BLANK（実カードを押し出す
   * 必要が無くなった）で、以下の「run.deck[dp.targetId] を1枚減らす」処理は**旧セーブ互換専用**
   * ——M6.6 WP3の移動モデルより前の cq_run に実体の空白(180)が残っていた場合だけ通り、
   * それを1枚消費する（実カードを押し出すケースはもう発生しない）。
   * cards はログ表示用（省略可・後方互換）：渡せばカード名で、渡さなければ従来どおりIDで出す。 */
  function applyDraft(run, pickedId, cards) {
    const dp = run.draftPending;
    if (!dp) return false;
    const name = function (id) { return cards && cards[id] ? cards[id].n : id; };
    if (pickedId !== dp.targetId) {
      if ((run.deck[dp.targetId] || 0) > 0) {
        run.deck[dp.targetId] -= 1;   /* 旧セーブ互換：実体の空白(180)を1枚消費するだけ */
      }
      run.rentals.push(pickedId);
      run.log.push('おまかせドラフト：' + name(dp.targetId) + ' → ' + name(pickedId) + '（レンタル）');
    } else {
      run.log.push('おまかせドラフト：変更しない（' + name(dp.targetId) + '）');
    }
    run.draftDone += 1;
    run.draftPending = null;
    return true;
  }

  /** 3回のドラフトを終え、開始マスから最初の分岐へ出発する。
   * 開始マスの「解決」は案内・ドラフトの時点で既に済んでいるので、ここで cleared にする
   * （さもないと choices()/advance() が「まだ解決していない」として先へ進めなくなる） */
  function depart(run) {
    run.map.nodes[run.map.start].cleared = true;
    run.at = run.map.start;
  }

  /* ---- 進行・分岐選択 -------------------------------------------------------- */

  function node(run, id) { return run.map.nodes[id || run.at]; }
  function currentNode(run) { return node(run, run.at); }

  /** いま選べる次のマス（現在のマスが解決済みのときだけ意味を持つ） */
  function choices(run) {
    const n = currentNode(run);
    if (!n || !n.cleared) return [];
    return n.connectsTo.map(function (id) { return run.map.nodes[id]; });
  }

  function advance(run, nextId) {
    const n = currentNode(run);
    if (!n || !n.cleared) return { ok: false, reason: 'このマスはまだ解決していません' };
    if (n.connectsTo.indexOf(nextId) < 0) return { ok: false, reason: 'そこへは進めません' };
    run.at = nextId;
    return { ok: true };
  }

  /* ---- 戦闘マス ------------------------------------------------------------ */

  /** run.seed とマスidから、その戦闘専用の決定的な乱数シードを作る（同じランは常に同じ結果になる）。
   *
   * M6.6 WP12：**挑戦回数（n.attempts）も種に混ぜる。** 逃走はマスを cleared にしない
   * （追補§8-3 案A）ので同じ相手に入り直せるが、種がマスidだけだと**まったく同じ戦闘が
   * そのまま再生される**（同じ手札・同じ先攻・同じ相手の動き）＝逃げる意味が無くなる。
   * 挑戦回数を混ぜることで、入り直すたびに別の引きになり、本人の言う「延命ではなく
   * 仕切り直し」が実際に成立する。決定性は保たれる（同じラン・同じマス・同じ挑戦回数なら
   * 常に同じ戦闘。attempts は run に入るのでセーブ・再開でも揺れない）。 */
  function battleSeed(run, n) {
    let h = (run.seed >>> 0) ^ 0x9e3779b9;
    const s = String(n.id) + '#' + (n.attempts || 0);
    for (let i = 0; i < s.length; i++) h = (Math.imul(h ^ s.charCodeAt(i), 16777619)) >>> 0;
    return h >>> 0;
  }

  /** 先攻／後攻（M6.6 WP5・追補§4）。従来はここが常に 'self' 固定だったため、ラン中の
   * 戦闘は必ずプレイヤーが先攻という有利が付いたままだった。戦闘シードから battleSeed() と
   * 別の乱数列を1回引くだけの、決定的な50%抽選にする——同じランの同じマスなら常に同じ結果
   * （タイトルの「先攻ルーレット」演出は、この確定済みの結果を見せるだけで乱数は使わない。
   *  見た目のブレ角±10°などは演出側でMath.randomを使ってよい＝結果には影響しない）。
   * battleSetup() の seed（=戦闘本編のRNG）とは別インスタンスから1回 next() を引くだけなので、
   * 本編の乱数列（手札・引きなど）を消費せず、抽選結果にも影響しない。 */
  function firstTurnOf(run, n) {
    const r = CQRng.create(battleSeed(run, n) ^ 0x51ed270b);
    return r.next() < 0.5 ? 'self' : 'enemy';
  }

  /** CQTurn.createMatch にそのまま渡せる引数を作る（rng/hooksは呼び出し側＝layout.jsが足す） */
  /** そのマスの敵編成を、実際に場へ立てる並びにする（M6.6 WP6）。
   * マップは「代表1体＋体数」で持っているので、体数ぶん同じユニットを並べる（最大3体＝敵レーン数）。 */
  function enemyBoardOf(n) {
    if (!n.enemy) return [];
    const out = [];
    for (let i = 0; i < Math.min(3, n.enemy.count || 1); i++) out.push(n.enemy.id);
    return out;
  }

  /* ================= M8.5 チュートリアルの固定戦闘 =================
   * 『実装計画追補 M8.5』§2.1〜§2.3。初めて遊ぶ人にだけ、**初期条件だけを固定した戦闘**を
   * 2つ用意する（進行は台本にしない＝プレイヤーが何をしても壊れない）。
   *   第1戦 … 置く／伏せる／攻める＝記録／めくる
   *   第2戦 … 強制開放で暴く／憑依解除で剥がす（本作の華の2枚）
   * 盤面の差し替えそのものは js/board-spec.js（デバッグの「盤面をセットして戦う」と同じ道具）が
   * 行う。ここが返すのは**その記述だけ**で、エンジンには触らない。 */

  function hintDone(meta, key) { return !!(meta && meta.seenHints && meta.seenHints[key]); }

  /** そのマスが固定戦闘になるか。なるなら 1 か 2、ならなければ 0。
   * 条件（§2.1〜§2.3）：草原の**通常戦闘マス**だけ（ボス・強敵・精鋭は対象外）。
   *   第1戦 … まだ見ていない
   *   第2戦 … 第1戦を終えた後。**日数の上限なし**＝初回ランで踏めなければ持ち越す（本人確定⑩）
   * meta を渡さない呼び出し（tools/simulate-run.js・tests）では常に 0＝固定しない。 */
  function tutorialStage(run, meta, n) {
    if (!meta || !n || !run) return 0;
    if (run.areaId !== 'grassland') return 0;
    if (n.type !== 'battle' || n.strength !== 'normal') return 0;
    /* ★2026-09-06 修正（本人報告）：以前は第1戦だけ meta.day===0（まだ1ランも
     * 終えていない）に限っていた。そのため**初回ランが草原の通常戦闘マスを踏まずに
     * 終わると、以後は通常プレイで二度と出ない**——負けても諦めても、そのランで
     * 強敵・精鋭のマスしか踏まなくても、そこで打ち切られてしまう。
     * 第2戦は「初回ランで踏めなければ2日目以降に持ち越す（日数の上限は設けない・
     * 本人確定⑩）」なのだから、第1戦も同じく**見るまで持ち越す**のが筋。
     * 「M8.5より前からの既存プレイヤーには出さない」は js/meta/save.js の
     * migrateTutorial（既読フラグを立てる一度きりの移行）が担当していて、
     * ここで日数を見る必要はもう無い。 */
    if (!hintDone(meta, 'tutorialBattle1')) return 1;
    if (!hintDone(meta, 'tutorialBattle2')) return 2;
    return 0;
  }

  /** 固定戦闘の盤面記述（CQBoardSpec の形）。数値の根拠は追補§2.2・§2.3の表。 */
  function tutorialSpec(stage, run) {
    const lp = Math.max(1, (run && run.lp) || 10);
    if (stage === 1) {
      /* 敵はアンフィビアス(23) 450/500 を1体。ピッグマン(8) 500/450 の攻撃 500 ≧ 500 で
       * **何も置かなくても勝てる**＝詰みが無い（同値も成功）。
       * カードを伏せれば防御が上がり（ＣＨボーナス：裏1枚につき防御+100・ゲーム仕様書§6.2⑥）、
       * 開けば攻撃が上がる（表1枚につき攻撃+100）——どちらに転んでも攻撃は通るので罠が無い。
       * 敵は最初から硬直していて、しかも弱ＡＩ（free）は最初の2手番は攻撃しない設定なので、
       * 置いて・伏せて・開いて・攻める、を落ち着いて一度ずつ試せる。
       * ピッグマンを敵にしないのは、スターターに10枚あって倒しても記憶データが増えず
       * 「一つ、書き留めたな。」が嘘になるため。 */
      return {
        first: 'self', active: 'self', phase: 'placement', win: 'field',
        lp: { self: lp, enemy: 10 },
        hand: { self: [8, 8, 194, 193, 165, 113], enemy: [] },
        lanes: { '3': { unit: 23, ch: [], stiff: true } }
      };
    }
    if (stage === 2) {
      /* 敵はシニスターセラフ(24) 450/400（ＣＨ数3）に、魔力の盾(153)＋空白(180)×2 を**伏せて**乗せる。
       *
       * ★2026-09-07 実装時に数値を組み直した。当初案（盾＋迎撃の2枚）は
       * **ＣＨボーナス（チャネル1枚につき、裏なら防御+100／表なら攻撃+100。ゲーム仕様書§6.2⑥）**を
       * 計算に入れ忘れていた。入れて計算し直すと次のとおりで、これで追補§2.3の狙いどおりになる：
       *
       *   伏せたまま   … 450 / 400+300 = **450/700**            ← ピッグマンの500では通らない
       *   強制開放の後 … 450-100+300 / 400+200 = **650/600**    ← 3枚が表になり、盾が見える
       *   憑依解除の後 … 450+200 / 400 = **650/400**            ← 盾が砕けて通る（500 ≧ 400）
       *
       * 防御が 700→600→400 と2段階で目に見えて下がる＝「この2枚だからこそ」が数で分かる。
       *
       * ＣＨ枠を3つとも埋めてあるのは**ＡＩに割り込ませない**ため。空きがあると相手が支援カードを
       * 足して防御が上がり、狙った数にならない（不死(177)を引かれると倒せなくなる）。
       *
       * 迎撃(171)は**入れていない**（本人確定⑧を見直す必要がある点）。ＣＨボーナスを入れると
       * 開いた後の相手の攻撃力は650まで上がり、攻撃に失敗したときの反撃 650 ≧ 自分の防御 450 で
       * **ピッグマンが砕ける**——迎撃を選んだ理由（追補§2.3「罠は見せるが罰は与えない」）が
       * 成り立たない。空白(180)は「効果はない。ＣＨの枠を埋めるだけの白紙のカード」なので
       * どう攻めても罰が無く、しかも**伏せ札の大半はただの枠埋め**という手触りが出る。
       * 迎撃に戻すときは 180 のどちらかを 171 に変えるだけでよい。 */
      return {
        first: 'self', active: 'self', phase: 'placement', win: 'field',
        lp: { self: lp, enemy: 10 },
        hand: { self: [8, 8, 108, 101, 194, 193], enemy: [] },
        lanes: { '3': { unit: 24, stiff: true,
          ch: [{ id: 153, up: false }, { id: 180, up: false }, { id: 180, up: false }] } }
      };
    }
    return null;
  }

  /** 固定戦闘になるマスを、盤面記述と食い違わないようにそろえる（読み取りではなく**書き込み**）。
   * ・n.enemy … 戦闘導入カットイン・マップの絵・敵デッキの花形が、実際に立つ敵と一致するように
   * ・n.fieldRules … 固定戦闘に戦場ルールは付けない（見せてから効かない、を防ぐ）
   * カットインを描く前に js/run-ui.js からも呼ぶ。何度呼んでも同じ結果になる。 */
  const TUTORIAL_FOE = { 1: 23, 2: 24 };
  function applyTutorialNode(run, meta, n) {
    const stage = tutorialStage(run, meta, n);
    if (!stage) return 0;
    const id = TUTORIAL_FOE[stage];
    if (!n.enemy || n.enemy.id !== id || n.enemy.count !== 1) n.enemy = { id: id, count: 1 };
    if (n.fieldRules && n.fieldRules.length) n.fieldRules = [];
    return stage;
  }

  function battleSetup(run, cards, n, meta) {
    const area = CQAreas.get(run.areaId);
    const isBoss = n.type === 'boss';
    /* M8.2 WP9（実装計画§1-1 案B）：七罪人は**ボスだがフリーユニット戦**。
     * 場に3体立って始まり、全滅させれば勝ち。ＬＰ勝負ではないので敵にＬＰを持たせず、
     * 逃走は封じ、初期硬直も無し（§6リスク表）。相手の呼び名は罪の名で出す。 */
    const isSin = isBoss && area.sinId != null && CQOpponents.sinOf(area.sinId);
    /* M8.3 WP13（実装計画§ 4 WP13）：神殿の封印（エグゼデグゼスとの1体勝負）。
     * 七罪人と同じ「ボスだがフリーユニット戦」だが、場に立つのは1体（area.monumentCard）だけ。
     * bossMasterOf() が初回訪問だけ null を返すようにしたので、ここでは run.repeatVisit で判定すればよい
     * （bossMasterOf と同じ式）。 */
    const isMonument = isBoss && !run.repeatVisit && area.monumentCard != null;
    const poolIds = (isSin || isMonument) ? CQAreas.enemyPool(cards, area.id).map(function (e) { return e.id; }) : null;
    applyTutorialNode(run, meta, n);          /* 固定戦闘なら、マスの敵と戦場ルールをそろえてから組む */
    return {
      cards: cards,
      selfDeck: buildPlayerDeck(run),
      enemyDeck: isSin ? CQOpponents.sinDeck(area.sinId, cards, poolIds)
        : (isMonument ? CQOpponents.monumentDeck(area.monumentCard, cards, poolIds)
        : (isBoss ? buildBossDeck(cards, area, run) : buildBattleDeck(cards, area, n))),
      first: firstTurnOf(run, n),
      opponentId: isSin ? area.sinId
        : (isMonument ? (area.monumentOpponentId != null ? area.monumentOpponentId : area.monumentCard)
        : 900 + (n.seg == null ? 90 : n.seg * 10) + (n.slot || 0)),
      fieldRules: n.fieldRules || [],
      selfOpts: { lp: run.lp, maxLp: run.maxLp },
      enemyOpts: (isBoss && !isSin && !isMonument) ? { lp: area.bossLp, maxLp: area.bossLp } : undefined,
      /* M6.6 WP6：通常戦闘はフリーユニット戦（敵は配置済み・召還不可・場が空になれば勝ち）。
       * マスター戦（ボス）だけは従来どおりのＬＰ勝負なので mode を付けない（§2-6）。
       * 七罪人（M8.2 WP9）と封印（M8.3 WP13）はボスだがフリーユニット戦なので mode を付ける。 */
      mode: (isBoss && !isSin && !isMonument) ? undefined : 'field',
      enemyBoard: isSin ? CQOpponents.sinBoard(area.sinId, poolIds) : (isMonument ? [area.monumentCard] : (isBoss ? undefined : enemyBoardOf(n))),
      enemyStiff: (isSin || isMonument) ? false : undefined,
      noFlee: (isSin || isMonument) ? true : undefined,
      foeName: (isSin || isMonument) ? area.bossName : undefined,
      /* M7.10 WP1：ゲーム仕様書§4.2・§5どおりのＡＩ強さ。通常戦闘は弱ＡＩ設定（free）固定、
       * ボスはエリアの帯（bossRank）。js/layout.js の startRunBattle() がこれを見て aiConfig を組む。
       * M8.5：チュートリアルの固定戦闘だけ、攻撃を待ってくれる 'tutorial' を使う。 */
      aiPreset: isBoss ? area.bossRank : (tutorialStage(run, meta, n) ? 'tutorial' : 'free'),
      seed: battleSeed(run, n),
      /* M8.5 WP0：チュートリアルの固定戦闘。js/layout.js の startRunBattle() が
       * boardSpec を CQBoardSpec.apply に通す。meta を渡さない呼び出しでは常に null＝
       * シミュレータ・テストの挙動は今までどおり変わらない。 */
      boardSpec: tutorialSpec(tutorialStage(run, meta, n), run),
      tutorial: tutorialStage(run, meta, n)
    };
  }

  /* ================= 神竜の間（M8.3 WP16） =================
   *
   * 実装計画§3-4・台本§13。マップも「ラン」も無い、9体（8神竜＋マスターズソウル）への
   * 単発の1体勝負。CQRun.start() は一切使わず、js/run-ui.js が meta.deck（いまのデッキ編集の
   * 内容）だけを持ってきて直接 js/layout.js の startRunBattle() へ渡す——ここはその
   * 「setup」を組む部分と、決着後の報酬・捧げ物の消費を確定させる部分だけを持つ。 */

  /** 捧げ物（本にある分だけ・デッキ分は対象外）が足りているか。マスターズソウルだけ
   * マスターレベルも見る（実装計画§3-4）。 */
  function dragonSacrificeOk(cardId, meta) {
    const d = CQOpponents.dragonOf(cardId);
    if (!d) return false;
    if (d.requireLevel != null && CQCollection.masterLevelOf(meta) < d.requireLevel) return false;
    return d.sacrifice.every(function (s) { return (meta.book[s.id] || 0) >= s.n; });
  }

  /** 捧げ物を実際に本から取り除く。呼ぶ前に dragonSacrificeOk() で確認しておくこと
   * （ここでは再確認しない＝呼び出し側の確認画面と実行を1回のUI操作の中で揃える）。
   * 勝敗に関わらずここで消費する（「捧げて挑む」という原作どおりの位置づけ・実装計画§3-4）。 */
  function dragonSacrificeConsume(cardId, meta) {
    const d = CQOpponents.dragonOf(cardId);
    if (!d) return false;
    d.sacrifice.forEach(function (s) {
      meta.book[s.id] = Math.max(0, (meta.book[s.id] || 0) - s.n);
      if (meta.book[s.id] === 0) delete meta.book[s.id];
    });
    return true;
  }

  /** その神竜との戦闘を、js/layout.js の startRunBattle(setup, onOver) にそのまま渡せる
   * 形で組む。selfDeck は「いまのデッキ編集の内容」（meta.deck）だけから作る——ランでは
   * ないのでレンタル・買い取りの枠は無い（buildPlayerDeck に rentals/bought の空配列だけ渡す）。
   * enemyDeck は神殿モニュメント（WP13）と同じ monumentDeck() を流用し、盤面には
   * その神竜（または64＝マスターズソウル）が1体だけ立つ。フリーユニット戦（mode:'field'）・
   * 逃走不可（noFlee）で、七罪人・神殿モニュメントと同じ扱い。 */
  function dragonBattleSetup(cardId, cards, meta) {
    const d = CQOpponents.dragonOf(cardId);
    if (!d) return null;
    const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
    const first = CQRng.create(seed ^ 0x51ed270b).next() < 0.5 ? 'self' : 'enemy';
    return {
      cards: cards,
      selfDeck: buildPlayerDeck({ deck: meta.deck, rentals: [], bought: [] }),
      enemyDeck: CQOpponents.monumentDeck(cardId, cards, []),
      first: first,
      opponentId: d.opponentId,
      fieldRules: [],
      enemyBoard: [cardId],
      enemyStiff: false,
      noFlee: true,
      foeName: d.foeName,
      aiPreset: 'rankA',
      mode: 'field',
      seed: seed
    };
  }

  /** 決着後の確定入手・初回撃破報酬・真の結末の判定。cardId＝挑んだ神竜のカードid。
   * M＝js/engine/turn.js の対戦状態（winnerを見る）。戻り値：
   *   { win, gained:[id,...], trueEnding }
   * gained には確定入手した神竜のカード自身と（あれば）初回撃破のボーナスが入る。
   * 実際に meta.book へ入れる（CQCollection.addCard）のはここで行う——ラン中の戦利品
   * （run.gainedCards／lootPending）のような「後で振り分ける」保留は無く、原作どおり
   * 倒した瞬間に確定で貰える（実装計画§1-1「案Bの注意」と同じ考え方）。 */
  function reportDragonBattle(cardId, M, meta) {
    if (!M || M.winner !== 'self') return { win: false, gained: [], trueEnding: false, titles: [] };
    const d = CQOpponents.dragonOf(cardId);
    if (!d) return { win: false, gained: [], trueEnding: false, titles: [] };
    const gained = [];
    const already = (meta.dragonWins && meta.dragonWins[cardId]) || 0;
    meta.dragonWins = meta.dragonWins || {};
    meta.dragonWins[cardId] = already + 1;
    CQCollection.addCard(meta, cardId, 'book');
    gained.push(cardId);
    if (already === 0 && d.first != null) {
      CQCollection.addCard(meta, d.first, 'book');
      gained.push(d.first);
    }
    let trueEnding = false;
    if (d.trueEnding && !meta.trueEndingSeen) {
      meta.trueEndingSeen = true;
      trueEnding = true;
    }
    /* M8.3 WP17：神竜の間はラン（settle()）を経由しないので、metaOnly の称号
     * （鍵7・エンディング・全169種）はここで別途チェックする——連続攻撃154／修練の拳187が
     * 最後の1種になって全169種が完成する、という筋道が実際にあるため。 */
    const titles = earnedMetaTitles(meta);
    titles.forEach(function (t) { meta.titles.push(t.key); });
    return { win: true, gained: gained, trueEnding: trueEnding, titles: titles };
  }

  /** 逃走してマップへ戻ったときの反映（M6.6 WP12・追補§4 WP12）。
   * 戦利品もＧも得ない。持ち越すのは**ＬＰの減少だけ**。
   * **そのマスは cleared にしない**（追補§8-3 で本人が案Aを採用）＝プレイヤーはそのマスに
   * 留まり、もう一度入り直せる。こうすることで「逃げる」は延命ではなく仕切り直しになり、
   * マップ仕様書§1の「通常戦闘3回＋ボス1回」という構造も保たれる（戦闘を避けて
   * ボスへ直行することができない）。
   * 逃走失敗のＬＰ−1でＬＰが0になった場合だけは、その場でランが終わる。 */
  function reportFlee(run, n, M) {
    run.lp = Math.max(0, M.players.self.lp);
    /* 挑戦回数を進める＝次に入り直したときは別の引きの戦闘になる（battleSeed 参照）。
     * これをやらないと、逃げても寸分違わず同じ戦闘が始まるだけで意味が無い。 */
    n.attempts = (n.attempts || 0) + 1;
    if (run.lp <= 0) {
      run.outcome = 'lose';
      run.log.push('逃げきれずに力尽きた');
      return { fled: true, dead: true };
    }
    run.log.push('戦いから離脱した（このマスはまだ残っている）');
    return { fled: true, dead: false };
  }

  /** 戦闘終了後（M.winner が確定した後）に呼ぶ。戦利品・Ｇ・ＬＰをランに反映する。
   * M6.6 WP6（§2-6）で報酬を変更した：
   *   通常戦闘（フリーユニット戦）＝**Ｇは出ない**。敵ユニットは金を落とさず、戦利品のカードだけ。
   *   マスター戦（ボス）＝**ファイトマネーは原作準拠**（areas.js の fightMoney。草原・森はＣ級500G）。
   *                       すでにクリア済みのエリアを周回しているときは50%。
   * ラン中の主収入は宝箱に寄る（マップ仕様書§7・追補§7-1の想定どおり）。
   * M6.6 WP7：戦利品はここでは自動でデッキ／本へ振り分けない。`run.lootPending` に積むだけにして、
   * どちらに送るかはプレイヤーが振り分け画面（resolveLootPick）で選ぶ。ただし「入手した」事実
   * （NEWバッジ・記憶データ登録の元になる gainedCards）はここで確定させる——カードは必ず
   * 手に入る（§2-7）ので、置き先が未定でも「入手済み」扱いにしてよい。 */
  function reportBattle(run, n, M, meta) {
    n.cleared = true;
    if (M.winner === 'self') {
      const loot = (M.loot || []).slice();
      if (!run.lootPending) run.lootPending = [];
      loot.forEach(function (id) {
        run.gainedCards.push(id);
        run.lootPending.push(id);
      });
      const area = CQAreas.get(run.areaId);
      /* M8.3 WP13（実装計画§1-1「案Bの注意」）：封印（モニュメント）は、
       * 倒し方に関わらず勝てば確定でその札が手に入る（原作の「魔法で倒すと戦利品が
       * 出ない」を意図的に逸脱）。battleSetup() と同じ式で判定する。 */
      const isMonument = n.type === 'boss' && !run.repeatVisit && area.monumentCard != null;
      let gold = 0;
      if (n.type === 'boss') {
        const repeat = !!(meta && meta.cleared && meta.cleared.indexOf(run.areaId) >= 0);
        gold = Math.round((area.fightMoney || 0) * (repeat ? 0.5 : 1));
        run.bossTurns = M.turn;
        if (isMonument) {
          /* すでに通常の loot（自分の一撃で倒した分）に同じIDが混ざっていることがあるので、
           * 重複させない。bossBonusOf（マスター初回撃破／部屋累計）は使わない（bossMasterOf が
           * この封印戦では null を返すので、使っても何も付与しない）。 */
          if (loot.indexOf(area.monumentCard) < 0) {
            run.gainedCards.push(area.monumentCard);
            run.lootPending.push(area.monumentCard);
          }
          run.log.push('封印を解いた：' + (area.bossName || 'モニュメント') + 'の一枚');
        } else {
          /* M8.1 WP4（実装計画§3-3）：ボス報酬。戦利品の振り分け画面（M6.6 WP7）に一緒に
           * 載せるため、ここで確定させて lootPending／gainedCards に足す。実際の
           * meta.bossWins／meta.clears への加算は settle() が行う（bossBonusOf は読むだけ）。 */
          run.bossBonus = bossBonusOf(run, area, meta);
          if (run.bossBonus.masterCard != null) {
            run.gainedCards.push(run.bossBonus.masterCard);
            run.lootPending.push(run.bossBonus.masterCard);
            run.log.push('マスター初回撃破報酬：' + run.bossBonus.masterName + 'の一枚');
          }
          if (run.bossBonus.roomCard != null) {
            run.gainedCards.push(run.bossBonus.roomCard);
            run.lootPending.push(run.bossBonus.roomCard);
            run.log.push('部屋（' + run.bossBonus.room + '）累計' + run.bossBonus.threshold + '回クリア報酬');
          }
        }
      }
      run.gold += gold;
      run.lp = M.players.self.lp;
      run.log.push((n.type === 'boss' ? 'ボス' : '戦闘') + 'に勝利（'
        + (gold ? 'Ｇ+' + gold + '・' : '') + '戦利品' + loot.length + '枚）');
      return { win: true, loot: loot, gold: gold };
    }
    run.lp = 0;
    run.outcome = 'lose';
    run.log.push((n.type === 'boss' ? 'ボス' : '戦闘') + 'に敗北');
    return { win: false };
  }

  /* ---- 戦利品の振り分け（M6.6 WP7） ---------------------------------------- */

  /** そのカードを今すぐ「デッキに加える」が選べるか（合計40未満・同種上限内）。
   * M7 WP3.5（案B）：レンタルはデッキ40枚の枠外なので、gainCard と同じ理由で
   * 空き枠の計算に**数えない**（以前は数えていた）。 */
  function canAssignToDeck(run, id) {
    const hasSlot = CQCollection.countsTotal(run.deck) < DECK_SIZE;
    return hasSlot && CQCollection.canAddToDeck(run.deck, id).ok;
  }

  /** 戦利品カード1枚を「デッキ」か「本」へ確定する（§4 WP7）。run.lootPending から
   * 該当の1枚を取り除く（同じIDが複数あるときはどれを消しても結果は同じなので先頭を消す）。
   * 「本に送る」は常に成功（本は上限なし＝必ず貰える）。「デッキに加える」は空きが無ければ
   * 失敗を返す（画面側は無効化しておくのが基本だが、二重タップ等の保険として弾く）。
   * cards はログ表示用（省略可・applyDraft と同じ規約）。 */
  function resolveLootPick(run, id, dest, cards) {
    if (!run.lootPending) run.lootPending = [];
    const idx = run.lootPending.indexOf(+id);
    if (idx < 0) return { ok: false, reason: '対象のカードが見つかりません' };
    if (dest === 'deck') {
      if (!canAssignToDeck(run, id)) return { ok: false, reason: 'デッキに空きがありません' };
      run.deck[id] = (run.deck[id] || 0) + 1;
    } else {
      if (!run.bookAdd) run.bookAdd = {};
      run.bookAdd[id] = (run.bookAdd[id] || 0) + 1;
    }
    run.lootPending.splice(idx, 1);
    const name = cards && cards[id] ? cards[id].n : id;
    run.log.push('戦利品：' + name + '→' + (dest === 'deck' ? 'デッキ' : '本'));
    return { ok: true, dest: dest };
  }

  /* ---- 宝箱・休憩・ショップ・換金・？イベント ------------------------------------- */

  function openChest(run, n) {
    if (n.opened) return { gold: 0, cardId: null };
    n.opened = true; n.cleared = true;
    run.gold += n.gold;
    if (n.cardId != null) gainCard(run, n.cardId);
    run.log.push('宝箱：Ｇ+' + n.gold + (n.cardId != null ? '・カード獲得' : ''));
    return { gold: n.gold, cardId: n.cardId };
  }

  /* M6.6 WP8：休憩の回復量は+5（本人確定・実装計画追補§2-5）。ショップの有料回復も
   * 同じ量に揃える（追補が推奨。値が2箇所に分かれないよう定数を1つにまとめた）。 */
  const REST_HEAL_AMOUNT = 5;

  function rest(run, n) {
    n.cleared = true;
    const before = run.lp;
    run.lp = Math.min(run.maxLp, run.lp + REST_HEAL_AMOUNT);
    const healed = run.lp - before;
    run.log.push('休憩：ＬＰ ' + before + '→' + run.lp);
    return { lp: run.lp, healed: healed };
  }

  const SHOP_RATE = 0.5;   /* ラン中ショップの割引率（初期値。ログショップ本体はM7） */
  function shopPrice(cards, cardId) {
    const c = cards[cardId];
    return c ? Math.max(50, Math.round(c.p * SHOP_RATE)) : 0;
  }
  function shopBuy(run, cards, n, cardId) {
    if (n.stock.indexOf(cardId) < 0) return { ok: false, reason: '品揃えにありません' };
    const cost = shopPrice(cards, cardId);
    if (run.gold < cost) return { ok: false, reason: 'Ｇが足りません' };
    run.gold -= cost;
    gainCard(run, cardId);
    n.stock.splice(n.stock.indexOf(cardId), 1);
    run.log.push('購入：' + (cards[cardId] ? cards[cardId].n : cardId) + '（-' + cost + 'Ｇ）');
    return { ok: true, cost: cost };
  }
  function shopHeal(run, n) {
    if (run.gold < n.healCost) return { ok: false, reason: 'Ｇが足りません' };
    run.gold -= n.healCost;
    const before = run.lp;
    run.lp = Math.min(run.maxLp, run.lp + REST_HEAL_AMOUNT);
    run.log.push('ショップでＬＰ回復：' + before + '→' + run.lp + '（-' + n.healCost + 'Ｇ）');
    return { ok: true, lp: run.lp };
  }
  function shopClearFog(run, n) {
    if (!n.hasFogClear || run.map.fog.cleared) return { ok: false, reason: '霧払いはできません' };
    if (run.gold < n.fogClearCost) return { ok: false, reason: 'Ｇが足りません' };
    run.gold -= n.fogClearCost;
    run.map.fog.cleared = true;
    run.log.push('霧払い（-' + n.fogClearCost + 'Ｇ）');
    return { ok: true };
  }
  function shopLeave(run, n) { n.cleared = true; }

  /* ---- 買い取り所（M7 WP8・経済追補§4-3〜§4-6） ---------------------------
   *
   * 旧・換金所を置き換えた。**Ｇを払って、いま借りているレンタルカードを買い取る**＝
   * レンタル属性が外れて自分のものになり、記憶データにも登録され、ラン終了後も手元に残る。
   * ショップ（抽選された品揃えから選ぶ＝運）の弱点を、
   * 「使ってみて良いと分かっているものを狙って買う＝確定」で埋めるのが狙い（§4-3）。
   *
   * 旧・換金所の売却（`sell()`）は**削除した**（§4-2でホームのログショップへ移った）。
   * ラン中に持ち出したカードを売る手段はもう無い＝ラン中にデッキが減ることはない。 */

  /** 買い取り価格（§4-4）：汎用は**定価ちょうど**、貴重は**定価×1.5**。
   * 貴重かどうかの閾値は**そのランのエリアの値**（§3-4）を使う——ラン中ショップの品揃え判定と
   * 同じ値でなければ、同じランの中で「貴重」の定義が2つできて事故る。
   * 割増率はホームの貴重限定枠と同じ `CQCollection.RARE_MARKUP`（規則を1本に保つ）。 */
  function buyoutPrice(cards, cardId, areaId) {
    const c = cards[cardId];
    if (!c || typeof c.p !== 'number') return 0;
    const th = CQAreas.rareThreshold(areaId);
    return CQCollection.isRare(c, th) ? Math.round(c.p * CQCollection.RARE_MARKUP) : c.p;
  }

  /** レンタルの idx 番目を買い取る。**同じカードを2枚借りていることがある**ので、
   * カードidではなく並びの位置で指定する（idで消すとどちらが消えたか曖昧になる）。
   *
   * 買い取ったカードは `gainCard()` を通す＝他の入手（戦利品・宝箱・購入）と同じ経路で
   * デッキか本に入り、`run.gainedCards` に載って記憶データに登録される。
   * 本行きになった場合だけ `run.bought` にも積み、ランの間は枠外で使い続けられるようにする。 */
  function buyout(run, cards, idx) {
    if (!run.rentals || idx < 0 || idx >= run.rentals.length) {
      return { ok: false, reason: '借りているカードがありません' };
    }
    const id = run.rentals[idx];
    const price = buyoutPrice(cards, id, run.areaId);
    if (!price) return { ok: false, reason: 'このカードは買い取れません' };
    if (run.gold < price) return { ok: false, reason: 'Ｇが足りません' };
    if (!run.bought) run.bought = [];     /* 旧形式の cq_run（中断中のラン）を再開した場合の保険 */
    run.gold -= price;
    run.rentals.splice(idx, 1);
    const dest = gainCard(run, id);
    if (dest === 'book') run.bought.push(id);
    run.log.push('買い取り：' + (cards[id] ? cards[id].n : id) + '（-' + price + 'Ｇ）');
    return { ok: true, id: id, price: price, dest: dest };
  }

  function buyoutLeave(run, n) { n.cleared = true; }

  /* 売却率。表示側（js/run-ui.js）も同じ式を使えるよう sellPrice() として公開する
   * ——以前は画面側で率を再計算しており、変えるときに2箇所直す必要があった。
   * M6.6 WP9：40%→50%（実装計画追補§4 WP9-b）。
   * **M7 WP7：50%→25%**（経済追補§4-2・ゲーム仕様書§7に実装を合わせた）。
   * 売却の場所がラン中の換金所からホームのログショップへ移り、ラン中の換金所は
   * 買い取り所（WP8）になるので、レート差で棲み分ける必要がもう無い。
   * **ホームの売却・一括換金もこの関数を通す**（CQCollection.bulkSellPlan に渡す）。 */
  const SELL_RATE = 0.25;
  function sellPrice(cards, cardId) {
    const c = cards[cardId];
    return c ? Math.max(10, Math.round(c.p * SELL_RATE)) : 0;
  }
  /* ★ラン中の売却（旧 sell()）は M7 WP8 で**削除した**（経済追補§4-2でホームへ移った）。
   * ラン中にカードが減る経路はもう無い。ホームの売却は CQCollection.sellFromBook が受ける。 */

  function resolveQuestion(run, n) {
    if (n.resolved) return null;
    n.resolved = true; n.cleared = true;
    const ev = n.event, eff = ev.effect || {};
    const res = { text: ev.text };
    if (eff.lp) { run.lp = Math.max(0, Math.min(run.maxLp, run.lp + eff.lp)); res.lp = eff.lp; }
    if (eff.gold) { run.gold = Math.max(0, run.gold + eff.gold); res.gold = eff.gold; }
    if (eff.draftCard && n.cardId != null) {
      gainCard(run, n.cardId);
      res.cardId = n.cardId;
    }
    run.log.push('？：' + ev.text);
    if (run.lp <= 0) run.outcome = 'lose';
    return res;
  }

  /* ---- 終了 ------------------------------------------------------------ */

  function retire(run) { run.outcome = 'retire'; }

  /* ---- M6.6 WP11：清算の減額と称号 -------------------------------------- */

  /** 終わり方ごとの減額率（追補§4 WP11-3）。**減るのは「今日の獲得ぶん」だけ**で、
   * 出発時に持って出たＧ（startGold）は終わり方に関わらず減らない——だから
   * 「リタイヤは獲得額−50%」という書き方になっている。マスター撃破は減額なし。 */
  const SETTLE_CUT = { win: 0, retire: 0.5, lose: 0.75 };

  /** 清算のひっ算に出す内訳を計算する（副作用なし）。UIの段階表示と settle() が
   * **同じ関数**を見るようにしてある——表示と実額がズレる事故は、換金所の売値で一度
   * やっているので繰り返さない（§4 WP9-b の sellPrice と同じ理由）。
   *   carried … 出発時に持って出たＧ（減らない）
   *   earned  … 今日の獲得ぶん。買い物で持ち出しぶんまで食い込んだ場合は 0
   *             （マイナスの獲得に減額を掛けて“損したぶんが返ってくる”のを防ぐ）
   *   cut     … earned に rate を掛けた減額（10Ｇ単位に丸める。宝箱・売値と同じ刻み）
   *   final   … 清算後の所持Ｇ＝run.gold − cut */
  function settleGold(run) {
    const rate = SETTLE_CUT[run.outcome] || 0;
    const carried = run.startGold != null ? run.startGold : run.gold;
    const earned = Math.max(0, run.gold - carried);
    const cut = Math.round(earned * rate / 10) * 10;
    return { carried: carried, earned: earned, rate: rate, cut: cut, final: run.gold - cut };
  }

  /** 称号の初期セット4つ（追補§4 WP11-5）。cond(run, meta) が true なら獲得。
   * meta を見てよいのは「初めて」を判定するため（cleared は settle() より前の状態を見る）。 */
  /* エリアの踏破称号（M8.1 WP3・実装計画§2-4）：草原・森だけの手書きだったものを
   * エリア表から自動生成する。key は既存セーブとの互換のため 'clear' + Pascal(areaId)
   * のまま（草原→clearGrassland・森→clearForest は生成結果も従来と完全に同じ文字列）。 */
  function pascal(id) { return id.charAt(0).toUpperCase() + id.slice(1); }
  const AREA_TITLES = CQAreas.list().map(function (area) {
    return {
      key: 'clear' + pascal(area.id), name: area.name + 'の踏破者',
      desc: area.name + 'のマスターを初めて撃破',
      cond: function (run) { return run.outcome === 'win' && run.areaId === area.id; }
    };
  });

  const TITLES = [
    { key: 'firstReturn', name: '初めての帰還', desc: '初めてランを終えた',
      cond: function () { return true; } }                        /* 終わり方は問わない */
  ].concat(AREA_TITLES).concat([
    /* 「無傷の一日」＝クリア時のＬＰが出発時（10）以上（2026-08-29 本人確定）。
     * 追補の原文は「ＬＰ満タンのまま」だが、ランは 10／15 で始まる＝満タンではないため、
     * 文字どおりだと回復してからクリアしないと取れない称号になってしまう。
     * 途中で削られても休憩などで取り返してあればよい、という条件に確定した。 */
    { key: 'flawless', name: '無傷の一日', desc: 'ＬＰを出発時まで保ったままクリア',
      cond: function (run) {
        return run.outcome === 'win' && run.lp >= (run.startLp != null ? run.startLp : run.lp);
      } },
    /* M8.1 WP4（実装計画§3-3）：原作のルームＡ／Ｓ限定の速攻報酬（磁場変動・爆雷）を
     * カードではなく実績（称号）に置き換えたもの。エリアの部屋がＡ帯以上のときだけ対象。 */
    { key: 'speedKill8', name: '速攻の達人', desc: 'Ａ帯以上のボスを8ターン以内に降す',
      cond: function (run) {
        if (run.outcome !== 'win' || run.bossTurns == null) return false;
        const area = CQAreas.get(run.areaId);
        return !!(area && HIGH_ROOMS[roomOf(area)] && run.bossTurns <= 8);
      } },
    { key: 'speedKill10', name: '疾風の一撃', desc: 'Ａ帯以上のボスを10ターン以内に降す',
      cond: function (run) {
        if (run.outcome !== 'win' || run.bossTurns == null) return false;
        const area = CQAreas.get(run.areaId);
        return !!(area && HIGH_ROOMS[roomOf(area)] && run.bossTurns <= 10);
      } }
  ]).concat([
    /* M8.3 WP17（実装計画§4 WP17）：ここからの3つは meta だけで判定できる称号
     * （metaOnly:true）。settle()（ランの終わり）だけでなく reportDragonBattle()
     * （神竜の間・ランを経由しない）でもチェックする——鍵7・全169種は神竜討伐が
     * きっかけで達成することもあるため（連続攻撃154・修練の拳187は神竜討伐報酬）。
     * cond の第一引数（run）は使わない（metaOnly の呼び出し側は常に null を渡す）。 */
    { key: 'allKeys', name: '七つの鍵', desc: '七つの鍵をすべて集めた', metaOnly: true,
      cond: function (run, meta) { return !!(meta && (meta.keys || []).length >= 7); } },
    { key: 'endingSeen', name: '結末を見た者', desc: 'エンディングに到達した', metaOnly: true,
      cond: function (run, meta) { return !!(meta && meta.endingSeen); } },
    /* 169＝コレクション対象（U/M/S・空白180を除く）の総数（js/run-ui.js の COLLECTION_TOTAL・
     * tests/run.js で毎回169であることを固定している値と同じ。run.js は cards 配列を
     * 受け取らない純関数群なので、ここでも同じ値を独立して持つ——BLANKの二重管理と同じ理由）。 */
    { key: 'allSpecies', name: '記録の完成', desc: '全169種の記憶データを集めた', metaOnly: true,
      cond: function (run, meta) { return !!(meta && (meta.known || []).length >= COLLECTION_TOTAL); } }
  ]);

  /** このランで**新しく**得た称号（既に持っているものは返さない）。副作用なし。
   * metaOnly の称号はここでは判定しない（earnedMetaTitles が担当）——run が無い
   * 呼び出し元（reportDragonBattle）で cond(run) が run.outcome 等に触れて例外に
   * なる事故を防ぐため、2つの関数を分けてある。 */
  function earnedTitles(run, meta) {
    const had = (meta && meta.titles) || [];
    return TITLES.filter(function (t) {
      return !t.metaOnly && had.indexOf(t.key) < 0 && t.cond(run, meta);
    });
  }

  /** meta だけで判定できる称号（metaOnly:true）のうち、まだ持っていないものを返す。
   * run を経由しない場所（reportDragonBattle）からも呼べる。副作用なし。 */
  function earnedMetaTitles(meta) {
    const had = (meta && meta.titles) || [];
    return TITLES.filter(function (t) {
      return !!t.metaOnly && had.indexOf(t.key) < 0 && t.cond(null, meta);
    });
  }

  /** 日誌に1行足す（M6.6 WP11・台本§7.2）。文面の組み立ては js/lore.js の仕事なので、
   * ここは受け取った文字列を積むだけにしてある（エンジンが台本に依存しないように）。 */
  const JOURNAL_MAX = 200;
  function pushJournal(meta, line) {
    CQCollection.ensure(meta);
    if (!line) return meta.journal;
    meta.journal.push(line);
    if (meta.journal.length > JOURNAL_MAX) meta.journal = meta.journal.slice(-JOURNAL_MAX);
    return meta.journal;
  }

  /** ランを終えて meta（永続所持データ）に反映する（M6.6 WP3：移動モデル）。
   *   deck   … run.deck の複製が保存デッキになる（次のランへそのまま持ち越し）。
   *            ラン中の売却で減った分は本に戻らない＝カードが世界から消える（§2-8）。
   *            旧セーブ由来の実体の空白(180)はここで捨てる（空白は実体で持たない）。
   *   book   … ラン中に本行きになった分（run.bookAdd）を加算。
   *   known  … ラン中に入手した種類（run.gainedCards）を登録。
   *            レンタル（run.rentals）は登録しない＝返却されて記憶にも残らない。
   *            **唯一の例外が買い取り（M7 WP8）**：買い取った時点で run.rentals から外れ
   *            gainCard() を通っているので、ここでは何もしなくても自然に登録される。
   *   gold   … M6.6 WP11：終わり方に応じて**今日の獲得ぶんだけ**減らして書く（settleGold）。
   *   titles / journal / day … 同じくWP11。内訳は run.settled にも残し、
   *            結果画面が「いま何が起きたか」を再計算せずに描けるようにする。
   *
   * **2回呼ばないこと。** 2度目は称号がもう meta にあるので新規ゼロになり、Ｇはさらに
   * 減額される。呼び出しは advanceAfterBattle と retire の2箇所だけ＝ランにつき1回。
   * 事故（二重タップ等）に備えて run.settled で番をしてある。 */
  function settle(run, meta) {
    CQCollection.ensure(meta);
    if (run.settled) return meta;                     /* 二重清算の防止（上のコメント参照） */
    meta.deck = Object.assign({}, run.deck);
    delete meta.deck[BLANK];
    Object.keys(meta.deck).forEach(function (k) { if (meta.deck[k] <= 0) delete meta.deck[k]; });
    Object.keys(run.bookAdd || {}).forEach(function (k) {
      if (run.bookAdd[k] > 0) meta.book[k] = (meta.book[k] || 0) + run.bookAdd[k];
    });
    (run.gainedCards || []).forEach(function (id) { CQCollection.registerKnown(meta, id); });
    const gold = settleGold(run);
    meta.gold = gold.final;
    /* M8.1 WP4（実装計画§3-3）：ボス報酬のカウンタ加算。bossBonusOf（reportBattle側）は
     * この加算より前の値を読んで「初めて／何回目」を判定しているので、ここでの加算は
     * 判定そのものには使わない——次のラン以降のための記録。bossMasterOf は run.seed と
     * run.repeatVisit だけで決まる純関数なので、戦闘時と同じマスターIDが再現される。 */
    if (run.outcome === 'win') {
      const bossArea = CQAreas.get(run.areaId);
      const masterId = bossMasterOf(run, bossArea);
      /* 七罪人のエリア（洞窟）には闘技場マスターが居ないので masterId は null。
       * そのときは bossWins を触らない（"null" というキーを作らない）。 */
      if (masterId != null) {
        meta.bossWins[masterId] = (meta.bossWins[masterId] || 0) + 1;
        /* M8.3 WP14（実装計画§4 WP14）：バルザミコス（role:'final'）に初めて勝つと
         * meta.endingSeen を立てる——原作の「ルームＳ3連勝で光臨」をエンディング到達の
         * 証に置き換えた（実装計画§3-3の該当行）。role で判定するので、area/idを
         * ハードコードしない（今のところ99だけだが、将来increaseしても対応できる）。
         * run.endingSeenNow は「今回のランで初めて立った」ことをUI（WP15）へ伝える印。 */
        const mInfo = CQOpponents.get(masterId);
        if (mInfo && mInfo.role === 'final' && !meta.endingSeen) {
          meta.endingSeen = true;
          run.endingSeenNow = true;
        }
      }
      meta.clears[run.areaId] = (meta.clears[run.areaId] || 0) + 1;
      /* M8.2 WP9（実装計画§3-4）：七罪人を降すと**鍵が確定で手に入る**。1つの洞窟につき1本
       * （周回しても増えない）。表示・節目・目標への反映は WP10。 */
      if (bossArea && bossArea.sinId != null && meta.keys.indexOf(run.areaId) < 0) {
        meta.keys.push(run.areaId);
        run.keyGained = run.areaId;
      }
    }
    /* 称号は cleared を更新する**前**に判定する（「初めて撃破」が cleared 由来ではなく
     * meta.titles 由来なので実害は無いが、判定材料の並びを素直に保つ）。
     * M8.3 WP17：metaOnly の称号（鍵7・エンディング・全169種）は、このランで
     * 鍵やカードが増えた結果として今まさに満たされることがあるので、通常の称号と
     * 同じ1つの配列（run.settled.titles）に混ぜて結果画面へ渡す。 */
    const titles = earnedTitles(run, meta).concat(earnedMetaTitles(meta));
    titles.forEach(function (t) { meta.titles.push(t.key); });
    meta.day = (meta.day || 0) + 1;
    /* M7 WP10：記録画面の統計。終わり方の内訳・ボス撃破数・累計の獲得枚数を数える。
     * `day`（通算日数）と重複しないよう、ここでは内訳だけを持つ。 */
    const st = meta.stats;
    if (run.outcome === 'win') { st.win += 1; st.boss += 1; }
    else if (run.outcome === 'retire') st.retire += 1;
    else st.lose += 1;
    st.cards += (run.gainedCards || []).length;
    if (run.outcome === 'win' && meta.cleared.indexOf(run.areaId) < 0) meta.cleared.push(run.areaId);
    run.settled = { gold: gold, titles: titles, day: meta.day, keyGained: run.keyGained || null };
    return meta;
  }


  const api = {
    DECK_SIZE, BLANK, DRAFT_ROUNDS, RENTAL_MAX, buildBattleDeck, buildBossDeck, buildPlayerDeck,
    bossMasterOf, bossDisplayName,
    start, gainCard, beginDraftRound, applyDraft, draftTarget, hasBlankSlot, depart,
    node, currentNode, choices, advance,
    battleSeed, firstTurnOf, battleSetup, reportBattle, reportFlee,
    tutorialStage, tutorialSpec, applyTutorialNode,
    canAssignToDeck, resolveLootPick,
    openChest, rest, shopPrice, shopBuy, shopHeal, shopClearFog, shopLeave,
    sellPrice, buyoutPrice, buyout, buyoutLeave, resolveQuestion, retire, settle,
    SETTLE_CUT, settleGold, TITLES, earnedTitles, earnedMetaTitles, COLLECTION_TOTAL, pushJournal,
    roomOf, bossBonusOf, effectiveBossPool,
    dragonSacrificeOk, dragonSacrificeConsume, dragonBattleSetup, reportDragonBattle
  };
  global.CQRun = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
