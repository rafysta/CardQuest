/* CardQuest — ゲーム内テキスト（台本）
 *
 * 『CardQuest 台本（アンバーのセリフ集）』§8 の構造そのまま。**文面の推敲がコードを
 * 触らずにできること**が最重要なので、ゲーム内のセリフは全部このファイルに閉じる。
 * run-ui.js からはキーで引くだけにする。
 *
 * 1つの吹き出し = { face: 'calm'|'down', lines: [string, string?] }
 *   配列        = 順に送る吹き出し群
 *   配列の配列  = ランダムに1つ選ぶ候補群（repeat など）
 *
 * 表記の規約（台本§0。推敲するときは必ず守る）：
 *   1吹き出しは2行まで・1行は全角24〜28文字以内／話者はアンバーのみ／一人称「私」・
 *   呼びかけ「お前」／感嘆符を使わない・励まさない・褒めない／三点リーダはアンバーが
 *   自分の過去に触れるときだけ（そのとき face は down）／説明と情感を混ぜない。
 *
 * 実装状況（2026-09-02 M7 WP5時点）：
 *   opening … WP1で実装（従来 js/run-ui.js に直書きしていたものをここへ移した）
 *   areas   … WP4で実装（開始マスの案内）
 *   home    … WP5で実装（ホーム画面。onFirstKey/onAllKeys/onExeCardはM8以降まで未使用）
 *   result / journal … M6.6 WP11で実装
 *   hints   … carryOut のみ実装。残り15種は将来の宿題（段階的開示の索引化とあわせて）
 *   nodes   … 未実装
 *
 * 台本本体との差分：opening は『実装計画追補M6.6』§5-1 の改訂版（目覚めの一枚を使う版）で、
 * 台本§1（旧オープニング）を置き換えたもの。areas.*.masterIntro と hints.carryOut は
 * 同追補 §5-2／§5-3 の追加分。次に台本本体を更新するとき v0.2 として取り込むこと。
 *
 * DOMには依存しない（Nodeのテストからも読める）。
 */
