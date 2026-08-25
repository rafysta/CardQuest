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
const CQCombat = require(path.join(root, 'js/engine/combat.js'));
const CQMagic = require(path.join(root, 'js/engine/effects/magic.js'));
const CQUnits = require(path.join(root, 'js/engine/effects/units.js'));
const HOOKS = { onMagicOpen: CQMagic.onMagicOpen, onUnitOpen: CQUnits.onUnitOpen };

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
    first: 'self', hooks: HOOKS
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
/* M5.5（v0.15.1）：山札切れ敗北は廃止。尽きたら初期リストを自動で再装填し、持ち主がＬＰ−2を払う */
t('山札が尽きたら自動で再装填しＬＰ−2（M5.5：山札切れ敗北の廃止）', () => {
  const m = newMatch(3, { selfDeck: [8, 8] });      // 2枚しかない→初手6枚の間に2回再装填
  CQTurn.beginTurn(m);
  eq([m.players.self.hand.length, m.players.self.reloads, m.players.self.lp, m.winner],
     [6, 2, 10 - 2 * CQTurn.RELOAD_LP_COST, null], '再装填2回・ＬＰ−4・敗北しない');
});
t('再装填のＬＰコストでＬＰ0になれば敗北する（終了保証）', () => {
  const m = newMatch(3, { selfDeck: [8, 8], selfOpts: { lp: 3 } });
  CQTurn.beginTurn(m);                              // 2枚→再装填(ＬＰ1)→2枚→再装填(ＬＰ−1)→敗北
  eq([m.winner, m.players.self.lp <= 0], ['enemy', true], '再装填コストで敗北');
});
t('再装填は初期デッキリストを復元する', () => {
  const m = newMatch(5, { selfDeck: [8, 101, 151] });
  const p = m.players.self;
  for (let i = 0; i < 3; i++) CQTurn.draw(m.rng, p, m);   // 3枚を引き切る
  eq(p.deckCount, 0, '山札が空');
  const id = CQTurn.draw(m.rng, p, m);                    // 4枚目 → 再装填してから引く
  eq([id != null, p.reloads, p.deckCount, p.lp],
     [true, 1, 2, 10 - CQTurn.RELOAD_LP_COST], '初期3枚を復元して1枚引いた');
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
  eq(m.board.lanes[0].stiff, false, '相手のユニットにチャネルしても相手は行動済みにならない（仕様書§4.2）');
});
t('チャネルの硬直は「付加された自陣ユニット」だけ（2026-08-24 本人の指摘）', () => {
  const m = newMatch(7, { selfDeck: mkDeck(50, [8, 101, 151]), enemyDeck: mkDeck(50, [8]) });
  CQTurn.beginTurn(m);
  CQTurn.summon(m, 0, m.players.self.hand.indexOf(8));
  m.board.lanes[0].stiff = false;                                   // 召還硬直をリセットして検証
  m.board.lanes[3] = lane(8, []);                                   // 敵ユニットを直接立てる
  const own = CQTurn.channel(m, 0, 0);
  eq([own.ok, m.board.lanes[0].stiff], [true, true], '自陣ユニットへのチャネルは硬直する');
  const foe = CQTurn.channel(m, 3, 0);
  eq([foe.ok, m.board.lanes[3].stiff, m.board.lanes[3].channeled],
     [true, false, true], '敵ユニットへのチャネルは硬直しない（channeled印だけ付く）');
});
t('メインステップではチャネルできない（配置は配置ステップ限定＝2026-08-24 本人の指定）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, []);
  m.board.lanes[3] = lane(8, []);
  m.players.self.hand.push(180, 180);
  m.players.self.handCount = m.players.self.hand.length;
  eq(CQTurn.channel(m, 0, 0).ok, false, '自陣レーンへのチャネルも拒否');
  eq(CQTurn.channel(m, 3, 0).ok, false, '敵レーンへのチャネルも拒否');
  eq(m.players.self.hand.length, 2, '手札は減らない');
});

section('turn: メインステップ・リバース');
/* リバースのテストは、盤面を直接組み立てて判定ロジックだけを検証する（ドローの偶然性を排除するため）。
 * 「開いた階層より下へは同じターン中は戻れない」性質上、ドロー経由の召還→チャネル→即クローズは
 * 原理的に成立しない（開いた瞬間にポインタが進み、そのターン中は同じ階層に触れられなくなる）。
 * ここでは「前のターンに開かれてポインタが0に戻っている」状態を直接作って検証する。 */
function mkBattleBoard() {
  const m = CQTurn.createMatch({ cards: CARD_BY_ID, rng: CQRng.create(1), selfDeck: [], enemyDeck: [], first: 'self', hooks: HOOKS });
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

section('turn: リバースの行動継続（opts.cont＝原作 SW583）');
t('cont：1階層開いた瞬間に硬直する（2026-08-24 本人の指定）。同じレーンの上の階層は続けて開ける', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(151), down(151)]);
  const r1 = CQTurn.reverseAction(m, 0, [1], { cont: true });
  eq([r1.ok, m.board.lanes[0].stiff, m.reversing], [true, true, 0], '1階層目：即硬直・継続中');
  const r2 = CQTurn.reverseAction(m, 0, [2], { cont: true });
  eq([r2.ok, m.board.lanes[0].channels[1].up, m.reversing], [true, true, 0], '硬直していても2階層目を続けて開ける');
});
t('cont：最上段まで開き切ると行動終了（硬直）＝原作 EV0048', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(151)]);
  CQTurn.reverseAction(m, 0, [1], { cont: true });
  CQTurn.reverseAction(m, 0, [2], { cont: true });
  eq([m.board.lanes[0].stiff, m.reversing], [true, null], '最上段到達で硬直・継続解除');
});
t('cont：リバース継続中のユニットはアタック・デッキ攻撃できない（原作 SW322）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(151)]);
  m.board.lanes[3] = lane(8, []);
  CQTurn.reverseAction(m, 0, [1], { cont: true });
  eq(CQCombat.canAttack(m, 0).ok, false, '継続中はアタック不可');
  eq(CQCombat.canDeckAttack(m, 0).ok, false, '継続中はデッキ攻撃不可');
});
t('cont：別のレーンの行動を始めると継続中のレーンは確定（硬直）する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(151)]);
  m.board.lanes[1] = lane(8, [down(151), down(151)]);
  CQTurn.reverseAction(m, 0, [1], { cont: true });
  CQTurn.reverseAction(m, 1, [1], { cont: true });                  // 別レーンのリバース開始
  eq([m.board.lanes[0].stiff, m.reversing], [true, 1], 'レーン0は硬直、レーン1が継続中');
  const more = CQTurn.reverseAction(m, 0, [2], { cont: true });
  eq(more.ok, false, '確定したレーン0はもう続けられない');
});
t('cont：継続中に別レーンへアタックすると確定（硬直）する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(151)]);
  m.board.lanes[1] = lane(20, []);                                  // 攻撃役（素の攻高め）
  m.board.lanes[3] = lane(28, []);                                  // 敵（スネイルリキッド：防0）
  CQTurn.reverseAction(m, 0, [1], { cont: true });
  const r = CQCombat.declareAttack(m, 1, 3);
  eq(r.ok, true, 'レーン1の攻撃は成立');
  eq([m.board.lanes[0].stiff, m.reversing], [true, null], '攻撃開始でレーン0は確定・硬直');
});
t('cont：継続中のレーンへのチャネルも拒否される（メインステップは配置不可）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [1], { cont: false });                 // ←contなし＝従来どおり1回で硬直
  eq(m.board.lanes[0].stiff, true, 'contなしの従来モードは1回で硬直');
  const m2 = mkBattleBoard();
  m2.board.lanes[0] = lane(8, [down(151), down(151)]);
  m2.players.self.hand.push(180);                                   // チャネルする手札を直接持たせる
  m2.players.self.handCount = m2.players.self.hand.length;
  CQTurn.reverseAction(m2, 0, [1], { cont: true });
  eq(m2.reversing, 0, '継続中');
  const ch = CQTurn.channel(m2, 0, 0);                              // 継続中のレーン自身へチャネル
  eq(ch.ok, false, 'メインステップのチャネルは拒否');
  eq(m2.board.lanes[0].stiff, true, 'リバースした時点で硬直している');
});
t('cont：ターン終了で継続中の印は消える', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(151)]);
  m.players.self.actedThisTurn = true;
  CQTurn.reverseAction(m, 0, [1], { cont: true });
  CQTurn.endTurn(m);
  eq(m.reversing, null, 'ターン終了で解除');
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

/* ================= combat: 攻撃宣言と対象制限 ================= */
section('combat: 攻撃宣言');
/** メインステップの盤面を直接組む（ドローを介さずレーンを置く） */
function mkC(opts) {
  const m = CQTurn.createMatch(Object.assign({
    cards: CARD_BY_ID, rng: CQRng.create(1),
    selfDeck: mkDeck(50, [8, 180]), enemyDeck: mkDeck(50, [8, 180]), first: 'self', hooks: HOOKS
  }, opts || {}));
  m.phase = 'main';
  return m;
}
/** 開かずにオープンフェイズを終えて、戦闘を判定まで進める */
function fin(m) {
  let guard = 0;
  while (m.combat && guard++ < 10) CQCombat.endOpen(m);
  return m.lastBattle;
}
/** 攻撃側レーン0・防御側レーン3 を置いた盤面 */
function duel(atkUnit, atkChs, defUnit, defChs, opts) {
  const m = mkC(opts);
  m.board.lanes[0] = lane(atkUnit, atkChs || []);
  m.board.lanes[3] = lane(defUnit, defChs || []);
  return m;
}

t('攻撃成功は「攻撃力 ≧ 防御力」（同値も成功）', () => {
  const m = duel(8, [], 1, []);                                  // A500 vs D500
  const r = CQCombat.declareAttack(m, 0, 3);
  eq([r.ok, r.result.success, m.board.lanes[3].unit], [true, true, null], '同値で成功');
});
t('攻撃力が足りなければ双方無傷', () => {
  const m = duel(8, [], 8, [down(180), down(180)]);              // 500 vs 450+200=650
  CQCombat.declareAttack(m, 0, 3);
  const r = fin(m);
  eq([r.success, m.board.lanes[0].unit, m.board.lanes[3].unit], [false, 8, 8], '失敗・双方生存');
});
t('硬直したユニットは攻撃できない', () => {
  const m = duel(8, [], 8, []);
  m.board.lanes[0].stiff = true;
  eq(CQCombat.canAttack(m, 0).ok, false, '硬直');
});
t('このターンにチャネリングされたユニットは攻撃できない', () => {
  const m = duel(8, [], 8, []);
  m.board.lanes[0].channeled = true;
  eq(CQCombat.canAttack(m, 0).ok, false, 'チャネリング済み');
});
t('気化しているユニットは攻撃できず、攻撃対象にもならない', () => {
  const a = duel(8, [up(176)], 8, []);
  eq(CQCombat.canAttack(a, 0).ok, false, '気化は攻撃できない');
  const b = duel(8, [], 8, [up(176)]);
  eq(CQCombat.canTarget(b, 0, 3).ok, false, '気化は狙えない');
});
t('隠遁：隠遁していない味方が居る間は狙えない', () => {
  const m = duel(8, [], 46, []);                                 // 46 ハイドクロウ＝隠遁
  m.board.lanes[4] = lane(8, []);
  eq([CQCombat.canTarget(m, 0, 3).ok, CQCombat.canTarget(m, 0, 4).ok], [false, true], '隠遁で守られる');
  m.board.lanes[4] = S.emptyLane();
  eq(CQCombat.canTarget(m, 0, 3).ok, true, '他が居なくなれば狙える');
});
t('磁力：磁力持ちが居る間は磁力持ちしか狙えない', () => {
  const m = duel(8, [], 47, []);                                 // 47 マグネットウェブ＝磁力
  m.board.lanes[4] = lane(8, []);
  eq([CQCombat.canTarget(m, 0, 3).ok, CQCombat.canTarget(m, 0, 4).ok], [true, false], '磁力が身代わり');
});
t('追跡は気化・隠遁・磁力の制限をすべて無視する', () => {
  const m = duel(2, [], 46, [up(176)]);                          // 2 パイロウイング＝追跡
  m.board.lanes[4] = lane(47, []);
  eq(CQCombat.canTarget(m, 0, 3).ok, true, '追跡');
});
t('攻撃できる相手が居ないときの一覧は空', () => {
  const m = duel(8, [], 8, [up(176)]);
  eq(CQCombat.attackTargets(m, 0), [], '対象なし');
});

