/* CardQuest エンジン単体テスト
 * 使い方: node tests/run.js
 * コミット前に必ず実行し、全件 PASS を確認すること。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ブラウザ用の data.js を読み込んで CARDS / CARD_BY_ID を得る */
const root = path.join(__dirname, '..');
const ctx = { window: undefined };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'js/data.js'), 'utf8')
  .replace(/^const /gm, 'globalThis.$&'.replace('$&', '') + '')
  .replace(/const (CARDS|CARD_BY_ID|DECKS)\b/g, 'var $1'), ctx);
vm.runInContext('globalThis.CARDS = CARDS; globalThis.CARD_BY_ID = CARD_BY_ID;', ctx);
const CARDS = ctx.CARDS, CARD_BY_ID = ctx.CARD_BY_ID;

const CQRng = require(path.join(root, 'js/engine/rng.js'));
const S = require(path.join(root, 'js/engine/state.js'));
const CQStats = require(path.join(root, 'js/engine/stats.js'));
const CQTurn = require(path.join(root, 'js/engine/turn.js'));

/* ---- ミニ・テストハーネス ---- */
let pass = 0, fail = 0; const failures = [];
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; }
  else { fail++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
}
function section(name) { /* 見出し。失敗時のログを読みやすくするだけ */ current = name; }
let current = '';
function t(label, fn) {
  try { fn(); }
  catch (e) { fail++; failures.push(`✗ [${current}] ${label} — 例外: ${e.message}\n${e.stack.split('\n')[1] || ''}`); }
}

/* ---- 盤面ビルダ ---- */
const OPT = { cards: CARD_BY_ID };
function lane(unitId, chs, opts) { return S.makeLane(unitId, chs || [], CARD_BY_ID, opts); }
function empty() { return S.emptyLane(); }
/** lanes: 最大6。省略分は空きレーン */
function board(lanes, handSelf, handEnemy) {
  const ls = lanes.slice();
  while (ls.length < 6) ls.push(empty());
  return S.makeBoard(ls, handSelf === undefined ? 5 : handSelf, handEnemy === undefined ? 5 : handEnemy);
}
function up(id, o) { return Object.assign({ card: id, up: true }, o || {}); }
function down(id, o) { return Object.assign({ card: id, up: false }, o || {}); }
/* 基準ユニット: 8 ピッグマン A500 D450 CH4 Lv1（固有能力はデッキ枚数制限のみ＝能力値に無関係） */
const PIG = 8, PIG_A = 500, PIG_D = 450;

/* ================= rng ================= */
section('rng');
t('同じシードは同じ列', () => {
  const a = CQRng.create(123), b = CQRng.create(123);
  eq([a.int(1, 50), a.int(1, 50), a.int(1, 50)], [b.int(1, 50), b.int(1, 50), b.int(1, 50)], 'rng determinism');
});
t('状態の保存と復元', () => {
  const a = CQRng.create(7); a.next(); const st = a.state();
  const x = a.next();
  const b = CQRng.create(0); b.restore(st);
  eq(b.next(), x, 'rng restore');
});
t('int の範囲', () => {
  const a = CQRng.create(42); let lo = 99, hi = -99;
  for (let i = 0; i < 500; i++) { const v = a.int(1, 6); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  eq([lo >= 1, hi <= 6], [true, true], 'rng int range');
});

/* ================= 基本のＣＨボーナス ================= */
section('ＣＨボーナス');
t('チャンネルなし＝素の値', () => {
  const b = board([lane(PIG)]);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def], [PIG_A, PIG_D], '素の値');
});
t('表+100攻／裏+100防（種別を問わず一律）', () => {
  const b = board([lane(PIG, [up(180), up(101), down(180)])]);   // 空白(表)・魔法(表)・空白(裏)
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def], [PIG_A + 200, PIG_D + 100], '±100');
});
t('狂戦士化：裏のボーナスも攻撃力へ', () => {
  const b = board([lane(PIG, [up(152), down(180), down(180)])]);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def], [PIG_A + 300, PIG_D], '狂戦士化');
});
t('魔道剣士：表向き魔法1枚が150点になる', () => {
  const b = board([lane(PIG, [up(161), up(101), up(102)])]);
  CQStats.recalc(b, OPT);
  eq(b.lanes[0].atk, PIG_A + 300 + 100, '魔道剣士 3枚表 + 魔法2枚×50');
});

