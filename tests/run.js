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

/* ================= 結果 ================= */
console.log(`\n${pass} passed / ${fail} failed`);
if (failures.length) { console.log('\n' + failures.join('\n\n')); process.exit(1); }