/* ================= combat: 判定の分岐 ================= */
section('combat: 迎撃・反射・貫通・不死');
t('迎撃：攻撃失敗のとき、防御側の攻撃力 ≧ 攻撃側の防御力で攻撃側が破壊される', () => {
  const m = duel(8, [], 7, [down(180), down(180)]);              // 7 ワーウルフ＝迎撃 / D450+200=650
  CQCombat.declareAttack(m, 0, 3);
  const r = fin(m);
  eq([r.success, m.board.lanes[0].unit, m.board.lanes[3].unit], [false, null, 7], '返り討ち');
});
t('迎撃：攻撃側の防御力のほうが高ければ何も起きない', () => {
  const m = duel(8, [down(180), down(180)], 7, [down(180), down(180)]);  // 攻撃側 D450+200=650 > 迎撃500
  CQCombat.declareAttack(m, 0, 3);
  fin(m);                                                        // 双方とも開かずに終える
  eq([m.board.lanes[0].unit, m.board.lanes[3].unit], [8, 7], '双方無傷');
});
t('反射は迎撃より先に判定される（インフェルノは2倍）', () => {
  const m = duel(8, [], 63, [down(180), down(180)]);             // 63 インフェルノ＝反射・2倍 / D500+200=700
  CQCombat.declareAttack(m, 0, 3);
  const r = fin(m);
  eq([r.reflect, m.board.lanes[0].unit], [1000, null], '反射500×2で攻撃側破壊');
});
t('貫通は迎撃・反射を完全に無効化する', () => {
  const m = duel(61, [], 7, [down(180), down(180)]);             // 61 ストライフ＝貫通 / A550 < D650
  CQCombat.declareAttack(m, 0, 3);
  const r = fin(m);
  eq([r.pierce, m.board.lanes[0].unit, m.board.lanes[3].unit], [true, 61, 7], '返り討ちにされない');
});
t('不死：破壊されずＬＰダメージだけ受け、そのあと迎撃だけが走る（相打ち）', () => {
  const m = duel(8, [], 8, [up(177), up(171)]);                  // 不死＋迎撃。防御側 A450+200=650 D450
  CQCombat.declareAttack(m, 0, 3);
  const r = fin(m);
  eq([r.success, m.board.lanes[3].unit, m.board.lanes[0].unit, m.players.enemy.lp],
     [true, 8, null, 6], '防御側は生存・攻撃側が破壊・ＬＰは減る');
});

/* ================= combat: ＬＰダメージと破壊処理 ================= */
section('combat: ＬＰダメージ・戦利品・憑依');
t('ＬＰダメージは「カード記載の素のＣＨ数」', () => {
  const m = duel(8, [], 8, []);                                  // 8 ピッグマン＝ＣＨ4
  CQCombat.declareAttack(m, 0, 3);
  eq(m.players.enemy.lp, 6, '10 - 4');
});
t('膨張でＣＨ上限が増えてもＬＰダメージは変わらない', () => {
  const m = duel(8, [], 8, [up(158)]);                           // 膨張で上限6・実枚数1
  CQCombat.declareAttack(m, 0, 3);
  eq(m.players.enemy.lp, 6, '素のＣＨ数4のまま');
});
t('ＣＨ数0のユニットを倒してもＬＰダメージは0', () => {
  const m = duel(8, [], 22, []);                                 // 22 ビッグモスキート＝ＣＨ0
  CQCombat.declareAttack(m, 0, 3);
  eq([m.board.lanes[3].unit, m.players.enemy.lp], [null, 10], 'ダメージなし');
});
t('スネイルリキッドは破壊されると持ち主の手札に戻る', () => {
  const m = duel(8, [], 28, []);                                 // 28 A450 D600 → 攻撃失敗するので直接破壊する
  m.board.lanes[3] = lane(28, []);
  CQCombat.destroy(m, 3, { normalAttack: true });
  eq([m.board.lanes[3].unit, m.players.enemy.hand.indexOf(28) >= 0], [null, true], '手札帰還');
});
t('救済は通常攻撃には効かない', () => {
  const m = duel(8, [], 8, [up(179)]);                           // 救済。D450 表1枚なので防御は450
  CQCombat.declareAttack(m, 0, 3);
  eq(m.board.lanes[3].unit, null, '通常攻撃では死ぬ');
});
t('救済は通常攻撃以外の破壊を無効化する', () => {
  const m = duel(8, [], 8, [up(179)]);
  const r = CQCombat.destroy(m, 3, { normalAttack: false });
  eq([r.survived, m.board.lanes[3].unit, m.players.enemy.lp], ['salvation', 8, 10], '生存・ＬＰも減らない');
});
t('戦利品はフリーユニット戦（対戦相手ID 101以上）の通常攻撃撃破でのみ入る', () => {
  const m = duel(8, [], 8, [], { opponentId: 101 });
  CQCombat.declareAttack(m, 0, 3);
  eq(m.loot, [8], '戦利品');
  const m2 = duel(8, [], 8, [], { opponentId: 0 });
  CQCombat.declareAttack(m2, 0, 3);
  eq(m2.loot, [], '闘技場戦では入らない');
});
t('魔法など通常攻撃以外の破壊では戦利品にならない', () => {
  const m = duel(8, [], 8, [], { opponentId: 101 });
  CQCombat.destroy(m, 3, { normalAttack: false });
  eq(m.loot, [], '特殊攻撃は戦利品なし');
});
t('憑依：通常攻撃で倒されたヘルファイアが相手にカースを残す', () => {
  const m = duel(8, [], 65, []);                                 // 65 ヘルファイア → カース91
  CQCombat.declareAttack(m, 0, 3);
  const ch = m.board.lanes[0].channels[0];
  eq([ch.card, ch.up, ch.st], [91, true, 'possess'], '表向きの憑依カード');
});
t('憑依：取り憑く先に空きが無ければ発動しない', () => {
  const m = duel(8, [up(180), up(180), up(180), up(180)], 65, []);   // 攻撃側は飽和（ＣＨ4）
  CQCombat.declareAttack(m, 0, 3);
  eq([m.board.lanes[0].channels.length, m.board.lanes[0].channels.some((c) => c.card === 91)],
     [4, false], '発動しない');
});
t('憑依：封印されたユニットはカースを残さない', () => {
  const m = duel(8, [], 65, [up(156)]);                          // 封印
  CQCombat.declareAttack(m, 0, 3);
  eq(m.board.lanes[0].channels.length, 0, '封印で不発');
});
t('カース97の永続憑依は連鎖する', () => {
  const m = duel(8, [], 8, [up(97)]);                            // 疫障250で防御200
  CQCombat.declareAttack(m, 0, 3);
  eq(m.board.lanes[0].channels.map((c) => c.card), [97], '97が移る');
});

/* ================= combat: オープンフェイズ ================= */
section('combat: オープンフェイズ');
t('攻撃側→防御側の順にフェイズが進む', () => {
  const m = duel(8, [down(180), down(180)], 8, [down(180)]);
  CQCombat.declareAttack(m, 0, 3);
  eq([m.combat.phase, CQCombat.openerLane(m)], ['attackerOpen', 0], '攻撃側から');
  CQCombat.endOpen(m);
  eq([m.combat.phase, CQCombat.openerLane(m)], ['defenderOpen', 3], '次は防御側');
});
t('オープンは下から上への一方通行（飛ばすのは可・戻るのは不可）', () => {
  const m = duel(8, [down(180), down(180), down(180)], 8, []);
  CQCombat.declareAttack(m, 0, 3);
  eq(CQCombat.open(m, 2).ok, true, '2階層目を開く');
  eq(CQCombat.open(m, 1).ok, false, '1階層目には戻れない');
  eq(CQCombat.openableLayers(m), [3], '残るのは3階層目だけ');
});
t('CQCombat.open：opts.choiceで憑依解除(101)の破壊対象を指定できる（2026-08-24 対話的選択）', () => {
  const m = duel(8, [down(101)], 1, [down(151), down(152)]);
  CQCombat.declareAttack(m, 0, 3);
  eq(CQCombat.openerLane(m), 0, '攻撃側（レーン0）から開く');
  const r = CQCombat.open(m, 1, { choice: { lane: 3, idx: 1 } });
  eq(r.ok, true, 'オープンできる');
  eq(m.board.lanes[3].channels.length, 1, '候補2枚のうち1枚だけ破壊される');
  eq(m.board.lanes[3].channels[0].card, 151, '指定した方（idx1＝152）が破壊され、151が残る');
});
t('オープンフェイズでクローズはできない（表のカードは選べない）', () => {
  const m = duel(8, [up(151), down(180)], 8, []);
  CQCombat.declareAttack(m, 0, 3);
  eq(CQCombat.openableLayers(m), [2], '表のカードは対象外');
});
t('開けるカードが無ければフェイズは自動でスキップされる', () => {
  const m = duel(8, [], 8, []);                                  // 双方チャンネル0枚
  const r = CQCombat.declareAttack(m, 0, 3);
  eq([m.combat, r.result.success], [null, true], '判定まで一気に進む');
});
t('固定・石化があるとオープンフェイズごとスキップされる', () => {
  const m = duel(8, [up(159), down(180)], 8, []);                // 159 固定
  CQCombat.declareAttack(m, 0, 3);
  eq(m.board.lanes[0].channels[1].up, false, '開けないまま判定へ');
});
t('甲殻：防御側になると全チャンネルが強制クローズされ、オープンもできない', () => {
  const m = duel(8, [], 8, [up(183), up(180)]);                  // 183 甲殻
  CQCombat.declareAttack(m, 0, 3);
  const chs = m.board.lanes[3].channels;
  eq([chs[0].up, chs[1].up], [true, false], '甲殻自身は開いたまま・他は閉じる');
});
t('硬直している防御側はオープンできない（攻撃側にはこの制限がない）', () => {
  const m = duel(8, [up(180)], 8, [down(172)]);                 // 攻撃側 A600 / 防御側 D450+100=550
  m.board.lanes[3].stiff = true;
  CQCombat.declareAttack(m, 0, 3);
  eq([m.combat, m.board.lanes[3].unit, m.board.lanes[3].channels.length], [null, null, 0], '開けずに判定→破壊');
});
t('縛鎖：攻撃側の表向き縛鎖と同じ階層番号は防御側が開けない', () => {
  const m = duel(8, [up(197)], 8, [down(180), down(180)]);       // 197 縛鎖が1階層目
  CQCombat.declareAttack(m, 0, 3);
  eq([m.combat.phase, CQCombat.openableLayers(m)], ['defenderOpen', [2]], '1階層目は封じられる');
});
t('オープンした魔法・技能はその場で能力値に反映される', () => {
  const m = duel(8, [down(192), down(180)], 8, [down(180), down(180)]);
  CQCombat.declareAttack(m, 0, 3);
  eq(m.board.lanes[0].atk, 500, 'オープン前は裏2枚ぶんが防御へ');
  CQCombat.open(m, 1);
  eq([m.board.lanes[0].atk, m.board.lanes[0].def], [600, 550], '開いた1枚が攻撃力へ移る');
});