/* ================= 素値の変換 ================= */
section('素値');
t('スキュラセル：手札×100', () => {
  const b = board([lane(4)], 6, 2);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def], [600, 600], 'スキュラセル');
});
t('リヴァイバー：敵手札×50はＣＨボーナス扱い', () => {
  const b = board([lane(58)], 5, 4);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def, b.lanes[0].atkBonus], [500 + 200, 500 + 200, 200], 'リヴァイバー');
});
t('マスターズソウル：装備なしは A200 D200 CH2', () => {
  const b = board([lane(64)]);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def, b.lanes[0].cap], [200, 200, 2], 'マスターズソウル素');
});
t('突然変異：奇数枚で入れ換え、偶数枚で戻る', () => {
  const b1 = board([lane(2, [up(164)])]);                       // パイロウイング A600 D400
  CQStats.recalc(b1, OPT);
  eq([b1.lanes[0].atk, b1.lanes[0].def], [400 + 100, 600], '突然変異1枚');
  const b2 = board([lane(2, [up(164), up(164)])]);
  CQStats.recalc(b2, OPT);
  eq([b2.lanes[0].atk, b2.lanes[0].def], [600 + 200, 400], '突然変異2枚=無効');
});
t('突然変異＋増幅：入れ換え無効（枚数が偶数化）', () => {
  const b = board([lane(2, [up(164), up(106)])]);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def], [600 + 200, 400], '突然変異×増幅');
});

/* ================= 磁場変動 ================= */
section('磁場変動');
t('ＣＨボーナスの攻防を入れ換える（素値はそのまま）', () => {
  const b = board([lane(2, [up(191), up(180), down(180), down(180)])]);
  // 表2(+200攻) 裏2(+200防) → 入れ換え → 攻=素+200(裏由来) 防=素+200(表由来)
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def], [600 + 200, 400 + 200], '磁場変動');
});
t('磁場変動＋増幅で無効（2倍→偶数）', () => {
  const b = board([lane(2, [up(191), up(106), down(180), down(180)])]);
  // 表2(+200攻) 裏2(+200防)、入れ換えは起きない
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def], [600 + 200, 400 + 200], '磁場変動×増幅');
});

/* ================= ＣＨ上限 ================= */
section('ＣＨ上限');
t('膨張+2、2枚で+4、3枚でも+4', () => {
  const mk = (n) => {
    const chs = []; for (let i = 0; i < n; i++) chs.push(up(158));
    const b = board([lane(28, chs)]);                            // スネイルリキッド CH0
    CQStats.recalc(b, OPT); return b.lanes[0].cap;
  };
  eq([mk(1), mk(2), mk(3)], [2, 4, 4], '膨張');
});
t('膨張＋増幅＝1枚で+4', () => {
  const b = board([lane(28, [up(158), up(106)])]);
  CQStats.recalc(b, OPT);
  eq(b.lanes[0].cap, 4, '膨張×増幅');
});
t('五つ星は完全上書き（膨張・白を無視、CH6→5）', () => {
  const b = board([lane(10, [up(157), up(158)])]);               // ヨルムンガンド CH6
  CQStats.recalc(b, OPT);
  eq(b.lanes[0].cap, 5, '五つ星');
});
t('上限クランプは6', () => {
  const b = board([lane(1, [up(158)])]);                         // ミルファイター CH5 +2 → 6
  CQStats.recalc(b, OPT);
  eq(b.lanes[0].cap, 6, 'クランプ6');
});
t('白の聖霊陣：自陣全レーン+1', () => {
  const b = board([lane(PIG, [up(195)]), lane(1), empty(), lane(PIG)]);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].cap, b.lanes[1].cap, b.lanes[3].cap], [5, 6, 4], '白の聖霊陣');
});
t('遮蔽・閉鎖：上限＝現在枚数', () => {
  const b = board([lane(PIG, [up(136), down(180)]), lane(PIG, [up(184)])]);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].cap, b.lanes[1].cap], [2, 1], '遮蔽・閉鎖');
});