'use strict';
(function (global) {

  const LORE = {

    /* オープニング＝目覚めの場面（初回起動時のみ・M6.6 WP1）。追補§5-1。 */
    opening: [
      { face: 'calm', lines: ['起きたか。'] },
      { face: 'calm', lines: ['名も、来し方も、覚えていない。', 'そういう顔をしている。'] },
      { face: 'calm', lines: ['私はアンバー。', 'この本に憑いている。'] },
      { face: 'calm', lines: ['ここはソウルゲート。', '渡れなかった魂が溜まる島だ。'] },
      { face: 'calm', lines: ['島の魂は、鎮めて書き留めれば呼べる。', 'それをする者を、記録者と呼ぶ。'] },
      { face: 'down', lines: ['……お前も、しばらくは出られん。'] },
      { face: 'calm', lines: ['自分が誰だったか知りたければ、', 'まずは書け。'] },
      { face: 'down', lines: ['白紙ばかりだが、書き残しが少しある。', '……前の持ち主の分だ。'] },
      { face: 'calm', lines: ['受け継いでおけ。', '最初は、それで足りる。'] },
      { face: 'calm', lines: ['行くぞ。今日の巡り先を選べ。'] }
    ],

    /* 開始マスの案内（M6.6 WP4）。2026-08-28 本人指定で**2回に分けて**出す：
     *
     *   ① 持ち出しの前（マップを見せながら）
     *        first（初回）または repeat（2回目以降・候補群から1つ）
     *        → fog（霧の日）／fieldRule（戦場ルールの日）＝今日の状況
     *        → hints.carryOut（初回だけの持ち出しの説明）
     *   ② 持ち出し・ドラフトを終えて、出発する直前（またマップを見せながら）
     *        masterIntro（初回のみ）→ depart（送り出しの一言・初回のみ）
     *
     *   ①は「今日どんな日か」と「何を持っていくか」、②は「この先に誰がいるか」と「行け」。
     *   デッキを組む判断に要る話を先に、送り出しを最後に置く並びにしてある。
     * fieldRule は全エリア共通なので areas の外（下の common）に置いてある。 */
    areas: {
      grassland: {
        first: [                                                    /* 台本§3.1-1 */
          { face: 'calm', lines: ['草原だ。ここの魂は薄い。', '長く留まりすぎて、形を忘れかけている。'] }
        ],
        /* 台本§3.1-3。②で出す送り出し。2026-08-28 本人指定により
         * §3.1-2「道は二つに分かれる。／強い相手ほど、良い記録になる。」は削除した。 */
        depart: [
          { face: 'calm', lines: ['行け。日が暮れるまでには戻れ。'] }
        ],
        repeat: [                                                   /* 台本§3.2・1つをランダムに */
          [{ face: 'calm', lines: ['草原だ。……今日も、書けるだけ書こう。'] }],
          [{ face: 'calm', lines: ['同じ魂がまた立っている。', '書かれなかったからだ。'] }],
          [{ face: 'calm', lines: ['草原だ。急ぐことはない。'] }]
        ],
        masterIntro: [                                              /* 追補§5-2・初回のみ */
          { face: 'calm', lines: ['最奥に、この土地のマスターがいる。', '老いた記録者だ。悪い男ではない。'] }
        ],
        fog: null                                                   /* 草原は霧率0% */
      },
      forest: {
        first: [                                                    /* 台本§4.1-1〜2 */
          { face: 'calm', lines: ['森は魂が濃い。木の影が、', '影のままでいてくれるとは限らん。'] },
          { face: 'calm', lines: ['ここのマスターは誰かを探している。', '探し物は、もう見つからんと思うがな。'] }
        ],
        depart: [                                                   /* 台本§4.1-3。②で出す送り出し */
          { face: 'calm', lines: ['足元を見ろ。深入りするな。'] }
        ],
        repeat: [                                                   /* 台本§4.2 */
          [{ face: 'calm', lines: ['森だ。……今日は見通しがきくな。'] }],
          [{ face: 'calm', lines: ['木が濡れている。魂が近い。'] }],
          [{ face: 'calm', lines: ['森だ。あの人はまだ探しているだろう。'] }]
        ],
        masterIntro: [                                              /* 追補§5-2・初回のみ */
          { face: 'calm', lines: ['最奥のマスターは、フードの記録者だ。', '誰かを探して、歩き続けている。'] }
        ],
        fog: [                                                      /* 台本§4.3・霧の日に追加で1つ */
          { face: 'down', lines: ['霧だ。……こういう日は、', '私も昔よく間違えた。'] }
        ]
      }
    },

    /* ホーム画面（ジェイルタウン・M7 WP5）。台本§2。
     *   first … オープニング直後、初めてホームに立ったときだけ（§2.1・3つ）
     *   idle  … 通常、ホームに戻るたびランダムに1つ（§2.2・候補群）
     *   onLevelUp / onAreaOpen … 節目（§2.3）。条件を満たした最初のホームで必ず出す。
     *     {n} はマスターレベル上昇時の記憶データ種類数、{area} は解放されたエリア名。
     *   onFirstKey / onAllKeys / onExeCard … 台本§2.3にある残り3つの節目。鍵・エグゼデグゼスは
     *     M8以降で入る要素で、現行コードには対応する状態が無いため今はまだ呼び出されない
     *     （文面だけ先にここへ置いておく。WP5実施メモに申し送り済み）。 */
    home: {
      first: [                                                    /* 台本§2.1 */
        { face: 'calm', lines: ['ジェイルタウン。島で唯一の街だ。'] },
        { face: 'calm', lines: ['もとは罪ある魂を留め置く牢だった。', 'いまは記録者の宿場だ。'] },
        { face: 'calm', lines: ['まずは草原へ行け。', '始めるにはちょうどいい。'] }
      ],
      idle: [                                                     /* 台本§2.2・1つをランダムに */
        [{ face: 'calm', lines: ['今日はどこを巡る。'] }],
        [{ face: 'calm', lines: ['本は編んだか。', '白紙のままでは何も呼べん。'] }],
        [{ face: 'calm', lines: ['街の記録所は、金さえ積めば大抵は出す。', '貴重なものは別だがな。'] }],
        [{ face: 'calm', lines: ['急ぐな。時間だけはいくらでもある。'] }],
        [{ face: 'down', lines: ['……夜が長いな。'] }]
      ],
      onLevelUp: [                                                /* 台本§2.3 */
        { face: 'calm', lines: ['{n}種。お前の格が上がった。', '行ける場所が増える。'] }
      ],
      onAreaOpen: [                                                /* 台本§2.3 */
        { face: 'calm', lines: ['{area}へ行けるようになった。'] }
      ],
      onFirstKey: [                                                /* 台本§2.3（M8以降で使用） */
        { face: 'down', lines: ['鍵だ。……島の底に、七つ眠っている。'] },
        { face: 'calm', lines: ['全て集めれば、門の封が解ける。'] }
      ],
      onAllKeys: [                                                 /* 台本§2.3（M8以降で使用） */
        { face: 'calm', lines: ['七つ揃った。神殿へ行け。', '門の封が解ける。'] }
      ],
      onExeCard: [                                                 /* 台本§2.3（M8以降で使用） */
        { face: 'down', lines: ['門の主を書き留めたな。'] },
        { face: 'calm', lines: ['……教会へ行け。あれが待っている。'] }
      ]
    },

    /* エリアに依らない開始マスの追加分（追補§5-2）。 */
    common: {
      /* 戦場ルールが1つでも付いている日。おじゃま虫（pestCard）が出る日は下の pest を代わりに出す。 */
      fieldRule: [
        { face: 'calm', lines: ['この辺りは条理がゆがんでいる。', '戦いの前に、場をよく見ろ。'] }
      ],
      pest: [
        { face: 'calm', lines: ['今日は虫が多い。', '手札に潜り込んでくる。'] }
      ]
    },

    /* 段階的開示ヒント（台本§5）。cq_meta.seenHints にキーを立て、一度出したら二度と出さない。
     * WP4で使うのは carryOut（追補§5-3・持ち出しの説明）だけ。
     * 残る15種（placement／loot／gameOverFirst ほか）は M6.5c で足す。 */
    hints: {
      carryOut: [                                                   /* 追補§5-3・初回の開始マスで1度だけ */
        { face: 'calm', lines: ['本は重い。全部は持てん。', '持っていく分を選べ。四十枚までだ。'] },
        { face: 'calm', lines: ['置いていったものは街で待っている。', '売り買いしたければ、持って出ろ。'] }
      ]
    },

    /* 記録画面のトップに出す「いまの目標」（世界観§6.6・M7 WP10）。
     * **原作がクリアされなかった最大の原因への対策**なので、必ず1行出す（省略しない）。
     * どのキーを出すかは CQCollection.nextGoal() が決め、ここは文面だけを持つ
     * （エンジンを台本に依存させない分担）。{n}{area}{lv} は goalLine() が差し替える。 */
    goals: {
      deck:       'まず、本のカードをデッキに入れる。あと{n}枚は入る。',
      area:       '{area}のマスターを倒す。',
      collection: '記憶データを増やす。次の段階（マスターレベル{lv}）まであと{n}種。',
      done:       'この地でやることは、ひとまず終えた。次の土地の話は、まだ聞こえてこない。'
    },

    /* リザルト画面のアンバーの一言（台本§7.1・M6.6 WP11）。終わり方ごとに1つだけ出す。
     * ゲームオーバーだけ初回と2回目以降で分ける——台本§7.1が初回に §5 `gameOverFirst`
     * （「記録は失われない」＝原作最大のストレスが無いことの説明）を出すよう指定しており、
     * 『世界観とプレイヤー案内』§6.3 #13 が「最優先で作る」としている一節でもある。
     * ここが伝わるかどうかで2回目のプレイに進むかが決まる、という位置づけ。 */
    result: {
      clear:    { face: 'calm', lines: ['戻ったか。今日の分は、書けたな。'] },
      retire:   { face: 'down', lines: ['引き返すのは弱さではない。', '……私はそれができなかった。'] },
      gameOver: { face: 'calm', lines: ['倒れたか。記録は残っている。次だ。'] },
      /* 台本§5 gameOverFirst 相当。cq_meta.seenHints.gameOverFirst で一度きり。 */
      gameOverFirst: { face: 'down', lines: ['倒れても、本は消えん。', '書いたものは、お前のものだ。'] }
    },

    /* 日誌のテンプレート（台本§7.2・M6.6 WP11）。数字は**算用数字**で出す
     * （2026-08-29 本人確定。『世界観とプレイヤー案内』§8-5 で未確定だった点）。 */
    journal: {
      clear:     '{day}日目。{area}。書き留めた魂 {count}。ＬＰ {lp}で戻る。',
      bossFirst: '{day}日目。{area}。{master} を降す。',
      retire:    '{day}日目。{area}。引き返す。',
      gameOver:  '{day}日目。{area}。倒れて戻る。'
    }
  };

  /** 候補群（配列の配列）から1つ選ぶ。演出用なので Math.random でよい
   * （ゲームロジックはシード付きRNGのみ、の原則は維持＝マップ仕様書§4.2と同じ扱い）。
   * rand を渡せばテストから決定的に呼べる。 */
  function pickOne(groups, rand) {
    if (!groups || !groups.length) return [];
    const r = (typeof rand === 'function' ? rand() : Math.random());
    return groups[Math.min(groups.length - 1, Math.floor(r * groups.length))];
  }

  /** プレースホルダの単純置換（{n} {area} など。台本§8「実装メモ」）。 */
  function fill(bubbles, vars) {
    if (!vars) return bubbles;
    return (bubbles || []).map(function (b) {
      return {
        face: b.face,
        lines: b.lines.map(function (line) {
          return line.replace(/\{(\w+)\}/g, function (m, k) {
            return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
          });
        })
      };
    });
  }

  /** 日誌の1行を組み立てる（台本§7.2・M6.6 WP11）。kind は journal のキー。
   * fill() は吹き出し（{face, lines}）向けなので、素の文字列にはこちらを使う。 */
  function journalLine(kind, vars) {
    const tpl = LORE.journal[kind];
    if (!tpl) return '';
    return tpl.replace(/\{(\w+)\}/g, function (m, k) {
      return Object.prototype.hasOwnProperty.call(vars || {}, k) ? String(vars[k]) : m;
    });
  }

  /** 「いまの目標」の1行を組み立てる（世界観§6.6・M7 WP10）。
   * goal は CQCollection.nextGoal() の返り値（{key, n, area, lv}）。
   * 知らないキーが来ても空文字ではなく無難な1行を返す——**この行は必ず出す**決まりなので、
   * 目標の種類が増えたときに画面が空欄になるほうが害が大きい。 */
  function goalLine(goal) {
    const tpl = (goal && LORE.goals[goal.key]) || LORE.goals.done;
    return tpl.replace(/\{(\w+)\}/g, function (m, k) {
      return Object.prototype.hasOwnProperty.call(goal || {}, k) ? String(goal[k]) : m;
    });
  }

  const api = { LORE, pickOne, fill, journalLine, goalLine };
  global.CQLore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