/* ================= combat: リバース召還 ================= */
section('combat: リバース召還');
t('召還レベルを満たせば場に出る（硬直しない）', () => {
  const m = duel(8, [down(8)], 8, [down(180)]);                  // 潜行ユニット8はＬｖ1
  CQCombat.declareAttack(m, 0, 3);
  const r = CQCombat.open(m, 1);
  eq([r.effect.result, m.board.lanes[1].unit, m.board.lanes[1].stiff, m.board.lanes[0].channels.length],
     ['summon', 8, false, 0], 'レーン1に召還');
});
t('配置階層が召還レベルに足りなければ破壊される', () => {
  const m = duel(8, [down(10)], 8, [down(180)]);                 // 10 ヨルムンガンド＝召還Ｌｖ5
  CQCombat.declareAttack(m, 0, 3);
  const r = CQCombat.open(m, 1);
  eq([r.effect.result, m.board.lanes[1].unit, m.board.lanes[0].channels.length],
     ['level', null, 0], '破壊');
});
t('召還先の空きが無ければ破壊される', () => {
  const m = duel(8, [down(8)], 8, [down(180)]);
  m.board.lanes[1] = lane(8, []); m.board.lanes[2] = lane(8, []);
  CQCombat.declareAttack(m, 0, 3);
  const r = CQCombat.open(m, 1);
  eq(r.effect.result, 'nospace', '空き無しで破壊');
});
t('抵抗があると出てこようとしたユニットを破壊する', () => {
  const m = duel(8, [up(178), down(8)], 8, [down(180)]);         // 178 抵抗
  CQCombat.declareAttack(m, 0, 3);
  const r = CQCombat.open(m, 2);
  eq([r.effect.result, m.board.lanes[1].unit], ['resist', null], '抵抗で破壊');
});
t('融合があると分離せずチャンネルのまま留まる', () => {
  const m = duel(20, [down(8)], 8, [down(180)]);                 // 20 フュージョナル＝融合
  CQCombat.declareAttack(m, 0, 3);
  const r = CQCombat.open(m, 1);
  eq([r.effect.result, m.board.lanes[0].channels.length, m.board.lanes[1].unit],
     ['fusion', 1, null], '潜行のまま');
});
t('カードが1枚減ったぶんカーソルは進めない（上のカードが落ちてくる）', () => {
  const m = duel(8, [down(8), down(180), down(180)], 8, []);
  CQCombat.declareAttack(m, 0, 3);
  CQCombat.open(m, 1);                                           // 1階層目が抜けて上が落ちる
  eq(CQCombat.openableLayers(m), [1, 2], '同じ位置から続けられる');
});

/* ================= combat: 戦闘終了・連続攻撃 ================= */
section('combat: 戦闘終了');
t('攻撃側は硬直し、防御側は硬直しない', () => {
  const m = duel(8, [], 8, [down(180), down(180)]);              // 攻撃失敗＝双方生存
  CQCombat.declareAttack(m, 0, 3); fin(m);
  eq([m.board.lanes[0].stiff, m.board.lanes[3].stiff, m.phase], [true, false, 'main'], '硬直は攻撃側だけ');
});
t('連続攻撃を持つと2回目の攻撃権が付き、使うと消える', () => {
  const m = duel(8, [up(154)], 8, [down(180), down(180)]);       // 154 連続攻撃。600 < 650 で失敗
  CQCombat.declareAttack(m, 0, 3); fin(m);
  eq([m.board.lanes[0].extraAttack, CQCombat.canAttack(m, 0).ok], [true, true], '硬直をバイパス');
  CQCombat.declareAttack(m, 0, 3); fin(m);
  eq([m.board.lanes[0].extraAttack, CQCombat.canAttack(m, 0).ok], [false, false], '2回で打ち止め');
});
t('戦闘終了で表向きの魔法カードが消える', () => {
  const m = duel(8, [up(101)], 8, [down(180), down(180)]);
  CQCombat.declareAttack(m, 0, 3); fin(m);
  eq(m.board.lanes[0].channels.length, 0, '魔法は消滅');
});
t('爆殺は飽和状態だと消滅処理で自爆する', () => {
  const m = mkC();
  m.board.lanes[0] = lane(8, [up(104), down(180), down(180), down(180)]);   // ＣＨ4で飽和
  CQCombat.expireMagic(m);
  eq([m.board.lanes[0].unit, m.players.self.lp], [null, 6], '自爆してＬＰ-4');
});
t('放出があると表向きの技能も一緒に消える', () => {
  const m = mkC();
  m.board.lanes[0] = lane(8, [up(160), up(152), down(180)]);
  CQCombat.expireMagic(m);
  eq(m.board.lanes[0].channels.map((c) => c.card), [180], '表の技能は消え、裏は残る');
});

/* ================= combat: デッキ攻撃 ================= */
section('combat: デッキ攻撃');
t('攻撃対象になる敵ユニットが0体ならデッキ攻撃できる', () => {
  const m = mkC();
  m.board.lanes[0] = lane(8, []);
  const before = m.players.enemy.deckCount;
  const r = CQCombat.deckAttack(m, 0);
  eq([r.ok, m.players.enemy.lp, m.players.enemy.deckCount, m.board.lanes[0].stiff],
     [true, 9, before - 1, true], 'ＬＰ-1・山札-1・硬直');
});
t('敵ユニットが居るとデッキ攻撃できない（気化は数えない）', () => {
  const m = mkC();
  m.board.lanes[0] = lane(8, []); m.board.lanes[3] = lane(8, []);
  eq(CQCombat.canDeckAttack(m, 0).ok, false, '対象が居る');
  m.board.lanes[3] = lane(8, [up(176)]);                         // 気化
  eq(CQCombat.canDeckAttack(m, 0).ok, true, '気化だけなら通れる');
});
t('跳躍があれば敵ユニット2体以下でもデッキ攻撃できる', () => {
  const m = mkC();
  m.board.lanes[0] = lane(19, []);                               // 19 ブレードライダー＝跳躍
  m.board.lanes[3] = lane(8, []); m.board.lanes[4] = lane(8, []);
  eq(CQCombat.canDeckAttack(m, 0).ok, true, '2体まで');
  m.board.lanes[5] = lane(8, []);
  eq(CQCombat.canDeckAttack(m, 0).ok, false, '3体は不可');
});
t('ビッグモスキートはデッキ攻撃でＬＰを回復する', () => {
  const m = mkC();
  m.players.self.lp = 5;
  m.board.lanes[0] = lane(22, []);
  CQCombat.deckAttack(m, 0);
  eq(m.players.self.lp, 6, 'ＬＰ+1');
});
t('デッキ攻撃で山札が尽きても敗北しない（M5.5）', () => {
  const m = mkC({ enemyDeck: [180] });
  m.board.lanes[0] = lane(8, []);
  CQCombat.deckAttack(m, 0);
  eq([m.players.enemy.deckCount, m.winner], [0, null], '山札0でも対局は続く');
});
t('デッキ攻撃：山札が空なら再装填してから破壊する（M5.5）', () => {
  const m = mkC({ enemyDeck: [180] });
  m.board.lanes[0] = lane(8, []);
  m.players.enemy.deckCount = 0; m.players.enemy.deck = {};   // 山札を空にしておく
  CQCombat.deckAttack(m, 0);
  eq([m.players.enemy.reloads, m.players.enemy.deckCount,
      m.players.enemy.lp], [1, 0, 10 - CQTurn.RELOAD_LP_COST - 1], '再装填→1枚破壊・ＬＰ−3');
});

/* ================= M4 v0.12: 技能49種＋カース9種の残り ================= */
/* 集計（アキュムレータへの加算）と能力値計算・戦闘判定への反映は既にＭ1〜Ｍ3の過程で
 * ほぼ全種実装済みだった。ここで追加するのは「オープンが唯一のトリガ」の原則から外れる
 * 効果（ターン終了時自滅・召還レベルの特例・押し込みの禁止・操作権の反転）。 */

section('M4: 閉鎖(184)・カース98');
t('閉鎖があるとチャネリングできない（押し込みも不可）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(184), down(180)]);            // ＣＨ4のうち2枚使用・184は表
  m.players.self.hand = [151];
  const r = CQTurn.channel(m, 0, 0);
  eq(r.ok, false, '空きがあっても閉鎖でチャネリング不可');
});
t('閉鎖で飽和扱いになっても押し込みには倒れない（明示的に拒否される）', () => {
  const m = mkBattleBoard();
  m.phase = 'placement';
  m.board.lanes[0] = lane(8, [up(184), down(180), down(180), down(180)]);  // ちょうど4枚（cap相当）
  m.players.self.hand = [151];
  const r = CQTurn.channel(m, 0, 0, { layer: 2 });
  eq(r.ok, false, '押し込みも拒否');
});

section('M4: 光臨(199)・魔道書(186)');
t('光臨が無いと召還Ｌｖ3以上のユニットは手札から直接出せない', () => {
  const m = newMatch(80, { selfDeck: mkDeck(50, [8]) });
  CQTurn.beginTurn(m);
  m.players.self.hand.push(13);                                 // 13 ニドヘッグ＝召還Ｌｖ3
  const r = CQTurn.summon(m, 1, m.players.self.hand.indexOf(13));
  eq(r.ok, false, '通常はＬｖ3を直接召還できない');
});
t('光臨（アッシュメイカーの固有能力）があれば召還Ｌｖ3〜6を直接召還できる', () => {
  const m = newMatch(81, { selfDeck: mkDeck(50, [8]) });
  CQTurn.beginTurn(m);
  m.board.lanes[2] = lane(55, []);                              // 55 アッシュメイカー＝光臨
  m.players.self.hand.push(13);
  const r = CQTurn.summon(m, 1, m.players.self.hand.indexOf(13));
  eq([r.ok, m.board.lanes[1].unit], [true, 13], '光臨で直接召還できる');
});
t('魔道書：レーンに付いている枚数×2ぶん、リバース召還の要求レベルが下がる', () => {
  // 10 ヨルムンガンド＝召還Ｌｖ5。魔道書2枚（表）で要求Ｌｖ5-4=1まで下がり、3階層目でも成功する
  const m = duel(8, [up(186), up(186), down(10)], 8, [down(180)]);
  CQCombat.declareAttack(m, 0, 3);
  const r = CQCombat.open(m, 3);
  eq([r.effect.result, m.board.lanes[1].unit], ['summon', 10], '魔道書2枚でＬｖ1相当まで下がり召還成功');
});
t('魔道書が無ければ同じ階層でも召還レベル不足で破壊される', () => {
  const m = duel(8, [down(180), down(180), down(10)], 8, [down(180)]);
  CQCombat.declareAttack(m, 0, 3);
  const r = CQCombat.open(m, 3);
  eq(r.effect.result, 'level', '魔道書が無いと破壊される');
});