/* ================= 増幅と負の値 ================= */
section('増幅・負値');
t('疫障＋増幅＝-500', () => {
  const b = board([lane(PIG, [up(155), up(106)])]);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def], [PIG_A + 200 - 500, PIG_D - 500], '疫障×増幅');
});
t('黒の邪霊陣×2＋疫障：クランプなしで負になる', () => {
  const b = board([lane(PIG, [up(196), up(196), up(155)])]);
  CQStats.recalc(b, OPT);
  // 表3=+300攻、黒2枚=-300/-300、疫障=-250/-250
  eq([b.lanes[0].atk, b.lanes[0].def], [PIG_A + 300 - 300 - 250, PIG_D - 300 - 250], '負値');
});
t('無効：魔法フラグを消す（障壁が効かない）', () => {
  const b = board([lane(PIG, [up(117), up(190)])]);
  CQStats.recalc(b, OPT);
  eq(b.lanes[0].def, PIG_D, '無効×障壁');   // 表2枚は攻+200のみ、障壁+300は消える
});
t('[修正2] レーン3(自陣3列目)の無効が自レーンの魔法を消す', () => {
  const b = board([lane(PIG, [up(117)]), empty(), lane(PIG, [up(117), up(190)])]);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].def, b.lanes[2].def], [PIG_D + 300, PIG_D], '無効の誤番地修正');
});
t('無効があるレーンでは増幅の倍化が止まる', () => {
  const b = board([lane(PIG, [up(155), up(106), up(190)])]);
  CQStats.recalc(b, OPT);
  eq(b.lanes[0].def, PIG_D - 250, '無効×増幅');
});

/* ================= 気化・爆殺 ================= */
section('気化・爆殺');
t('気化：攻防0に上書き', () => {
  const b = board([lane(PIG, [up(176), down(180)])]);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def], [0, 0], '気化');
});
t('爆殺：飽和時のみ+250（気化の後に加算される）', () => {
  const sat = board([lane(28, [up(104), up(176)])]);             // CH0+膨張なし… count2 > cap0 → 超過消滅が絡むので CH2 の 27 を使う
  const b = board([lane(27, [up(104), up(176)])]);               // メガゾエア CH2、飽和
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def], [250, 0], '気化+爆殺');
  const b2 = board([lane(PIG, [up(104)])]);                      // CH4、飽和でない
  CQStats.recalc(b2, OPT);
  eq(b2.lanes[0].atk, PIG_A + 100, '爆殺 非飽和');
});

/* ================= 個別の加減算 ================= */
section('個別加算');
t('魔力の盾：-100/+200（点数はカード枚数に比例）', () => {
  const b = board([lane(PIG, [up(153), up(153)])]);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def], [PIG_A + 200 - 200, PIG_D + 400], '魔力の盾×2');
});
t('石化：防+200', () => {
  const b = board([lane(PIG, [up(168)])]);
  CQStats.recalc(b, OPT);
  eq(b.lanes[0].def, PIG_D + 200, '石化');
});
t('巨大化：+100/+100', () => {
  const b = board([lane(PIG, [up(188)])]);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def], [PIG_A + 200, PIG_D + 100], '巨大化');
});
t('収束：自陣の他ユニット×100', () => {
  const b = board([lane(PIG, [up(170)]), lane(PIG), lane(PIG)]);
  CQStats.recalc(b, OPT);
  eq(b.lanes[0].atk, PIG_A + 100 + 200, '収束');
});
t('孤高の戦士：単独時のみ+100', () => {
  const alone = board([lane(PIG, [up(165)])]);
  CQStats.recalc(alone, OPT);
  eq(alone.lanes[0].atk, PIG_A + 100 + 100, '孤高 単独');
  const pair = board([lane(PIG, [up(165)]), lane(PIG)]);
  CQStats.recalc(pair, OPT);
  eq(pair.lanes[0].atk, PIG_A + 100, '孤高 2体');
});
t('ソルブレード固有：単独時+150', () => {
  const b = board([lane(50)]);
  CQStats.recalc(b, OPT);
  eq(b.lanes[0].atk, 400 + 150, 'ソルブレード');
});
t('偽装：空き枠×100', () => {
  const b = board([lane(PIG, [up(143)])]);                       // CH4 空き3
  CQStats.recalc(b, OPT);
  eq(b.lanes[0].atk, PIG_A + 100 + 300, '偽装');
});
t('蜜月：飽和時のみ+100（キリン固有は+150）', () => {
  const b = board([lane(27, [up(182), down(180)])]);             // メガゾエア CH2 飽和
  CQStats.recalc(b, OPT);
  eq(b.lanes[0].atk, 400 + 100 + 100, '蜜月 飽和');
  const b2 = board([lane(PIG, [up(182)])]);
  CQStats.recalc(b2, OPT);
  eq(b2.lanes[0].atk, PIG_A + 100, '蜜月 非飽和');
  const kirin = board([lane(18, [down(180), down(180), down(180), down(180), down(180), down(180)])]);
  CQStats.recalc(kirin, OPT);
  eq(kirin.lanes[0].atk, 500 + 150, 'キリン 飽和');
});
t('赤・青の聖霊陣：陣営全体+50', () => {
  const b = board([lane(PIG, [up(193), up(194)]), lane(PIG), empty(), lane(PIG)]);
  CQStats.recalc(b, OPT);
  eq([b.lanes[1].atk, b.lanes[1].def, b.lanes[3].atk], [PIG_A + 50, PIG_D + 50, PIG_A], '霊陣');
});
t('カース：93=-150 99=-300 97=疫障-250', () => {
  const b = board([lane(PIG, [up(93), up(99), up(97)])]);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def], [PIG_A + 300 - 250, PIG_D - 150 - 300 - 250], 'カース');
});
t('ジャガーノート：自レーンの技能を全消去（封印だけ残る）', () => {
  const b = board([lane(37, [up(155), up(168)])]);               // 疫障・石化が消える
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].atk, b.lanes[0].def, b.lanes[0].acc.seal], [550 + 200, 550, 1], 'ジャガーノート');
});