section('M4: 腐食(167)・カース94/95（ターン終了時自滅）');
t('腐食：ターン終了時に自滅する（通常攻撃ではないので戦利品も憑依も発生しない）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(167)]);                        // 8 ピッグマン＋腐食
  m.players.self.actedThisTurn = true;                          // 空デッキでの自動補充を避ける
  const lpBefore = m.players.self.lp;
  CQTurn.endTurn(m);
  eq([m.board.lanes[0].unit, m.players.self.lp, m.loot], [null, lpBefore - 4, []], '自滅・戦利品なし');
});
t('カース94/95（マッドシックル／デストレーダー由来）もターン終了時に自滅する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(94)]);
  m.players.self.actedThisTurn = true;
  CQTurn.endTurn(m);
  eq(m.board.lanes[0].unit, null, 'カース94で自滅');
  const m2 = mkBattleBoard();
  m2.board.lanes[0] = lane(8, [up(95)]);
  m2.players.self.actedThisTurn = true;
  CQTurn.endTurn(m2);
  eq(m2.board.lanes[0].unit, null, 'カース95で自滅');
});
t('救済があれば腐食のターン終了時自滅も無効化される', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(167), up(179)]);               // 腐食＋救済
  m.players.self.actedThisTurn = true;
  CQTurn.endTurn(m);
  eq(m.board.lanes[0].unit, 8, '救済で生存');
});

section('M4: 魂の門(181)');
t('魂の門：ターン終了時にデッキから直にＣＨ付加を得る（空きがあれば）', () => {
  const m = CQTurn.createMatch({ cards: CARD_BY_ID, rng: CQRng.create(90),
    selfDeck: mkDeck(10, [180]), enemyDeck: [], first: 'self' });
  m.phase = 'main';
  m.board.lanes[0] = lane(8, [up(181)]);                        // ＣＨ4のうち1枚使用
  m.players.self.actedThisTurn = true;
  const deckBefore = m.players.self.deckCount;
  CQTurn.endTurn(m);
  eq(m.board.lanes[0].channels.length, 2, 'ＣＨが1枚増える');
  eq(m.players.self.deckCount, deckBefore - 1, '山札を1枚消費');
});
t('魂の門：空きが無ければ得られない', () => {
  const m = CQTurn.createMatch({ cards: CARD_BY_ID, rng: CQRng.create(91),
    selfDeck: mkDeck(10, [180]), enemyDeck: [], first: 'self' });
  m.phase = 'main';
  m.board.lanes[0] = lane(8, [up(181), down(180), down(180), down(180)]);  // 飽和
  m.players.self.actedThisTurn = true;
  const deckBefore = m.players.self.deckCount;
  CQTurn.endTurn(m);
  eq([m.board.lanes[0].channels.length, m.players.self.deckCount], [4, deckBefore], '変化なし');
});

section('M4: 傀儡(169)・カース92（操作権の反転）');
t('傀儡：物理的には自陣のユニットでも、操作権は相手に移る', () => {
  const m = mkC();
  m.board.lanes[0] = lane(8, [up(169)]);                        // 傀儡が付いた自陣ユニット
  m.board.lanes[1] = lane(8, []);                                // 通常の自陣ユニット
  eq(CQCombat.canAttack(m, 0).ok, false, '元の持ち主はもう動かせない');
  eq(CQCombat.canAttack(m, 1).ok, true, '傀儡されていないユニットは通常どおり');
  m.active = 'enemy';
  eq(CQCombat.canAttack(m, 0).ok, true, '操作権を得た側が動かせる');
});
t('傀儡：新しい操作側の視点では、傀儡された自軍ユニットが攻撃対象になる', () => {
  const m = mkC();
  m.board.lanes[0] = lane(8, [up(169)]);
  m.board.lanes[1] = lane(8, []);
  eq(CQCombat.attackTargets(m, 1), [0], '傀儡された自軍ユニットが対象に含まれる');
});
t('傀儡：破壊時のＬＰダメージは、操作権を得た側が受ける', () => {
  const m = mkC();
  m.board.lanes[1] = lane(8, []);                                // 攻撃側：自分（操作権そのまま）
  m.board.lanes[0] = lane(8, [up(169)]);                         // 防御側：物理的には自陣だが操作権は敵
  const r = CQCombat.declareAttack(m, 1, 0);
  eq([r.ok, m.players.enemy.lp, m.players.self.lp], [true, 6, 10], '被弾は操作側（敵）');
});
t('カース92（傀儡化）も同様に操作権を反転させる', () => {
  const m = mkC();
  m.board.lanes[0] = lane(8, [up(92)]);
  m.active = 'enemy';
  eq(CQCombat.canAttack(m, 0).ok, true, 'カース92でも操作権が移る');
});
t('傀儡：メインステップのリバースも新しい操作側だけができる', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(169), down(151)]);
  eq(CQTurn.reverseAction(m, 0, [2]).ok, false, '元の持ち主はリバースできない');
  m.active = 'enemy';
  eq(CQTurn.reverseAction(m, 0, [2]).ok, true, '新しい操作側はリバースできる');
});

/* ================= M4 v0.13: 魔法48種 ================= */
section('M4 v0.13: 魔法101〜110');

t('101 憑依解除：ＣＨ１つを破壊する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(101)]);
  m.board.lanes[1] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[1].channels.length, 0, '他ユニットのＣＨが破壊される（自分自身は対象から除外）');
});
t('101 憑依解除：opts.choiceで指定した対象を優先して破壊する（2026-08-24 対話的選択）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(101)]);
  m.board.lanes[1] = lane(8, [down(151), down(151)]);      // 候補が2枚（idx 0, 1）
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 1, idx: 1 } });
  eq(m.board.lanes[1].channels.length, 1, '候補2枚のうち1枚だけ破壊される');
  eq(m.board.lanes[1].channels[0].card, 151, '指定した方（idx1）が破壊され、idx0が残る');
});
t('101 憑依解除：choiceが不正な対象（既に無い等）なら自動選択にフォールバックする', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(101)]);
  m.board.lanes[1] = lane(8, [down(151)]);
  const r = CQTurn.reverseAction(m, 0, [1], { choice: { lane: 9, idx: 9 } });
  eq(r.ok, true, 'エラーにならない');
  eq(m.board.lanes[1].channels.length, 0, '不正な指定は無視して合法な対象が自動で破壊される');
});
t('102 侵食：自分の山札から他ユニットのＣＨを埋め尽くす', () => {
  const m = newMatch(300, { selfDeck: mkDeck(50, [180]) });
  m.phase = 'main';
  m.board.lanes[0] = lane(8, [down(102)]);
  m.board.lanes[1] = lane(8, []);
  const deckBefore = m.players.self.deckCount;
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[1].channels.length, 4, '他ユニットのＣＨが満杯になる');
  eq(m.players.self.deckCount, deckBefore - 4, '自分の山札を4枚消費');
});
t('103 渇望：敵の山札から自分（このレーン）のＣＨを埋める', () => {
  const m = newMatch(301, { enemyDeck: mkDeck(50, [180]) });
  m.phase = 'main';
  m.board.lanes[0] = lane(8, [down(103)]);
  const enemyDeckBefore = m.players.enemy.deckCount;
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].channels.length, 4, '自分のＣＨが満杯になる');
  eq(m.players.enemy.deckCount, enemyDeckBefore - 3, '敵の山札を3枚消費（103自身が既に1枚使用済み）');
});
t('105 歪曲：ＣＨ位置を上下反転する', () => {
  const m = mkBattleBoard();
  m.board.lanes[1] = lane(8, [down(151), down(105)]);
  CQTurn.reverseAction(m, 1, [2]);
  eq(m.board.lanes[1].channels.map(c => c.card), [105, 151], 'ＣＨの並びが反転');
});
t('105 歪曲：原作バグ再現（レーン1・ＣＨ6枚のとき最上段が消滅する）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(151), down(151), down(151), down(151), down(105)]);
  CQTurn.reverseAction(m, 0, [6]);
  eq(m.board.lanes[0].channels.length, 5, '6枚が反転後5枚に減る（原作バグ再現）');
});
t('107 逃走：ＣＨ数4以下ならユニットを手札に戻す（戦闘中×）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(107)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq([m.board.lanes[0].unit, m.players.self.hand], [null, [8]], '手札に戻る');
});
t('107 逃走：ＣＨ数5以上では戻らない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(151), down(151), down(151), down(107)]);
  CQTurn.reverseAction(m, 0, [5]);
  eq(m.board.lanes[0].unit, 13, 'そのまま残る');
});
t('108 強制開放：場のＣＨを全て強制オープンする（戦闘中×強制中×）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(151), down(108)]);
  m.board.lanes[3] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.board.lanes[0].channels.every(c => c.up), true, '自陣のＣＨが全てオープン');
  eq(m.board.lanes[3].channels[0].up, true, '敵陣のＣＨもオープン');
});
t('109 強制転回：場のＣＨを全て強制リバースする（戦闘中×強制中×）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(151), down(151), down(109)]);
  m.board.lanes[3] = lane(8, [up(151)]);
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.board.lanes[0].channels[0].up, false, '表だったカードが裏になる');
  eq(m.board.lanes[0].channels[1].up, true, '裏だったカードが表になる');
  eq(m.board.lanes[3].channels[0].up, false, '敵陣のＣＨも反転する');
});
t('強制開放・強制転回は互いを連鎖的に起動しない（原作CE0355）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(109), down(108)]);
  CQTurn.reverseAction(m, 0, [2]);
  eq(m.board.lanes[0].channels[0].up, false, '109(強制中×)自身は強制開放で開かない');
});
t('110 閉門：自陣のオープン中のＣＨを全て同時にクローズする', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(151), down(110)]);
  m.board.lanes[3] = lane(8, [up(151)]);
  CQTurn.reverseAction(m, 0, [2]);
  eq(m.board.lanes[0].channels[0].up, false, '自陣のカードがクローズされる');
  eq(m.board.lanes[3].channels[0].up, true, '敵陣は影響を受けない');
});

section('M4 v0.13: 魔法111〜120');
t('111 変換：手札を全て捨て新たに3枚引く', () => {
  const m = newMatch(302);
  m.phase = 'main';
  m.board.lanes[0] = lane(8, [down(111)]);
  m.players.self.hand = [151, 152, 153];
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.players.self.hand.length, 3, '手札が3枚になる');
});
t('112 抽出：手札を3枚得るがドロー毎にＬＰ1点を失う', () => {
  const m = newMatch(303);
  m.phase = 'main';
  m.board.lanes[0] = lane(8, [down(112)]);
  const lpBefore = m.players.self.lp;
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.players.self.lp, lpBefore - 3, 'ＬＰを3点消費');
});
t('113 透視：ＣＨ2つの内容を確認できる', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(113)]);
  CQTurn.reverseAction(m, 0, [2]);
  eq(m.board.lanes[0].channels[0].revealed, true, '裏向きのＣＨが確認される');
});
t('114 暗殺：敵マスター手札内のユニットを破壊＋ＬＰ1点', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(114)]);
  m.players.enemy.hand = [1];
  const lpBefore = m.players.enemy.lp;
  CQTurn.reverseAction(m, 0, [1]);
  eq([m.players.enemy.hand, m.players.enemy.lp], [[], lpBefore - 1], '手札のユニットが破壊されＬＰも減る');
});
t('115 流行り病：手札の疫障(155)を表状態で付加する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(115)]);
  m.players.self.hand = [155];
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].channels.some((c) => c.card === 155 && c.up), true, '疫障が表で付加される');
  eq(m.players.self.hand, [], '手札から消える');
});
t('116 解析：レベル4でユニット1体のＣＨを全て確認する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(151), down(151), down(116)]);
  m.board.lanes[1] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [4]);
  const anyRevealed = m.board.lanes[0].channels.some((c) => c.revealed) ||
    m.board.lanes[1].channels.some((c) => c.revealed);
  eq(anyRevealed, true, 'いずれかのユニットのＣＨが確認される');
});
t('116 解析：レベル4未満では発動しない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(116)]);
  m.board.lanes[1] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [2]);
  eq(m.board.lanes[1].channels[0].revealed, false, '発動レベル不足で効果なし');
});
t('118 押収：裏状態のＣＨ１つをこのレーンへ奪う', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(118)]);
  m.board.lanes[1] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].channels.length, 2, '奪ったＣＨがこのレーンに追加される');
  eq(m.board.lanes[1].channels.length, 0, '奪われた側は減る');
});
t('119 鎮静：場にある全てのＣＨをクローズする（戦闘中×）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(151), down(119)]);
  m.board.lanes[3] = lane(8, [up(151)]);
  CQTurn.reverseAction(m, 0, [2]);
  eq(m.board.lanes[0].channels[0].up, false, '自陣もクローズ');
  eq(m.board.lanes[3].channels[0].up, false, '敵陣もクローズ');
});

section('M4 v0.13: 魔法121〜130');
t('121 招来：潜行しているユニット1つを自分の場に召還する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(1), down(121)]);
  CQTurn.reverseAction(m, 0, [2]);
  const summoned = m.board.lanes[1].unit === 1 || m.board.lanes[2].unit === 1;
  eq(summoned, true, '潜行ユニットが空きレーンに召還される');
});
t('122 予見：山札を確認する（このエンジンでは山札は無順序のため効果はログのみ）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(122)]);
  const before = JSON.stringify(m.players.self.deck);
  CQTurn.reverseAction(m, 0, [1]);
  eq(JSON.stringify(m.players.self.deck), before, '山札の中身は変化しない');
});
t('123 発症：配置されたレベルと同数のＬＰを失う', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(151), down(123)]);
  const lpBefore = m.players.self.lp;
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.players.self.lp, lpBefore - 3, '3階層目で3点のＬＰダメージ');
});
t('124 凍結：場にあるユニット1体を硬直させる（戦闘中×）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(124)]);
  m.board.lanes[1] = lane(8, []);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.log.some((l) => l.indexOf('凍結：') === 0 && l.indexOf('対象が無い') < 0), true, '硬直させる効果が発動する');
});
t('125 移送：最も高いレベルにあるＣＨを他ユニットへ移動する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(125)]);
  m.board.lanes[1] = lane(8, []);
  CQTurn.reverseAction(m, 0, [2]);
  eq(m.board.lanes[0].channels.length, 1, '元のレーンから1枚減る');
  eq(m.board.lanes[1].channels.map((c) => c.card), [151], '移動先に付加される');
});
t('126 統合：ＣＨ付加の無いユニット1体をＣＨとして吸収する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(126)]);
  m.board.lanes[1] = lane(1, []);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[1].unit, null, '吸収されたユニットは場から消える');
  eq(m.board.lanes[0].channels.some((c) => c.card === 1), true, 'そのユニットＩＤがＣＨとして付加される');
});
t('127 死の棘：手札の腐食(167)を表状態で付加する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(127)]);
  m.players.self.hand = [167];
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].channels.some((c) => c.card === 167 && c.up), true, '腐食が表で付加される');
});
t('128 転写：手札の技能カードをこのカードの位置へ転送する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(128)]);
  m.players.self.hand = [151];
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].channels.some((c) => c.card === 151 && !c.up), true, '技能カードが裏で付加される');
  eq(m.players.self.hand, [], '手札から消える');
});
t('129 窃盗：敵マスターの手札1枚を奪う', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(129)]);
  m.players.enemy.hand = [151];
  CQTurn.reverseAction(m, 0, [1]);
  eq([m.players.enemy.hand, m.players.self.hand], [[], [151]], '手札が移動する');
});
t('130 漂着：山札から1枚を直に表状態で付加する', () => {
  const m = newMatch(304);
  m.phase = 'main';
  m.board.lanes[0] = lane(8, [down(130)]);
  const before = m.board.lanes[0].channels.length;
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].channels.length, before + 1, 'ＣＨが1枚増える');
  eq(m.board.lanes[0].channels[m.board.lanes[0].channels.length - 1].up, true, '表状態で付加される');
});

section('M4 v0.13: 魔法131〜140');
t('131 菊一文字：全ユニットの同レベルのＣＨを全て破壊する（戦闘中×）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(131)]);
  m.board.lanes[1] = lane(8, [down(151), down(151)]);
  CQTurn.reverseAction(m, 0, [2]);
  eq(m.board.lanes[0].channels.length, 1, '自レーンの2階層目（131自身）も破壊される');
  eq(m.board.lanes[1].channels.length, 1, '他レーンの2階層目も破壊される');
});
t('132 殲滅：レベル5で場の全ユニットを除去する（原作バグ再現：ＬＰダメージ等は発生しない）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(151), down(151), down(151), down(132)]);
  m.board.lanes[3] = lane(8, []);
  const lpBefore = m.players.self.lp;
  CQTurn.reverseAction(m, 0, [5]);
  eq([m.board.lanes[0].unit, m.board.lanes[3].unit, m.players.self.lp], [null, null, lpBefore], '全ユニット除去・ＬＰダメージ無し');
});
t('132 殲滅：レベル5未満では発動しない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(151), down(132)]);
  m.board.lanes[3] = lane(8, []);
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.board.lanes[3].unit, 8, '発動レベル不足で他ユニットは残る');
});
t('132 殲滅：戦闘中は発動しない', () => {
  // 防御側が通常の戦闘判定でも生き残るよう、攻撃力(600)を上回る防御力にしておく
  const m = duel(13, [down(151), down(151), down(151), down(151), down(132)], 8, [down(180), down(180)]);
  CQCombat.declareAttack(m, 0, 3);
  CQCombat.open(m, 5);
  eq(m.board.lanes[3].unit, 8, '戦闘中は不発（通常の戦闘判定でも防御側は生存する）');
});
t('133 呪爆：このカードをオープンさせたユニットを破壊する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(133)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].unit, null, 'ユニットごと破壊される');
});
t('134 呪念：オープンさせたマスターのＬＰ5点破壊（レベル3）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(151), down(134)]);
  const lpBefore = m.players.self.lp;
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.players.self.lp, lpBefore - 5, 'オープンした側（自分）がＬＰ5点失う');
});
t('135 雷撃：防御力550以下のユニット1つを無条件に破壊する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(135)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].unit, null, '対象条件を満たすユニットが破壊される');
});
t('137 潜行爆弾：（簡略実装）敵の山札を1枚破壊する', () => {
  const m = newMatch(305);
  m.phase = 'main';
  m.board.lanes[0] = lane(8, [down(137)]);
  const before = m.players.enemy.deckCount;
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.players.enemy.deckCount, before - 1, '敵の山札が1枚減る');
});
t('138 潜入：レベル3で他ユニットにチャンネルとして潜行する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(151), down(138)]);
  m.board.lanes[1] = lane(8, []);
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.board.lanes[0].channels.some((c) => c.card === 138), false, '元のレーンから消える');
  eq(m.board.lanes[1].channels.some((c) => c.card === 138), true, '別のユニットへ潜行する');
});
t('139 爆雷：敵マスターのＬＰを3点減らす（戦闘中×）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(139)]);
  const lpBefore = m.players.enemy.lp;
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.players.enemy.lp, lpBefore - 3, '敵のＬＰが3点減る');
});
t('140 時の渦：レベル4で手番側がもう1枚ドローする（簡略実装／戦闘中×強制中×）', () => {
  const m = newMatch(306);
  m.phase = 'main';
  m.board.lanes[0] = lane(13, [down(151), down(151), down(151), down(140)]);
  const handBefore = m.players.self.hand.length;
  CQTurn.reverseAction(m, 0, [4]);
  eq(m.players.self.hand.length, handBefore + 1, '手札が1枚増える');
});

section('M4 v0.13: 魔法141〜148');
t('141 思念波：防御力550以下のユニットには不発（原作バグ再現：対象判定が551〜1000限定）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(141)]);
  m.board.lanes[3] = lane(57, []);                    // 57 ネクロスフィア D500
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[3].unit, 57, '防御力550は範囲外のため不発');
});
t('141 思念波：防御力551〜1000のユニットには成立する（原作バグ再現：レベル制限も機能しない）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(141)]);            // レベル6のはずが1階層目でも発動する
  m.board.lanes[3] = lane(28, []);                    // 28 スネイルリキッド D600
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[3].unit, null, '防御力551〜1000のユニットは破壊される');
});
t('141 思念波：戦闘中は発動しない', () => {
  // 防御側が通常の戦闘判定でも生き残るよう、攻撃力(600)を上回る防御力にしておく
  // （28番はＣＨ数0で付加できないため、ここでは8番ピッグマンで代用する）
  const m = duel(8, [down(141)], 8, [down(180), down(180)]);
  CQCombat.declareAttack(m, 0, 3);
  CQCombat.open(m, 1);
  eq(m.board.lanes[3].unit, 8, '戦闘中は不発（通常の戦闘判定でも防御側は生存する）');
});
t('142 身転換：戦闘防御時、レベル3でユニット本体が入れ替わる', () => {
  const m = duel(8, [], 13, [down(151), down(151), down(142)]);
  CQCombat.declareAttack(m, 0, 3);                    // 攻撃側はＣＨが無いので自動的に防御側フェイズへ
  CQCombat.open(m, 3);
  eq([m.board.lanes[0].unit, m.board.lanes[3].unit], [13, 8], 'ユニット本体が入れ替わる');
});
t('142 身転換：メインステップのリバースでは発動しない（戦闘防御時限定）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(151), down(142)]);
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.board.lanes[0].unit, 8, '戦闘外では入れ替わらない');
});
t('144 還元：全ＣＨを破壊しその分だけ手札を得る', () => {
  const m = newMatch(307);
  m.phase = 'main';
  m.board.lanes[0] = lane(8, [down(151), down(144)]);
  const handBefore = m.players.self.hand.length;
  CQTurn.reverseAction(m, 0, [2]);
  eq(m.board.lanes[0].channels.length, 0, 'ＣＨが全て破壊される（自分自身も含む）');
  eq(m.players.self.hand.length, handBefore + 2, '破壊した枚数ぶん手札を得る');
});
t('146 口寄せ：レベル3で山札から1枚を直接手札に得る（簡略実装）', () => {
  const m = newMatch(308, { selfDeck: mkDeck(30, [180]) });
  m.phase = 'main';
  m.board.lanes[0] = lane(13, [down(151), down(151), down(146)]);
  const before = m.players.self.deckCount;
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.players.self.deckCount, before - 1, '山札が1枚減る');
  eq(m.players.self.hand.indexOf(180) >= 0, true, '手札に加わる');
});
t('147 治癒：手札を全て捨てその枚数と同値のＬＰを回復する（戦闘中×）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(147)]);
  m.players.self.hand = [151, 152, 153];
  m.players.self.lp = 5;
  CQTurn.reverseAction(m, 0, [1]);
  eq([m.players.self.hand, m.players.self.lp], [[], 8], '手札3枚を捨ててＬＰ+3');
});
t('147 治癒：戦闘中は発動しない', () => {
  const m = duel(8, [down(147)], 8, []);
  m.players.self.hand = [151];
  CQCombat.declareAttack(m, 0, 3);
  CQCombat.open(m, 1);
  eq(m.players.self.hand, [151], '戦闘中は不発');
});
t('148 妄執：自爆し任意のユニットに憑依する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(148)]);
  m.board.lanes[1] = lane(8, []);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].unit, null, '自爆する');
  eq(m.board.lanes[1].channels.some((c) => c.card === 148 && c.up), true, '別のユニットに憑依する');
});
t('148 妄執：原作バグ再現（レーン3(物理インデックス2)は救済チェックが働かない）', () => {
  const m = mkBattleBoard();
  m.board.lanes[2] = lane(8, [up(179), down(148)]);
  CQTurn.reverseAction(m, 2, [2]);
  eq(m.board.lanes[2].unit, null, 'レーン3では救済があっても自爆する（バグ再現）');
});
t('148 妄執：レーン1では救済があれば自爆しない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(179), down(148)]);
  CQTurn.reverseAction(m, 0, [2]);
  eq(m.board.lanes[0].unit, 8, 'レーン1では救済が効く');
});