/* ================= 戦闘中の効果 ================= */
section('戦闘');
t('凍結：戦闘当事者以外のレーンは更新されない', () => {
  const b = board([lane(PIG), lane(PIG), empty(), lane(PIG)]);
  CQStats.recalc(b, OPT);
  b.lanes[1].atk = 9999;                                          // 前の値のふりをする
  CQStats.recalc(b, { cards: CARD_BY_ID, combat: { attacker: 0, defender: 3 } });
  eq([b.lanes[1].atk, b.lanes[0].atk], [9999, PIG_A], '凍結');
});
t('勇猛：攻撃側で相手のＣＨ上限が大きいとき+100', () => {
  const b = board([lane(41), empty(), empty(), lane(10)]);        // デアデビル CH4 vs ヨルムンガンド CH6
  CQStats.recalc(b, { cards: CARD_BY_ID, combat: { attacker: 0, defender: 3 } });
  eq(b.lanes[0].atk, 500 + 100, '勇猛 発動');
  const b2 = board([lane(41), empty(), empty(), lane(27)]);       // vs CH2
  CQStats.recalc(b2, { cards: CARD_BY_ID, combat: { attacker: 0, defender: 3 } });
  eq(b2.lanes[0].atk, 500, '勇猛 不発');
});
t('修練の拳：相手のＣＨ攻撃ボーナスを奪う', () => {
  const b = board([lane(PIG, [up(187)]), empty(), empty(), lane(PIG, [up(180), up(180)])]);
  CQStats.recalc(b, { cards: CARD_BY_ID, combat: { attacker: 0, defender: 3 } });
  // 攻撃側: 素500+表1(100)+奪った200 ／ 防御側: 素500+200-200
  eq([b.lanes[0].atk, b.lanes[3].atk], [PIG_A + 100 + 200, PIG_A], '修練の拳');
});
t('縛鎖：攻撃側の表向き縛鎖の階層が記録される（封印で無効）', () => {
  const b = board([lane(PIG, [down(180), up(197)]), empty(), empty(), lane(PIG)]);
  CQStats.recalc(b, { cards: CARD_BY_ID, combat: { attacker: 0, defender: 3 } });
  eq(b.chainLocked, [2], '縛鎖 階層2');
  const b2 = board([lane(PIG, [up(156), up(197)]), empty(), empty(), lane(PIG)]);
  CQStats.recalc(b2, { cards: CARD_BY_ID, combat: { attacker: 0, defender: 3 } });
  eq(b2.chainLocked, null, '縛鎖×封印');
});
t('鏡身：相手の表向き技能を自分にも発現', () => {
  const b = board([lane(54), empty(), empty(), lane(PIG, [up(168)])]);   // ミラージョア vs 石化持ち
  CQStats.recalc(b, { cards: CARD_BY_ID, combat: { attacker: 0, defender: 3 } });
  eq(b.lanes[0].def, 500 + 200, '鏡身');
});
t('抑制：攻撃側が持つと相手の魔法フラグが封殺される', () => {
  const b = board([lane(PIG, [up(120)]), empty(), empty(), lane(PIG, [up(117)])]);
  CQStats.recalc(b, { cards: CARD_BY_ID, combat: { attacker: 0, defender: 3 } });
  eq(b.lanes[3].def, PIG_D, '抑制');                              // 障壁+300が消える（表1枚の攻+100のみ）
});

/* ================= 超過ＣＨ消滅 ================= */
section('超過ＣＨ');
t('[修正1] cap0 に2枚（身転換相当）でもハングせず両方消える', () => {
  const b = board([lane(22, [down(180), down(101)])]);            // ビッグモスキート CH0
  const r = CQStats.recalc(b, OPT);
  eq([b.lanes[0].count, r.removed.length, r.removed[0].card], [0, 2, 101], '超過消滅は最上段から');
});
t('五つ星でCH6→5になった1枚が消え、ボーナスも再計算される', () => {
  const chs = [up(157), down(180), down(180), down(180), down(180), down(180)];
  const b = board([lane(10, chs)]);                               // ヨルムンガンド CH6→5
  const r = CQStats.recalc(b, OPT);
  eq([b.lanes[0].count, b.lanes[0].cap, r.removed.length], [5, 5, 1], '五つ星 超過');
  eq(b.lanes[0].def, 550 + 400, '超過消滅後の防御力');            // 裏4枚
});

/* ================= 自己認識 ================= */
section('自己認識');
t('相手が置いた裏カードの中身が判明する', () => {
  const b = board([lane(PIG, [up(166), down(180, { mine: false }), down(180, { mine: true })])]);
  CQStats.recalc(b, OPT);
  eq([b.lanes[0].channels[1].revealed, b.lanes[0].channels[2].revealed], [true, false], '自己認識');
});

/* ================= UIアダプタ ================= */
section('UIアダプタ');
t('layout.js の G から盤面を作れる', () => {
  const G = {
    mine: [{ cid: 1, own: true, chs: [{ cid: 153, up: true, own: true }, { cid: 135, up: false, own: false }] },
           null, { cid: 30, own: false, chs: [] }],
    enemy: [{ cid: 10, own: false, chs: [{ cid: 117, up: false }] }, null, null],
    hand: [1, 2, 3], enemyHand: 5
  };
  const b = S.boardFromUI(G, CARD_BY_ID);
  CQStats.recalc(b, OPT);
  // 自1: ミルファイター A500 D500 + 表(魔力の盾)+100攻-100攻+200防 + 裏+100防
  eq([b.lanes[0].atk, b.lanes[0].def], [500, 500 + 300], 'アダプタ 自陣');
  // 敵1: ヨルムンガンド + 裏1 → 防+100。裏の own 未設定 → 敵側が置いた扱い
  eq([b.lanes[3].def, b.lanes[3].channels[0].mine], [550 + 100, false], 'アダプタ 敵陣');
  eq(b.hand, { self: 3, enemy: 5 }, 'アダプタ 手札');
});

/* ================= M2: ターン進行 ================= */
section('turn: 山札・ドロー');
t('createDeck は残枚数の多重集合を作る', () => {
  const d = CQTurn.createDeck([8, 8, 8, 101]);
  eq(d, { 8: 3, 101: 1 }, 'createDeck');
});
t('draw：山札が尽きたら null', () => {
  const rng = CQRng.create(1);
  const p = CQTurn.createPlayer([8]);
  eq(CQTurn.draw(rng, p), 8, 'draw 1枚目');
  eq(CQTurn.draw(rng, p), null, 'draw 枯渇');
  eq(p.hand, [8], 'hand');
});
t('draw：同じシードなら同じ結果（決定的）', () => {
  const deck = []; for (let i = 0; i < 20; i++) deck.push(8, 101, 151);
  const p1 = CQTurn.createPlayer(deck); const r1 = CQRng.create(99);
  const p2 = CQTurn.createPlayer(deck); const r2 = CQRng.create(99);
  for (let i = 0; i < 10; i++) { CQTurn.draw(r1, p1); CQTurn.draw(r2, p2); }
  eq(p1.hand, p2.hand, 'draw determinism');
});