section('M4 v0.13: 魔法ディスパッチャの共通機構');
t('継続効果型の魔法（爆殺・増幅・障壁・抑制・遮蔽・偽装・鏡身）はオープン時に例外なく動作する', () => {
  [104, 106, 117, 120, 136, 143, 145].forEach(function (id) {
    const m = mkBattleBoard();
    m.board.lanes[0] = lane(8, [down(id)]);
    const r = CQTurn.reverseAction(m, 0, [1]);
    eq(r.ok, true, id + '：オープンできる');
  });
});
t('無効(190)があると魔法は発動しない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(190), down(101)]);
  m.board.lanes[1] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [2]);
  eq(m.board.lanes[1].channels.length, 1, '無効化され他ユニットのＣＨは破壊されない');
});
t('連唱(174)があると魔法が2回発動する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(174), down(101)]);
  m.board.lanes[1] = lane(8, [down(151), down(151), down(151)]);
  const before = m.board.lanes[0].channels.length + m.board.lanes[1].channels.length;
  CQTurn.reverseAction(m, 0, [2]);
  const after = m.board.lanes[0].channels.length + m.board.lanes[1].channels.length;
  eq(after, before - 2, '2回発動して2枚破壊される');
});
t('魔道書(186)は魔法の発動レベルも下げる', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [up(186), up(186), down(132)]);   // 3階層目。要求Ｌｖ5-4=1で足りる
  m.board.lanes[3] = lane(8, []);
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.board.lanes[3].unit, null, '魔道書で要求レベルが下がり殲滅が発動する');
});
t('手札上限7枚を超えたら超過分は自動的に捨てられる', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(107)]);
  m.players.self.hand = [151, 152, 153, 154, 155, 156, 157];
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.players.self.hand.length <= 7, true, '8枚になった分は自動的に捨てられる');
});
t('メインステップのリバースでも魔法発動・リバース召還が起きる（オープンが唯一の起動トリガー）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(1)]);              // 潜行しているユニット
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[1].unit === 1 || m.board.lanes[2].unit === 1, true, 'リバース召還が発生する');
});

section('M4 v0.14: ユニット固有能力「開：」型（10体）');
t('1 ミルファイター：開：クローズ×１', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(151)]);
  m.board.lanes[1] = lane(8, [down(1)]);
  CQTurn.reverseAction(m, 1, [1]);
  eq(m.board.lanes[0].channels[0].up, false, '技能ＣＨがクローズされる');
});
t('16 レッドレックス：開：Ａ６００火弾（Ｄ600以下の敵ユニットを破壊）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(16)]);
  m.board.lanes[3] = lane(8, []);                     // Ｄ450＜＝600
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[3].unit, null, '敵ユニットが破壊される');
});
t('23 アンフィビアス：開：手札２枚入手', () => {
  const m = newMatch(500, { selfDeck: mkDeck(50, [180]) });
  m.phase = 'main';
  m.board.lanes[0] = lane(8, [down(23)]);
  const before = m.players.self.hand.length;
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.players.self.hand.length, before + 2, '手札が2枚増える');
});
t('24 シニスターセラフ：開：ＣＨ×１破壊（自分自身は対象から除く）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(24)]);
  m.board.lanes[1] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[1].channels.length, 0, '他ユニットのＣＨが破壊される');
});
t('25 スケープゴート：開：摩り替り（簡略実装：手札に分身を得る）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(25)]);
  const before = m.players.self.hand.length;
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.players.self.hand.length, before + 1, '手札が1枚増える');
  eq(m.players.self.hand[m.players.self.hand.length - 1], 25, '増えたのは25自身の分身');
});
t('27 メガゾエア：開：クローズ×１', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(151)]);
  m.board.lanes[1] = lane(8, [down(27)]);
  CQTurn.reverseAction(m, 1, [1]);
  eq(m.board.lanes[0].channels[0].up, false, '技能ＣＨがクローズされる');
});
t('29 ステルスゴブリン：開：敵手札×１奪取', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(29)]);
  m.players.enemy.hand = [180];
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.players.enemy.hand.length, 0, '相手の手札が減る');
  eq(m.players.self.hand.indexOf(180) >= 0, true, '自分の手札に加わる');
});
t('30 イビルアイ：開：呪爆能力（ホストのレーンごと破壊される）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(30)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].unit, null, '呪爆でレーンが破壊される');
});
t('31 ドライアード：開：ＬＰ＋１回復', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(31)]);
  m.players.self.lp -= 5;
  const before = m.players.self.lp;
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.players.self.lp, before + 1, 'ＬＰが1回復する');
});
t('40 スピアバード：開：ＣＨ×１確認', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(40)]);
  m.board.lanes[1] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[1].channels[0].revealed, true, '裏向きのＣＨが確認される');
});

section('M4 v0.14: ユニット固有能力「特：」型（14体）');
t('特殊行動：Ｃ型を持たないユニットは実行できない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, []);
  eq(CQTurn.canSpecialAction(m, 0).ok, false, '通常ユニットは不可');
});
t('特殊行動：硬直・チャネリング済み・敵陣・固定石化では実行できない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(3, []);
  m.board.lanes[0].stiff = true;
  eq(CQTurn.canSpecialAction(m, 0).ok, false, '硬直中は不可');
  const m2 = mkBattleBoard();
  m2.board.lanes[0] = lane(3, []);
  m2.board.lanes[0].channeled = true;
  eq(CQTurn.canSpecialAction(m2, 0).ok, false, 'このターンにチャネリングしたユニットは不可');
  const m3 = mkBattleBoard();
  m3.board.lanes[3] = lane(3, []);
  eq(CQTurn.canSpecialAction(m3, 3).ok, false, '敵陣のユニットは不可（自陣のみ）');
});
t('3 ダーククラウド：特：「石化」付加', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(3, []);
  m.board.lanes[3] = lane(8, []);
  const r = CQTurn.specialAction(m, 0);
  eq(r.ok, true, '実行できる');
  eq(m.board.lanes[3].channels.some(c => c.card === 168), true, '石化(168)が付加される');
  eq(m.board.lanes[0].stiff, true, '実行後は硬直する');
});
t('6 ヴェノムスピナー：特：「疫障」付加', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(6, []);
  m.board.lanes[3] = lane(8, []);
  CQTurn.specialAction(m, 0);
  eq(m.board.lanes[3].channels.some(c => c.card === 155), true, '疫障(155)が付加される');
});
t('9 ディゾルバー：特：ＬＰ消費ＣＨ１破壊', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(9, []);
  m.board.lanes[1] = lane(8, [down(151)]);
  const lpBefore = m.players.self.lp;
  CQTurn.specialAction(m, 0);
  eq(m.players.self.lp, lpBefore - 1, 'ＬＰを1点消費');
  eq(m.board.lanes[1].channels.length, 0, 'ＣＨが破壊される');
});
t('10 ヨルムンガンド：特：Ａ５５０雷撃', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(10, []);
  m.board.lanes[3] = lane(8, []);                     // Ｄ450＜＝550
  CQTurn.specialAction(m, 0);
  eq(m.board.lanes[3].unit, null, '敵ユニットが破壊される');
});
t('32 キャノンタートル：特：Ａ５５０雷撃', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(32, []);
  m.board.lanes[3] = lane(8, []);
  CQTurn.specialAction(m, 0);
  eq(m.board.lanes[3].unit, null, '敵ユニットが破壊される');
});
t('34 サイコダイバー：特：潜入能力（自分が他ユニットの裏向きＣＨとして潜行する）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(34, []);
  m.board.lanes[1] = lane(8, []);
  CQTurn.specialAction(m, 0);
  eq(m.board.lanes[0].unit, null, '元のレーンは空になる');
  eq(m.board.lanes[1].channels.some(c => c.card === 34 && c.up === false), true, '潜行先へ裏向きで加わる');
});
t('35 ティンバータンク：特：自己ＣＨシャッフル', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(35, [down(151), down(152), down(153), down(154)]);
  const before = m.board.lanes[0].channels.map(c => c.card).slice().sort();
  CQTurn.specialAction(m, 0);
  const after = m.board.lanes[0].channels.map(c => c.card).slice().sort();
  eq(after, before, 'ＣＨの中身（多重集合）は変わらない');
});
t('36 ヘルフライアー：特：Ａ５５０烈風', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(36, []);
  m.board.lanes[3] = lane(8, []);
  CQTurn.specialAction(m, 0);
  eq(m.board.lanes[3].unit, null, '敵ユニットが破壊される');
});
t('38 デモングローブ：特：手札＋１入手', () => {
  const m = newMatch(501, { selfDeck: mkDeck(50, [180]) });
  m.phase = 'main';
  m.board.lanes[0] = lane(38, []);
  const before = m.players.self.hand.length;
  CQTurn.specialAction(m, 0);
  eq(m.players.self.hand.length, before + 1, '手札が1枚増える');
});
t('44 ブレインサッカー：特：クローズ×１', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(44, []);
  m.board.lanes[1] = lane(8, [up(151)]);
  CQTurn.specialAction(m, 0);
  eq(m.board.lanes[1].channels[0].up, false, '技能ＣＨがクローズされる');
});
t('45 デザートニードル：特：「腐食」付加', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(45, []);
  m.board.lanes[3] = lane(8, []);
  CQTurn.specialAction(m, 0);
  eq(m.board.lanes[3].channels.some(c => c.card === 167), true, '腐食(167)が付加される');
});
t('48 スカウター：特：ＣＨ×１確認', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(48, []);
  m.board.lanes[1] = lane(8, [down(151)]);
  CQTurn.specialAction(m, 0);
  eq(m.board.lanes[1].channels[0].revealed, true, '裏向きのＣＨが確認される');
});
t('49 シャドウハンズ：特：ＣＨ×１確認', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(49, []);
  m.board.lanes[1] = lane(8, [down(151)]);
  CQTurn.specialAction(m, 0);
  eq(m.board.lanes[1].channels[0].revealed, true, '裏向きのＣＨが確認される');
});
t('70 ポルターガイスト：特：妄執・憑依：D-150（自爆して他ユニットにカース96を付ける）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(70, []);
  m.board.lanes[1] = lane(8, []);
  CQTurn.specialAction(m, 0);
  eq(m.board.lanes[0].unit, null, '自爆してレーンが空になる');
  eq(m.board.lanes[1].channels.some(c => c.card === 96), true, 'カース96（防御力-150）が憑依する');
});
t('特殊行動は対象が無くても行動を消費する（仕様書§10.1）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(3, []);                     // 石化を付ける敵ユニットが盤面に無い
  const r = CQTurn.specialAction(m, 0);
  eq(r.ok, true, '対象が無くても失敗しない');
  eq(m.board.lanes[0].stiff, true, '対象が無くても硬直する（行動を消費）');
});