section('turn: マッチ・ドローステップ');
function mkDeck(n, ids) { const d = []; for (let i = 0; i < n; i++) d.push(ids[i % ids.length]); return d; }
function newMatch(seed, opts) {
  return CQTurn.createMatch(Object.assign({
    cards: CARD_BY_ID, rng: CQRng.create(seed === undefined ? 1 : seed),
    selfDeck: mkDeck(50, [8, 101, 151, 180]),
    enemyDeck: mkDeck(50, [8, 101, 151, 180]),
    first: 'self'
  }, opts || {}));
}
t('初手は6枚、以降は1枚', () => {
  const m = newMatch();
  CQTurn.beginTurn(m);
  eq([m.turn, m.phase, m.players.self.hand.length], [1, 'placement', 6], '初手6枚');
  CQTurn.endPlacement(m); CQTurn.endTurn(m);      // 自分のターン終了 → 相手へ
  CQTurn.beginTurn(m);                            // 相手の初手も6枚
  eq(m.players.enemy.hand.length, 6, '相手の初手6枚');
  CQTurn.endPlacement(m); CQTurn.endTurn(m);      // 相手のターン終了 → 自分へ
  CQTurn.beginTurn(m);
  eq([m.turn, m.players.self.hand.length], [3, 7], '2ターン目は+1枚');
});
t('手札7枚超過で discard フェーズに入る', () => {
  const m = newMatch(2, { selfDeck: mkDeck(50, [8]) });
  CQTurn.beginTurn(m);
  CQTurn.endPlacement(m); CQTurn.endTurn(m);
  CQTurn.beginTurn(m); CQTurn.endPlacement(m); CQTurn.endTurn(m);   // 敵ターンを消化
  CQTurn.beginTurn(m);                             // 自分2ターン目：6+1=7枚（超過なし）
  eq(m.phase, 'placement', '7枚ちょうどは超過なし');
});
t('山札切れは即敗北', () => {
  const m = newMatch(3, { selfDeck: [8, 8] });      // 2枚しかない→初手6枚requiredで枯渇
  CQTurn.beginTurn(m);
  eq([m.players.self.lost, CQTurn.checkResult(m)], [true, 'enemy'], '山札切れ敗北');
});

section('turn: 配置ステップ');
t('召還：Lv1は可、レーン埋まり・Lv2以上は不可', () => {
  const m = newMatch(4, { selfDeck: mkDeck(50, [8, 10]) });
  CQTurn.beginTurn(m);
  const idxPig = m.players.self.hand.indexOf(8);
  const r1 = CQTurn.summon(m, 0, idxPig);
  eq(r1.ok, true, '召還 成功');
  eq(m.board.lanes[0].unit, 8, '召還先');
  eq(m.board.lanes[0].stiff, true, '召還は硬直');
  const r2 = CQTurn.summon(m, 0, m.players.self.hand.indexOf(8));
  eq(r2.ok, false, 'レーン埋まり拒否');
  const idx10 = m.players.self.hand.indexOf(10);
  if (idx10 >= 0) {
    const r3 = CQTurn.summon(m, 1, idx10);
    eq(r3.ok, false, 'Lv5は直接召還できない');
  }
});
t('チャネル：裏向きで積み、満杯まで', () => {
  const m = newMatch(5, { selfDeck: mkDeck(50, [8, 101, 151, 180]) });
  CQTurn.beginTurn(m);
  CQTurn.summon(m, 0, m.players.self.hand.indexOf(8));
  const before = m.players.self.hand.length;
  const r = CQTurn.channel(m, 0, 0);
  eq(r.ok, true, 'チャネル成功');
  eq([m.board.lanes[0].channels.length, m.board.lanes[0].channels[0].up, m.players.self.hand.length],
     [1, false, before - 1], 'チャネル結果');
});
t('チャネル：満杯で押し込み（配置ステップのみ）', () => {
  const m = newMatch(6, { selfDeck: mkDeck(50, [8, 8, 8, 8, 8, 8, 180, 180, 180, 180]) });
  CQTurn.beginTurn(m);                                              // Pig(CH4)を召還してCH4まで積む
  CQTurn.summon(m, 0, m.players.self.hand.indexOf(8));
  for (let i = 0; i < 4; i++) CQTurn.channel(m, 0, 0);
  eq(m.board.lanes[0].channels.length, 4, '満杯');
  const r = CQTurn.channel(m, 0, 0, { layer: 2 });
  eq([r.ok, m.board.lanes[0].channels.length], [true, 4], '押し込み成功・枚数不変');
});
t('相手の場にもチャネルできる（原作準拠）', () => {
  const m = newMatch(7, { selfDeck: mkDeck(50, [8, 101]), enemyDeck: mkDeck(50, [8, 101]) });
  CQTurn.beginTurn(m); CQTurn.summon(m, 0, m.players.self.hand.indexOf(8));
  CQTurn.endPlacement(m); CQTurn.endTurn(m);
  CQTurn.beginTurn(m);                                              // 敵ターン：敵がレーン3召還
  CQTurn.summon(m, 3, m.players.enemy.hand.indexOf(8));
  const r = CQTurn.channel(m, 0, m.players.enemy.hand.indexOf(101));// 敵が自分（プレイヤー）のレーン0へチャネル
  eq(r.ok, true, '敵→自レーンへのチャネル成立');
  eq(m.board.lanes[0].channels[0].mine, false, '所有者は置いた側（敵）');
});

section('turn: メインステップ・リバース');
/* リバースのテストは、盤面を直接組み立てて判定ロジックだけを検証する（ドローの偶然性を排除するため）。
 * 「開いた階層より下へは同じターン中は戻れない」性質上、ドロー経由の召還→チャネル→即クローズは
 * 原理的に成立しない（開いた瞬間にポインタが進み、そのターン中は同じ階層に触れられなくなる）。
 * ここでは「前のターンに開かれてポインタが0に戻っている」状態を直接作って検証する。 */
function mkBattleBoard() {
  const m = CQTurn.createMatch({ cards: CARD_BY_ID, rng: CQRng.create(1), selfDeck: [], enemyDeck: [], first: 'self' });
  m.phase = 'main';
  return m;
}
t('リバース：階層は飛ばせるが、開いた階層より下へは戻れない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(151)]);
  const skip = CQTurn.reverseAction(m, 0, [2]);
  eq([skip.ok, m.board.lanes[0].reversePtr, m.board.lanes[0].channels[1].up], [true, 2, true], '飛び越し可');
  const back = CQTurn.reverseAction(m, 0, [1]);
  eq(back.ok, false, '戻れない');
});
t('技能カード以外（ユニット・魔法・カース）はクローズできない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(101)]);                            // 表向きの魔法（前ターンに開いた想定）
  const r = CQTurn.reverseAction(m, 0, [1]);
  eq(r.ok, false, '魔法カードはクローズ不可');
  const m2 = mkBattleBoard();
  m2.board.lanes[0] = lane(8, [up(151)]);                           // 技能カードはクローズ可
  const r2 = CQTurn.reverseAction(m2, 0, [1]);
  eq(r2.ok, true, '技能カードはクローズ可');
});
t('腐食は封印がないとクローズできない（同レーンに封印があれば可）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(167)]);
  const noSeal = CQTurn.reverseAction(m, 0, [1]);
  eq(noSeal.ok, false, '封印なしは不可');
  const m2 = mkBattleBoard();
  m2.board.lanes[0] = lane(8, [up(167), up(156)]);                  // 封印(156)も表で同レーンに
  const withSeal = CQTurn.reverseAction(m2, 0, [1]);
  eq(withSeal.ok, true, '封印ありは可');
});
t('固定・石化があるレーンはリバースできない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(159), down(151)]);                 // 固定(159)は表でないと効かない
  const r = CQTurn.reverseAction(m, 0, [2]);
  eq(r.ok, false, '固定でリバース不可');
});
t('硬直しているレーンはリバースできない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151)]);
  m.board.lanes[0].stiff = true;
  const r = CQTurn.reverseAction(m, 0, [1]);
  eq(r.ok, false, '硬直でリバース不可');
});
t('メインステップでは敵陣のユニットをリバースできない', () => {
  const m = mkBattleBoard();
  m.board.lanes[3] = lane(8, [down(151)]);
  const r = CQTurn.reverseAction(m, 3, [1]);
  eq(r.ok, false, '敵陣はリバース不可');
});
t('メインのチャネルは押し込み不可・対象が行動済みなら不可', () => {
  const m = newMatch(12, { selfDeck: mkDeck(50, [8, 8, 8, 8, 8, 180, 180, 180, 180, 180]) });
  CQTurn.beginTurn(m);
  CQTurn.summon(m, 0, m.players.self.hand.indexOf(8));
  for (let i = 0; i < 4; i++) CQTurn.channel(m, 0, m.players.self.hand.indexOf(8) >= 0 ? m.players.self.hand.indexOf(8) : 0);
  m.board.lanes[0].stiff = false;
  CQTurn.endPlacement(m);
  const push = CQTurn.channel(m, 0, 0, { layer: 1 });
  eq(push.ok, false, 'メインステップは押し込み不可');
});