/* ================= M5: 敵ＡＩ（評価関数方策） ================= */
section('M5: 敵AI・情報モデル（カンニングしない）');
const CQAi = require(path.join(root, 'js/engine/ai.js'));

t('難易度プリセット：透視率は撤廃され、差はサンプル数と読みの深さ（M5.7）', () => {
  ['free', 'rankC', 'rankB', 'rankA', 'heuristic', 'random'].forEach((k) => {
    eq(CQAi.PRESETS[k].spyRate, undefined, k + '：透視率パラメータが存在しない');
  });
  eq(CQAi.PRESETS.free.policy, 'search', 'フリー＝search');
  eq(CQAi.PRESETS.rankC.policy, 'search', 'Ｃ＝search');
  eq(CQAi.PRESETS.rankB.policy, 'search', 'Ｂ＝search');
  eq(CQAi.PRESETS.rankA.policy, 'search', 'Ａ＝search');
  eq(CQAi.PRESETS.rankC.samples < CQAi.PRESETS.rankB.samples, true, 'Ｃ<Ｂ（サンプル数）');
  eq(CQAi.PRESETS.rankB.samples < CQAi.PRESETS.rankA.samples, true, 'Ｂ<Ａ（サンプル数）');
  eq(CQAi.PRESETS.free.samples < CQAi.PRESETS.rankC.samples, true, 'フリー<Ｃ（サンプル数）');
  eq(CQAi.PRESETS.free.noise >= CQAi.PRESETS.rankC.noise, true, 'フリー≧Ｃ（決定ノイズ）');
  eq(CQAi.PRESETS.rankC.noise > CQAi.PRESETS.rankB.noise, true, 'Ｃ>Ｂ（決定ノイズ）');
  eq(CQAi.PRESETS.rankB.noise > CQAi.PRESETS.rankA.noise, true, 'Ｂ>Ａ（決定ノイズ）');
  eq(CQAi.PRESETS.rankA.noise, 0, 'Ａ＝最善のみ（ノイズ0）');
  eq(CQAi.PRESETS.heuristic.policy, 'eval', 'heuristic＝M5の評価関数方策（較正・代行用）');
  eq(CQAi.PRESETS.random.policy, 'random', '未設定・random は従来のランダム方策');
});
t('knownTo：知れるのは自分が置いたカード・表・公開済みだけ（人間と完全対称）', () => {
  eq(CQAi.knownTo({ up: false, mine: true }, 'self'), true, '自分が置いた裏カードは分かる');
  eq(CQAi.knownTo({ up: false, mine: true }, 'enemy'), false, '相手には分からない');
  eq(CQAi.knownTo({ up: true, mine: true }, 'enemy'), true, '表なら誰でも分かる');
  eq(CQAi.knownTo({ up: false, mine: true, revealed: true }, 'enemy'), true, '公開済みなら分かる');
  eq(CQAi.knownTo({ up: false, mine: true, spied_enemy: true }, 'enemy'), false,
     '旧透視フラグが残っていても効かない（M5.7で撤廃）');
});

section('M5: 敵AI・仮想能力値（§11.2）');
t('仮想能力値：自分のカードは中身どおり、不明カードは空白として数える', () => {
  const m = mkBattleBoard();
  // 自陣レーン0：疫障(155)と停滞(151)を自分で置いた（中身既知）
  m.board.lanes[0] = lane(8, [down(155), down(151)]);
  CQStats.recalc(m.board, OPT);
  const own = CQAi.virtualStats(m, 'self', 0);
  eq(own.atk, 600, '自分視点：疫障は開かない（500+100の1枚分だけ）');
  eq(own.def, 650, '仮想防御力＝全部裏（450+100×2）');
  // 同じレーンを敵視点で見ると：中身不明＝空白2枚として全部開く（最悪ケース）
  const foe = CQAi.virtualStats(m, 'enemy', 0);
  eq(foe.atk, 700, '敵視点：不明2枚は+100の頭数として全開（500+200）');
});
t('仮想能力値：公開済み（revealed）のカードは実物として評価される', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(155), down(151)]);
  m.board.lanes[0].channels[0].revealed = true;         // 疫障が公開済み（スカウター等）
  CQStats.recalc(m.board, OPT);
  const foe = CQAi.virtualStats(m, 'enemy', 0);
  eq(foe.atk, 450, '公開済みの疫障(-250)を含めて評価する（500+200-250）');
});

section('M5: 敵AI・攻撃判断（§11.2。heuristic＝旧評価関数方策のまま検証を維持）');
/* 評価関数側を self に置く（human=enemy を手で操作するテスト構成） */
function aiBoard(turn) {
  const m = mkBattleBoard();
  m.aiConfig = { self: CQAi.PRESETS.heuristic };
  m.turn = turn === undefined ? 5 : turn;               // 序盤ペナルティ切れ
  m.players.self.turnsTaken = 3;
  return m;
}
t('margin≧0（確実に勝てる攻撃）は序盤ペナルティが切れていれば必ず実行する', () => {
  const m = aiBoard(5);
  m.board.lanes[0] = lane(16, []);                      // A600（Ｃ型特殊行動なし）
  m.board.lanes[3] = lane(8, []);                       // D450 → margin +150
  const acted = CQAi.mainStep(m);
  eq(acted, true, '行動した');
  eq(m.board.lanes[3].unit, null, '敵ユニットが破壊された');
  eq(!!m.lastBattle, true, '特殊行動ではなく攻撃で破壊した');
});
t('margin<0（判定上必ず失敗する攻撃）は仕掛けない', () => {
  const m = aiBoard(5);
  m.board.lanes[0] = lane(8, []);                       // A500
  m.board.lanes[3] = lane(8, [down(151, { mine: false }), down(151, { mine: false })]);  // D650
  m.players.self.lp = 99;                               // やけくそ条件を殺す（③リーサル・②全滅の余地なし）
  m.players.enemy.lp = 99;
  const acted = CQAi.mainStep(m);
  eq(acted, false, '何もしない（攻撃・リバース・特殊行動の対象が無い）');
  eq(m.board.lanes[3].unit, 8, '敵ユニットは無傷');
});
t('1ターン目は確実に勝てる攻撃でも見送る（序盤ペナルティ最大+1000）', () => {
  const m = aiBoard(1);
  m.board.lanes[0] = lane(16, []);                      // Ｃ型特殊行動なし
  m.board.lanes[3] = lane(8, []);
  m.players.enemy.lp = 99;                              // リーサルによるやけくそを殺す
  CQAi.mainStep(m);
  eq(m.board.lanes[3].unit, 8, 'まだ攻撃しない');
});
t('リーサル（ＣＨ数≧相手ＬＰ）の相手を最優先で狙う', () => {
  const m = aiBoard(5);
  m.board.lanes[0] = lane(16, []);                      // A600：どちらも倒せる
  m.board.lanes[3] = lane(27, []);                      // メガゾエア ＣＨ2
  m.board.lanes[4] = lane(8, []);                       // ピッグマン ＣＨ4 ＝リーサル
  m.players.enemy.lp = 4;
  CQAi.mainStep(m);
  eq(m.winner, 'self', 'ＣＨ4のピッグマンを選んで勝負を決める');
});
t('フリーユニットの行動制限（noAttackTurns＝最初の2手番攻撃しない）は eval でも効く（§11.4）', () => {
  const m = aiBoard(9);
  m.aiConfig = { self: { policy: 'eval', noAttackTurns: 2, mulligan: false, handSlots: 6 } };
  m.players.self.turnsTaken = 2;                        // まだ2手番目
  m.players.enemy.lp = 99;
  m.board.lanes[0] = lane(16, []);                      // Ｃ型特殊行動なし
  m.board.lanes[3] = lane(8, []);
  CQAi.mainStep(m);
  eq(m.board.lanes[3].unit, 8, '2手番目までは攻撃しない');
  m.players.self.turnsTaken = 3;
  CQAi.mainStep(m);
  eq(m.board.lanes[3].unit, null, '3手番目からは攻撃する');
});
t('相手スタックに公開済みで見えている雷撃(135)の罠がある相手は避ける', () => {
  const m = aiBoard(5);
  m.board.lanes[0] = lane(10, []);                      // A600 D550（雷撃の射程内）
  m.board.lanes[3] = lane(8, [down(135, { mine: false })]);   // 罠入り D550
  m.board.lanes[3].channels[0].revealed = true;         // 公開済み（スカウター等で見えた）
  m.board.lanes[4] = lane(27, []);                      // 罠なし D400
  m.players.enemy.lp = 99;
  CQAi.mainStep(m);
  eq(m.board.lanes[4].unit, null, '罠の無い方を狙う');
  eq(m.board.lanes[3].unit, 8, '罠入りは残る');
});

section('M5: 敵AI・戦闘中のオープン判断');
t('防御側：閉じたままで守れるなら1枚も開かない', () => {
  const m = mkBattleBoard();
  m.aiConfig = { enemy: CQAi.PRESETS.heuristic };
  m.board.lanes[0] = lane(8, []);                                  // A500
  m.board.lanes[3] = lane(8, [down(151, { mine: false })]);        // D550 → 安全
  CQCombat.declareAttack(m, 0, 3);
  let g = 0;
  while (m.combat && g++ < 10) CQAi.openStep(m);                   // 防御側＝評価関数ＡＩ
  eq(m.board.lanes[3].channels[0].up, false, '閉じたまま');
  eq(m.lastBattle.success, false, '攻撃は失敗');
});
t('防御側：死ぬしかないなら、知っている対抗魔法（135雷撃）を開いて攻撃側を落とす', () => {
  // 135は「防御力550以下から無作為選択」なので、防御側自身が射程外（>550）になる盤面で
  // 決定的に検証する：防御側は開いた後も防御力600、攻撃側は550＝雷撃は必ず攻撃側に当たる
  const m = mkBattleBoard();
  m.aiConfig = { enemy: CQAi.PRESETS.heuristic };
  m.board.lanes[0] = lane(10, [up(151), up(151)]);                 // A800 D550（表2枚で攻撃+200）
  m.board.lanes[3] = lane(27, [down(135, { mine: false }), down(151, { mine: false })]);  // D700
  CQCombat.declareAttack(m, 0, 3);                                 // 800≧700 → 防御側は死ぬしかない
  let g = 0;
  while (m.combat && g++ < 10) CQAi.openStep(m);
  eq(m.board.lanes[0].unit, null, '雷撃で攻撃側が破壊される');
  eq(m.board.lanes[3].unit, 27, '防御側は生き残る');
});

section('M5: 敵AI・配置と手札');
t('手札スロット7のカードは使わない（§11.4：ＡＩは実質6枚運用）', () => {
  const m = mkBattleBoard();
  m.phase = 'placement';
  m.aiConfig = { self: CQAi.PRESETS.heuristic };
  m.players.self.hand = [180, 180, 180, 180, 180, 180, 8];   // ユニットはスロット7にだけ
  CQAi.placementStep(m);
  eq(m.board.lanes.every((l) => l.unit == null), true, 'スロット7のユニットは召還できない');
});
t('評価関数の強制捨ては空白(180)を優先し、無ければ末尾（スロット7）を捨てる', () => {
  const m = mkBattleBoard();
  m.phase = 'discard';
  m.aiConfig = { self: CQAi.PRESETS.heuristic };
  m.players.self.hand = [8, 180, 151];
  CQAi.discardStep(m);
  eq(m.players.self.hand.indexOf(180), -1, '空白が捨てられた');
  m.phase = 'discard';                                  // 捨て終わるとphaseが進むので戻す
  m.players.self.hand = [8, 151, 152];
  CQAi.discardStep(m);
  eq(m.players.self.hand, [8, 151], '空白が無ければ末尾を捨てる');
});
t('マリガン：召還できるユニットが無い初手は手札を引き直す（§4.1）', () => {
  const m = newMatch(600, { selfDeck: mkDeck(50, [151, 8]) });
  m.aiConfig = { self: CQAi.PRESETS.heuristic };
  CQTurn.beginTurn(m);
  m.players.self.hand = [151, 151, 151, 151, 151, 151];      // ユニットなしの初手に固定
  const lpBefore = m.players.self.lp;
  CQAi.placementStep(m);
  eq(m.players.self.hasChanged, true, 'チェンジを使った');
  eq(m.players.self.lp, lpBefore - 1, 'ＬＰを1消費');
});
t('フリーユニットはマリガンしない（§11.4）', () => {
  const m = newMatch(601, { selfDeck: mkDeck(50, [151, 8]) });
  m.aiConfig = { self: { policy: 'eval', noAttackTurns: 2, mulligan: false, handSlots: 6 } };
  CQTurn.beginTurn(m);
  m.players.self.hand = [151, 151, 151, 151, 151, 151];
  CQAi.placementStep(m);
  eq(m.players.self.hasChanged, false, 'チェンジを使わない');
});
t('罠カード（呪爆133など）は相手のユニットに仕込む', () => {
  const m = mkBattleBoard();
  m.phase = 'placement';
  m.aiConfig = { self: CQAi.PRESETS.heuristic };
  m.board.lanes[0] = lane(8, []);
  m.board.lanes[3] = lane(8, []);
  m.players.self.hand = [133];
  let g = 0;
  while (g++ < 5 && CQAi.placementStep(m)) { /* 置けるだけ置く */ }
  eq(m.board.lanes[3].channels.some((c) => c.card === 133), true, '呪爆は敵ユニットへ');
  eq(m.board.lanes[0].channels.length, 0, '自陣には置かない');
});
t('aiConfig未設定なら従来のランダム方策のまま動く（後方互換）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, []);
  m.board.lanes[3] = lane(8, []);
  const acted = CQAi.mainStep(m);                        // ランダム方策は無条件に攻撃する
  eq(acted, true, '行動する');
  eq(!!m.lastBattle, true, '攻撃が実行された');
});

/* ================= M5.7: 探索方策（決定化サンプリング＋先読み） ================= */
section('M5.7: 探索方策・決定化サンプラー');
const CQSearch = require(path.join(root, 'js/engine/search.js'));
/* テスト用の決定的な search 設定：時間予算を事実上無効化してサンプル数を固定する */
function searchCfg(over) {
  return Object.assign({ policy: 'search', samples: 3, depth: 1, budgetMs: 1e9, minSamples: 3,
                         noAttackTurns: 0, mulligan: true, handSlots: 6 }, over || {});
}

t('カウンティング分布：公開済みのカードを母集団から差し引く', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(151), down(152)]);     // ユニット8・表151・自分置き152
  m.players.self.hand = [180];
  const pool = CQSearch.countingPool(m, 'self', {});
  // 母集団は各ＩＤ×2枚。8は場に1枚・151は表1枚・152は自分置き1枚・180は手札1枚が引かれる
  eq(pool.filter((x) => x === 8).length, 1, 'ユニット8が1枚差し引かれる');
  eq(pool.filter((x) => x === 151).length, 1, '表の151が1枚差し引かれる');
  eq(pool.filter((x) => x === 152).length, 1, '自分が置いた152が1枚差し引かれる');
  eq(pool.filter((x) => x === 180).length, 1, '自分の手札の180が1枚差し引かれる');
  eq(pool.filter((x) => x === 91).length, 0, 'カース(t:C)は母集団に入らない');
});
t('カウンティング分布：samplePool を渡すとその分布を使う（エリアの敵プール等）', () => {
  const m = mkBattleBoard();
  const pool = CQSearch.countingPool(m, 'self', { samplePool: [8, 8, 151] });
  eq(pool.slice().sort((a, b) => a - b), [8, 8, 151], '指定した母集団がそのまま使われる');
});
t('世界の決定化：不明カードだけが引き直され、既知のカード・自分の手札は保存される', () => {
  const m = mkBattleBoard();
  m.aiConfig = { enemy: searchCfg({ samplePool: [180] }) };
  m.board.lanes[0] = lane(8, [down(135), up(151)]);     // 裏135＝敵には不明／表151＝既知
  m.players.self.hand = [101, 102];                     // プレイヤーの手札（敵には不明）
  m.players.enemy.hand = [151, 152];                    // 敵自身の手札（既知）
  const rng = CQRng.create(7);
  const world = CQSearch.makeWorld(m, 'enemy', rng, [180]);
  eq(world.board.lanes[0].channels[0].card, 180, '不明カードは分布から引き直される');
  eq(world.board.lanes[0].channels[1].card, 151, '表のカードはそのまま');
  eq(world.players.enemy.hand, [151, 152], '自分（敵ＡＩ）の手札はそのまま');
  eq(world.players.self.hand, [180, 180], '相手の手札は枚数を保って引き直される');
  eq(m.board.lanes[0].channels[0].card, 135, '元の対局は一切変更されない');
  eq(m.players.self.hand, [101, 102], '元の手札も変更されない');
});
t('サンプリングは対局の m.rng を消費しない（別系統ＲＮＧ＝再現性の保護）', () => {
  const m = mkBattleBoard();
  m.aiConfig = { self: searchCfg() };
  m.board.lanes[0] = lane(16, []);
  m.board.lanes[3] = lane(8, [down(151, { mine: false })]);
  const before = m.rng.state();
  CQSearch.decide(m, 'self', CQSearch.enumerateMain(m));
  eq(m.rng.state(), before, '決定の過程で対局の乱数列は進まない');
});

section('M5.7: 探索方策・カンニング検出ガード（恒久）');
t('未公開カードの実ＩＤを差し替えても、同一シードなら同一の手を選ぶ', () => {
  /* 敵ＡＩ（active=enemy）から見えないプレイヤー側の裏向きカードだけを差し替えた
   * 2つの対局で、選択される手が完全に一致することを確認する。
   * ここが崩れたら、ＡＩの判断経路のどこかが未公開情報を読んでいる（＝カンニング） */
  const play = (hiddenId) => {
    const m = mkBattleBoard();
    m.active = 'enemy';
    m.aiConfig = { enemy: searchCfg({ samplePool: [8, 151, 180] }) };
    m.board.lanes[3] = lane(16, []);                    // 敵ＡＩのユニット
    m.board.lanes[0] = lane(8, [down(hiddenId), down(hiddenId)]);  // プレイヤーの裏向きＣＨ
    m.players.self.hand = [hiddenId];                   // プレイヤーの手札も差し替え対象
    CQAi.mainStep(m);
    return JSON.stringify(m._lastChoice);
  };
  eq(play(135), play(158), '雷撃(135)を膨張(158)に差し替えても同じ手');
  eq(play(135), play(101), '魔法101に差し替えても同じ手');
});

section('M5.7: 探索方策・時間予算と決定');
t('時間予算：budgetMs=0 なら minSamples で打ち切る', () => {
  const m = mkBattleBoard();
  m.aiConfig = { self: searchCfg({ samples: 1000, minSamples: 2, budgetMs: 0 }) };
  m.board.lanes[0] = lane(16, []);
  m.board.lanes[3] = lane(8, [down(151, { mine: false })]);
  CQAi.mainStep(m);
  eq(m._searchStats.samples, 2, 'minSamples=2 で打ち切られる');
});
t('リーサル確定（全世界で適用直後に勝ち）の手を最優先で選ぶ', () => {
  const m = mkBattleBoard();
  m.turn = 5;
  m.players.self.turnsTaken = 3;
  m.aiConfig = { self: searchCfg() };
  m.board.lanes[0] = lane(16, []);                      // A600（Ｃ型なし）：どちらも倒せる
  m.board.lanes[3] = lane(27, []);                      // メガゾエア ＣＨ2 D400
  m.board.lanes[4] = lane(8, []);                       // ピッグマン ＣＨ4 D450 ＝リーサル
  m.players.enemy.lp = 4;
  CQAi.mainStep(m);
  CQAi.finishCombat(m);
  eq(m.winner, 'self', 'ＣＨ4のピッグマンを選んで勝負を決める');
});
t('確実に勝てる攻撃がある盤面では、パスではなく攻撃を選ぶ', () => {
  const m = mkBattleBoard();
  m.turn = 5;
  m.players.self.turnsTaken = 3;
  m.aiConfig = { self: searchCfg() };
  m.board.lanes[0] = lane(16, []);                      // A600 vs D450 → margin +150
  m.board.lanes[3] = lane(8, []);
  const acted = CQAi.mainStep(m);
  CQAi.finishCombat(m);
  eq(acted, true, '行動した');
  eq(m.board.lanes[3].unit, null, '敵ユニットが破壊された');
});

section('M5.7: 探索方策・候補手の列挙（行動制限の維持）');
t('noAttackTurns：最初の2手番は攻撃・デッキ攻撃が候補に入らない（フリーの個性を維持）', () => {
  const m = mkBattleBoard();
  m.aiConfig = { self: searchCfg({ noAttackTurns: 2 }) };
  m.board.lanes[0] = lane(16, []);
  m.board.lanes[3] = lane(8, []);
  m.players.self.turnsTaken = 2;
  const c1 = CQSearch.enumerateMain(m);
  eq(c1.some((c) => c.type === 'attack' || c.type === 'deck'), false, '2手番目まで攻撃候補なし');
  m.players.self.turnsTaken = 3;
  const c2 = CQSearch.enumerateMain(m);
  eq(c2.some((c) => c.type === 'attack'), true, '3手番目からは攻撃が候補に入る');
});
t('handSlots：手札スロット7のカードは候補に入らない（§11.4：実質6枚運用）', () => {
  const m = mkBattleBoard();
  m.phase = 'placement';
  m.aiConfig = { self: searchCfg() };
  m.players.self.hand = [180, 180, 180, 180, 180, 180, 8];   // ユニットはスロット7にだけ
  const cands = CQSearch.enumeratePlacement(m);
  eq(cands.some((c) => c.type === 'summon'), false, 'スロット7のユニットは召還候補にならない');
});
t('search のマリガン：召還できるユニットが無い初手は手札を引き直す（§4.1）', () => {
  const m = newMatch(700, { selfDeck: mkDeck(50, [151, 8]) });
  m.aiConfig = { self: searchCfg() };
  CQTurn.beginTurn(m);
  m.players.self.hand = [151, 151, 151, 151, 151, 151];
  const lpBefore = m.players.self.lp;
  CQAi.placementStep(m);
  eq(m.players.self.hasChanged, true, 'チェンジを使った');
  eq(m.players.self.lp, lpBefore - 1, 'ＬＰを1消費');
});
t('search の配置：場が空でユニットが手札にあれば召還する', () => {
  const m = mkBattleBoard();
  m.phase = 'placement';
  m.turn = 1;
  m.aiConfig = { self: searchCfg({ samplePool: [180] }) };
  m.players.self.hand = [8, 180];
  const acted = CQAi.placementStep(m);
  eq(acted, true, '行動した');
  eq(m.board.lanes.slice(0, 3).some((l) => l.unit === 8), true, 'ユニットが召還される');
});

/* ================= 結果 ================= */
console.log(`\n${pass} passed / ${fail} failed`);
if (failures.length) { console.log('\n' + failures.join('\n\n')); process.exit(1); }