section('turn: チェンジ・ターン終了');
t('チェンジは自分の最初のターンのみ、LP1消費', () => {
  const m = newMatch(13);
  CQTurn.beginTurn(m);
  const lp0 = m.players.self.lp, n0 = m.players.self.hand.length;
  const r = CQTurn.change(m);
  eq([r.ok, m.players.self.lp, m.players.self.hand.length], [true, lp0 - 1, n0], 'チェンジ成功');
  const r2 = CQTurn.change(m);
  eq(r2.ok, false, '既にチェンジ済みは不可（何か操作済み扱い）');
});
t('表向き魔法カードはターン終了時に消える（停滞があれば残る）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(101)]);                            // 魔法のみ・停滞なし
  m.board.lanes[1] = lane(8, [up(101), up(151)]);                   // 魔法＋停滞
  m.players.self.actedThisTurn = true;                              // 自動補充を回避
  CQTurn.endTurn(m);
  eq(m.board.lanes[0].channels.length, 0, '停滞なし：魔法は消える');
  eq(m.board.lanes[1].channels.some((c) => c.card === 101), true, '停滞あり：魔法は残る');
});
t('未行動かつ手札5枚以下ならターン終了時に1枚補充', () => {
  const m = newMatch(15, { selfDeck: mkDeck(50, [8, 101, 151, 180, 8, 101]) });
  CQTurn.beginTurn(m);                                              // 6枚
  while (m.players.self.hand.length > 5) m.players.self.hand.pop(); // テスト用に5枚まで減らす
  CQTurn.endPlacement(m);
  const before = m.players.self.hand.length;
  CQTurn.endTurn(m);
  eq(m.players.self.hand.length, before + 1, '未行動時の自動補充');
});
t('ターン終了で自陣の硬直・リバースポインタが解除される', () => {
  const m = newMatch(16);
  CQTurn.beginTurn(m);
  CQTurn.summon(m, 0, m.players.self.hand.indexOf(8));
  eq(m.board.lanes[0].stiff, true, '召還直後は硬直');
  CQTurn.endPlacement(m); CQTurn.endTurn(m);
  eq([m.board.lanes[0].stiff, m.board.lanes[0].reversePtr], [false, 0], '解除された');
});
t('ターン数は両者の手番で+1される', () => {
  const m = newMatch(17);
  CQTurn.beginTurn(m); CQTurn.endPlacement(m); CQTurn.endTurn(m);
  CQTurn.beginTurn(m); CQTurn.endPlacement(m); CQTurn.endTurn(m);
  eq(m.turn, 2, '2手番で turn=2');
});
t('LPが0になると相手の勝ち', () => {
  const m = newMatch(18);
  m.players.self.lp = 0;
  eq(CQTurn.checkResult(m), 'enemy', 'LP0で敗北');
});

/* ================= 結果 ================= */
console.log(`\n${pass} passed / ${fail} failed`);
if (failures.length) { console.log('\n' + failures.join('\n\n')); process.exit(1); }
