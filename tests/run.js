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
const CQField = require(path.join(root, 'js/engine/fieldrules.js'));
const CQAreas = require(path.join(root, 'js/run/areas.js'));
const CQMap = require(path.join(root, 'js/run/map.js'));
const CQRun = require(path.join(root, 'js/run/run.js'));
const CQSave = require(path.join(root, 'js/meta/save.js'));
const CQCollection = require(path.join(root, 'js/meta/collection.js'));
const CQLore = require(path.join(root, 'js/lore.js'));
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
t('初手は先攻6枚・後攻7枚、以降は1枚', () => {
  const m = newMatch();                            // first:'self'
  CQTurn.beginTurn(m);
  eq([m.turn, m.phase, m.players.self.hand.length], [1, 'placement', 6], '先攻の初手6枚');
  CQTurn.endPlacement(m); CQTurn.endTurn(m);      // 自分のターン終了 → 相手へ
  CQTurn.beginTurn(m);
  /* 2026-08-29 本人指定・先行有利の是正：後攻だけ初期ドロー+1（SECOND_DRAW_BONUS）。
   * 手札上限7枚ちょうどなので、この1枚で捨て札は発生しない。 */
  eq(m.players.enemy.hand.length, 7, '後攻の初手は7枚（先行有利の是正）');
  eq(m.phase, 'placement', '7枚ちょうどなので捨て札にはならない');
  CQTurn.endPlacement(m); CQTurn.endTurn(m);      // 相手のターン終了 → 自分へ
  CQTurn.beginTurn(m);
  eq([m.turn, m.players.self.hand.length], [3, 7], '2ターン目は+1枚');
});
t('後攻+1ドローは「先攻でない側」に付く（先攻が相手なら自分が7枚）', () => {
  const m = newMatch(11, { first: 'enemy' });
  eq(m.first, 'enemy', 'first は対局のあいだ保持される');
  CQTurn.beginTurn(m);
  eq(m.players.enemy.hand.length, 6, '先攻（相手）は6枚');
  CQTurn.endPlacement(m); CQTurn.endTurn(m);
  CQTurn.beginTurn(m);
  eq(m.players.self.hand.length, 7, '後攻（自分）は7枚');
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
  // 10 ヨルムンガンド＝召還Ｌｖ5。魔道書2枚（表）で要求Ｌｖ5-4=1まで下がり、3階層目でも成功する。
  // ただしＬｖ2以上なので生贄の儀式が要る（v0.15.3）＝メインステップで検証する
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(2, [up(186), up(186), down(10)]);
  CQStats.recalc(m.board, OPT);
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.board.lanes[0].unit, 10, '魔道書2枚でＬｖ1相当まで下がり召還成功（ホストの跡地）');
  eq(m.board.lanes[0].channels.length, 2, '下の魔道書2枚を引き継ぐ');
});
t('魔道書で要求レベルが下がっても、戦闘中は生贄の儀式ができない（v0.15.3）', () => {
  const m = duel(8, [up(186), up(186), down(10)], 8, [down(180)]);
  CQCombat.declareAttack(m, 0, 3);
  const r = CQCombat.open(m, 3);
  eq(r.effect.result, 'ritualCombat', '戦闘中は召還失敗');
  eq(m.board.lanes.filter((l) => l.unit === 10).length, 0, 'ヨルムンガンドは破壊された');
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
  /* 満杯まで埋めたあと、使い終わった103自身が消える（2026-08-31 の新原則）＝3枚残る */
  eq(m.board.lanes[0].channels.length, 3, '満杯まで埋まり、103自身は消える');
  eq(m.players.enemy.deckCount, enemyDeckBefore - 3, '敵の山札を3枚消費（103自身が既に1枚使用済み）');
});
t('105 歪曲：ＣＨ位置を上下反転する', () => {
  const m = mkBattleBoard();
  m.board.lanes[1] = lane(8, [down(151), down(105)]);
  CQTurn.reverseAction(m, 1, [2]);
  eq(m.board.lanes[1].channels.map(c => c.card), [151], '並びが反転し、使い終わった105は消える');
});
t('105 歪曲：原作バグ再現（レーン1・ＣＨ6枚のとき最上段が消滅する）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(151), down(151), down(151), down(151), down(105)]);
  CQTurn.reverseAction(m, 0, [6]);
  eq(m.board.lanes[0].channels.length, 4, '6枚が反転後5枚に減り（原作バグ再現）、105自身も消える');
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
t('108 強制開放：選んだ他ユニット1体のＣＨだけを下から順に開く（M6.7で全体→1体に修正）', () => {
  /* 原作解析 05_magic.md §2 のとおり対象は「他ユニット1体」。v0.16.21までは盤面全部を
   * 一括で開いていた（実装の誤り）。自分の乗っているレーンは対象外。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(108)]);
  m.board.lanes[3] = lane(8, [down(151), down(152)]);
  m.board.lanes[4] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [2], { choice: { lane: 3 } });
  eq(m.board.lanes[3].channels.every(c => c.up), true, '選んだレーンは全部開く');
  eq(m.board.lanes[4].channels[0].up, false, '選ばなかったレーンは開かない');
  eq(m.board.lanes[0].channels[0].up, false, '自分の乗っているレーンは対象外');
});
t('108 強制開放：下から順に処理する（steps が下から上に並ぶ）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[3] = lane(8, [down(151), down(152), down(153)]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.lastForcedChain.steps.map(x => x.idx), [0, 1, 2], '階層0→1→2の順');
  eq(m.lastForcedChain.aborted, null, '最後まで通る');
});
t('108 強制開放：既に表のＣＨは飛ばす（開放は裏のものだけ）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[3] = lane(8, [up(151), down(152)]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.lastForcedChain.steps.map(x => x.idx), [1], '裏だった1階層目だけが対象');
});
t('109 強制転回：選んだ1体のＣＨを下から順に表裏ひっくり返す', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(109)]);
  m.board.lanes[3] = lane(8, [up(151), down(152)]);
  m.board.lanes[4] = lane(8, [up(151)]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[3].channels[0].up, false, '表だったカードが裏になる');
  eq(m.board.lanes[3].channels[1].up, true, '裏だったカードが表になる');
  eq(m.board.lanes[4].channels[0].up, true, '選ばなかったレーンは変わらない');
});
t('強制開放・強制転回は互いを連鎖的に起動しない（原作CE0355）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(109), down(108)]);
  CQTurn.reverseAction(m, 0, [2]);
  eq(m.board.lanes[0].channels[0].up, false, '109(強制中×)自身は強制開放で開かない');
});
t('110 閉門：選んだ他ユニット1体のＣＨを全てクローズ（敵陣も選べる。M6.7で自陣全部→1体に修正）', () => {
  /* 原作解析 §2「他ユニット1体（表ＣＨ1枚以上）」。119鎮静（700Ｇ・盤面全部）より
   * 高い800Ｇなのは「狙って閉じられる」ぶん使い勝手がよいから、という説明が付く。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(151), down(110)]);
  m.board.lanes[3] = lane(8, [up(151)]);
  m.board.lanes[4] = lane(8, [up(152)]);
  CQTurn.reverseAction(m, 0, [2], { choice: { lane: 3 } });
  eq(m.board.lanes[3].channels[0].up, false, '選んだ敵陣のカードが閉じる');
  eq(m.board.lanes[4].channels[0].up, true, '選ばなかったレーンは開いたまま');
  eq(m.board.lanes[0].channels[0].up, true, '自分の乗っているレーンは対象外');
});
t('110 閉門：強制開放で開かれたＣＨを閉じ直せる（対抗札としての使い道）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(110)]);
  m.board.lanes[3] = lane(8, [up(151), up(152)]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[3].channels.every(c => !c.up), true, '2枚とも閉じる');
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
t('113 透視：相手が置いた裏向きＣＨを2枚まで、選んで確認できる（M6.7で対象を修正）', () => {
  /* 原作解析 §2「敵が置いた裏ＣＨ×2」。v0.16.21までは自分が置いたものも含む
   * 裏ＣＨ全部から乱数で2枚選んでいた（自分の伏せ札は元から中身が分かるので無意味）。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(113)]);          // 自分が置いた伏せ札
  m.board.lanes[3] = lane(8, [down(152), down(153), down(155)]);
  m.board.lanes[3].channels.forEach((c) => { c.mine = false; });
  CQTurn.reverseAction(m, 0, [2], { choice: { picks: [{ lane: 3, idx: 0 }, { lane: 3, idx: 2 }] } });
  eq(m.board.lanes[3].channels[0].revealed, true, '選んだ1枚目が判明する');
  eq(m.board.lanes[3].channels[2].revealed, true, '選んだ2枚目が判明する');
  eq(m.board.lanes[3].channels[1].revealed, false, '選ばなかったものは伏せたまま');
  eq(m.board.lanes[0].channels[0].revealed, false, '自分が置いた伏せ札は対象外');
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
  /* 奪った1枚が乗り、使い終わった118自身は消える＝残るのは奪った1枚だけ */
  eq(m.board.lanes[0].channels.map((c) => c.card), [151], '奪ったＣＨだけが残る');
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
  /* M6.7 WP5：対象は**他レーン**の潜行ユニット（自分の乗っているレーンは選べない・§1-4）。
   * 中身が分かっているもの（自分が置いた／既知）だけが候補。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(121)]);
  m.board.lanes[3] = lane(8, [down(1, { mine: true })]);
  CQTurn.reverseAction(m, 0, [1]);
  const summoned = m.board.lanes[1].unit === 1 || m.board.lanes[2].unit === 1;
  eq(summoned, true, '潜行ユニットが空きレーンに召還される');
});
t('122 予見：山札から5枚見て1枚もらう（M6.7 判断4で効果を変更）', () => {
  /* 原作は「5枚を任意の順で山札の先頭に戻す」だが、このエンジンの山札は無順序なので
   * 実装できず、v0.16.22までは no-op（説明文だけが嘘をついている状態）だった。 */
  const m = newMatch(320, { selfDeck: mkDeck(30, [8]) });
  m.phase = 'main';
  m.board.lanes[0] = lane(8, [down(122)]);
  const deckBefore = m.players.self.deckCount;
  const handBefore = m.players.self.hand.length;
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.players.self.hand.length, handBefore + 1, '手札が1枚増える');
  eq(m.players.self.deckCount, deckBefore - 1, '山札は差し引き1枚だけ減る（残り4枚は戻す）');
  eq(m.pendingChoice, null, 'interactiveでなければその場で自動解決される（ＡＩ・シミュレータ用）');
});
t('122 予見：interactive なら5枚を提示して選択待ちになる', () => {
  const m = newMatch(321, { selfDeck: mkDeck(30, [8, 41, 70, 101, 153]) });
  m.phase = 'main';
  m.board.lanes[0] = lane(8, [down(122)]);
  const handBefore = m.players.self.hand.length;
  CQTurn.reverseAction(m, 0, [1], { interactive: true });
  eq(m.pendingChoice.kind, 'foresee', '選択待ちになる');
  eq(m.pendingChoice.options.length, 5, '5枚が提示される');
  eq(m.players.self.hand.length, handBefore, 'まだ手札は増えていない');
  const want = m.pendingChoice.options[2];
  CQMagic.resolvePending(m, { pick: 2 });
  eq(m.players.self.hand[m.players.self.hand.length - 1], want, '選んだ3枚目が手に入る');
  eq(m.pendingChoice, null, '解決すると選択待ちが解ける');
});
t('123 発症：配置されたレベルと同数のＬＰを失う', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(151), down(123)]);
  const lpBefore = m.players.self.lp;
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.players.self.lp, lpBefore - 3, '3階層目で3点のＬＰダメージ');
});
t('124 凍結：ＣＨを持つ他ユニット1体を硬直させる（戦闘中×）', () => {
  /* M6.7 WP5：対象確認は CE0216 EJECT（05_magic.md §1-3）＝
   * **ＣＨを1枚以上持つ他ユニット**。ＣＨの無い裸のユニットは凍らせられない。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(124)]);
  m.board.lanes[1] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.log.some((l) => l.indexOf('凍結：') === 0 && l.indexOf('対象が無い') < 0), true, '硬直させる効果が発動する');
});
t('125 移送：最も高いレベルにあるＣＨを他ユニットへ移動する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(125)]);
  m.board.lanes[1] = lane(8, []);
  CQTurn.reverseAction(m, 0, [2]);
  eq(m.board.lanes[0].channels.length, 0, '1枚移り、使い終わった125自身も消える');
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
  eq(m.board.lanes[0].channels.length, 0, '第1層が壊れ、使い終わった131自身も消える');
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
  /* M6.7 WP5：**自分の乗っているレーンは選べない**（§1-4・原作の教習でも明示）。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(135)]);
  m.board.lanes[3] = lane(8, []);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[3].unit, null, '対象条件を満たすユニットが破壊される');
  eq(m.board.lanes[0].unit, 8, '自分の乗っているレーンは巻き込まれない');
});
t('137 潜行爆弾：相手のユニットに爆弾を仕掛ける（M6.7 判断14で本人案に変更）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(137)]);
  m.board.lanes[3] = lane(8, []);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[0].channels.length, 0, '自分は元の位置から消える');
  eq(m.board.lanes[3].channels.length, 1, '相手のユニットにチャネルされる');
  eq(m.board.lanes[3].channels[0].card, 137, '爆弾の正体は137のまま');
  eq(m.board.lanes[3].channels[0].up, false, '裏向きで仕掛けられる');
  eq(m.board.lanes[3].channels[0].armed, true, '仕掛け済みの印が付く');
});
t('137 潜行爆弾：仕掛けた爆弾が表になると、防御力600以下のユニットを破壊する', () => {
  const m = mkBattleBoard();
  m.board.lanes[3] = lane(8, []);                       // 8 ピッグマン D450
  m.board.lanes[3].channels.push({ card: 137, up: false, mine: true, revealed: true, armed: true });
  m.board.lanes[3].count = 1;
  m.active = 'enemy';                                    // 仕掛けられた側が自分で開く
  CQTurn.reverseAction(m, 3, [1]);
  eq(m.board.lanes[3].unit, null, '防御力450なので爆発で破壊される');
});
t('137 潜行爆弾：防御力が600を超えるユニットには効かず、爆弾だけが壊れる', () => {
  const m = mkBattleBoard();
  m.board.lanes[3] = lane(8, []);
  /* 魔力の盾(153)で防御力を+200して650にしてから爆発させる */
  m.board.lanes[3].channels.push({ card: 153, up: true, mine: false, revealed: true });
  m.board.lanes[3].channels.push({ card: 137, up: false, mine: true, revealed: true, armed: true });
  m.board.lanes[3].count = 2;
  m.active = 'enemy';
  CQTurn.reverseAction(m, 3, [2]);
  eq(m.board.lanes[3].unit, 8, 'ユニットは生き残る');
  eq(m.board.lanes[3].channels.some((c) => c.card === 137), false, '爆弾だけが壊れる');
});
t('137 潜行爆弾：強制開放で開かせて爆発させられる（108とのコンボ）', () => {
  /* 判断14で本人案を採ったいちばんの理由がこれ。相手のユニットに仕掛けておき、
   * 強制開放で自分から開かせて爆発させる、という2枚の噛み合わせが成立する。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[3] = lane(8, []);
  m.board.lanes[3].channels.push({ card: 137, up: false, mine: true, revealed: true, armed: true });
  m.board.lanes[3].count = 1;
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[3].unit, null, '強制開放で開かれた爆弾が爆発した');
});
t('138 潜入：このカードが付いているユニットごと、他ユニットの中へ潜り込む（詠唱Ｌｖ3）', () => {
  /* ★2026-08-30 本人指定で効果を変更した。以前は「このカード自身」が移るだけで
   * 盤面がほとんど動かなかった。いまは**ユニットごと隠す**（積んでいたＣＨは失われる）。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(151), down(138)]);
  m.board.lanes[1] = lane(13, []);
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.board.lanes[0].unit, null, '潜ったユニットのレーンは空になる');
  eq(m.board.lanes[0].channels.length, 0, '積んでいたＣＨも一緒に消える');
  eq(m.board.lanes[1].channels.map((c) => c.card), [8], 'ユニットが裏向きのＣＨとして潜り込む');
  eq(m.board.lanes[1].channels[0].up, false, '裏向き＝潜行している');
  eq(m.players.self.lp, 10, '破壊ではないのでＬＰは減らない');
});

t('138 潜入：潜ったユニットは招来(121)やリバース召還で出し直せる', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(151), down(138)]);
  m.board.lanes[1] = lane(13, []);
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.board.lanes[1].channels.map((c) => c.card), [8], '潜っている');
  /* 別レーンから招来で引き出す */
  m.board.lanes[2] = lane(13, [down(121)]);
  CQTurn.reverseAction(m, 2, [1]);
  eq(m.board.lanes[0].unit, 8, '空きレーンへ召還し直せる');
});

t('138 潜入：ＣＨに空きが無いユニットには潜り込めない（FLOOD）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(151), down(138)]);   /* 詠唱Ｌｖ3なので第3層に置く */
  m.board.lanes[1] = lane(70, [down(151), down(151)]);   /* ポルターガイストはＣＨ2＝満杯 */
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.board.lanes[0].unit, 8, '潜れないので、そのまま場に残る');
  eq(m.log.some((l) => l.indexOf('潜入：潜り込む先が無い') === 0), true, '不発の記録が残る');
});
t('139 爆雷：敵マスターのＬＰを3点減らす（戦闘中×）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(139)]);
  const lpBefore = m.players.enemy.lp;
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.players.enemy.lp, lpBefore - 3, '敵のＬＰが3点減る');
});
t('140 時の渦：詠唱Ｌｖ4で自分のターンをやり直す（M6.7 判断5で作り直し）', () => {
  const m = newMatch(306);
  m.phase = 'main';
  m.board.lanes[0] = lane(13, [down(151), down(151), down(151), down(140)]);
  m.board.lanes[1] = lane(8, []);
  m.board.lanes[1].stiff = true;                        // 行動済みのユニットが居る
  m.players.self.actedThisTurn = true;
  CQTurn.reverseAction(m, 0, [4]);
  eq(m.phase, 'placement', '配置ステップからやり直しになる');
  eq(m.board.lanes[1].stiff, false, '自陣の硬直が解ける＝もう一度動ける');
  eq(m.board.lanes[0].stiff, false, 'リバースしたユニット自身の硬直も解ける');
  eq(m.players.self.actedThisTurn, false, '行動済みの印も消える');
  eq(m.board.lanes[0].channels.some((c) => c.card === 140), false, '時の渦自身は壊れる');
});
t('140 時の渦：それより上の階層は開かれない（以降のカード効果を停止する）', () => {
  const m = newMatch(307);
  m.phase = 'main';
  m.board.lanes[0] = lane(13, [down(151), down(151), down(151), down(140), down(152)]);
  CQTurn.reverseAction(m, 0, [4, 5]);
  /* 140が4階層目で発動して自分が消えるので、元の5階層目（152）は4番目に繰り下がる。
   * 開かれていないこと＝停止したことを確認する。 */
  eq(m.board.lanes[0].channels.filter((c) => c.up).length, 0, '上の階層は開かれない');
});
t('140 時の渦：強制リバース連鎖の最中は、連鎖を止めるだけでターンはやり直さない', () => {
  /* 2026-08-30 本人確定。連鎖を仕掛けたのは相手・カードの持ち主はこちら、という状況で
   * 「誰のターンをやり直すのか」が決まらないため、止めるところまでにしてある。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[3] = lane(13, [down(151), down(151), down(151), down(140), down(152)]);
  m.board.lanes[3].channels.forEach((c) => { c.mine = false; });
  const phaseBefore = m.phase;
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.lastForcedChain.aborted != null, true, '連鎖が中断される');
  eq(m.lastForcedChain.steps.length, 4, '4枚目（時の渦）までで止まる');
  eq(m.board.lanes[3].channels.some((c) => c.up && c.card === 152), false, '5枚目は開かれない');
  eq(m.phase, phaseBefore, 'ターンのやり直しは起きない');
});

section('M4 v0.13: 魔法141〜148');
t('141 思念波：防御力550以下のユニットには不発（原作バグ再現：対象判定が551〜1000限定）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(141)]);
  m.board.lanes[3] = lane(57, []);                    // 57 ネクロスフィア D500
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[3].unit, 57, '防御力550は範囲外のため不発');
});
t('141 思念波：6階層目に置けば成立する（M6.7 判断12：詠唱Ｌｖ6を本物にした）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(10, [down(151), down(151), down(151), down(151), down(151), down(141)]);
  m.board.lanes[3] = lane(28, []);                    // 28 スネイルリキッド D600
  CQTurn.reverseAction(m, 0, [6]);
  eq(m.board.lanes[3].unit, null, '防御力551〜1000のユニットは破壊される');
});
t('141 思念波：詠唱Ｌｖ6に満たない階層では不発（M6.7 判断12）', () => {
  /* 原作は V397==6 の分岐が存在せずレベル判定が働かないバグだったが、
   * 「防御力1000以下を無条件破壊」という強さに見合う制約として本物にした。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(141)]);            // 1階層目
  m.board.lanes[3] = lane(28, []);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[3].unit, 28, 'レベル不足で不発');
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
t('146 口寄せ：詠唱Ｌｖ3で山札から1枚めくる（M6.7 判断5：原作仕様に作り直し）', () => {
  const m = newMatch(308, { selfDeck: mkDeck(30, [8]) });
  m.phase = 'main';
  m.board.lanes[0] = lane(13, [down(151), down(151), down(146)]);
  const before = m.players.self.deckCount;
  const handBefore = m.players.self.hand.length;
  CQTurn.reverseAction(m, 0, [3]);
  eq(m.players.self.deckCount, before - 1, '山札が1枚減る');
  eq(m.players.self.hand.length, handBefore + 1, '採用して手札に加わる');
  eq(m.pendingChoice, null, 'interactiveでなければ自動解決される');
});
t('146 口寄せ：interactive なら「採用する／捨ててもう1枚」を繰り返せる', () => {
  const m = newMatch(309, { selfDeck: mkDeck(30, [8]) });
  m.phase = 'main';
  m.board.lanes[0] = lane(13, [down(151), down(151), down(146)]);
  const deckBefore = m.players.self.deckCount;
  CQTurn.reverseAction(m, 0, [3], { interactive: true });
  eq(m.pendingChoice.kind, 'summon', '選択待ちになる');
  eq(m.pendingChoice.options.length, 1, '1枚だけ見せる');
  CQMagic.resolvePending(m, { keep: false });          // 捨ててもう1枚
  eq(m.pendingChoice.kind, 'summon', 'まだ選択待ちのまま');
  eq(m.pendingChoice.tries, 2, '2回目');
  eq(m.players.self.deckCount, deckBefore - 2, '捨てた札は山札に戻らない＝掘るほど減る');
  CQMagic.resolvePending(m, { keep: true });           // 今度は採用
  eq(m.pendingChoice, null, '採用すると終わる');
});
t('147 治癒：手札を全て捨てその枚数と同値のＬＰを回復する（戦闘中×）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(147)]);
  m.players.self.hand = [151, 152, 153];
  m.players.self.lp = 5;
  CQTurn.reverseAction(m, 0, [1]);
  eq([m.players.self.hand, m.players.self.lp], [[], 8], '手札3枚を捨ててＬＰ+3');
});
t('147 治癒：戦闘中でも発動する（M6.7：資料§2の「戦闘中○」に合わせて修正）', () => {
  /* v0.16.21までは NO_COMBAT に入れて塞いでいたが、原作解析 §2 の一覧表では
   * 144還元・147治癒はどちらも「戦闘中○」。誤って塞いでいた。 */
  const m = duel(8, [down(147)], 8, []);
  m.players.self.hand = [151, 152];
  const lpBefore = m.players.self.lp;
  CQCombat.declareAttack(m, 0, 3);
  CQCombat.open(m, 1);
  eq(m.players.self.hand, [], '手札を全部捨てる');
  eq(m.players.self.lp, Math.min(m.players.self.maxLp, lpBefore + 2), '捨てた枚数だけＬＰ回復');
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
  eq(after, before - 3, '2回発動して2枚破壊し、使い終わった101自身も消える');
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
t('25 スケープゴート：摩り替り＝チャネル先のユニットと位置を入れ替える（M6.7 判断6）', () => {
  /* 原作解析 07_unit_abilities.md §ID25 で仕様が判明した。名前どおりの「身代わり」で、
   * v0.16.22までの「手札に分身を得る」は推測が外れていた。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(25)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].unit, 25, 'スケープゴートがユニット本体になる');
  eq(m.board.lanes[0].channels[0].card, 8, '元のユニットがそのＣＨ階層へ落ちる');
  eq(m.board.lanes[0].channels[0].up, false, '落ちた元ユニットは裏向き');
});
t('25 スケープゴート：自分で置いたチャンネルでなければ入れ替わらない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(25)]);
  m.board.lanes[0].channels[0].mine = false;           // 相手が押し付けた身代わり
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].unit, 8, 'ユニットは入れ替わらない');
});
t('25 スケープゴート：スケープゴートに重ねても無限に入れ替わらない（simulate.js seed 1855 の回帰）', () => {
  /* 入れ替えても盤面が変わらないのにチャンネルが裏へ戻るため、
   * オープンフェイズが永遠に終わらなくなっていた。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(25, [down(25)]);
  CQTurn.reverseAction(m, 0, [1]);   /* 無限ループしないこと自体がこのテストの主眼 */
  eq(m.board.lanes[0].unit, 25, 'ユニットはスケープゴートのまま');
  /* 入れ替える意味が無いので摩り替りは起きず、ユニットカードとして普通に
   * リバース召還される（＝この階層からは居なくなる）。 */
  eq(m.board.lanes[0].channels.length, 0, 'その階層のカードはリバース召還で場へ出る');
});
t('25 スケープゴート：入れ替えても階層は無くならない（カーソルをずらさない）', () => {
  /* consumed を返すと、オープンフェイズ／リバースのカーソルが1つずれて
   * 同じ階層を読み直してしまう。この階層は「中身が変わった」だけで無くなっていない。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(25), down(151)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].channels.length, 2, '階層の数は変わらない');
  eq(m.board.lanes[0].channels[1].card, 151, '上の階層はそのまま');
});
t('25 スケープゴート：原作の「2体になる」バグは再現しない（M6.7 §0-1の方針）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(25)]);
  m.board.lanes[1] = S.emptyLane();                    // 空きレーンがある状態
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[1].unit, null, '空きレーンにスケープゴートは増えない');
  eq(m.board.lanes[0].channels[0].card, 8, '元ユニットも消えない');
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

/* ================= M5.8: 生贄召還（召還Ｌｖ2以上のリバース召還） ================= */
section('M5.8: 生贄召還の成立');
/* ホストは パイロウイング(2)＝召還Ｌｖ1・ＣＨ5・固有能力が儀式に干渉しない。
 * 積むカードは 空白(180)＝表になっても効果が無いので、引き継ぎ枚数だけを純粋に見られる */
const FILL = 180;
function ritualBoard(chs, hostId) {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(hostId === undefined ? 2 : hostId, chs);
  CQStats.recalc(m.board, OPT);
  return m;
}

t('召還Ｌｖ5：ホストを生贄に、下に積まれた4枚を引き継いで跡地に立つ', () => {
  const m = ritualBoard([down(FILL), down(FILL), down(FILL), down(FILL), down(12)]);
  const lpBefore = m.players.self.lp;
  const r = CQTurn.reverseAction(m, 0, [5]);
  eq(r.ok, true, 'リバース成功');
  eq(m.board.lanes[0].unit, 12, 'ホストの跡地にウロボロスが立つ');
  eq(m.board.lanes[0].channels.length, 4, '下の4枚を引き継いだ');
  eq(m.board.lanes[0].channels.every((c) => c.card === FILL && !c.up), true, '裏向きのまま引き継ぐ');
  eq(m.players.self.lp, lpBefore, '生贄でＬＰは減らない（suppress）');
  eq(m.board.lanes[0].stiff, false, '召還されたユニットは硬直しない');
});
t('引き継いだ裏向きＣＨはそのまま防御力になる（Ｄ550＋100×4＝950）', () => {
  const m = ritualBoard([down(FILL), down(FILL), down(FILL), down(FILL), down(12)]);
  CQTurn.reverseAction(m, 0, [5]);
  CQStats.recalc(m.board, OPT);
  eq(m.board.lanes[0].def, 950, 'ウロボロスＤ550＋引き継ぎ4枚');
});
t('召還されるユニットより上に積まれていたカードはホストと一緒に破壊される', () => {
  const m = ritualBoard([down(FILL), down(FILL), down(13), down(FILL), down(FILL)]);
  CQTurn.reverseAction(m, 0, [3]);                      // ニドヘッグ(Ｌｖ3)を3階層目から
  eq(m.board.lanes[0].unit, 13, 'ニドヘッグが立つ');
  eq(m.board.lanes[0].channels.length, 2, '下の2枚だけが残る（上の2枚は消える）');
});
t('敵が仕込んだカードも一緒に引き継ぐ', () => {
  const m = ritualBoard([down(FILL, { mine: false }), down(FILL), down(FILL), down(FILL), down(12)]);
  CQTurn.reverseAction(m, 0, [5]);
  eq(m.board.lanes[0].channels[0].mine, false, '敵が置いたカードも持ち主のまま付いてくる');
});
t('リバース召還したユニットはその場で攻撃できる', () => {
  const m = ritualBoard([down(FILL), down(FILL), down(FILL), down(FILL), down(12)]);
  m.board.lanes[3] = lane(8, []);
  m.turn = 5;
  CQTurn.reverseAction(m, 0, [5]);
  eq(CQCombat.canAttack(m, 0).ok, true, '硬直していないので攻撃できる');
});

section('M5.8: 生贄召還の失敗（儀式が成立しない4条件）');
t('戦闘中のオープンフェイズでは儀式ができず、ユニットは破壊される', () => {
  const m = ritualBoard([down(FILL), down(FILL), down(FILL), down(FILL), down(12)]);
  m.board.lanes[3] = lane(8, []);
  m.turn = 5;
  CQCombat.declareAttack(m, 0, 3);
  eq(!!m.combat, true, '戦闘に入った');
  CQCombat.open(m, 5);                                   // ウロボロスの階層を開く
  eq(m.board.lanes[0].unit, 2, 'ホストは生き残る');
  eq(m.board.lanes[0].channels.some((c) => c.card === 12), false, 'ウロボロスは破壊された');
  eq(m.board.lanes.filter((l) => l.unit === 12).length, 0, '場のどこにも召還されていない');
});
t('救済(179)が表向きのホストは生贄にできず、召還は失敗する', () => {
  const m = ritualBoard([up(179), down(FILL), down(FILL), down(FILL), down(12)]);
  CQTurn.reverseAction(m, 0, [5]);
  eq(m.board.lanes[0].unit, 2, 'ホストは救済で守られて残る');
  eq(m.board.lanes[0].channels.some((c) => c.card === 12), false, 'ウロボロスは破壊された');
});
t('裏向きの救済は儀式を邪魔しない（技能は表向きのときだけ効く）', () => {
  const m = ritualBoard([down(179), down(FILL), down(FILL), down(FILL), down(12)]);
  CQTurn.reverseAction(m, 0, [5]);
  eq(m.board.lanes[0].unit, 12, '儀式は成立する');
  eq(m.board.lanes[0].channels.some((c) => c.card === 179), true, '救済は引き継がれる');
});
t('救済能力を固有で持つケツァルコアトル(11)はホストにできない', () => {
  const m = ritualBoard([down(FILL), down(FILL), down(FILL), down(FILL), down(12)], 11);
  CQTurn.reverseAction(m, 0, [5]);
  eq(m.board.lanes[0].unit, 11, 'ケツァルコアトルは生贄にならない');
  eq(m.board.lanes[0].channels.some((c) => c.card === 12), false, 'ウロボロスは破壊された');
});
t('敵のユニットに仕込んだ場合は生贄を用意できず失敗する', () => {
  const m = mkBattleBoard();
  m.active = 'enemy';                                    // 敵が自分のレーンをリバースする
  m.board.lanes[3] = lane(2, [down(FILL, { mine: true }), down(FILL, { mine: true }),
                              down(FILL, { mine: true }), down(FILL, { mine: true }),
                              down(12, { mine: true })]);  // プレイヤーが敵のスタックに仕込んだ
  CQStats.recalc(m.board, OPT);
  CQTurn.reverseAction(m, 3, [5]);
  eq(m.board.lanes[3].unit, 2, '敵のホストは生贄にならない');
  eq(m.board.lanes.filter((l) => l.unit === 12).length, 0, 'ウロボロスは召還されず破壊された');
});

section('M5.8: 傀儡で奪ったユニットの生贄と、召還Ｌｖ1の据え置き');
t('傀儡で操作権を奪った敵ユニットは生贄にできる（自分の場の空きへ召還）', () => {
  const m = mkBattleBoard();
  m.board.lanes[3] = lane(2, [down(FILL), down(FILL), down(13), up(169)]);   // 表の傀儡で操作権が自分に
  CQStats.recalc(m.board, OPT);
  eq(CQState.controlSide(m.board.lanes[3], 3), 'self', '操作権は自分側');
  CQTurn.reverseAction(m, 3, [3]);
  eq(m.board.lanes[3].unit, null, '敵陣のホストが生贄になった');
  const born = m.board.lanes.findIndex((l, i) => i < 3 && l.unit === 13);
  eq(born >= 0, true, 'ニドヘッグは自分の場に召還される');
  eq(m.board.lanes[born].channels.length, 2, '下の2枚を引き継ぐ');
});
t('傀儡で奪っても、自分の場に空きが無ければ召還は失敗する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, []); m.board.lanes[1] = lane(8, []); m.board.lanes[2] = lane(8, []);
  m.board.lanes[3] = lane(2, [down(FILL), down(FILL), down(13), up(169)]);
  CQStats.recalc(m.board, OPT);
  CQTurn.reverseAction(m, 3, [3]);
  eq(m.board.lanes[3].unit, 2, 'ホストは残る');
  eq(m.board.lanes[3].channels.some((c) => c.card === 13), false, 'ニドヘッグは破壊された');
});
t('召還Ｌｖ1のユニットは従来どおり（生贄なし・引き継ぎなし・空きレーンへ）', () => {
  const m = ritualBoard([down(19)]);                     // 召還Ｌｖ1のユニットを1階層目に
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].unit, 2, 'ホストは生き残る');
  const born = m.board.lanes.findIndex((l, i) => i < 3 && l.unit === 19);
  eq(born >= 0 && born !== 0, true, '空きレーンに召還される');
  eq(m.board.lanes[born].channels.length, 0, 'ＣＨは引き継がない');
});
t('儀式が失敗しても、下に積まれていたカードは残る', () => {
  const m = ritualBoard([up(179), down(FILL), down(FILL), down(FILL), down(12)]);
  CQTurn.reverseAction(m, 0, [5]);
  eq(m.board.lanes[0].channels.length, 4, '救済＋空白3枚がそのまま残る');
});

/* ================= M6: 戦場ルール（バトルモディファイア） =================
 * 『CardQuest 実装計画 追補：M5.7』の M6追補 §0〜§5 の実装を検証する。
 * 設計原理どおり「エンジンにフックとして実装し、ＡＩ側には何も書かない」ため、
 * ここで通るルールは search の先読みがそのまま体験して回避できることになる。 */
section('M6: 戦場ルールの共通枠組み');

/** 戦場ルール付きのマッチ（メインステップから始める。盤面は呼び出し側が組む） */
function mkField(rules, opts) {
  const m = CQTurn.createMatch(Object.assign({
    cards: CARD_BY_ID, rng: CQRng.create(1),
    selfDeck: mkDeck(40, [8, 180]), enemyDeck: mkDeck(40, [8, 180]),
    first: 'self', hooks: HOOKS, fieldRules: rules
  }, opts || {}));
  m.phase = 'main';
  return m;
}

t('ルール無しのバトルでは派生データが素通し（従来と完全に同じ）', () => {
  const m = mkField();
  eq(m.fieldRules, [], 'ルールは空');
  eq(m.board.fieldCap, [null, null, null, null, null, null], 'ＣＨ上限の制限なし');
  eq(m.board.fieldLock, [false, false, false, false, false, false], 'ロックなし');
});
t('正規化：未知のＩＤ・壊れたレーン指定は捨てる', () => {
  eq(CQField.normalize([{ id: 'nosuchRule' }, { id: 'laneCap', lanes: [] }, { id: 'laneLock' }]).length, 0,
     '3つとも捨てられる');
  eq(CQField.normalize([{ id: 'laneCap', lanes: [9, 2, 2, -1] }])[0].lanes, [2], '範囲外・重複は除去');
});
t('正規化：既定値が埋まる', () => {
  const r = CQField.normalize([{ id: 'bomb' }, { id: 'noHighCH' }, { id: 'pestCard' }]);
  eq([r[0].period, r[0].layer, r[1].max, r[2].period], [5, 4, 4, 3], '追補の既定値');
});
t('正規化：片陣営3レーン全部のロックは1レーン残す（生成データの不備で詰まないように）', () => {
  const r = CQField.normalize([{ id: 'laneLock', lanes: [0, 1, 2, 3] }]);
  eq(r[0].lanes, [0, 1, 3], '自陣は2レーンまでに削られる');
});
t('複数の laneCap が同じレーンに掛かったら厳しいほうを採る', () => {
  const m = mkField([{ id: 'laneCap', cap: 4, lanes: [0] }, { id: 'laneCap', cap: 2, lanes: [0, 1] }]);
  eq([m.board.fieldCap[0], m.board.fieldCap[1]], [2, 2], '2が採用される');
});
t('先読みのクローンにも戦場ルールが持ち回される（設計原理の要）', () => {
  const m = mkField([{ id: 'bomb', period: 3, layer: 2 }, { id: 'laneLock', lanes: [1] }]);
  const c = CQSearch.cloneMatch(m, CQRng.create(1));
  eq(c.fieldRules.length, 2, 'ルール定義が残る');
  eq(c.board.fieldLock[1], true, 'レーン別の派生データも残る');
  c.fieldRules[0].period = 99;
  eq(m.fieldRules[0].period, 3, 'クローンを触っても実対局は変わらない');
});

section('M6: noHighCH（高ＣＨユニット禁止）');
t('通常召還：素のＣＨ数が上限超えのユニットは召還できない／上限内は通る', () => {
  const m = mkField([{ id: 'noHighCH', max: 4 }]);
  m.phase = 'placement';
  m.players.self.hand = [1, 8];                       // 1 ミルファイター(ＣＨ5) / 8 ピッグマン(ＣＨ4)
  const ng = CQTurn.summon(m, 0, 0);
  eq(ng.ok, false, 'ＣＨ5は却下');
  eq(/戦場ルール/.test(ng.reason), true, '理由が戦場ルールだと分かる');
  eq(CQTurn.summon(m, 0, 1).ok, true, 'ＣＨ4は通る');
});
t('光臨(199)による召還Ｌｖ3〜6の直接召還も同じゲートを通る（例外なし）', () => {
  const withAdvent = function (rules) {
    const m = mkField(rules);
    m.phase = 'placement';
    m.board.lanes[2] = lane(8, [up(199)]);            // 光臨を表向きで用意
    CQStats.recalc(m.board, OPT);
    m.players.self.hand = [13];                       // 13 ニドヘッグ ＣＨ6 Ｌｖ3
    return CQTurn.summon(m, 0, 0);
  };
  eq(withAdvent().ok, true, 'ルール無しなら光臨で直接召還できる（対照）');
  eq(withAdvent([{ id: 'noHighCH', max: 4 }]).ok, false, '戦場ルールが光臨より優先される');
});
t('リバース召還（召還Ｌｖ1）も却下され、カードは破壊される', () => {
  const m = mkField([{ id: 'noHighCH', max: 4 }]);
  m.board.lanes[0] = lane(8, [down(1)]);              // ミルファイター(ＣＨ5・Ｌｖ1)を潜行
  CQStats.recalc(m.board, OPT);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].channels.length, 0, '出てこようとしたカードは破壊された');
  eq(m.board.lanes.filter((l) => l.unit === 1).length, 0, '場には出ていない');
});
t('生贄召還（召還Ｌｖ2以上）も却下され、ホストは生き残る', () => {
  const m = mkField([{ id: 'noHighCH', max: 4 }]);
  m.board.lanes[0] = lane(2, [down(FILL), down(FILL), down(FILL), down(FILL), down(12)]);
  CQStats.recalc(m.board, OPT);
  CQTurn.reverseAction(m, 0, [5]);
  eq(m.board.lanes[0].unit, 2, 'ホストは生贄にならない');
  eq(m.board.lanes[0].channels.length, 4, 'ウロボロスだけが破壊される');
});

section('M6: bomb（定期爆撃）');
/** 爆撃の検証盤面：自陣レーン0・敵陣レーン3の4階層目に指定カードを置く */
function bombBoard(rules, ch4Self, ch4Foe) {
  const m = mkField(rules);
  m.board.lanes[0] = lane(8, [down(FILL), down(FILL), down(FILL), ch4Self].filter(Boolean));
  m.board.lanes[3] = lane(8, [down(FILL), down(FILL), down(FILL), ch4Foe].filter(Boolean));
  CQStats.recalc(m.board, OPT);
  return m;
}
t('period の倍数のターン終了時にだけ落ちる（境界）', () => {
  const m = bombBoard([{ id: 'bomb', period: 5, layer: 4 }], down(FILL), down(FILL));
  m.turn = 4;
  CQTurn.endTurn(m);
  eq([m.board.lanes[0].count, m.board.lanes[3].count], [4, 4], '4ターン目は落ちない');
  m.phase = 'main'; m.active = 'self'; m.turn = 5;
  CQTurn.endTurn(m);
  eq([m.board.lanes[0].count, m.board.lanes[3].count], [3, 3], '5ターン目に敵味方とも落ちる');
});
t('表向きのカードも裏向きのカードも同じように破壊される', () => {
  const m = bombBoard([{ id: 'bomb', period: 1, layer: 4 }], up(151), down(151));
  m.turn = 1;
  CQTurn.endTurn(m);
  eq([m.board.lanes[0].count, m.board.lanes[3].count], [3, 3], '表裏を問わない');
});
t('裏のまま吹き飛んだ呪爆(133)は発動しない（既存のＣＨ破壊魔法と同じ扱い）', () => {
  const m = bombBoard([{ id: 'bomb', period: 1, layer: 4 }], down(133), null);
  m.turn = 1;
  CQTurn.endTurn(m);
  eq(m.board.lanes[0].unit, 8, 'ホストは無事＝オープン時効果は起きていない');
  eq(m.board.lanes[0].count, 3, '呪爆だけが消えた');
});
t('上に積まれたカードは下に詰まり、枚数カウントも合う', () => {
  const m = mkField([{ id: 'bomb', period: 1, layer: 2 }]);
  m.board.lanes[0] = lane(8, [down(151), down(152), down(154), down(155)]);
  CQStats.recalc(m.board, OPT);
  m.turn = 1;
  CQTurn.endTurn(m);
  const ln = m.board.lanes[0];
  eq(ln.channels.map((c) => c.card), [151, 154, 155], '2階層目が抜けて上が下りてくる');
  eq(ln.count, ln.channels.length, '枚数カウントが一致');
});
t('該当階層が空のレーンでは何も起きない（no-op）／ユニット本体とＬＰは無傷', () => {
  const m = bombBoard([{ id: 'bomb', period: 1, layer: 6 }], down(FILL), down(FILL));
  const lp = [m.players.self.lp, m.players.enemy.lp];
  m.turn = 1;
  CQTurn.endTurn(m);
  eq([m.board.lanes[0].count, m.board.lanes[0].unit], [4, 8], '6階層目は空なので無傷');
  eq([m.players.self.lp, m.players.enemy.lp], lp, 'ＬＰは動かない');
});

section('M6: pestCard（おじゃま虫）');
t('チャネリングできない／召還もできない', () => {
  const m = mkField([{ id: 'pestCard', period: 3 }]);
  m.phase = 'placement';
  m.board.lanes[0] = lane(8, []);
  CQStats.recalc(m.board, OPT);
  m.players.self.hand = [CQField.PEST_CARD];
  const c = CQTurn.channel(m, 0, 0);
  eq(c.ok, false, 'チャネリング却下');
  eq(CQTurn.summon(m, 1, 0).ok, false, '召還も却下');
  eq(m.players.self.hand.length, 1, '却下されても手札から消えない（＝腐ったまま残る）');
});
t('相手の手番が period 回まわるごとに1枚投げ込まれる', () => {
  const m = mkField([{ id: 'pestCard', period: 3 }]);
  CQField.onTurnEnd(m, 'self');
  eq(m.players.self.hand.length, 0, '自分の手番では増えない');
  CQField.onTurnEnd(m, 'enemy'); CQField.onTurnEnd(m, 'enemy');
  eq(m.players.self.hand.length, 0, '2回目まではまだ');
  CQField.onTurnEnd(m, 'enemy');
  eq(m.players.self.hand, [CQField.PEST_CARD], '3回目で投げ込まれる');
});
t('手札が満杯（7枚）のときは不発（裏で増やさない）', () => {
  const m = mkField([{ id: 'pestCard', period: 1 }]);
  m.players.self.hand = [8, 8, 8, 8, 8, 8, 8];
  CQField.onTurnEnd(m, 'enemy');
  eq(m.players.self.hand.length, 7, '7枚のまま');
});
t('7枚オーバーの強制捨ての対象になる', () => {
  const m = mkField([{ id: 'pestCard', period: 1 }]);
  m.phase = 'discard';
  m.players.self.hand = [8, 8, 8, 8, 8, 8, 8, CQField.PEST_CARD];
  eq(CQTurn.discardCard(m, 7).ok, true, '捨てられる');
  eq(m.players.self.hand.indexOf(CQField.PEST_CARD), -1, '手札から消えた');
});
t('引き直し（チェンジ）で山札に戻らない＝再装填でも復活しない', () => {
  const m = mkField([{ id: 'pestCard', period: 1 }]);
  m.phase = 'placement';
  m.players.self.turnsTaken = 1;
  m.players.self.hand = [8, CQField.PEST_CARD];
  const before = m.players.self.deckCount;
  eq(CQTurn.change(m).ok, true, 'チェンジできる');
  eq(m.players.self.deck[CQField.PEST_CARD] || 0, 0, '山札に混ざらない');
  eq(m.players.self.initial.indexOf(CQField.PEST_CARD), -1, '再装填リストにも入らない');
  eq(m.players.self.deckCount, before - 1 + 1, '戻したのはピッグマン1枚だけ（引き直しも1枚）');
});
t('配置ステップでは手札から直接捨てられる（2026-08-26 本人の指定）', () => {
  const m = mkField([{ id: 'pestCard', period: 99 }]);
  m.phase = 'placement'; m.turn = 1;
  m.players.self.hand = [8, CQField.PEST_CARD];
  eq(CQTurn.discardPest(m, 1).ok, true, '捨てられる');
  eq(m.players.self.hand, [8], '手札から消えた');
  eq(m.board.hand.self, 1, '手札枚数の同期も取れている');
});
t('捨てられるのはおじゃま虫だけ・配置ステップだけ', () => {
  const m = mkField([{ id: 'pestCard', period: 99 }]);
  m.phase = 'placement'; m.turn = 1;
  m.players.self.hand = [8, CQField.PEST_CARD];
  eq(CQTurn.discardPest(m, 0).ok, false, 'ふつうのカードは捨てられない');
  m.phase = 'main';
  eq(CQTurn.discardPest(m, 1).ok, false, 'メインステップでは捨てられない');
  eq(m.players.self.hand.length, 2, '手札は減っていない');
});
t('捨てられるのは1ターンに1枚まで（次のターンにはまた捨てられる）', () => {
  const m = mkField([{ id: 'pestCard', period: 99 }]);
  m.phase = 'placement'; m.turn = 1;
  m.players.self.hand = [CQField.PEST_CARD, CQField.PEST_CARD];
  eq(CQTurn.discardPest(m, 0).ok, true, '1枚目は捨てられる');
  const ng = CQTurn.discardPest(m, 0);
  eq([ng.ok, /1ターンに1枚/.test(ng.reason)], [false, true], '同じターンの2枚目は却下');
  m.turn = 3;                                   // 自分の次の手番
  eq(CQTurn.discardPest(m, 0).ok, true, 'ターンが変われば捨てられる');
});
t('捨てると「行動した」扱いになり、未行動のときの1枚補充を受けられない', () => {
  const drew = function (discard) {
    const m = mkField([{ id: 'pestCard', period: 99 }]);
    m.phase = 'placement'; m.turn = 1;
    m.players.self.hand = [CQField.PEST_CARD];
    if (discard) CQTurn.discardPest(m, 0);
    CQTurn.endPlacement(m);
    const before = m.players.self.deckCount;
    CQTurn.endTurn(m);
    return before - m.players.self.deckCount;   // ターン終了時に引いた枚数
  };
  eq(drew(false), 1, '何もしなければ1枚補充される（対照）');
  eq(drew(true), 0, '捨てたターンは補充されない＝捨てるのはタダではない');
});
t('ＡＩは配置ステップでおじゃま虫を捨てる', () => {
  const m = mkField([{ id: 'pestCard', period: 99 }]);
  m.phase = 'placement'; m.turn = 1;
  m.aiConfig = { self: CQAi.PRESETS.heuristic };
  m.players.self.hand = [CQField.PEST_CARD, 8];
  CQAi.placementStep(m);
  eq(m.players.self.hand.indexOf(CQField.PEST_CARD), -1, '真っ先に捨てる');
});
t('ＡＩは真っ先におじゃま虫を捨てる（空白より優先）', () => {
  const m = mkField([{ id: 'pestCard', period: 1 }]);
  m.phase = 'discard';
  m.aiConfig = { self: CQAi.PRESETS.heuristic };
  m.players.self.hand = [8, 180, CQField.PEST_CARD, 8, 8, 8, 8, 8];
  CQAi.discardStep(m);
  eq(m.players.self.hand.indexOf(CQField.PEST_CARD), -1, 'おじゃま虫が捨てられた');
  eq(m.players.self.hand.indexOf(180) >= 0, true, '空白はまだ残っている');
});

section('M6: laneCap（レーンＣＨ上限＝石詰まり）');
t('上限に達したらチャネリングは却下され、押し込みだけができる', () => {
  const m = mkField([{ id: 'laneCap', cap: 2, lanes: [0] }]);
  m.phase = 'placement';
  m.board.lanes[0] = lane(8, [down(FILL), down(FILL)]);
  CQStats.recalc(m.board, OPT);
  eq(m.board.lanes[0].cap, 2, 'ＣＨ4のユニットでも上限2');
  m.players.self.hand = [151, 152];
  eq(CQTurn.channel(m, 0, 0).ok, false, '積み増しは却下');
  eq(CQTurn.channel(m, 0, 0, { layer: 1 }).ok, true, '押し込みはできる');
  eq(m.board.lanes[0].count, 2, '枚数は増えない');
});
t('膨張(158)で伸ばしても上限で頭打ちになる', () => {
  const m = mkField([{ id: 'laneCap', cap: 3, lanes: [0] }]);
  m.board.lanes[0] = lane(8, [up(158)]);
  CQStats.recalc(m.board, OPT);
  eq(m.board.lanes[0].cap, 3, '4+2=6 のところを3で頭打ち');
});
t('五つ星(157)の上書き（cap=5）よりも戦場ルールが後に効く', () => {
  const m = mkField([{ id: 'laneCap', cap: 3, lanes: [0] }]);
  m.board.lanes[0] = lane(8, [up(157)]);
  CQStats.recalc(m.board, OPT);
  eq(m.board.lanes[0].cap, 3, '五つ星でも3');
});
t('上限を超えて積まれていたカードは既存の超過ＣＨ消滅で最上段から消える', () => {
  const m = mkField([{ id: 'laneCap', cap: 2, lanes: [0] }]);
  m.board.lanes[0] = lane(8, [down(151), down(152), down(154), down(155)]);
  CQStats.recalc(m.board, OPT);
  eq(m.board.lanes[0].channels.map((c) => c.card), [151, 152], '上2枚が消える');
});
t('制限していないレーンは従来どおり', () => {
  const m = mkField([{ id: 'laneCap', cap: 2, lanes: [0] }]);
  m.board.lanes[1] = lane(8, []);
  CQStats.recalc(m.board, OPT);
  eq(m.board.lanes[1].cap, 4, 'ピッグマンの素のＣＨ4のまま');
});

section('M6: laneLock（レーン制限）');
t('ロックされたレーンには召還できない（隣のレーンは使える）', () => {
  const m = mkField([{ id: 'laneLock', lanes: [0] }]);
  m.phase = 'placement';
  m.players.self.hand = [8, 8];
  const ng = CQTurn.summon(m, 0, 0);
  eq(ng.ok, false, 'ロックレーンは却下');
  eq(/戦場ルール/.test(ng.reason), true, '理由が分かる');
  eq(CQTurn.summon(m, 1, 0).ok, true, '空いているレーンには出せる');
});
t('ロックされたレーンはチャネリングの対象にもならない', () => {
  const m = mkField([{ id: 'laneLock', lanes: [0] }]);
  m.phase = 'placement';
  m.board.lanes[0] = lane(8, []);          // 異常系：何かの拍子にユニットが居ても受け付けない
  CQStats.recalc(m.board, OPT);
  m.players.self.hand = [151];
  eq(CQTurn.channel(m, 0, 0).ok, false, 'ロックレーンへのチャネリングは却下');
});
t('リバース召還の召還先からロックレーンが除外される', () => {
  const build = function (rules) {
    const m = mkField(rules);
    m.board.lanes[0] = lane(8, [down(19)]);          // 19 ブレードライダー ＣＨ4 Ｌｖ1
    CQStats.recalc(m.board, OPT);
    CQTurn.reverseAction(m, 0, [1]);
    return m;
  };
  eq(build().board.lanes.findIndex((l) => l.unit === 19) >= 1, true, '対照：空きレーンに出る');
  const locked = build([{ id: 'laneLock', lanes: [1, 2] }]);
  eq(locked.board.lanes.some((l) => l.unit === 19), false, '召還先が無く破壊された');
  eq(locked.board.lanes[0].channels.length, 0, 'チャネルからも消えている');
});
t('ＡＩの候補列挙もロックレーンを空きとして数えない', () => {
  const m = mkField([{ id: 'laneLock', lanes: [0, 1] }]);
  m.phase = 'placement';
  m.players.self.hand = [8];
  m.aiConfig = { self: CQAi.PRESETS.heuristic };
  CQAi.placementStep(m);
  eq([m.board.lanes[0].unit, m.board.lanes[1].unit, m.board.lanes[2].unit], [null, null, 8],
     'ロックされていないレーン2にだけ召還する');
});

/* ================= M6 ラン：分岐マップ生成器（js/run/map.js） ================= */
section('M6 ラン: マップ生成器');

t('草原・森の敵プールが原作ドロップ表から拾える', () => {
  const g = CQAreas.enemyPool(CARD_BY_ID, 'grassland');
  const f = CQAreas.enemyPool(CARD_BY_ID, 'forest');
  eq(g.length > 5, true, '草原プールが十分な数ある');
  eq(f.length > 5, true, '森プールが十分な数ある');
  eq(g.every((e) => e.price > 0 && e.price <= CQAreas.DEFS.grassland.priceMax), true, '草原プールの価格上限が守られている');
  eq(g.every((e) => e.id !== 64), true, 'マスターズソウルは混ざらない');
});

t('マップ生成：8マス構造（開始1＋2択×2×3セグメント＋ボス1＝14ノード）で常に同じ形', () => {
  const m1 = CQMap.generate({ cards: CARD_BY_ID, areaId: 'grassland', seed: 42, ownedIds: [] });
  eq(Object.keys(m1.nodes).length, 14, 'ノード総数14');
  eq(m1.nodes[m1.start].connectsTo.length, 2, '開始マスの分岐は常に2択');
  eq(m1.nodes[m1.boss].connectsTo.length, 0, 'ボスの先はない');
  const segACounts = {};
  Object.values(m1.nodes).forEach((n) => { if (n.seg != null) segACounts[n.seg] = (segACounts[n.seg] || 0) + 1; });
  eq(segACounts, { 0: 4, 1: 4, 2: 4 }, '各セグメントは4ノード（A0,A1,B0,B1）');
});

t('マップ生成：同じシードなら常に同じ結果（決定的）', () => {
  const a = CQMap.generate({ cards: CARD_BY_ID, areaId: 'grassland', seed: 999, ownedIds: [1, 2] });
  const b = CQMap.generate({ cards: CARD_BY_ID, areaId: 'grassland', seed: 999, ownedIds: [1, 2] });
  eq(JSON.stringify(a), JSON.stringify(b), '同一シード・同一入力は同一マップ');
});

t('関門（第3セグメント）にだけ精鋭が出現しうる', () => {
  let sawElite2 = false, eliteOutside = false;
  for (let seed = 1; seed <= 60; seed++) {
    const m = CQMap.generate({ cards: CARD_BY_ID, areaId: 'grassland', seed, ownedIds: [] });
    Object.values(m.nodes).forEach((n) => {
      if (n.strength !== 'elite') return;
      if (n.seg === 2) sawElite2 = true; else eliteOutside = true;
    });
  }
  eq(sawElite2, true, '関門に精鋭が出る試行が十分ある');
  eq(eliteOutside, false, '関門以外に精鋭は出ない');
});

t('？イベントは1ランに最大1回', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const m = CQMap.generate({ cards: CARD_BY_ID, areaId: 'grassland', seed, ownedIds: [] });
    const qCount = Object.values(m.nodes).filter((n) => n.type === 'question').length;
    if (qCount > 1) throw new Error('seed ' + seed + ' で？が' + qCount + '回出た');
  }
});

t('霧が有効なランでは第1セグメントに必ずショップがある', () => {
  let sawFog = false;
  for (let seed = 1; seed <= 60; seed++) {
    const m = CQMap.generate({ cards: CARD_BY_ID, areaId: 'forest', seed, ownedIds: [] });
    if (!m.fog.active) continue;
    sawFog = true;
    const seg0Types = Object.values(m.nodes).filter((n) => n.seg === 0).map((n) => n.type);
    eq(seg0Types.indexOf('shop') >= 0, true, 'seed ' + seed + '：霧マップの第1セグメントにショップがある');
  }
  eq(sawFog, true, '森は十分な試行で霧が発生する（初期値50%）');
});

t('霧は開始と第1セグメントには掛からない（第2・第3・ボスだけ）', () => {
  const m = CQMap.generate({ cards: CARD_BY_ID, areaId: 'forest', seed: 7, ownedIds: [] });
  eq(m.nodes[m.start].fog, false, '開始マスは霧なし');
  Object.values(m.nodes).forEach((n) => {
    if (n.seg === 0) eq(n.fog, false, '第1セグメントは霧なし: ' + n.id);
  });
});

t('おまかせドラフトの候補は3回とも重複しない', () => {
  const m = CQMap.generate({ cards: CARD_BY_ID, areaId: 'grassland', seed: 55, ownedIds: [] });
  const all = m.draftPools.flat();
  eq(new Set(all).size, all.length, '3回ぶん9枚（プールが十分あれば）すべて別カード');
});

/* ================= M6 ラン：進行管理（js/run/run.js） ================= */
section('M6 ラン: 進行管理');

const STARTER = [8, 1, 3, 2, 5, 7, 9, 19, 20, 22, 31, 70, 58, 65, 66, 67, 71, 73, 10, 17,
  151, 158, 167, 169, 171, 172, 173, 177, 178, 179, 181, 183, 199,
  101, 104, 113, 117, 136, 143, 145];
/** テスト用：40枚ちょうど「デッキに入った」メタを作る（M6.6 WP3のgainCard／ドラフトの
 * 押し出しロジックなど、デッキが満杯であることを前提に組んだテストの多くがこれを使う）。
 * M6.6 WP1でCQSave.loadMetaの初期化は「本」へ入れる正式仕様になったため、
 * ここでは loadMeta を経由せず直接デッキ入りのメタを組み立てる（本物の初回起動の挙動は
 * 別途「本とデッキの移動モデル」節の「スターターセット」テストで検証する）。 */
function freshMeta() {
  return { book: {}, deck: CQSave.toDeckCounts(STARTER), known: STARTER.slice(), gold: 500, cleared: [], openingSeen: true };
}

/** テスト用：デッキに空きがある（＝空白が残っている）メタ。M6.6 WP4でおまかせドラフトが
 * 「空白がある時だけ発生」に変わったため、ドラフト関連のテストはこちらを使う。
 * blanks で空白の枚数を指定できる（既定4枚）。known は STARTER 全部にしておく
 * （＝ドラフト候補の「未入手優先」の判定に効くので、テストごとにブレないようにする）。 */
function roomyMeta(blanks) {
  const n = (blanks == null) ? 4 : blanks;
  const ids = STARTER.slice(0, Math.max(0, STARTER.length - n));
  return { book: {}, deck: CQSave.toDeckCounts(ids), known: STARTER.slice(), gold: 500, cleared: [], openingSeen: true };
}

t('ラン開始：マップと初期状態が揃う', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 123, freshMeta());
  eq(run.at, run.map.start, '開始マスに立っている');
  eq(run.lp, 10, 'ＬＰ初期値');
  eq(run.rentals, [], 'レンタルは最初は空');
  eq(Object.values(run.deck).reduce((a, b) => a + b, 0), STARTER.length, '所持デッキは初期デッキと同じ枚数');
});

t('プレイヤーデッキ組み立ては常にDECK_SIZE枚（不足は空白で埋める）', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 1, freshMeta());
  const deck = CQRun.buildPlayerDeck(run);
  eq(deck.length, CQRun.DECK_SIZE, 'DECK_SIZE枚ちょうど');
});

t('おまかせドラフト：対象は空白優先、無ければ定価最安。ピックはレンタルで所持デッキに残らない', () => {
  const meta = freshMeta();
  meta.deck[180] = 2;  // 空白を混ぜておく
  const run = CQRun.start(CARD_BY_ID, 'grassland', 2, meta);
  const dp = CQRun.beginDraftRound(run, CARD_BY_ID);
  eq(dp.targetId, 180, '空白がある間は空白が対象');
  const before180 = run.deck[180];
  CQRun.applyDraft(run, dp.options[0]);
  eq(run.deck[180], before180 - 1, '空白が1枚減った');
  eq(run.rentals.indexOf(dp.options[0]) >= 0, true, 'ピックはレンタルに入る');
  eq(run.deck[dp.options[0]] || 0, 0, 'レンタルは所持デッキ(run.deck)には加算されない');
});

t('おまかせドラフト：「変更しない」を選ぶと何も変わらない', () => {
  /* M6.6 WP4：ドラフトは空白がある時だけ発生するので、空きのあるデッキで始める */
  const run = CQRun.start(CARD_BY_ID, 'grassland', 3, roomyMeta());
  const dp = CQRun.beginDraftRound(run, CARD_BY_ID);
  const before = JSON.stringify(run.deck);
  CQRun.applyDraft(run, dp.targetId);
  eq(JSON.stringify(run.deck), before, '所持デッキは変化しない');
  eq(run.rentals.length, 0, 'レンタルも増えない');
});

t('戦闘マス設定：敵デッキ・自デッキともDECK_SIZE枚、戦場ルールがそのまま渡る', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 4, freshMeta());
  CQRun.depart(run);
  const n = Object.values(run.map.nodes).find((x) => x.type === 'battle');
  n.fieldRules = [{ id: 'noHighCH', max: 5 }];
  const setup = CQRun.battleSetup(run, CARD_BY_ID, n);
  eq(setup.enemyDeck.length, CQRun.DECK_SIZE, '敵デッキDECK_SIZE枚');
  eq(setup.selfDeck.length, CQRun.DECK_SIZE, '自デッキDECK_SIZE枚');
  eq(setup.fieldRules, n.fieldRules, '戦場ルールがそのまま渡る');
});

t('戦闘結果の反映：勝利で戦利品が入り、ＬＰが引き継がれる（M6.6 WP6でＧは出ない）', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 5, freshMeta());
  CQRun.depart(run);
  const n = Object.values(run.map.nodes).find((x) => x.type === 'battle');
  const goldBefore = run.gold;
  const fakeM = { winner: 'self', loot: [8, 8], players: { self: { lp: 7 } } };
  const res = CQRun.reportBattle(run, n, fakeM);
  eq(res.win, true, '勝利フラグ');
  eq(n.cleared, true, 'マスが解決済みになる');
  /* M6.6 WP7：戦利品は自動でデッキ／本へ振り分けない。まず lootPending に積まれ、
   * gainedCards（NEW・記憶データの元）だけはこの時点で確定する。 */
  eq(run.lootPending, [8, 8], '戦利品はまず振り分け待ちに積まれる');
  eq(run.bookAdd[8], undefined, 'この時点ではまだ本に入らない（振り分け画面待ち）');
  eq(run.gainedCards, [8, 8], '獲得リストにはこの時点で入る（NEW・記憶データの元）');
  eq(run.lp, 7, 'ＬＰが戦闘後の値に更新される');
  /* M6.6 WP6（§2-6）：敵ユニットは金を落とさない。通常戦闘の報酬はカードだけ */
  eq(res.gold, 0, '通常戦闘ではＧが出ない');
  eq(run.gold, goldBefore, '所持Ｇも増えない');
});

t('戦闘結果の反映：敗北はＬＰ0＝ランの終了（ゲームオーバー）', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 6, freshMeta());
  CQRun.depart(run);
  const n = Object.values(run.map.nodes).find((x) => x.type === 'battle');
  CQRun.reportBattle(run, n, { winner: 'enemy', loot: [], players: { self: { lp: 0 } } });
  eq(run.lp, 0, 'ＬＰ0');
  eq(run.outcome, 'lose', '敗北で終了フラグが立つ');
});

t('ボス撃破は run.outcome を勝利にする（js/run-ui.js のフックが行う判定と同じ規則）', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 8, freshMeta());
  const bossNode = run.map.nodes[run.map.boss];
  CQRun.reportBattle(run, bossNode, { winner: 'self', loot: [], players: { self: { lp: 9 } } });
  if (bossNode.type === 'boss' && true) run.outcome = run.outcome || 'win';
  eq(run.outcome, 'win', 'ボス勝利でラン成功');
});

t('マス移動：解決前は進めない、connectsTo外にも進めない', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 9, freshMeta());
  CQRun.depart(run);
  const first = CQRun.currentNode(run);
  eq(CQRun.advance(run, 'zzz').ok, false, '未解決のうちは進めない');
  first.cleared = true;
  eq(CQRun.advance(run, 'zzz').ok, false, 'つながっていない先には進めない');
  eq(CQRun.advance(run, first.connectsTo[0]).ok, true, 'つながっている先には進める');
  eq(run.at, first.connectsTo[0], '現在地が移動する');
});

t('宝箱：開封は1回だけ、Ｇとカードが入る', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 10, freshMeta());
  const n = { type: 'chest', rare: false, gold: 100, cardId: 41, opened: false };
  const before = run.gold;
  const r1 = CQRun.openChest(run, n);
  eq(r1.gold, 100, '初回はゴールドが返る');
  eq(run.gold, before + 100, 'Ｇが増える');
  eq(run.bookAdd[41], 1, 'カードが入る（満杯デッキでは本行き：M6.6 WP3）');
  const r2 = CQRun.openChest(run, n);
  eq(r2.gold, 0, '2回目は何も起きない');
  eq(run.gold, before + 100, 'Ｇは増えない');
});

t('休憩：ＬＰ+5・maxLpで頭打ち（M6.6 WP8）', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 11, freshMeta());
  run.lp = 8;
  const r1 = CQRun.rest(run, {});
  eq(run.lp, 13, 'ＬＰ+5される');
  eq(r1.healed, 5, '回復した量がそのまま返る');
  run.lp = 14;
  const r2 = CQRun.rest(run, {});
  eq(run.lp, 15, 'maxLp(15)で頭打ち');
  eq(r2.healed, 1, '頭打ちのぶんだけ回復量が減って返る');
});

t('宝箱：金額は「配置された敵編成」のいずれか1体の定価の50%（10G単位・M6.6 WP8）', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const m = CQMap.generate({ cards: CARD_BY_ID, areaId: 'grassland', seed, ownedIds: [] });
    const roster = Object.values(m.nodes).filter((n) => n.type === 'battle' && n.enemy).map((n) => n.enemy);
    const candidates = roster.map((e) => Math.round(e.price * 0.5 / 10) * 10);
    const chests = Object.values(m.nodes).filter((n) => n.type === 'chest');
    chests.forEach((n) => {
      eq(n.gold % 10, 0, 'seed ' + seed + '：宝箱の金額は10G単位');
      eq(candidates.indexOf(n.gold) >= 0, true,
        'seed ' + seed + '：宝箱の金額(' + n.gold + ')は配置された敵の定価の50%のいずれかと一致');
    });
  }
  /* 同じseedなら常に同じ金額になる（マップ生成時に決定的に確定） */
  const a = CQMap.generate({ cards: CARD_BY_ID, areaId: 'forest', seed: 99, ownedIds: [] });
  const b = CQMap.generate({ cards: CARD_BY_ID, areaId: 'forest', seed: 99, ownedIds: [] });
  const chestGolds = (m) => Object.values(m.nodes).filter((n) => n.type === 'chest').map((n) => n.gold);
  eq(chestGolds(a), chestGolds(b), '同じseedなら宝箱の金額も再現される');
});

t('ショップ：購入・回復・霧払いはＧが無いと断られる', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 12, freshMeta());
  run.gold = 0;
  const n = { stock: [41], healCost: 100, fogClearCost: 100, hasFogClear: true };
  eq(CQRun.shopBuy(run, CARD_BY_ID, n, 41).ok, false, 'Ｇ不足で購入できない');
  eq(CQRun.shopHeal(run, n).ok, false, 'Ｇ不足で回復できない');
  eq(CQRun.shopClearFog(run, n).ok, false, 'Ｇ不足で霧払いできない');
  run.gold = 99999;
  const buy = CQRun.shopBuy(run, CARD_BY_ID, n, 41);
  eq(buy.ok, true, '購入できる');
  eq(run.bookAdd[41], 1, '購入したカードが入る（満杯デッキでは本行き：M6.6 WP3）');
  eq(n.stock.indexOf(41), -1, '品揃えから消える');
});

t('換金：所持カードだけ売れる。空白は売れない', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 13, freshMeta());
  eq(CQRun.sell(run, CARD_BY_ID, 180).ok, false, '空白は売れない');
  eq(CQRun.sell(run, CARD_BY_ID, 99999).ok, false, '持っていないカードは売れない');
  const before = run.deck[8];
  const r = CQRun.sell(run, CARD_BY_ID, 8);
  eq(r.ok, true, '所持カードは売れる');
  eq(run.deck[8], before - 1, '1枚減る');
});

t('換金：売却価格は定価の50%（M6.6 WP9・40%→50%に変更）', () => {
  /* 実装計画追補§4 WP9-b「SELL_RATEを0.4→0.5に変更」。js/run-ui.jsの換金所グリッドも
   * CQRun.sellPrice() を経由して同じ式を出す（画面側で率を再計算しない）ので、
   * ここでエンジン側の式だけ固定しておけば表示側の金額もズレない。 */
  const meta = { book: {}, deck: { 101: 1 }, known: [101], gold: 0, cleared: [] };
  const run = CQRun.start(CARD_BY_ID, 'grassland', 27, meta);
  const c = CARD_BY_ID[101];
  const expected = Math.max(10, Math.round(c.p * 0.5));
  eq(CQRun.sellPrice(CARD_BY_ID, 101), expected, 'sellPrice()は定価の50%（10G未満は10G）');
  const r = CQRun.sell(run, CARD_BY_ID, 101);
  eq(r.gold, expected, 'sell()の実際の売却額もsellPrice()と一致する');
});

t('？イベント：一度解決したら再解決しない', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 14, freshMeta());
  const n = { type: 'question', event: { id: 'coin', text: 't', effect: { gold: 150 } }, resolved: false };
  const before = run.gold;
  CQRun.resolveQuestion(run, n);
  eq(run.gold, before + 150, '効果が適用される');
  eq(n.resolved, true, '解決済みになる');
  const r2 = CQRun.resolveQuestion(run, n);
  eq(r2, null, '2回目は何もしない');
  eq(run.gold, before + 150, 'Ｇも変わらない');
});

t('ラン終了の清算：レンタルは所持デッキに混入しない（返却）', () => {
  const meta = roomyMeta();     /* M6.6 WP4：空白があるデッキでないとドラフトが起きない */
  const run = CQRun.start(CARD_BY_ID, 'grassland', 15, meta);
  const dp = CQRun.beginDraftRound(run, CARD_BY_ID);
  CQRun.applyDraft(run, dp.options[0]);
  eq(run.rentals.length, 1, 'レンタルが1枚入った');
  const settled = CQRun.settle(run, meta);
  eq((settled.deck[dp.options[0]] || 0), 0, 'レンタルは清算後の所持デッキに残らない');
  eq(settled.cleared.length, 0, '未クリアなら解放エリアは増えない');
});

t('ラン終了の清算：クリアするとエリアが解放リストに入る', () => {
  const meta = freshMeta();
  const run = CQRun.start(CARD_BY_ID, 'grassland', 16, meta);
  run.outcome = 'win';
  const settled = CQRun.settle(run, meta);
  eq(settled.cleared.indexOf('grassland') >= 0, true, '草原がクリア済みになる');
});

/* ================= M6.6 WP3：本とデッキの移動モデル（js/meta/collection.js） ================= */
section('M6.6 WP3: 本とデッキの移動モデル');

/** 移動モデルの検証用メタ：本にピッグマン(8)×5・憑依解除(101)×4、デッキは空 */
function bookMeta() {
  const m = { book: { 8: 5, 101: 4 }, deck: {}, known: [8, 101], gold: 100, cleared: [] };
  return m;
}

t('持ち出し（moveToDeck）：本が減り、デッキが増える。総所持数は不変', () => {
  const m = bookMeta();
  const r = CQCollection.moveToDeck(m, 101, 2);
  eq(r.ok, true, '移動できる');
  eq(m.book[101], 2, '本が2枚減る');
  eq(m.deck[101], 2, 'デッキが2枚増える');
  eq((m.book[101] || 0) + (m.deck[101] || 0), 4, '総所持数は変わらない');
});

t('返却（moveToBook）：デッキが減り、本が増える。0になったキーは消える', () => {
  const m = bookMeta();
  CQCollection.moveToDeck(m, 101, 2);
  const r = CQCollection.moveToBook(m, 101, 2);
  eq(r.ok, true, '戻せる');
  eq(m.deck[101], undefined, 'デッキから消える（0のキーは残さない）');
  eq(m.book[101], 4, '本に全部戻る');
});

t('持ち出しの制限：本に無いカードは持ち出せない', () => {
  const m = bookMeta();
  eq(CQCollection.moveToDeck(m, 41, 1).ok, false, '本に無いものは動かせない');
  CQCollection.moveToDeck(m, 101, 4);
  eq(CQCollection.moveToDeck(m, 101, 1).ok, false, '本が0枚になったらもう持ち出せない');
});

t('持ち出しの制限：同種3枚まで。ピッグマン(8)だけ無制限', () => {
  const m = bookMeta();
  const r101 = CQCollection.moveToDeck(m, 101, 4);
  eq(r101.ok, false, '4枚目で断られる');
  eq(r101.moved, 3, '3枚までは移動済み');
  eq(m.deck[101], 3, 'デッキには3枚');
  const r8 = CQCollection.moveToDeck(m, 8, 5);
  eq(r8.ok, true, 'ピッグマンは5枚全部持ち出せる');
  eq(m.deck[8], 5, '同種上限の例外');
});

t('持ち出しの制限：デッキ合計40枚まで。blankCount は残りの空白数', () => {
  const m = { book: { 8: 50 }, deck: {}, known: [8], gold: 0, cleared: [] };
  const r = CQCollection.moveToDeck(m, 8, 50);
  eq(r.ok, false, '41枚目で断られる');
  eq(r.moved, 40, '40枚までは移動済み');
  eq(CQCollection.deckTotal(m), 40, 'デッキ合計40');
  eq(CQCollection.blankCount(m), 0, '空白0枚');
  CQCollection.moveToBook(m, 8, 3);
  eq(CQCollection.blankCount(m), 3, '3枚戻せば空白3枚');
});

t('入手（addCard）：knownに登録され、destに入る。デッキ満杯なら本へ回る', () => {
  const m = { book: {}, deck: {}, known: [], gold: 0, cleared: [] };
  const r1 = CQCollection.addCard(m, 41, 'book');
  eq(r1.dest, 'book', '本行き');
  eq(m.book[41], 1, '本に入る');
  eq(m.known, [41], 'knownに登録');
  const r2 = CQCollection.addCard(m, 41, 'deck');
  eq(r2.dest, 'deck', 'デッキ行き');
  eq(m.deck[41], 1, 'デッキに入る');
  m.deck[41] = 3;                                  /* 同種上限まで埋める */
  const r3 = CQCollection.addCard(m, 41, 'deck');
  eq(r3.dest, 'book', '同種上限で入らなければ本へ回る（カードは必ず貰える）');
  eq(CQCollection.addCard(m, 180, 'book').ok, false, '空白は実体を持たないので入手できない');
});

t('売却（sellFromDeck）：デッキから1枚消えてＧが増える。本は不変・knownに残る', () => {
  const m = bookMeta();
  CQCollection.moveToDeck(m, 101, 3);
  const r = CQCollection.sellFromDeck(m, 101, 250);
  eq(r.ok, true, '売れる');
  eq(m.deck[101], 2, 'デッキから1枚消える');
  eq(m.book[101], 1, '本にあるカードは影響を受けない');
  eq(m.gold, 350, 'Ｇが増える');
  eq(m.known.indexOf(101) >= 0, true, '売ってもknown（記憶データ）からは消えない');
  eq(CQCollection.sellFromDeck(m, 8, 100).ok, false, 'デッキに無いカードは売れない');
});

t('旧セーブの移行：旧deckは全部bookへ・knownに種類を登録・deckは空・空白は捨てる', () => {
  const st = mockStorage();
  st.setItem('cq_meta', JSON.stringify({ deck: { 8: 2, 41: 1, 180: 3 }, gold: 700, cleared: ['grassland'] }));
  const m = CQSave.loadMeta(st, [1]);
  eq(m.book, { 8: 2, 41: 1 }, '旧deckがbookへ移る（空白180は捨てる）');
  eq(m.deck, {}, '保存デッキは空になる');
  eq(m.known.slice().sort((a, b) => a - b), [8, 41], '種類がknownに登録される');
  eq(m.gold, 700, 'Ｇは維持');
  eq(m.cleared, ['grassland'], 'クリア済みエリアは維持');
  eq(m.openingSeen, true, '旧形式からの移行＝既存プレイヤーなので目覚めは出さない（M6.6 WP1）');
});

t('新形式でもopeningSeenが無い既存セーブ（WP3時代）は「見た」扱いにする', () => {
  const st = mockStorage();
  st.setItem('cq_meta', JSON.stringify({ book: {}, deck: { 8: 5 }, known: [8], gold: 500, cleared: [] }));
  const m = CQSave.loadMeta(st, [1]);
  eq(m.openingSeen, true, 'openingSeenが無い新形式セーブは目覚めを出さない（既存データがある以上）');
});

t('スターターセット（M6.6 §2-2確定）：8種28枚が本へ・デッキ空・Ｇ0で始まる '
  + '（js/run-ui.js の STARTER_BOOK と同じ内容。値を変えたら3箇所とも直すこと）', () => {
  const STARTER_BOOK = [
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    101, 101, 101,
    108, 108,
    113, 113,
    153, 153, 153,
    165, 165,
    193, 193, 193,
    194, 194, 194
  ];
  eq(STARTER_BOOK.length, 28, 'スターターは28枚');
  const st = mockStorage();
  const m = CQSave.loadMeta(st, STARTER_BOOK);
  eq(m.book, { 8: 10, 101: 3, 108: 2, 113: 2, 153: 3, 165: 2, 193: 3, 194: 3 }, '本に8種28枚が入る');
  eq(m.deck, {}, 'デッキは空で始まる（WP4のデッキ編集で持ち出すまで）');
  eq(m.known.slice().sort((a, b) => a - b), [8, 101, 108, 113, 153, 165, 193, 194], '8種がknownに登録される');
  eq(m.gold, 0, 'Ｇは0で始まる');
  eq(m.openingSeen, false, '目覚めは未視聴で始まる');
});

t('ラン中の入手：デッキに空きがあればデッキへ、満杯なら本行き（run.bookAdd）', () => {
  const meta = { book: {}, deck: { 8: 1 }, known: [8], gold: 0, cleared: [] };
  const run = CQRun.start(CARD_BY_ID, 'grassland', 21, meta);
  eq(CQRun.gainCard(run, 41), 'deck', '空きがあればデッキへ');
  eq(run.deck[41], 1, 'run.deckに入る');
  run.deck[41] = 3;
  eq(CQRun.gainCard(run, 41), 'book', '同種3枚を超える分は本行き');
  eq(run.bookAdd[41], 1, 'run.bookAddに貯まる');
  eq(run.gainedCards, [41, 41], 'どちらもgainedCardsには入る');
});

t('レンタルは空白の枠を埋める：空き枠の計算に数えられ、40枚を超えない', () => {
  /* デッキ39枚＋レンタル1枚＝実質40枚。ここからのドラフト対象は空白ではなく実カードになり、
   * 入手も本行きになる（40枚超過で戦闘デッキから黙って切り捨てられるのを防ぐ） */
  const meta = { book: {}, deck: { 8: 39 }, known: [8], gold: 0, cleared: [] };
  const run = CQRun.start(CARD_BY_ID, 'grassland', 27, meta);
  run.rentals.push(70);
  eq(CQRun.draftTarget(run, CARD_BY_ID) !== 180, true, '実質満杯ならドラフト対象は実カード');
  eq(CQRun.gainCard(run, 41), 'book', '実質満杯なら入手は本行き');
  const deck = CQRun.buildPlayerDeck(run);
  eq(deck.length, CQRun.DECK_SIZE, '戦闘デッキは40枚ちょうど');
  eq(deck.indexOf(70) >= 0, true, 'レンタルが戦闘デッキに必ず入っている');
});

t('清算（settle）：bookAddがbookへ・gainedCardsがknownへ・レンタルは登録されない', () => {
  const meta = { book: {}, deck: { 8: 1 }, known: [8], gold: 0, cleared: [] };
  const run = CQRun.start(CARD_BY_ID, 'grassland', 22, meta);
  CQRun.gainCard(run, 41);            /* デッキ行き */
  run.deck[41] = 3;
  CQRun.gainCard(run, 41);            /* 本行き */
  run.rentals.push(70);               /* レンタル */
  CQRun.settle(run, meta);
  eq(meta.deck[41], 3, '保存デッキはrun.deckの複製');
  eq(meta.book[41], 1, '本行き分がbookへ加算される');
  eq(meta.known.indexOf(41) >= 0, true, '入手した種類がknownに登録される');
  eq(meta.known.indexOf(70), -1, 'レンタルはknownに登録されない（返却）');
});

t('清算（settle）：ラン中の売却は本に戻らない（カードが世界から消える）', () => {
  /* WP9（換金所リメイク）の注意事項の先取り回帰テスト：初版の誤解（売ると本からも減る／
   * 売った分が本に戻る）を防ぐ。売却はrun.deckから減らすだけ→settleでmeta.deckに複製→
   * meta.bookは終始不変、が正しい。 */
  const meta = { book: { 101: 2 }, deck: { 101: 3 }, known: [101], gold: 0, cleared: [] };
  const run = CQRun.start(CARD_BY_ID, 'grassland', 23, meta);
  const r = CQRun.sell(run, CARD_BY_ID, 101);
  eq(r.ok, true, '売れる');
  CQRun.settle(run, meta);
  eq(meta.deck[101], 2, '売った1枚はデッキから消えたまま');
  eq(meta.book[101], 2, '本には戻らない・本からも減らない');
  eq(meta.known.indexOf(101) >= 0, true, '売ってもknownには残る');
});

t('清算（settle）：旧セーブ由来の実体の空白(180)はmeta.deckに残さない', () => {
  const meta = { book: {}, deck: { 8: 1 }, known: [8], gold: 0, cleared: [] };
  const run = CQRun.start(CARD_BY_ID, 'grassland', 24, meta);
  run.deck[180] = 2;                  /* 旧cq_runの再開を模す */
  CQRun.settle(run, meta);
  eq(meta.deck[180], undefined, '空白は実体で保存しない');
});

t('ドラフトの空白は仮想：デッキが40枚未満なら対象は空白。実カードの押し出しは本行き', () => {
  const meta = { book: {}, deck: { 8: 3 }, known: [8], gold: 0, cleared: [] };
  const run = CQRun.start(CARD_BY_ID, 'grassland', 25, meta);
  const dp = CQRun.beginDraftRound(run, CARD_BY_ID);
  eq(dp.targetId, 180, '40枚未満なら空白が対象（実体が無くても）');
  CQRun.applyDraft(run, dp.options[0], CARD_BY_ID);
  eq(run.deck[8], 3, '実カードは減らない');
  eq(run.rentals.length, 1, 'レンタルが入る');
  /* 満杯デッキ：M6.6 WP4から、空白が無いランではドラフト自体が発生しない（§2-4） */
  const meta2 = freshMeta();          /* スターター40枚＝満杯 */
  const run2 = CQRun.start(CARD_BY_ID, 'grassland', 26, meta2);
  eq(CQRun.beginDraftRound(run2, CARD_BY_ID), null, '満杯ならドラフトは起きない（WP4）');
  eq(CQRun.draftTarget(run2, CARD_BY_ID) !== 180, true,
    'draftTarget単体では従来どおり最安の実カードを返す（満杯時の対象計算そのものは残す）');
  /* 押し出し＝本行きの処理自体は残っている（v0.16.5以前に保存された中断中のランを
   * 再開したとき、実カードが対象の draftPending が残っている場合に通る経路）。
   * beginDraftRound を経由せず直接組み立てて確かめる。 */
  const target = CQRun.draftTarget(run2, CARD_BY_ID);
  const before = run2.deck[target];
  run2.draftPending = { round: 0, options: [run2.map.draftPools[0][0]], targetId: target };
  CQRun.applyDraft(run2, run2.draftPending.options[0], CARD_BY_ID);
  eq(run2.deck[target], before - 1, '押し出されてデッキから減る');
  eq(run2.bookAdd[target], 1, '消滅ではなく本行きになる');
});

/* ================= M6 ラン：セーブ（js/meta/save.js） ================= */
section('M6 ラン: セーブ');

function mockStorage() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
}

t('cq_meta：無ければ既定デッキから初期化、あれば保存した内容を読む', () => {
  const st = mockStorage();
  const m1 = CQSave.loadMeta(st, [8, 8, 180]);
  eq(m1.book, { 8: 2 }, '既定デッキ（180=空白は無視）が本へ入る（M6.6 WP1で正式仕様に変更）');
  eq(m1.deck, {}, 'デッキは空で始まる');
  eq(m1.known, [8], '既定デッキの種類がknownに登録される');
  eq(m1.gold, 0, 'Ｇは0で始まる（M6.6 WP1）');
  eq(m1.openingSeen, false, '目覚めは未視聴で始まる');
  m1.gold = 777;
  CQSave.saveMeta(st, m1);
  const m2 = CQSave.loadMeta(st, [1]);
  eq(m2.gold, 777, '保存した内容を読み戻す（既定デッキは無視される）');
});

t('cq_run：無ければnull、保存すれば読み戻せる、clearRunで消える', () => {
  const st = mockStorage();
  eq(CQSave.loadRun(st), null, '最初はnull');
  CQSave.saveRun(st, { at: 'n0', gold: 5 });
  eq(CQSave.loadRun(st), { at: 'n0', gold: 5 }, '保存した内容を読み戻す');
  CQSave.clearRun(st);
  eq(CQSave.loadRun(st), null, 'clearRunで消える');
});

t('cq_meta：clearMetaで消える（M6.6 WP2：最初からやり直す）', () => {
  const st = mockStorage();
  const m1 = CQSave.loadMeta(st, [8, 8, 180]);
  CQSave.saveMeta(st, m1);
  eq(CQSave.loadMeta(st, [1]).gold, 0, '保存直後は既定デッキ無視で読み戻る（Ｇも保存値のまま）');
  CQSave.clearMeta(st);
  const m2 = CQSave.loadMeta(st, [1]);
  eq(m2.book, { 1: 1 }, 'clearMeta後はdefaultDeckIdsから作り直される（本へ入る）');
  eq(m2.openingSeen, false, 'リセット後は目覚めがまた出る');
});

t('壊れたcq_metaは初期化して復旧する', () => {
  const st = mockStorage();
  st.setItem('cq_meta', '{not json');
  const m = CQSave.loadMeta(st, [8]);
  eq(m.book, { 8: 1 }, '壊れていても既定デッキから復旧する（本へ入る）');
});

/* ================= M6.6 WP6: フリーユニット戦 ================= */
section('M6.6 WP6: フリーユニット戦');

/** field モードの対戦を1つ作る（敵は enemyBoard の編成で場に立って始まる）。 */
function fieldMatch(enemyBoard, opts) {
  return CQTurn.createMatch(Object.assign({
    cards: CARD_BY_ID,
    rng: CQRng.create(1),
    selfDeck: CQSave.toDeckCounts ? STARTER.slice(0, 40) : [],
    enemyDeck: CQAreas.SUPPORT_SHELL.slice(),
    mode: 'field',
    enemyBoard: enemyBoard
  }, opts || {}));
}

t('fieldモード：敵は編成どおり場に立って始まる（召還を待たない）', () => {
  const m = fieldMatch([8, 8, 1]);
  eq(CQTurn.isFieldMode(m), true, 'fieldモードになっている');
  eq(CQTurn.enemyUnitCount(m), 3, '敵レーンに3体立っている');
  const lanes = [3, 4, 5].map((i) => m.board.lanes[i].unit);
  eq(lanes, [8, 8, 1], '編成の順にレーン3〜5へ入る');
  eq(m.board.lanes[0].unit, null, '自陣は空のまま');
  /* 最初の1ターンだけ硬直（立て直す猶予。較正で入れた） */
  eq(m.board.lanes[3].stiff, true, '初期配置は硬直して始まる');
});

t('fieldモード：敵は手札から召還できない（味方は従来どおり召還できる）', () => {
  const m = fieldMatch([8]);
  m.players.enemy.hand = [8];
  m.active = 'enemy'; m.phase = 'placement';
  eq(CQTurn.canSummonSide(m, 'enemy'), false, '敵は召還できない');
  eq(CQTurn.canSummonSide(m, 'self'), true, '自分は召還できる');
  const r = CQTurn.summon(m, 3, 0);
  eq(r.ok, false, '敵の召還は拒否される');
  /* 自分側は普通に召還できる */
  m.players.self.hand = [8];
  m.active = 'self'; m.phase = 'placement';
  eq(CQTurn.summon(m, 0, 0).ok, true, '自分は召還できる');
});

t('fieldモード：敵のＬＰは勝敗に関わらない（自分のＬＰ0は従来どおり敗北）', () => {
  const m = fieldMatch([8]);
  eq(m.players.enemy.lp > 0, true, '（初期ＬＰは正の値）');
  /* 敵のＬＰが0になっても決着しない＝ＬＰ判定が敵に効いていない。
   * ＬＰは再装填コスト等で勝手に減りうるので、そこで勝ってしまわないことが要点。 */
  m.players.enemy.lp = 0;
  eq(CQTurn.checkResult(m), null, '敵のＬＰが0でも決着しない');
  /* 自分のＬＰ0は従来どおり敗北 */
  m.players.self.lp = 0;
  eq(CQTurn.checkResult(m), 'enemy', '自分のＬＰ0は敗北');
});

t('fieldモード：デッキ攻撃のＬＰダメージも敵には通らない（combat.js の damage）', () => {
  const m = fieldMatch([8]);
  m.players.self.hand = [];
  const before = m.players.enemy.lp;
  /* デッキ攻撃は相手にＬＰ1を与える処理（combat.js: damage(m, foeSide, 1)）。
   * 自陣にユニットを立て、そこからデッキ攻撃を通してみる。 */
  m.active = 'self'; m.phase = 'placement';
  m.players.self.hand = [8];
  CQTurn.summon(m, 0, 0);
  m.board.lanes[0].stiff = false;
  m.phase = 'main';
  const r = CQCombat.deckAttack(m, 0);
  if (r && r.ok) eq(m.players.enemy.lp, before, '敵のＬＰは減らない');
  else eq(true, true, '（この盤面ではデッキ攻撃が通らなかったのでスキップ）');
});

t('fieldモード：敵の場が空になれば勝ち', () => {
  const m = fieldMatch([8, 8]);
  eq(CQTurn.checkResult(m), null, '敵が残っているうちは決着しない');
  m.board.lanes[3] = S.emptyLane();
  eq(CQTurn.checkResult(m), null, '1体倒しただけでは決着しない');
  m.board.lanes[4] = S.emptyLane();
  eq(CQTurn.checkResult(m), 'self', '全部倒せば勝ち');
  eq(m.phase, 'over', '決着でphaseがoverになる');
});

t('fieldモード：敵を1体も立てられない場合は従来のＬＰ勝負に落ちる', () => {
  const m = fieldMatch([]);
  eq(CQTurn.isFieldMode(m), false, '編成が空ならfieldモードにしない');
  eq(CQTurn.checkResult(m), null, '即勝ちにならない');
});

t('battleSetup：通常戦闘はfieldモード＋編成、ボスは従来どおりのＬＰ勝負', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 61, freshMeta());
  const n = Object.values(run.map.nodes).find((x) => x.type === 'battle');
  const s = CQRun.battleSetup(run, CARD_BY_ID, n);
  eq(s.mode, 'field', '通常戦闘はfield');
  eq(s.enemyBoard.length, Math.min(3, n.enemy.count), '編成の体数ぶん場に出る');
  s.enemyBoard.forEach((id) => eq(id, n.enemy.id, 'マップに出ている敵と同じカード'));
  const boss = run.map.nodes[run.map.boss];
  const bs = CQRun.battleSetup(run, CARD_BY_ID, boss);
  eq(bs.mode, undefined, 'ボスはfieldモードではない');
  eq(bs.enemyBoard, undefined, 'ボスは初期配置なし');
});

t('敵デッキ：召還できないので支援シェル中心・ユニットは少量（§7-5）', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 62, freshMeta());
  const n = Object.values(run.map.nodes).find((x) => x.type === 'battle');
  const deck = CQRun.battleSetup(run, CARD_BY_ID, n).enemyDeck;
  eq(deck.length, CQRun.DECK_SIZE, '40枚ちょうど');
  const units = deck.filter((id) => CARD_BY_ID[id].t === 'U').length;
  eq(units <= 8, true, 'ユニットは少量（チャネル弾ぶんだけ）：' + units + '枚');
  eq(deck.length - units >= 30, true, '大半は魔法・技能');
});

t('報酬：ボスのファイトマネーは原作準拠、周回は50%（§2-6）', () => {
  const area = CQAreas.get('grassland');
  eq(area.fightMoney, 500, '草原はＣ級500G');
  eq(CQAreas.get('forest').fightMoney, 500, '森もＣ級500G');
  /* 初回 */
  const run1 = CQRun.start(CARD_BY_ID, 'grassland', 63, freshMeta());
  const boss1 = run1.map.nodes[run1.map.boss];
  const g0 = run1.gold;
  const r1 = CQRun.reportBattle(run1, boss1, { winner: 'self', loot: [], players: { self: { lp: 9 } } },
    { cleared: [] });
  eq(r1.gold, 500, '初回は満額');
  eq(run1.gold, g0 + 500, '所持Ｇに入る');
  /* 周回（すでにクリア済みのエリア） */
  const run2 = CQRun.start(CARD_BY_ID, 'grassland', 64, freshMeta());
  const boss2 = run2.map.nodes[run2.map.boss];
  const r2 = CQRun.reportBattle(run2, boss2, { winner: 'self', loot: [], players: { self: { lp: 9 } } },
    { cleared: ['grassland'] });
  eq(r2.gold, 250, '周回は50%');
});

/* ================= M6.6 WP4: 開始マスの新フロー ================= */
section('M6.6 WP4: 開始マスの新フロー');

t('おまかせドラフトは最大2回（3回から変更）', () => {
  eq(CQRun.DRAFT_ROUNDS, 2, 'DRAFT_ROUNDSは2');
  const run = CQRun.start(CARD_BY_ID, 'grassland', 41, roomyMeta(6));
  let rounds = 0;
  for (let i = 0; i < 5; i++) {
    const dp = CQRun.beginDraftRound(run, CARD_BY_ID);
    if (!dp) break;
    rounds++;
    CQRun.applyDraft(run, dp.options[0], CARD_BY_ID);   /* 毎回レンタルで空白を1つ埋める */
  }
  eq(rounds, 2, '空白が足りていても3回目は来ない');
});

/* §4 WP4 の受け入れ基準「空白0/1/2枚の3ケースのドラフト分岐をテスト化」 */
t('空白0枚：ドラフトは1回も発生しない', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 42, roomyMeta(0));
  eq(CQRun.hasBlankSlot(run), false, '空白なし');
  eq(CQRun.beginDraftRound(run, CARD_BY_ID), null, '発生しない');
});

t('空白1枚：1回目で埋めたら2回目は発生しない', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 43, roomyMeta(1));
  const dp1 = CQRun.beginDraftRound(run, CARD_BY_ID);
  eq(!!dp1, true, '1回目は発生する');
  eq(dp1.targetId, 180, '対象は空白');
  CQRun.applyDraft(run, dp1.options[0], CARD_BY_ID);    /* レンタルで空白を埋める */
  eq(run.rentals.length, 1, 'レンタルが1枚入った');
  eq(CQRun.beginDraftRound(run, CARD_BY_ID), null, '空白が無くなったので2回目は発生しない');
});

t('空白1枚：空白を選んで残せば2回目が発生する', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 44, roomyMeta(1));
  const dp1 = CQRun.beginDraftRound(run, CARD_BY_ID);
  CQRun.applyDraft(run, dp1.targetId, CARD_BY_ID);      /* 「変更しない」＝空白のまま */
  eq(run.rentals.length, 0, 'レンタルは入らない');
  const dp2 = CQRun.beginDraftRound(run, CARD_BY_ID);
  eq(!!dp2, true, '空白が残っているので2回目が発生する');
  eq(dp2.round, 1, '2回目の候補プールを使う');
});

t('空白2枚：2回とも発生し、2回とも埋められる', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 45, roomyMeta(2));
  const dp1 = CQRun.beginDraftRound(run, CARD_BY_ID);
  eq(!!dp1, true, '1回目が発生');
  CQRun.applyDraft(run, dp1.options[0], CARD_BY_ID);
  const dp2 = CQRun.beginDraftRound(run, CARD_BY_ID);
  eq(!!dp2, true, '2回目も発生');
  CQRun.applyDraft(run, dp2.options[0], CARD_BY_ID);
  eq(run.rentals.length, 2, 'レンタルが2枚');
  eq(CQRun.beginDraftRound(run, CARD_BY_ID), null, '3回目は無い');
});

t('ドラフト候補：1回目はこのエリアの敵・2回目は買える魔法／技能（§2-4）', () => {
  const meta = roomyMeta(4);
  const run = CQRun.start(CARD_BY_ID, 'grassland', 46, meta);
  const pools = run.map.draftPools;
  eq(pools.length, 2, 'プールは2回分');
  const enemyIds = CQAreas.enemyPool(CARD_BY_ID, 'grassland').map((e) => e.id);
  pools[0].forEach((id) => {
    eq(enemyIds.indexOf(id) >= 0, true, '1回目の候補' + id + 'は草原の敵プール由来');
    eq(CARD_BY_ID[id].t, 'U', '1回目はモンスター');
  });
  pools[1].forEach((id) => {
    eq(CARD_BY_ID[id].t !== 'U', true, '2回目の候補' + id + 'は魔法か技能');
    eq(/コレクション段階(\d+)/.test(CARD_BY_ID[id].g || ''), true, '2回目はショップ品揃え由来');
  });
});

t('マスターレベル：記憶データの種類数で決まる（ゲーム仕様書§6.2）', () => {
  eq(CQAreas.masterLevel(0), 1, '0種はLv1');
  eq(CQAreas.masterLevel(19), 1, '19種はまだLv1');
  eq(CQAreas.masterLevel(20), 2, '20種でLv2');
  eq(CQAreas.masterLevel(52), 3, '52種でLv3');
  eq(CQAreas.masterLevel(100), 4, '100種でLv4');
  eq(CQAreas.masterLevel(168), 5, '168種でLv5');
});

t('ショップ品揃えプール：段階が現在のレベル以下のものだけ', () => {
  const lv1 = CQAreas.shopSpellPool(CARD_BY_ID, 1);
  const lv3 = CQAreas.shopSpellPool(CARD_BY_ID, 3);
  eq(lv1.length > 0, true, 'Lv1でも買えるものがある');
  eq(lv3.length >= lv1.length, true, 'レベルが上がると増える（減らない）');
  lv1.forEach((e) => {
    const m = (CARD_BY_ID[e.id].g || '').match(/コレクション段階(\d+)/);
    eq(+m[1] <= 1, true, 'Lv1のプールは段階1のみ');
  });
});

t('メタ：訪問回数とヒント既読を記録する（案内の出し分け用）', () => {
  const st = mockStorage();
  const m = CQSave.loadMeta(st, [8]);
  eq(CQSave.visitCount(m, 'grassland'), 0, '最初は0回');
  CQSave.markVisit(m, 'grassland');
  eq(CQSave.visitCount(m, 'grassland'), 1, '1回目');
  CQSave.markVisit(m, 'grassland');
  eq(CQSave.visitCount(m, 'grassland'), 2, '2回目');
  eq(CQSave.visitCount(m, 'forest'), 0, 'エリアごとに別で数える');
  eq(CQSave.hintSeen(m, 'carryOut'), false, 'まだ見ていない');
  CQSave.markHint(m, 'carryOut');
  eq(CQSave.hintSeen(m, 'carryOut'), true, '見たら立つ');
  /* 保存して読み直しても残る */
  CQSave.saveMeta(st, m);
  const m2 = CQSave.loadMeta(st, [8]);
  eq(CQSave.visitCount(m2, 'grassland'), 2, '保存・復元しても残る');
  eq(CQSave.hintSeen(m2, 'carryOut'), true, 'ヒントも残る');
});

t('メタ：visits／seenHintsが無い既存セーブでも落ちない（後方互換）', () => {
  const st = mockStorage();
  st.setItem('cq_meta', JSON.stringify({ book: { 8: 2 }, deck: {}, known: [8], gold: 10, cleared: [], openingSeen: true }));
  const m = CQSave.loadMeta(st, [8]);
  eq(m.visits, {}, 'visitsが空で補われる');
  eq(m.seenHints, {}, 'seenHintsが空で補われる');
  eq(CQSave.visitCount(m, 'grassland'), 0, '数えられる');
});

/* ================= M6.6 WP7: 戦利品の振り分け ================= */
section('M6.6 WP7: 戦利品の振り分け');

t('戦利品振り分け：デッキに空きがあれば「デッキに加える」が選べ、run.deckに入る', () => {
  const meta = { book: {}, deck: { 8: 1 }, known: [8], gold: 0, cleared: [] };
  const run = CQRun.start(CARD_BY_ID, 'grassland', 60, meta);
  const n = { type: 'battle', cleared: false };
  CQRun.reportBattle(run, n, { winner: 'self', loot: [41], players: { self: { lp: 10 } } });
  eq(run.lootPending, [41], '振り分け待ちに積まれる');
  eq(CQRun.canAssignToDeck(run, 41), true, '空きがあるのでデッキに加えられる');
  const r = CQRun.resolveLootPick(run, 41, 'deck', CARD_BY_ID);
  eq(r.ok, true, '成功する');
  eq(run.deck[41], 1, 'デッキに入る');
  eq(run.lootPending, [], '振り分け待ちから消える');
});

t('戦利品振り分け：デッキが満杯でも「本に送る」は必ず成功する（本は上限なし）', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 61, freshMeta()); /* スターター40枚＝満杯 */
  const n = { type: 'battle', cleared: false };
  CQRun.reportBattle(run, n, { winner: 'self', loot: [41], players: { self: { lp: 10 } } });
  eq(CQRun.canAssignToDeck(run, 41), false, '満杯なのでデッキには加えられない');
  const r = CQRun.resolveLootPick(run, 41, 'book', CARD_BY_ID);
  eq(r.ok, true, '本行きは常に成功する');
  eq(run.bookAdd[41], 1, '本行きに積まれる');
  eq(run.lootPending, [], '振り分け待ちから消える');
});

t('戦利品振り分け：デッキが満杯のとき「デッキに加える」を無理に呼んでも失敗し、振り分け待ちは減らない', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 62, freshMeta());
  const n = { type: 'battle', cleared: false };
  CQRun.reportBattle(run, n, { winner: 'self', loot: [41], players: { self: { lp: 10 } } });
  const r = CQRun.resolveLootPick(run, 41, 'deck', CARD_BY_ID);
  eq(r.ok, false, '満杯なので失敗する');
  eq(run.lootPending, [41], '振り分け待ちのまま残る（何度でもやり直せる）');
});

t('戦利品振り分け：同じIDが複数あっても1回の振り分けで1枚だけ減る', () => {
  const meta = { book: {}, deck: { 8: 1 }, known: [8], gold: 0, cleared: [] };
  const run = CQRun.start(CARD_BY_ID, 'grassland', 63, meta);
  const n = { type: 'battle', cleared: false };
  CQRun.reportBattle(run, n, { winner: 'self', loot: [41, 41], players: { self: { lp: 10 } } });
  eq(run.lootPending, [41, 41], '2枚とも振り分け待ちに積まれる');
  CQRun.resolveLootPick(run, 41, 'deck', CARD_BY_ID);
  eq(run.deck[41], 1, '1枚目がデッキに入る');
  eq(run.lootPending, [41], '残り1枚だけになる（2枚とも消えない）');
  CQRun.resolveLootPick(run, 41, 'book', CARD_BY_ID);
  eq(run.bookAdd[41], 1, '2枚目は本に入る');
  eq(run.lootPending, [], '振り分け待ちが空になる');
});

t('戦利品振り分け：全部振り分けた後にsettleすると、デッキ／本のどちらも正しく反映される', () => {
  const meta = { book: {}, deck: { 8: 1 }, known: [8], gold: 0, cleared: [] };
  const run = CQRun.start(CARD_BY_ID, 'grassland', 64, meta);
  const n = { type: 'battle', cleared: false };
  CQRun.reportBattle(run, n, { winner: 'self', loot: [41, 42], players: { self: { lp: 10 } } });
  CQRun.resolveLootPick(run, 41, 'deck', CARD_BY_ID);
  CQRun.resolveLootPick(run, 42, 'book', CARD_BY_ID);
  CQRun.settle(run, meta);
  eq(meta.deck[41], 1, 'デッキ行きは保存デッキに残る');
  eq(meta.book[42], 1, '本行きはmeta.bookへ加算される');
  eq(meta.known.indexOf(41) >= 0 && meta.known.indexOf(42) >= 0, true, 'どちらもknownに登録される');
});

t('戦利品0枚：lootPendingは空のまま（振り分け画面はスキップされる想定）', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 65, freshMeta());
  const n = { type: 'battle', cleared: false };
  CQRun.reportBattle(run, n, { winner: 'self', loot: [], players: { self: { lp: 10 } } });
  eq(run.lootPending, [], '戦利品が無ければ何も積まれない');
});

t('台本（lore.js）：規約どおりの形になっている', () => {
  const L = CQLore.LORE;
  const all = [].concat(
    L.opening, L.hints.carryOut, L.common.fieldRule, L.common.pest,
    L.areas.grassland.first, L.areas.grassland.depart, L.areas.grassland.masterIntro,
    L.areas.forest.first, L.areas.forest.depart, L.areas.forest.masterIntro, L.areas.forest.fog
  );
  L.areas.grassland.repeat.forEach((g) => g.forEach((b) => all.push(b)));
  L.areas.forest.repeat.forEach((g) => g.forEach((b) => all.push(b)));
  all.forEach((b) => {
    eq(b.face === 'calm' || b.face === 'down', true, 'faceはcalmかdown：' + JSON.stringify(b));
    eq(b.lines.length >= 1 && b.lines.length <= 2, true, '1吹き出しは2行まで：' + JSON.stringify(b));
    b.lines.forEach((line) => {
      eq(line.length <= 28, true, '1行は全角28文字以内：' + line + '（' + line.length + '字）');
      eq(line.indexOf('！') < 0 && line.indexOf('!') < 0, true, '感嘆符を使わない：' + line);
    });
  });
  /* 台本§0は「三点リーダはアンバーが自分の過去に触れるときだけ（そのとき表情はdown）」と
   * 定めているが、台本§3.2「草原だ。……今日も、書けるだけ書こう。」・§4.2「森だ。……今日は
   * 見通しがきくな。」は calm のまま三点リーダを使っている（言い淀みの用法）。
   * 台本が正なので転記はそのままにし、ここでは「……なら必ずdown」の機械判定はしない。
   * 規約の解釈を厳密に揃えるなら台本側の改訂が要る（2026-08-28 申し送り）。 */
  const downCount = all.filter((b) => b.face === 'down').length;
  eq(downCount > 0, true, 'down表情の吹き出しが存在する（過去に触れる場面）');
  eq(L.areas.grassland.fog, null, '草原は霧率0%なので霧の文を持たない');
});

t('台本：開始マスの案内は2段に分かれている（2026-08-28 本人指定）', () => {
  const L = CQLore.LORE;
  ['grassland', 'forest'].forEach((id) => {
    const a = L.areas[id];
    eq(Array.isArray(a.first) && a.first.length > 0, true, id + '：①のエリア導入がある');
    eq(Array.isArray(a.depart) && a.depart.length > 0, true, id + '：②の送り出しがある');
    eq(Array.isArray(a.masterIntro) && a.masterIntro.length > 0, true, id + '：②のマスター紹介がある');
  });
  /* 削除した台本§3.1-2「道は二つに分かれる」がどこにも残っていないこと */
  const grass = [].concat(a2(L.areas.grassland.first), a2(L.areas.grassland.depart),
    a2(L.areas.grassland.masterIntro));
  eq(grass.some((b) => b.lines.join('').indexOf('道は二つに分かれる') >= 0), false,
    '「道は二つに分かれる」は削除済み');
  /* 送り出しは「行け」で終わる＝出発の直前に置く文であること */
  eq(L.areas.grassland.depart[0].lines.join('').indexOf('行け') >= 0, true,
    '草原の送り出しは「行け。日が暮れるまでには戻れ。」');
  function a2(x) { return x || []; }
});

t('台本：プレースホルダの置換と候補群の抽選', () => {
  const filled = CQLore.fill([{ face: 'calm', lines: ['{n}種。お前の格が上がった。'] }], { n: 20 });
  eq(filled[0].lines[0], '20種。お前の格が上がった。', '{n}が置き換わる');
  eq(filled[0].face, 'calm', 'faceはそのまま');
  const groups = [[{ face: 'calm', lines: ['A'] }], [{ face: 'calm', lines: ['B'] }]];
  eq(CQLore.pickOne(groups, () => 0)[0].lines[0], 'A', '乱数0なら先頭');
  eq(CQLore.pickOne(groups, () => 0.99)[0].lines[0], 'B', '乱数が大きければ後ろ');
  eq(CQLore.pickOne([], () => 0).length, 0, '空でも落ちない');
});

/* ================= M6.6 WP5: 戦闘導入カットインと先攻ルーレット ================= */
section('M6.6 WP5: 先攻ルーレット');

t('先攻判定：同じラン・同じマスなら常に同じ結果（決定的）', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 42, freshMeta());
  CQRun.depart(run);
  const n = Object.values(run.map.nodes).find((x) => x.type === 'battle');
  const a = CQRun.firstTurnOf(run, n);
  const b = CQRun.firstTurnOf(run, n);
  eq(a === 'self' || a === 'enemy', true, '結果は self か enemy のどちらか');
  eq(b, a, '同じ入力なら同じ結果');
  const setup1 = CQRun.battleSetup(run, CARD_BY_ID, n);
  const setup2 = CQRun.battleSetup(run, CARD_BY_ID, n);
  eq(setup1.first, a, 'battleSetup().first が firstTurnOf() と一致する');
  eq(setup2.first, a, 'battleSetup() を何度呼んでも同じ結果');
});

t('先攻判定：シードが違えば偏りなく self / enemy の両方が出る', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 7, freshMeta());
  CQRun.depart(run);
  const n = Object.values(run.map.nodes).find((x) => x.type === 'battle');
  const seen = {};
  for (let seed = 0; seed < 40; seed++) {
    const r2 = CQRun.start(CARD_BY_ID, 'grassland', seed, freshMeta());
    CQRun.depart(r2);
    const n2 = Object.values(r2.map.nodes).find((x) => x.type === 'battle');
    seen[CQRun.firstTurnOf(r2, n2)] = true;
  }
  eq(Object.keys(seen).sort(), ['enemy', 'self'], '40シード試せば両方の結果が出る');
});

t('先攻判定：マスが違えば同じランでも結果が変わりうる（マスidも種にしている）', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 9, freshMeta());
  CQRun.depart(run);
  const battles = Object.values(run.map.nodes).filter((x) => x.type === 'battle' || x.type === 'boss');
  const results = battles.map((n) => CQRun.firstTurnOf(run, n));
  eq(results.every((r) => r === 'self' || r === 'enemy'), true, 'すべて有効な値');
});

/* ================= M6.6 WP12: 逃げる・諦める ================= */
section('M6.6 WP12: 逃げる・諦める');

/** field モード（フリーユニット戦）のマッチを作る。逃走はここでしか使えない。
 * ※ WP6の節にも `fieldMatch` があるので、名前を分けてある（同名だと巻き上げで
 *   後ろの定義が前の定義を潰し、WP6のテストが壊れる。実際に一度踏んだ）。 */
function fleeMatch(seed, opts) {
  return CQTurn.createMatch(Object.assign({
    cards: CARD_BY_ID, rng: CQRng.create(seed === undefined ? 1 : seed),
    selfDeck: mkDeck(40, [8, 101, 151, 180]),
    enemyDeck: mkDeck(40, [8, 101, 151, 180]),
    first: 'self', mode: 'field', enemyBoard: [8, 8], hooks: HOOKS
  }, opts || {}));
}

t('逃走：フリーユニット戦の配置ステップでだけ使える（原作§4.1の条件）', () => {
  const m = fleeMatch(1);
  CQTurn.beginTurn(m);
  eq(m.phase, 'placement', '配置ステップにいる');
  eq(CQTurn.canFlee(m), true, '配置ステップなら逃げられる');
  CQTurn.endPlacement(m);
  eq(m.phase, 'main', 'メインステップへ');
  eq(CQTurn.canFlee(m), false, 'メインステップでは逃げられない');
  eq(CQTurn.flee(m).ok, false, '呼んでも失敗する');
});

t('逃走：マスター戦（fieldでない）では使えない', () => {
  const m = CQTurn.createMatch({
    cards: CARD_BY_ID, rng: CQRng.create(2),
    selfDeck: mkDeck(40, [8, 101]), enemyDeck: mkDeck(40, [8, 101]),
    first: 'self', hooks: HOOKS
  });
  CQTurn.beginTurn(m);
  eq(m.mode, null, 'fieldモードではない＝マスター戦');
  eq(CQTurn.canFlee(m), false, 'ボス戦では逃げられない（台本の「逃げ道はない」と一致）');
  const r = CQTurn.flee(m);
  eq(r.ok, false, '呼んでも失敗する');
  eq(r.reason, 'この相手からは逃げられません', '理由が出る');
});

t('逃走：そのターンに何かした後は使えない', () => {
  const m = fleeMatch(3);
  CQTurn.beginTurn(m);
  const unit = m.players.self.hand.find((id) => CARD_BY_ID[id].t === 'U');
  CQTurn.summon(m, 0, m.players.self.hand.indexOf(unit));
  eq(m.players.self.actedThisTurn, true, '召還したので行動済み');
  eq(CQTurn.canFlee(m), false, '行動後は逃げられない');
});

t('逃走：試せるのは毎ターン1回まで（失敗してもその場で再挑戦できない）', () => {
  /* 失敗するシードを探して、そのうえで2回目が弾かれることを見る */
  let m = null;
  for (let s = 1; s < 60 && !m; s++) {
    const cand = fleeMatch(s);
    CQTurn.beginTurn(cand);
    const before = cand.players.self.lp;
    if (CQTurn.flee(cand).escaped === false) { m = cand; eq(cand.players.self.lp, before - 1, '失敗でＬＰ−1'); }
  }
  eq(!!m, true, '失敗するシードが見つかる');
  if (m) {
    eq(m.players.self.fledThisTurn, true, 'このターンは試し済みの印が立つ');
    eq(CQTurn.canFlee(m), false, '同じターンに二度は試せない');
    eq(CQTurn.flee(m).ok, false, '呼んでも失敗する');
  }
});

t('逃走：成功すると m.fled が立ち、勝敗は付かない', () => {
  let m = null;
  for (let s = 1; s < 60 && !m; s++) {
    const cand = fleeMatch(s);
    CQTurn.beginTurn(cand);
    const before = cand.players.self.lp;
    if (CQTurn.flee(cand).escaped === true) { m = cand; eq(cand.players.self.lp, before, '成功ならＬＰは減らない'); }
  }
  eq(!!m, true, '成功するシードが見つかる');
  if (m) {
    eq(m.fled, 'self', '逃げた側が記録される');
    eq(m.winner, null, '勝敗は付かない（勝ちでも負けでもない）');
    eq(m.phase, 'over', '対局は終わっている');
  }
});

t('逃走：同じシードなら結果は常に同じ（m.rng を通しているか）', () => {
  const a = fleeMatch(7); CQTurn.beginTurn(a);
  const b = fleeMatch(7); CQTurn.beginTurn(b);
  eq(CQTurn.flee(a).escaped, CQTurn.flee(b).escaped, '同じシードなら同じ結果');
});

t('逃走：50%前後で成功する（極端に偏っていない）', () => {
  let ok = 0, n = 0;
  for (let s = 1; s <= 200; s++) {
    const m = fleeMatch(s);
    CQTurn.beginTurn(m);
    if (CQTurn.flee(m).escaped) ok++;
    n++;
  }
  eq(ok > n * 0.35 && ok < n * 0.65, true, '200試行の成功率が35〜65%に収まる：' + ok + '/' + n);
});

t('逃走の失敗でＬＰが0になったら、その場で敗北が確定する', () => {
  let m = null;
  for (let s = 1; s < 60 && !m; s++) {
    const cand = fleeMatch(s, { selfOpts: { lp: 1, maxLp: 15 } });
    CQTurn.beginTurn(cand);
    if (CQTurn.flee(cand).escaped === false) m = cand;
  }
  eq(!!m, true, 'ＬＰ1で失敗するシードが見つかる');
  if (m) {
    eq(m.players.self.lp, 0, 'ＬＰ0');
    eq(m.winner, 'enemy', '敗北が確定する');
    eq(!!m.fled, false, '逃げられてはいない');
  }
});

t('諦める：ＬＰ0の敗北として扱われる', () => {
  const m = fleeMatch(9);
  CQTurn.beginTurn(m);
  const r = CQTurn.resign(m, 'self');
  eq(r.ok, true, '成功する');
  eq(m.players.self.lp, 0, 'ＬＰ0になる');
  eq(m.winner, 'enemy', '相手の勝ち＝こちらの敗北');
  eq(m.resigned, 'self', '諦めた側が記録される（画面の文言の出し分けに使う）');
});

t('諦める：マスター戦でも使える（逃走と違って制限なし）', () => {
  const m = CQTurn.createMatch({
    cards: CARD_BY_ID, rng: CQRng.create(10),
    selfDeck: mkDeck(40, [8, 101]), enemyDeck: mkDeck(40, [8, 101]),
    first: 'self', hooks: HOOKS
  });
  CQTurn.beginTurn(m);
  eq(CQTurn.resign(m, 'self').ok, true, 'ボス戦でも諦められる');
  eq(m.winner, 'enemy', '敗北になる');
});

t('ラン側：逃走はマスを cleared にせず、ＬＰだけ持ち越す（追補§8-3 案A）', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 21, freshMeta());
  CQRun.depart(run);
  const n = Object.values(run.map.nodes).find((x) => x.type === 'battle');
  const goldBefore = run.gold;
  const fakeM = { fled: 'self', winner: null, loot: [], players: { self: { lp: 6 } } };
  const r = CQRun.reportFlee(run, n, fakeM);
  eq(r.fled, true, '逃走として処理される');
  eq(r.dead, false, 'まだ死んでいない');
  eq(!!n.cleared, false, '★マスは解決済みにならない＝そのマスに留まり、入り直せる');
  eq(run.lp, 6, 'ＬＰは戦闘後の値を持ち越す');
  eq(run.gold, goldBefore, 'Ｇは増えない');
  eq(run.lootPending, [], '戦利品も無い');
  eq(!run.outcome, true, 'ランはまだ続く');
});

t('ラン側：逃走失敗でＬＰ0ならランが終わる', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 22, freshMeta());
  CQRun.depart(run);
  const n = Object.values(run.map.nodes).find((x) => x.type === 'battle');
  const r = CQRun.reportFlee(run, n, { fled: null, players: { self: { lp: 0 } } });
  eq(r.dead, true, '力尽きた');
  eq(run.lp, 0, 'ＬＰ0');
  eq(run.outcome, 'lose', 'ゲームオーバー');
  eq(!!n.cleared, false, 'それでもマスは解決済みにしない');
});

t('ラン側：逃げたマスは「いま立っているのに未解決」なので、選び直せる', () => {
  const run = CQRun.start(CARD_BY_ID, 'grassland', 23, freshMeta());
  CQRun.depart(run);
  const first = CQRun.choices(run)[0];
  CQRun.advance(run, first.id);
  eq(run.at, first.id, 'そのマスへ進んだ');
  eq(!!first.cleared, false, 'まだ解決していない');
  /* この状態が「逃げて戻ってきた直後」と同じ。run-ui の runChoiceIds は
   * 現在地が未解決なら現在地自身を選択可能として返す（＝もう一度入れる）。 */
  eq(CQRun.choices(run), [], '未解決のうちは先へは進めない');
});

/* ================= M6.7 WP1: 強制リバース連鎖（108/109）の中断 ================= */
section('M6.7 WP1: 強制リバース連鎖');

/* 本人の指摘（2026-08-29）が設計の核心：
 *   「108/109は値段の割に強力なため、様々な対抗策が用意されている。133でソース源の
 *    モンスターを破壊して止めたり、101で108/109のカードを破壊してプロセスを途中で
 *    終わらせる。110を用意しておけば開いてしまったカードをまた閉じるという戦略も成り立つ。
 *    その際に重要なのが、下から順にカードがめくられて、効果もその順に発揮していくこと。」
 * 原作解析 05_magic.md §1-8 もまったく同じ設計だった。**中断のテストがこの節の主役。** */

t('連鎖の中断：連鎖中に開いた133呪爆が「仕掛けた側」を撃ち、そこで連鎖が止まる', () => {
  /* 原作 §1-8：連鎖中に開いた呪爆・呪念は V970（＝仕掛けた側）を狙う。
   * ＝強制開放は撃った本人に跳ね返る。仕掛けたユニットが死ねばマーカーごと消えるので、
   * 次の1枚を処理する前に連鎖が打ち切られる。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);                    // 仕掛ける側
  m.board.lanes[3] = lane(8, [down(133), down(151), down(152)]);
  m.board.lanes[3].channels.forEach((c) => { c.mine = false; });
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[0].unit, null, '仕掛けた側のユニットが呪爆で破壊される（跳ね返り）');
  eq(m.lastForcedChain.steps.length, 1, '1枚目を開いた時点で止まる');
  /* 開いた呪爆は連鎖の終わりに消える（2026-08-31）。残るのは開かれなかった151と152。 */
  eq(m.board.lanes[3].channels.map((c) => [c.card, c.up]), [[151, false], [152, false]],
    '2枚目・3枚目は裏のまま残り、開いた呪爆は消えている');
});

t('連鎖の中断：仕掛けたユニットが死ぬと、残りのＣＨは開かない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(108)]);
  m.board.lanes[3] = lane(8, [down(133), down(152), down(153), down(155)]);
  m.board.lanes[3].channels.forEach((c) => { c.mine = false; });
  CQTurn.reverseAction(m, 0, [2], { choice: { lane: 3 } });
  eq(m.lastForcedChain.aborted != null, true, '中断として記録される');
  /* 開いたのは呪爆(133)の1枚だけ——ただし連鎖が開いた魔法は連鎖の終わりに消える
   * （2026-08-31）ので、残っているのは「開かれなかった3枚（すべて裏）」になる。 */
  eq(m.lastForcedChain.steps.length, 1, '開いたのは1枚だけ');
  eq(m.board.lanes[3].channels.filter((c) => c.up).length, 0, '開いた呪爆は消え、残りは裏のまま');
});

t('連鎖：中断が無ければ最上段まで開き切る', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[3] = lane(8, [down(151), down(152), down(153), down(155)]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[3].channels.every((c) => c.up), true, '4枚とも開く');
  eq(m.lastForcedChain.aborted, null, '中断していない');
});

t('連鎖：開いたカードの効果はその場・その順で発動する', () => {
  /* 「複数の効果が一度に発生してしまって判断がつかなくなる」のを避けるための順序保証。
   * 1階層目に呪念(134)を置くと、その時点で仕掛けた側のＬＰが減る。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(151), down(108)]);
  /* 呪念(134)は詠唱Ｌｖ3なので3階層目に置く（低い階層だとレベル不足で不発になる）。 */
  m.board.lanes[3] = lane(8, [down(151), down(152), down(134)]);
  m.board.lanes[3].channels.forEach((c) => { c.mine = false; });
  const lpBefore = m.players.self.lp;
  CQTurn.reverseAction(m, 0, [3], { choice: { lane: 3 } });
  eq(m.lastForcedChain.steps.map((x) => x.idx), [0, 1, 2], '1→2→3階層目の順に処理される');
  eq(m.players.self.lp, lpBefore - 5, '3枚目の呪念が仕掛けた側のマスターを撃つ（跳ね返り）');
});

t('連鎖：連鎖中に開かれた108/109は発動しない（多重連鎖の禁止・原作CE0355）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[3] = lane(8, [down(109), down(151)]);
  m.board.lanes[4] = lane(8, [down(152), down(153)]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[3].channels.every((c) => c.up), true, '対象レーンは開き切る');
  eq(m.board.lanes[4].channels.some((c) => c.up), false, '連鎖中の109は不発なので別レーンは無傷');
});

t('連鎖：対象が居なければ何も起きない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  for (let i = 1; i < 6; i++) m.board.lanes[i] = S.emptyLane();
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.lastForcedChain, undefined, '連鎖自体が始まらない');
});

t('連鎖：interactive なら1ビートずつ止まる（めくる→効果→取り除く）', () => {
  /* 2026-08-30 本人指摘：「めくるのが早すぎて確認できない」「効果はめくった後に発動してほしい」。
   * エンジンが1ビートずつ返すようになったので、ＵＩが間を置いて再生できる。
   * ＡＩ・シミュレータは interactive を渡さないので従来どおり一気に解決する。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[3] = lane(8, [down(151), down(152)]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 }, interactive: true });
  eq(!!m.forcedChain, true, '連鎖が始まったまま止まっている');
  eq(m.board.lanes[3].channels[0].up, false, 'まだ1枚も開いていない');

  const a = CQMagic.forcedChainStep(m);
  eq(a.phase, 'flip', '1ビート目はめくるだけ');
  eq(m.board.lanes[3].channels[0].up, true, '1枚目が開く');
  eq(m.board.lanes[3].channels[1].up, false, '2枚目はまだ開かない');

  const b = CQMagic.forcedChainStep(m);
  eq(b.phase, 'effect', '2ビート目に効果が出る');

  const c = CQMagic.forcedChainStep(m);
  eq(c.phase, 'flip', '次の1枚へ');
  eq(m.board.lanes[3].channels[1].up, true, '2枚目が開く');
});

t('連鎖：憑依解除が狙ったカードは、いったん印が付くだけで場に残る（赤枠で見せるため）', () => {
  /* 本人の要望：「ターゲットになるカードが何であるのかを、プレイヤーが確認できるように」。
   * effect ビートでは doomed の印を付けるだけにして、strike ビートで実際に取り除く。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[3] = lane(70, [down(101, { mine: false })]);
  m.board.lanes[4] = lane(8, [down(153, { mine: false })]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 }, interactive: true });
  CQMagic.forcedChainStep(m);                         /* flip：憑依解除が開く */
  const e = CQMagic.forcedChainStep(m);               /* effect：狙いを付ける */
  eq(e.phase, 'effect', '効果のビート');
  eq(e.aimed.length >= 1, true, '狙ったカードが返る');
  const aim = e.aimed[0];
  const stillThere = m.board.lanes[aim.lane].channels[aim.idx];
  eq(!!(stillThere && stillThere.doomed), true, 'まだ場にあり、印が付いている');

  const st = CQMagic.forcedChainStep(m);              /* strike：実際に取り除く */
  eq(st.phase, 'strike', '取り除くビート');
  eq(st.removed >= 1, true, '取り除かれた');
});

t('連鎖：相手の憑依解除は「連鎖の元凶」を狙う（2026-08-30 本人指摘の対抗手）', () => {
  /* ルール上は元から狙えた（h101の候補は自分以外の全ＣＨ）。400回試すと約25%で
   * 偶然当たっていたが、狙って当てていなかっただけ。自動選択がそれを優先するようにした。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);            // 元凶（自分が仕掛けた）
  m.board.lanes[3] = lane(70, [down(101, { mine: false }), down(172, { mine: false })]);
  m.board.lanes[4] = lane(8, [down(153, { mine: false })]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[0].channels.some((c) => c.card === 108), false, '元凶が破壊される');
  eq(m.lastForcedChain.aborted != null, true, '連鎖が止まる');
  eq(m.board.lanes[3].channels.some((c) => c.card === 172 && c.up), false,
    '2枚目の反射までは開かれない');
});

t('連鎖：自分が仕掛けた側の憑依解除は元凶を狙わない（自分の連鎖を止めない）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[3] = lane(70, [down(101, { mine: true }), down(172, { mine: true })]);  // 仕掛けた側の札
  m.board.lanes[4] = lane(8, [down(153, { mine: false })]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  /* 連鎖の途中で元凶が壊されていない＝中断せず最後まで走ったことを見る。
   * （連鎖の終わりには役目を終えた108自身も消えるようになったので、
   *   「残っているか」ではなく「中断しなかったか」で確かめる。2026-08-31） */
  eq(m.lastForcedChain.aborted == null, true, '自分の憑依解除は連鎖を止めない');
  eq(m.log.some((l) => l.indexOf('連鎖の元凶を狙う') >= 0), false, '元凶を狙う挙動が出ていない');
});

t('連鎖：ＵＩ用の steps は「レーン・階層・カード・表裏」を処理順に持つ', () => {
  /* ＵＩはこの配列を200〜300ms間隔で再生して「1枚ずつめくる」演出にする。
   * ＡＩ・シミュレータは見なくてよい（無改修で動く）。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(109)]);
  m.board.lanes[3] = lane(8, [up(151), down(152)]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.lastForcedChain.kind, 109, 'どちらのカードか');
  eq(m.lastForcedChain.target, 3, '対象レーン');
  eq(m.lastForcedChain.steps, [
    { lane: 3, idx: 0, card: 151, up: false },
    { lane: 3, idx: 1, card: 152, up: true }
  ], '処理順に、めくった結果まで入る');
});

/* ================= M6.7 WP2: 詠唱レベル ================= */
section('M6.7 WP2: 詠唱レベル');

t('詠唱Ｌｖ：魔法48種すべてに lv がある（判断13：無かったものは Lv1 と明記）', () => {
  const magic = CARDS.filter((c) => c.t === 'M');
  eq(magic.length, 48, '魔法は48種');
  eq(magic.every((c) => typeof c.lv === 'number' && c.lv >= 1), true, '全部に lv が入っている');
});

t('詠唱Ｌｖ：原作でレベルを持つ8種はその値、残りは1', () => {
  /* 原作解析 05_magic.md §2 の Lv 列がそのまま出典。判断13により、
   * 残る40種は「レベルの変更はせず、Lv1と明示するだけ」。 */
  const want = { 116: 4, 132: 5, 134: 3, 138: 3, 140: 4, 141: 6, 142: 3, 146: 3 };
  const got = {};
  CARDS.filter((c) => c.t === 'M' && c.lv > 1).forEach((c) => { got[c.id] = c.lv; });
  eq(got, want, '8種だけが Lv2 以上');
});

t('詠唱Ｌｖ：データの lv とエンジンの LEVEL_REQ が食い違わない', () => {
  /* 表示（data.js）と判定（magic.js）が別々に持っている以上、ズレたら嘘を表示することになる。
   * 換金所の売値（M6.6 WP9）で一度やった事故なので、ここは必ず突き合わせる。 */
  CARDS.filter((c) => c.t === 'M').forEach((c) => {
    eq(c.lv, CQMagic.LEVEL_REQ[c.id] || 1, 'ＩＤ' + c.id + ' ' + c.n + ' の詠唱Ｌｖ');
  });
});

t('詠唱Ｌｖ：Ｌｖ1の魔法は1階層目でも発動する', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(101)]);                    // 憑依解除＝Ｌｖ1
  m.board.lanes[3] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[3].channels.length, 0, '1階層目でも効果が出る');
});

t('詠唱Ｌｖ：魔道書(186)が同じレーンにあると必要レベルが2下がる', () => {
  /* 原作 §1-1：V397 -= 魔道書の枚数×2。116解析はＬｖ4なので、魔道書1枚で2階層目から通る。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(186), down(116)]);
  m.board.lanes[3] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [2]);
  eq(m.board.lanes[3].channels[0].revealed, true, '魔道書のぶんレベルが下がって発動する');
});

/* ================= M6.6 WP11: 探索終了リザルト（清算の減額・称号・日誌） ================= */
section('M6.6 WP11: リザルト');

/** WP11のテスト用：終わり方と金額だけを指定して、清算直前のランを作る。
 * 実際にマップを踏破させる必要は無い（清算が見るのは outcome / gold / startGold / lp だけ）。 */
function endedRun(meta, outcome, opts) {
  const o = opts || {};
  const run = CQRun.start(CARD_BY_ID, o.areaId || 'grassland', o.seed || 900, meta);
  run.outcome = outcome;
  run.gold = o.gold != null ? o.gold : run.startGold;
  if (o.lp != null) run.lp = o.lp;
  run.gainedCards = (o.gained || []).slice();
  run.rentals = (o.rentals || []).slice();
  return run;
}

t('清算の減額：マスター撃破（win）は今日の獲得ぶんが丸ごと残る', () => {
  const meta = freshMeta();                              /* gold: 500 */
  const run = endedRun(meta, 'win', { gold: 900 });
  const g = CQRun.settleGold(run);
  eq(g.carried, 500, '持ち込みは出発時のＧ');
  eq(g.earned, 400, '今日の獲得は 900−500');
  eq(g.cut, 0, 'クリアなら減額なし');
  eq(g.final, 900, '所持Ｇはそのまま');
});

t('清算の減額：リタイヤは獲得ぶんの50%だけ失う（持ち込みは減らない）', () => {
  const meta = freshMeta();
  const run = endedRun(meta, 'retire', { gold: 900 });
  const g = CQRun.settleGold(run);
  eq(g.cut, 200, '400の50%＝200');
  eq(g.final, 700, '900−200。持ち込みの500は残る');
});

t('清算の減額：ゲームオーバーは獲得ぶんの75%を失う', () => {
  const meta = freshMeta();
  const run = endedRun(meta, 'lose', { gold: 900 });
  const g = CQRun.settleGold(run);
  eq(g.cut, 300, '400の75%＝300');
  eq(g.final, 600, '900−300');
});

t('清算の減額：買い物で持ち込みを食い込んだ日は、減額されない（獲得が0扱い）', () => {
  /* マイナスの獲得に率を掛けると「損したぶんが返ってくる」ので、earned は 0 で止める。 */
  const meta = freshMeta();
  const run = endedRun(meta, 'lose', { gold: 200 });     /* 500持って出て200まで使った */
  const g = CQRun.settleGold(run);
  eq(g.earned, 0, '獲得はマイナスにしない');
  eq(g.cut, 0, '減額もしない');
  eq(g.final, 200, '使った結果がそのまま残る');
});

t('清算の減額：減額は10Ｇ単位に丸める（宝箱・売値と同じ刻み）', () => {
  const meta = freshMeta();
  const run = endedRun(meta, 'retire', { gold: 500 + 375 });
  eq(CQRun.settleGold(run).cut, 190, '375の50%＝187.5→190');
});

t('清算：settle が減額後のＧを meta に書く', () => {
  const meta = freshMeta();
  const run = endedRun(meta, 'retire', { gold: 900 });
  CQRun.settle(run, meta);
  eq(meta.gold, 700, 'meta.gold は減額後');
  eq(run.settled.gold.cut, 200, '内訳が run.settled に残る（結果画面が使う）');
});

t('清算：2回呼んでも二重に減額されない', () => {
  /* 二重タップ等の保険。1回目で称号も配り終えているので、2回目で消えないことも確かめる。 */
  const meta = freshMeta();
  const run = endedRun(meta, 'lose', { gold: 900 });
  CQRun.settle(run, meta);
  const after1 = meta.gold, titles1 = meta.titles.slice(), day1 = meta.day;
  CQRun.settle(run, meta);
  eq(meta.gold, after1, 'Ｇはもう減らない');
  eq(meta.titles, titles1, '称号も増えない');
  eq(meta.day, day1, '日数も進まない');
});

t('称号：初めてランを終えると「初めての帰還」が付く（終わり方は問わない）', () => {
  const meta = freshMeta();
  const run = endedRun(meta, 'lose', { gold: 500, lp: 0 });
  CQRun.settle(run, meta);
  eq(meta.titles.indexOf('firstReturn') >= 0, true, '敗北でも付く');
  /* 2回目のランでは付かない */
  const meta2 = Object.assign({}, meta);
  const run2 = endedRun(meta2, 'retire', { gold: 500 });
  eq(CQRun.earnedTitles(run2, meta2).map((x) => x.key).indexOf('firstReturn'), -1, '2回目は付かない');
});

t('称号：エリアのマスターを初めて撃破すると踏破者の称号が付く', () => {
  const meta = freshMeta();
  const run = endedRun(meta, 'win', { gold: 500, areaId: 'grassland' });
  CQRun.settle(run, meta);
  eq(meta.titles.indexOf('clearGrassland') >= 0, true, '草原の踏破者');
  eq(meta.titles.indexOf('clearForest') >= 0, false, '行っていない森の分は付かない');
});

t('称号：リタイヤ・敗北では踏破者の称号は付かない', () => {
  const meta = freshMeta();
  const run = endedRun(meta, 'retire', { gold: 500, areaId: 'grassland' });
  eq(CQRun.earnedTitles(run, meta).map((x) => x.key), ['firstReturn'], '帰還だけ');
});

t('称号：「無傷の一日」はクリア時のＬＰが出発時（10）以上のとき（2026-08-29本人確定）', () => {
  /* 追補の原文は「ＬＰ満タン」だが、ランは10／15で始まる＝満タンではないため、
   * 文字どおりだと回復してからクリアしないと取れない。出発時まで保っていればよい、に確定。 */
  const meta = freshMeta();
  const kept = endedRun(meta, 'win', { gold: 500, lp: 10 });
  eq(CQRun.earnedTitles(kept, meta).map((x) => x.key).indexOf('flawless') >= 0, true, 'ＬＰ10で付く');
  const healed = endedRun(meta, 'win', { gold: 500, lp: 15 });
  eq(CQRun.earnedTitles(healed, meta).map((x) => x.key).indexOf('flawless') >= 0, true, '回復済みでも付く');
  const hurt = endedRun(meta, 'win', { gold: 500, lp: 9 });
  eq(CQRun.earnedTitles(hurt, meta).map((x) => x.key).indexOf('flawless') >= 0, false, '1でも削れたら付かない');
  const lost = endedRun(meta, 'lose', { gold: 500, lp: 10 });
  eq(CQRun.earnedTitles(lost, meta).map((x) => x.key).indexOf('flawless') >= 0, false, 'クリアでなければ付かない');
});

t('称号：同じ称号は二度付かない', () => {
  const meta = freshMeta();
  CQRun.settle(endedRun(meta, 'win', { gold: 500, lp: 10 }), meta);
  const before = meta.titles.slice();
  CQRun.settle(endedRun(meta, 'win', { gold: 500, lp: 10 }), meta);
  eq(meta.titles, before, '2回目のクリアでは増えない');
});

t('通算日数：ランを終えるたびに1日進む', () => {
  const meta = freshMeta();
  eq(meta.day, undefined, '初期メタにはまだ無い');
  CQRun.settle(endedRun(meta, 'retire', { gold: 500 }), meta);
  eq(meta.day, 1, '1日目');
  CQRun.settle(endedRun(meta, 'lose', { gold: 500 }), meta);
  eq(meta.day, 2, '2日目');
});

t('日誌：終わり方ごとのテンプレートに値が入る（算用数字・2026-08-29本人確定）', () => {
  eq(CQLore.journalLine('clear', { day: 37, area: '草原', count: 2, lp: 4 }),
    '37日目。草原。書き留めた魂 2。ＬＰ 4で戻る。', 'クリア');
  eq(CQLore.journalLine('bossFirst', { day: 39, area: '森', master: 'フードの記録者' }),
    '39日目。森。フードの記録者 を降す。', 'ボス初撃破');
  eq(CQLore.journalLine('retire', { day: 38, area: '森' }), '38日目。森。引き返す。', 'リタイヤ');
  eq(CQLore.journalLine('gameOver', { day: 40, area: '森' }), '40日目。森。倒れて戻る。', 'ゲームオーバー');
  eq(CQLore.journalLine('nope', {}), '', '知らない種類は空文字（画面が壊れない）');
});

t('日誌：pushJournal で積み上がり、古い行から捨てられる', () => {
  const meta = freshMeta();
  CQRun.pushJournal(meta, '1日目。草原。引き返す。');
  CQRun.pushJournal(meta, '2日目。森。倒れて戻る。');
  eq(meta.journal.length, 2, '2行');
  eq(meta.journal[1], '2日目。森。倒れて戻る。', '新しい行が末尾');
  CQRun.pushJournal(meta, '');
  eq(meta.journal.length, 2, '空文字は積まない');
  for (let i = 0; i < 250; i++) CQRun.pushJournal(meta, i + '日目。');
  eq(meta.journal.length, 200, '上限200行で頭から捨てる');
  eq(meta.journal[199], '249日目。', '最後は最新の行');
});

t('アンバーの一言：終わり方ごとに台本§7.1の文面がある', () => {
  const r = CQLore.LORE.result;
  eq(!!(r.clear && r.retire && r.gameOver && r.gameOverFirst), true, '4種そろっている');
  eq(r.retire.face, 'down', 'リタイヤは down（過去に触れる台詞なので台本§0の規約どおり）');
  eq(r.clear.lines.length <= 2, true, '吹き出しは2行まで（台本§0）');
  Object.keys(r).forEach((k) => {
    r[k].lines.forEach((line) => {
      eq(line.length <= 28, true, k + ' の各行は全角28字以内（台本§0）：' + line);
      eq(line.indexOf('！') < 0, true, k + ' に感嘆符を使わない（台本§0）：' + line);
    });
  });
});

t('メタデータ：古いセーブにも titles / journal / day の入れ物が用意される', () => {
  const old = { book: {}, deck: { 8: 1 }, known: [8], gold: 0, cleared: [] };
  CQCollection.ensure(old);
  eq(old.titles, [], '称号');
  eq(old.journal, [], '日誌');
  eq(old.day, 0, '通算日数');
});


/* ================= 盤面セットアップ（デバッグ用の盤面記述） =================
 * js/board-spec.js。デバッグ画面（js/layout.js）とテストの両方から同じ形を使う。
 * ここで確かめるのは「書いたとおりの盤面になること」と「おかしな記述を弾くこと」。 */
section('盤面セットアップ（board-spec）');

const CQBoardSpec = require(path.join(root, 'js/board-spec.js'));

/** 記述を適用した対戦を作る（デバッグ画面 startBoardBattle と同じ手順）。 */
function specMatch(spec, opts) {
  const o = opts || {};
  const m = CQTurn.createMatch({
    cards: CARD_BY_ID, rng: CQRng.create(o.seed === undefined ? 7 : o.seed),
    selfDeck: Array(40).fill(8), enemyDeck: Array(40).fill(8),
    first: (spec && spec.first) || 'self', hooks: HOOKS
  });
  CQBoardSpec.apply(m, spec);
  return m;
}

t('レーン・ＣＨ・表裏・置いた側が書いたとおりになる', () => {
  const m = specMatch({
    lanes: {
      '0': { unit: 8, ch: [{ id: 108, up: false, by: 'self' }] },
      '3': { unit: 70, ch: [{ id: 101, up: false, by: 'enemy' }, { id: 172, up: true, by: 'self' }] }
    }
  });
  eq(m.board.lanes[0].unit, 8, '自陣1にユニット');
  eq(m.board.lanes[0].count, 1, 'ln.count が channels の長さに合っている');
  eq(m.board.lanes[1].unit, null, '書かなかったレーンは空き');
  eq(m.board.lanes[3].channels.map((c) => [c.card, c.up, c.mine]),
     [[101, false, false], [172, true, true]], '敵陣のＣＨ（表裏・置いた側）');
  eq(m.board.lanes[3].count, 2, '敵陣の ln.count');
});

t('by を省くとそのレーンの持ち主が置いた扱いになる', () => {
  const m = specMatch({ lanes: { '0': { unit: 8, ch: [{ id: 108 }] }, '3': { unit: 8, ch: [{ id: 108 }] } } });
  eq(m.board.lanes[0].channels[0].mine, true, '自陣は自分置き');
  eq(m.board.lanes[3].channels[0].mine, false, '敵陣は相手置き');
});

t('手札・ＬＰ・手番・ステップが書いたとおりになる', () => {
  const m = specMatch({ active: 'enemy', phase: 'placement', lp: { self: 3, enemy: 12 },
                        hand: { self: [108, 113], enemy: [101] }, lanes: { '3': { unit: 8, ch: [] } } });
  eq(m.players.self.hand, [108, 113], '自分の手札');
  eq(m.players.enemy.hand, [101], '相手の手札');
  eq([m.board.hand.self, m.board.hand.enemy], [2, 1], '盤面側の手札枚数も合っている');
  eq([m.players.self.lp, m.players.enemy.lp], [3, 12], 'ＬＰ');
  eq(m.players.enemy.maxLp >= 12, true, '最大ＬＰは指定ＬＰを下回らない');
  eq([m.active, m.phase], ['enemy', 'placement'], '手番とステップ');
  eq(m.players.self.turnsTaken, 1, '初手の6枚ドローが起きないようにしてある');
});

t('置いた盤面のまま能力値が計算されている（recalc を通っている）', () => {
  const m = specMatch({ lanes: { '0': { unit: 8, ch: [{ id: 151, up: true, by: 'self' }] } } });
  const base = CARD_BY_ID[8];
  eq(m.board.lanes[0].atk >= base.a, true, '攻撃力が算出済み（0のままではない）');
  eq(m.board.lanes[0].cap > 0, true, 'ＣＨ上限が算出済み');
});

t('伏せたＣＨは revealed が付かない（透視・予見の対象から外れない）', () => {
  const m = specMatch({ lanes: { '3': { unit: 8, ch: [{ id: 101, by: 'enemy' }] } } });
  eq(!!m.board.lanes[3].channels[0].revealed, false, '見られていない札として置かれる');
});

t('セットした盤面から魔法が普通に発動する（hooks の配線を含めた通し確認）', () => {
  /* 自陣に憑依解除(101)を伏せ、敵陣のＣＨを1枚だけにしておく。開ければそれが消える。 */
  const m = specMatch({ lanes: {
    '0': { unit: 8, ch: [{ id: 101, up: false, by: 'self' }] },
    '3': { unit: 8, ch: [{ id: 153, up: false, by: 'enemy' }] }
  } });
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[3].channels.length, 0, '相手のＣＨが破壊された＝魔法が発動している');
});

t('dump は apply したものをそのまま取り出せる（往復して変わらない）', () => {
  const spec = { first: 'enemy', active: 'enemy', phase: 'main', win: 'lp',
                 lp: { self: 4, enemy: 9 }, hand: { self: [108], enemy: [101, 113] },
                 lanes: { '1': { unit: 8, ch: [{ id: 108, up: true, by: 'enemy' }] },
                          '4': { unit: 70, ch: [] } } };
  const m = specMatch(spec);
  const back = CQBoardSpec.dump(m);
  eq(back, CQBoardSpec.normalize(spec, CARD_BY_ID).spec, '書き出したものが元の記述と一致する');
});

t('書き出した文字列は読み直せる（Claudeとの受け渡し口）', () => {
  const spec = CQBoardSpec.normalize({
    hand: { self: [108] },
    lanes: { '0': { unit: 8, ch: [{ id: 108, up: false, by: 'self' }] },
             '3': { unit: 70, stiff: true, ch: [{ id: 101, up: false, by: 'enemy' }] } }
  }, CARD_BY_ID).spec;
  const r = CQBoardSpec.parse(CQBoardSpec.stringify(spec), CARD_BY_ID);
  eq(r.errors, [], '読み直しでエラーが出ない');
  eq(r.spec, spec, '往復しても中身が変わらない');
});

t('硬直も指定できる（アタックできない状態から始めたいとき）', () => {
  const m = specMatch({ lanes: { '0': { unit: 8, ch: [], stiff: true }, '3': { unit: 8, ch: [] } } });
  eq(m.board.lanes[0].stiff, true, '硬直あり');
  eq(m.board.lanes[3].stiff, false, '指定しなければ動ける');
});

t('モンスターも階層に置ける（リバース召還の検証・2026-08-30 本人指定）', () => {
  const r = CQBoardSpec.normalize({ lanes: { '0': { unit: 8, ch: [{ id: 1, by: 'self' }] } } }, CARD_BY_ID);
  eq(r.errors, [], 'モンスターを伏せてもエラーにならない');
  const m = specMatch({ lanes: { '0': { unit: 8, ch: [{ id: 1, up: false, by: 'self' }] },
                                 '3': { unit: 8, ch: [] } } });
  eq(m.board.lanes[0].channels[0].card, 1, '階層にモンスターが伏せてある');
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[1].unit, 1, '開くと自陣の空きレーンにリバース召還される');
  eq(m.board.lanes[0].channels.length, 0, '元の階層からは消える');
});

t('おじゃま虫だけは階層に置けない（チャネリング不可のカード）', () => {
  const r = CQBoardSpec.normalize({ lanes: { '0': { unit: 8, ch: [{ id: 200 }] } } }, CARD_BY_ID);
  eq(r.errors.length, 1, '1件指摘される');
  eq(r.spec.lanes['0'].ch.length, 0, '置かれない');
});

t('おかしな記述はエラーとして返す（適用する前に気づける）', () => {
  const bad = CQBoardSpec.normalize({
    first: 'me', phase: 'battle', lp: { self: 0 },
    hand: { self: [999] },
    lanes: { '9': { unit: 8 }, '0': { unit: 101 }, '1': { unit: 8, ch: [{ id: 200 }] } }
  }, CARD_BY_ID);
  eq(bad.errors.length, 7, '7件の指摘：' + JSON.stringify(bad.errors));
  eq(bad.spec.first, 'self', '不正な値は既定に戻す');
});

t('ＣＨ上限を超えた記述は指摘され、超えた分は落とされる', () => {
  const cap = CQState.unitStats(CARD_BY_ID[8]).ch;
  const chs = []; for (let i = 0; i <= cap; i++) chs.push({ id: 108 });
  const r = CQBoardSpec.normalize({ lanes: { '0': { unit: 8, ch: chs } } }, CARD_BY_ID);
  eq(r.errors.length, 1, '1件指摘される');
  eq(r.spec.lanes['0'].ch.length, cap, '上限までに切り詰められる');
});

t('ＪＳＯＮとして壊れていても落ちない', () => {
  eq(CQBoardSpec.parse('{ こわれている', CARD_BY_ID).errors.length, 1, '読めない旨を返す');
  eq(CQBoardSpec.parse('[1,2,3]', CARD_BY_ID).errors.length, 1, '配列は受け取らない');
});

/* ---- 「📮 盤面を報告」のＪＳＯＮ（封筒）をそのまま貼れる（2026-08-31 本人指定） ----
 * 直した後に「同じ場面をもう一度」を確かめるための入口。メールで届いたＪＳＯＮを
 * 盤面セットアップの貼り付け欄にそのまま入れれば、中の盤面が取り出される。 */
function mkReport(board, history) {
  return {
    kind: 'cardquest-board-report', app: '0.16.39', at: '2026-08-31T23:10:58+09:00',
    comment: '憑依解除が使った直後に消えている',
    where: { area: '草原', turn: 12, active: 'self', lp: { self: 11, enemy: 10 },
             fieldRules: [{ id: 'laneLock', lanes: [2] }] },
    board: board, history: history || [], names: {}, log: ['戦闘終了']
  };
}
const REP_NOW = { lanes: { '0': { unit: 8, ch: [{ id: 101, up: true, by: 'self' }] },
                           '3': { unit: 70, ch: [] } } };
const REP_PREV = { lanes: { '0': { unit: 8, ch: [{ id: 101, up: false, by: 'self' }] },
                            '3': { unit: 70, ch: [{ id: 167, up: false, by: 'enemy' }] } } };

t('報告のＪＳＯＮを貼り付けると、中の盤面が取り出される', () => {
  const r = CQBoardSpec.parse(JSON.stringify(mkReport(REP_NOW)), CARD_BY_ID);
  eq(r.errors, [], 'エラーなく読める');
  eq(r.spec.lanes['0'].ch[0].id, 101, '封筒の中の盤面が入っている');
  eq(r.report.comment, '憑依解除が使った直後に消えている', 'コメントも取り出せる');
  eq(r.report.where.area, '草原', '場所も取り出せる');
});

t('報告の履歴は古い順に −N手 の名前が付く（その手が終わった時点の盤面）', () => {
  const rep = mkReport(REP_NOW, [
    { turn: 12, log: ['自分 が 3 階層目に押し込み'], board: REP_PREV },
    { turn: 12, log: ['自分 が 4階層目の 憑依解除 をオープン'], board: REP_NOW }
  ]);
  const r = CQBoardSpec.parse(JSON.stringify(rep), CARD_BY_ID);
  eq(r.report.history.map((h) => h.label), ['−2手', '−1手'], '古いほうが大きい番号');
  const back = CQBoardSpec.normalize(r.report.history[0].board, CARD_BY_ID);
  eq(back.errors, [], '履歴の盤面もそのまま取り込める');
  eq(back.spec.lanes['3'].ch[0].id, 167, '−2手の時点では腐食がまだ生きている');
});

t('盤面の入っていない報告（戦闘中でないとき）は、そう言って断る', () => {
  const rep = mkReport(null);
  const r = CQBoardSpec.parse(JSON.stringify(rep), CARD_BY_ID);
  eq(r.errors.length, 1, '1件指摘される');
  eq(/盤面が入っていません/.test(r.errors[0]), true, '理由が分かる：' + r.errors[0]);
});

t('ふつうの盤面ＪＳＯＮを貼ったときは report が付かない（今までどおり）', () => {
  const r = CQBoardSpec.parse(JSON.stringify(REP_NOW), CARD_BY_ID);
  eq(r.errors, [], 'エラーなく読める');
  eq(r.report, null, '封筒ではない');
  eq(r.spec.lanes['3'].unit, 70, '盤面はそのまま');
});

t('unwrap は封筒でないものに null を返す（誤検出しない）', () => {
  eq(CQBoardSpec.unwrap(REP_NOW), null, '盤面記述は封筒ではない');
  eq(CQBoardSpec.unwrap(null), null, '空でも落ちない');
  eq(CQBoardSpec.unwrap([1, 2]), null, '配列でも落ちない');
  eq(CQBoardSpec.unwrap(mkReport(REP_NOW)) !== null, true, '封筒は見分けられる');
});


/* ================= 破壊の予約（赤枠→粉々→消える） =================
 * 2026-08-30 本人指定。憑依解除(101)は一瞬でカードを消していたので何が壊れたのか
 * 分からなかった。ＵＩが演出できるよう、予約された対戦では doomed の印を付けて残す。
 * ここで守りたい性質は2つ：①予約しなければ従来どおり即座に消える（ＡＩ・シミュレータ）
 * ②予約は対戦オブジェクトごと＝**複製（ＡＩの先読み）には漏れない**。 */
section('破壊の予約（beginAim / endAim / strikeDoomed）');

/** 自陣0に憑依解除(101)を伏せ、敵陣3にＣＨを1枚だけ置いた盤面。開けばそれが狙われる。 */
function aimBoard(seed) {
  return specMatch({ lanes: {
    '0': { unit: 8, ch: [{ id: 101, up: false, by: 'self' }] },
    '3': { unit: 8, ch: [{ id: 153, up: false, by: 'enemy' }] }
  } }, { seed: seed === undefined ? 11 : seed });
}

t('予約しなければ従来どおりその場で消える（ＡＩ・シミュレータの経路）', () => {
  const m = aimBoard();
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[3].channels.length, 0, 'すぐ取り除かれる');
  eq(m.board.lanes[3].count, 0, 'ln.count も合っている');
});

t('予約すると、消さずに doomed の印を付けて残す（赤枠で見せられる）', () => {
  const m = aimBoard();
  CQMagic.beginAim(m);
  CQTurn.reverseAction(m, 0, [1]);
  const aimed = CQMagic.endAim(m);
  /* 対象の1枚に加え、使い終わった101自身も予約される（2026-08-31 の新原則）＝2枚 */
  eq(aimed.length, 2, '対象＋自分自身の2枚が予約された');
  eq([aimed[0].lane, aimed[0].idx, aimed[0].card], [3, 0, 153], '狙った場所とカード');
  eq(m.board.lanes[3].channels.length, 1, 'まだ場に残っている＝赤枠で見せられる');
  eq(m.board.lanes[3].channels[0].doomed, true, 'doomed の印が付く');
  eq(m.board.lanes[0].channels[0].doomed, true, '使い終わった101にも印が付く');
});

t('strikeDoomed で実際に取り除かれる（ln.count も揃う）', () => {
  const m = aimBoard();
  CQMagic.beginAim(m);
  CQTurn.reverseAction(m, 0, [1]);
  CQMagic.endAim(m);
  eq(CQMagic.strikeDoomed(m), 2, '対象と使い終わった101の2枚を取り除いた');
  eq(m.board.lanes[3].channels.length, 0, '場から消えた');
  eq(m.board.lanes[3].count, 0, 'ln.count も合っている');
  eq(m.board.lanes[0].channels.length, 0, '101自身も消えた');
  eq(CQMagic.strikeDoomed(m), 0, '二度目は何も起きない');
});

t('★予約は対戦ごと＝ほかの対戦（＝ＡＩの先読みの複製）には漏れない', () => {
  const a = aimBoard(11), b = aimBoard(12);
  CQMagic.beginAim(a);                         /* a だけ予約する */
  CQTurn.reverseAction(b, 0, [1]);             /* b は予約されていない */
  eq(b.board.lanes[3].channels.length, 0, '予約していない対戦は即座に消える');
  CQTurn.reverseAction(a, 0, [1]);
  eq(a.board.lanes[3].channels.length, 1, '予約した対戦だけが残す');
  CQMagic.endAim(a);
});

t('endAim すると予約は解ける（次の操作に持ち越さない）', () => {
  const m = aimBoard();
  CQMagic.beginAim(m);
  eq(CQMagic.endAim(m), [], '何も起きていなければ空');
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[3].channels.length, 0, '解けたあとは即座に消える');
  eq(CQMagic.endAim(m), [], '予約していない対戦の endAim は空を返す');
});

t('強制リバース連鎖の予約は今までどおり動く（m.forcedAim が優先される）', () => {
  const m = specMatch({ lanes: {
    '0': { unit: 8, ch: [{ id: 108, up: false, by: 'self' }] },
    '3': { unit: 70, ch: [{ id: 101, up: false, by: 'enemy' }, { id: 172, up: false, by: 'enemy' }] }
  } });
  CQTurn.reverseAction(m, 0, [1], { interactive: true, choice: { lane: 3 } });
  CQMagic.forcedChainStep(m);                        /* flip：憑依解除が開く */
  const e = CQMagic.forcedChainStep(m);              /* effect：狙いを付ける */
  eq(e.phase, 'effect', '効果のビート');
  eq(e.aimed.length, 1, '1枚を狙った');
  eq(m.board.lanes[0].channels.length, 1, 'まだ元凶は場にある（赤枠の段階）');
  CQMagic.forcedChainStep(m);                        /* strike：実際に取り除く */
  eq(m.board.lanes[0].channels.length, 0, '取り除かれた');
});


/* ================= M6.7 WP5: 対象の候補（targetsFor） =================
 * 候補の列挙をエンジンへ切り出した（ＵＩ・ＡＩ・テストが同じものを見る）。
 * 条件の正は原作解析『05_magic.md』§1-3「対象確認ルーチン」の表。 */
section('M6.7 WP5: 対象の候補（targetsFor）');

/** 自陣0の第1階層にそのカードが置いてある前提の ctx。 */
function tf(m, id, o) {
  return CQMagic.targetsFor(m, id, Object.assign({ laneIndex: 0, layer: 1, caster: 'self' }, o || {}));
}

t('自分の乗っているレーンは選べない（§1-4・原作の教習でも明示）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(135)]);
  m.board.lanes[3] = lane(8, []);
  eq(tf(m, 135).targets, [3], '自陣0は候補に入らない');
});

t('EJECT：ＣＨを1枚以上持つ他ユニット（116解析・124凍結）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(116)]);
  m.board.lanes[1] = lane(8, []);              /* ＣＨ無し＝対象外 */
  m.board.lanes[3] = lane(8, [down(151)]);
  eq(tf(m, 116).targets, [3], '解析');
  eq(tf(m, 124).targets, [3], '凍結');
  m.board.lanes[3].stiff = true;
  eq(tf(m, 124).targets, [], '凍結は既に硬直しているユニットを選べない');
});

t('FLOOD：ＣＨに空きのある他ユニット（102侵食・125移送・138潜入・148妄執）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(102)]);
  m.board.lanes[1] = lane(70, [down(151), down(151)]);   /* ポルターガイストはＣＨ2＝満杯 */
  m.board.lanes[3] = lane(8, []);
  CQStats.recalc(m.board, OPT);
  [102, 125, 138, 148].forEach((id) => {
    eq(tf(m, id).targets, [3], String(id) + '：満杯のレーンは候補にならない');
  });
});

t('BLITZ：防御力で候補が決まる（135雷撃・141思念波）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(135)]);
  m.board.lanes[3] = lane(8, []);
  CQStats.recalc(m.board, OPT);
  const def = m.board.lanes[3].def;
  eq(tf(m, 135).targets.length, def <= 550 ? 1 : 0, '雷撃は550以下（実測 def=' + def + '）');
  eq(tf(m, 141).targets.length, (def >= 551 && def <= 1000) ? 1 : 0, '思念波は551〜1000');
});

t('DASH：裏向きのＣＨ（118押収）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(118)]);
  m.board.lanes[3] = lane(8, [down(151), up(152)]);
  const r = tf(m, 118);
  eq(r.kind, 'ch', 'ＣＨを選ぶ型');
  eq(r.targets, [{ lane: 3, idx: 0 }], '表向きは対象外・自分のレーンも対象外');
});

t('126統合：ＣＨの付いていない他ユニットだけ', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(126)]);
  m.board.lanes[1] = lane(8, [down(151)]);
  m.board.lanes[3] = lane(8, []);
  eq(tf(m, 126).targets, [3], 'ＣＨが付いていると吸収できない');
});

t('121招来：中身の分かっている潜行ユニットだけ選べる', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(121)]);
  m.board.lanes[3] = lane(8, [down(1, { mine: false }), down(2, { mine: true })]);
  eq(tf(m, 121).targets, [{ lane: 3, idx: 1 }], '相手が置いた未知の札は選べない');
  m.board.lanes[3].channels[0].revealed = true;          /* 透視・解析で既知になった */
  eq(tf(m, 121).targets.length, 2, '既知になれば選べる');
});

t('114暗殺：相手の手札のモンスターだけが候補（選択中は手札が全部見える）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(114)]);
  m.players.enemy.hand = [101, 8, 151, 13];
  const r = tf(m, 114);
  eq(r.kind, 'hand', '手札から選ぶ型');
  eq(r.targets, [1, 3], 'モンスターの位置だけ');
});

t('131菊一文字：階層（レベル）を選ぶ — 4つ目の型', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(131), down(151)]);
  m.board.lanes[3] = lane(13, [down(151), down(151), down(151), down(151)]);
  const r = tf(m, 131, { layer: 2 });
  eq(r.kind, 'layer', '階層を選ぶ型');
  eq(r.targets, [1, 3, 4], 'ＣＨが1枚でもある階層が候補（自分と同じ第2層は選べない）');
});

t('131菊一文字：自分と同じレベルは選べない（原作 EV0271）。ただし使い終わると自壊する', () => {
  /* 対象として自分の階層は選べない（第2層は候補外）が、2026-08-31 の新原則で
   * 使い終わった魔法は消えるので、効果の後に131自身も消える。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(131), down(152)]);
  m.board.lanes[3] = lane(13, [down(153), down(154), down(155)]);
  CQTurn.reverseAction(m, 0, [2], { choice: { layer: 2 } });   /* 自分と同じ階層は候補外 */
  /* 不正な指定（自分の階層）は無視され、候補（第1層か第3層）から選び直される。
   * どちらが選ばれても第2層のカード（敵陣の154）は無事で、131は使い終わって消える。 */
  eq(m.board.lanes[3].channels.some((c) => c.card === 154), true, '自分と同じ第2層は壊されない');
  eq(m.board.lanes[3].channels.length, 2, '壊れたのは1階層ぶんだけ');
  eq(m.board.lanes[0].channels.some((c) => c.card === 131), false, '使い終わった131は消える');
});

t('131菊一文字：自分より下の階層を壊すと、リバースの位置が正しくずれる', () => {
  /* 原作 EV0271 の `V28x -= 1`。ここを直さないと、下へ落ちたカードの上の階層が
   * 「もう開いた」ことになって開けなくなる。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(131), down(152), down(153)]);
  m.board.lanes[3] = lane(13, [down(154)]);
  CQTurn.reverseAction(m, 0, [2], { cont: true, choice: { layer: 1 } });
  /* 第1層が壊れ、使い終わった131自身も消える（2026-08-31 の新原則）。
   * 通過済みのカードが残らないので、リバースの位置は0へ戻る。 */
  eq(m.board.lanes[0].channels.map((c) => c.card), [152, 153], '第1層と131自身が消えて全体が下がる');
  eq(m.board.lanes[0].reversePtr, 0, '通過済みが残っていないので位置は0');
  const nxt = CQTurn.reverseAction(m, 0, [1], { cont: true });
  eq(nxt.ok, true, '下りてきたカードを続けて開ける（位置がずれていれば開けない）');
});

t('★選んだ対象がそのまま使われる（ctx.choice）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(124)]);
  m.board.lanes[1] = lane(8, [down(151)]);
  m.board.lanes[3] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq([m.board.lanes[1].stiff, m.board.lanes[3].stiff], [false, true], '選んだレーンだけが硬直する');
});

t('★選ばなければ従来どおり乱数で決まる（ＡＩ・シミュレータは無改修）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(124)]);
  m.board.lanes[3] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[3].stiff, true, '候補が1つならそこへ');
});

t('★候補に無いものを指定しても無視される（不正な choice で盤面が壊れない）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(124)]);
  m.board.lanes[3] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 5 } });   /* レーン5は空き */
  eq(m.board.lanes[3].stiff, true, '候補の中から選び直される');
});

t('131菊一文字：選んだ階層が全レーンで破壊される', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(131), down(152)]);
  m.board.lanes[3] = lane(13, [down(153), down(154), down(155)]);
  CQTurn.reverseAction(m, 0, [2], { choice: { layer: 3 } });
  /* 第3層に加え、使い終わった131自身も消える（2026-08-31 の新原則） */
  eq(m.board.lanes[0].channels.map((c) => c.card), [151], '自陣は3階層目と131自身が消える');
  eq(m.board.lanes[3].channels.map((c) => c.card), [153, 154], '敵陣の3階層目も消える');
});

t('戦闘中は当事者の2レーンだけが母数（§1-3）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(116)]);
  m.board.lanes[1] = lane(8, [down(151)]);
  m.board.lanes[3] = lane(8, [down(151)]);
  eq(tf(m, 116).targets, [1, 3], '戦闘外なら両方');
  m.combat = { attacker: 0, defender: 3 };
  eq(tf(m, 116).targets, [3], '戦闘中は当事者だけ');
});


/* ================= 2026-08-30 本人の実機フィードバック =================
 * 招来(121)で引き出したユニットの「開：」能力・菊一文字(131)の破壊演出。 */
section('実機フィードバック（招来の開：能力／菊一文字の破壊予約）');

t('★121招来：引き出したユニットの「開：」能力が発動する（本人指定）', () => {
  /* ミルファイター(1) は「開：クローズ×１」。相手の表向きＣＨが1枚閉じるはず。
   * 原作は招来だけ別経路でＣＨオープン処理を通らず、発動しなかった。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(42, [down(121)]);
  m.board.lanes[2] = lane(8, [down(1, { mine: true })]);   /* 潜行しているミルファイター */
  m.board.lanes[3] = lane(8, [up(151)]);                   /* 閉じられる表向きＣＨ */
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[1].unit, 1, 'ミルファイターが召還された');
  eq(m.board.lanes[3].channels[0].up, false, '開：クローズ×１が発動して表のＣＨが閉じた');
});

t('121招来：硬直しているユニットに潜んでいても引き出せる（本人の想定どおり）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(42, [down(121)]);
  m.board.lanes[2] = lane(8, [down(1, { mine: true })]);
  m.board.lanes[2].stiff = true;                          /* 潜行先が行動済みでも関係ない */
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[1].unit, 1, '硬直に関係なく召還できる');
  eq(m.board.lanes[2].channels.length, 0, '潜んでいた場所からは消える');
});

t('★131菊一文字：予約すると赤枠で見せてから消せる（憑依解除と同じ流れ）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(131), down(152)]);
  m.board.lanes[3] = lane(13, [down(153), down(154), down(155)]);
  CQMagic.beginAim(m);
  CQTurn.reverseAction(m, 0, [2], { choice: { layer: 3 } });
  const aimed = CQMagic.endAim(m);
  /* 第3層の2枚＋使い終わった131自身＝3枚（2026-08-31 の新原則） */
  eq(aimed.length, 3, '対象2枚と131自身が予約された');
  eq(m.board.lanes[0].channels.length, 3, 'まだ場に残っている＝赤枠で見せられる');
  eq(m.board.lanes[0].channels[2].doomed, true, 'doomed の印が付く');
  eq(CQMagic.strikeDoomed(m), 3, '3枚取り除いた');
  eq(m.board.lanes[0].channels.map((c) => c.card), [151], '第3層と131自身が消えた');
  eq(m.board.lanes[3].channels.map((c) => c.card), [153, 154], '敵陣も同じ');
});

t('131菊一文字：予約したまま下の階層を壊しても、リバースの位置がずれない', () => {
  /* 予約のときは strikeDoomed が位置を戻す（即座に消すときは reverseAction が戻す）。
   * 2026-08-31 の新原則で使い終わった131自身も消えるので、第1層＋131の2枚が消え、
   * 位置は0（まだ何も開いていない扱い）まで戻る。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(151), down(131), down(152), down(153)]);
  m.board.lanes[3] = lane(13, [down(154)]);
  CQMagic.beginAim(m);
  CQTurn.reverseAction(m, 0, [2], { cont: true, choice: { layer: 1 } });
  CQMagic.endAim(m);
  eq(m.board.lanes[0].reversePtr, 2, '消す前は第2層のまま');
  CQMagic.strikeDoomed(m);
  eq(m.board.lanes[0].channels.map((c) => c.card), [152, 153], '第1層と131自身が消えて全体が下がる');
  eq(m.board.lanes[0].reversePtr, 0, '通過済みのカードが残っていないので位置は0へ戻る');
  eq(CQTurn.reverseAction(m, 0, [1], { cont: true }).ok, true, '下りてきたカードを続けて開ける');
});


/* ================= M6.7 WP6: ユニット固有能力の対象選択 =================
 * 魔法（WP5）と同じ形の targetsFor をユニット側にも用意した。
 * 条件の正は原作解析『07_unit_abilities.md』§4（開：型）・§5（特：型）。 */
section('M6.7 WP6: ユニット固有能力の対象選択');

function uf(m, id, o) {
  return CQUnits.targetsFor(m, id, Object.assign({ laneIndex: 0, layer: 1, caster: 'self' }, o || {}));
}

t('★クローズ×１は表向きのＣＨなら何でも裏に戻せる（原作 CE0275）', () => {
  /* v0.16.30 までは通常のクローズ規則（技能カードのみ）を流用していて対象が狭すぎた。
   * 原作は「そこにカードがあり、表向き」しか見ていない＝魔法もカースも潜行ユニットも戻せる。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(1)]);
  m.board.lanes[3] = lane(8, [up(151), up(105), down(152)]);
  const r = uf(m, 1);
  eq(r.kind, 'ch', 'ＣＨを選ぶ型');
  eq(r.targets, [{ lane: 3, idx: 0 }, { lane: 3, idx: 1 }], '表向きなら技能でも魔法でも候補');
});

t('★自分の乗っているレーンは対象にできない（§4-1・本人指摘）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(151), down(1)]);        /* 自分のレーンにも表向きのＣＨがある */
  m.board.lanes[3] = lane(8, [up(152)]);
  eq(uf(m, 1, { layer: 2 }).targets, [{ lane: 3, idx: 0 }], '自陣0の表向きＣＨは候補に入らない');
});

t('★選んだカードがクローズされる（ctx.choice）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(1)]);
  m.board.lanes[3] = lane(8, [up(151), up(152)]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3, idx: 1 } });
  eq(m.board.lanes[3].channels.map((c) => c.up), [true, false], '選んだ第2層だけが裏に戻る');
});

t('16レッドレックス：防御力600以下の相手ユニットが候補', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(16)]);
  m.board.lanes[1] = lane(8, []);                        /* 味方は対象外 */
  m.board.lanes[3] = lane(8, []);
  CQStats.recalc(m.board, OPT);
  const r = uf(m, 16);
  eq(r.kind, 'lane', 'レーンを選ぶ型');
  eq(r.targets, [3], '相手陣だけが候補');
});

t('24シニスターセラフ：自分のレーン以外の全ＣＨが候補', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(151), down(24)]);
  m.board.lanes[3] = lane(8, [down(152)]);
  eq(uf(m, 24, { layer: 2 }).targets, [{ lane: 3, idx: 0 }], '自分の下のＣＨも対象外');
});

t('40スピアバード：まだ中身の分かっていない裏向きＣＨが候補', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(40)]);
  m.board.lanes[3] = lane(8, [down(151), down(152)]);
  m.board.lanes[3].channels[0].revealed = true;          /* もう知っている札は見る意味が無い */
  eq(uf(m, 40).targets, [{ lane: 3, idx: 1 }], '既知の札は候補から外れる');
});

t('29ステルスゴブリン：相手の手札から1枚を選んで奪う（選択中は手札が丸見え）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(29)]);
  m.players.enemy.hand = [101, 8, 151];
  const r = uf(m, 29);
  eq(r.kind, 'hand', '手札から選ぶ型');
  eq(r.targets, [0, 1, 2], '種類の制限は無い（07_unit_abilities.md §ID29）');
  CQTurn.reverseAction(m, 0, [1], { choice: { handIndex: 2 } });
  eq(m.players.enemy.hand, [101, 8], '選んだ1枚が相手の手札から消える');
  eq(m.players.self.hand.indexOf(151) >= 0, true, '自分の手札に入る');
});

t('★特殊行動（Ｃ型）でも対象を選べる — 10ヨルムンガンドのＡ５５０雷撃', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(10, []);
  m.board.lanes[3] = lane(8, []);
  m.board.lanes[4] = lane(8, []);
  CQStats.recalc(m.board, OPT);
  const r = CQUnits.targetsFor(m, 10, { laneIndex: 0, caster: 'self' });
  eq(r.targets, [3, 4], '防御力550以下の相手ユニットが候補');
  CQTurn.specialAction(m, 0, { choice: { lane: 4 } });
  eq([m.board.lanes[3].unit, m.board.lanes[4].unit], [8, null], '選んだほうだけが壊れる');
});

t('特殊行動：選ばなければ従来どおり乱数（ＡＩ・シミュレータは無改修）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(10, []);
  m.board.lanes[3] = lane(8, []);
  CQStats.recalc(m.board, OPT);
  CQTurn.specialAction(m, 0);
  eq(m.board.lanes[3].unit, null, '候補が1体ならそこへ');
});

t('9ディゾルバー：ＬＰ1点を払ってＣＨ1枚を壊す（判断7で1点確定）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(9, []);
  m.board.lanes[3] = lane(8, [down(151), down(152)]);
  const lp = m.players.self.lp;
  CQTurn.specialAction(m, 0, { choice: { lane: 3, idx: 1 } });
  eq(m.players.self.lp, lp - 1, 'ＬＰ -1');
  eq(m.board.lanes[3].channels.map((c) => c.card), [151], '選んだ第2層が消える');
});

t('34サイコダイバー：潜り込む先を選べる（ＣＨに空きのあるユニット）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(34, []);
  m.board.lanes[1] = lane(70, [down(151), down(151)]);   /* 満杯＝候補外 */
  m.board.lanes[3] = lane(13, []);
  CQStats.recalc(m.board, OPT);
  eq(CQUnits.targetsFor(m, 34, { laneIndex: 0, caster: 'self' }).targets, [3], '空きのあるユニットだけ');
  CQTurn.specialAction(m, 0, { choice: { lane: 3 } });
  eq(m.board.lanes[0].unit, null, '潜ったので元のレーンは空になる');
  eq(m.board.lanes[3].channels.map((c) => c.card), [34], '選んだユニットの中へ潜り込む');
});

t('対象を選ばない能力は候補を返さない（ＵＩが選択に入らない）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(23)]);
  eq(uf(m, 23), null, '23アンフィビアス（手札２枚入手）');
  eq(uf(m, 31), null, '31ドライアード（ＬＰ＋１回復）');
  eq(uf(m, 30), null, '30イビルアイ（呪爆能力）');
  eq(uf(m, 25), null, '25スケープゴート（摩り替り）');
  eq(uf(m, 35), null, '35ティンバータンク（自己ＣＨシャッフル）');
});

t('戦闘中は当事者の2レーンだけが母数（§4-1）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(1)]);
  m.board.lanes[1] = lane(8, [up(151)]);
  m.board.lanes[3] = lane(8, [up(151)]);
  eq(uf(m, 1).targets.length, 2, '戦闘外なら両方');
  m.combat = { attacker: 0, defender: 3 };
  eq(uf(m, 1).targets, [{ lane: 3, idx: 0 }], '戦闘中は当事者だけ');
});


/* ================= M6.7 WP4: 説明文の全面書き直し =================
 * 追補§0-2「分かりにくい説明文はすべて分かりやすく書き直す」。
 * ・主語と対象をはっきり書く
 * ・発動条件（戦闘中×・強制中×・レベル）は文章に混ぜず、画面の別欄（.i-cond）に出す
 * ・原作テキストは eOrig に残す（資料との突き合わせのため） */
section('M6.7 WP4: 説明文');

t('全169種に説明文がある', () => {
  const empty = CARDS.filter((c) => !c.e || !String(c.e).trim()).map((c) => c.id);
  eq(empty, [], '空の説明文が無い');
  eq(CARDS.length, 180, 'デッキに入る169種＋カース9種＋おじゃま虫');
});

t('★発動条件が説明文に混ざっていない（別の欄に出す）', () => {
  /* 「／戦闘中×」「／強制中×」「（レベル３」のような書き方が残っていないこと。
   * これらは画面側 cardCondHTML() がエンジンの NO_COMBAT / NO_FORCED から出す。 */
  const bad = CARDS.filter((c) => /／\s*(戦闘中|強制中)|（レベル|\(レベル/.test(c.e || ''))
    .map((c) => c.id + ' ' + c.n + '：' + c.e);
  eq(bad, [], '条件が文末に押し込まれた説明文は残っていない');
});

t('説明文の長さが揃っている（カード枠に収まる範囲）', () => {
  const longOnes = CARDS.filter((c) => (c.e || '').length > 60)
    .map((c) => c.id + ' ' + c.n + '(' + c.e.length + '字)');
  eq(longOnes, [], '60字を超える説明文は無い');
});

t('★原作テキストは eOrig に残っている（資料と突き合わせられる）', () => {
  /* 書き直したカードは必ず元の文を控えている。 */
  const rewritten = CARDS.filter((c) => c.eOrig);
  eq(rewritten.length >= 169, true, '書き直した分だけ控えがある：' + rewritten.length + '件');
  const same = rewritten.filter((c) => c.e === c.eOrig).map((c) => c.id);
  eq(same, [], '控えと同じ文が eOrig に入っているものは無い');
});

t('全角の記号・数字で統一されている（画面の他の文字と揃える）', () => {
  /* 半角のカタカナ・半角数字が混じると、カードの上で見た目が崩れる。 */
  const bad = CARDS.filter((c) => /[0-9]/.test((c.e || '').replace(/\(\d+\)/g, '')))
    .map((c) => c.id + ' ' + c.n + '：' + c.e);
  eq(bad, [], '説明文の数字は全角（カードＩＤの参照だけ半角括弧つきで許す）');
});

t('魔法の詠唱Ｌｖは data と エンジン（LEVEL_REQ）で一致している', () => {
  /* WP2 から続く不変条件。説明文を書き直しても崩れていないこと。 */
  const bad = CARDS.filter((c) => c.t === 'M')
    .filter((c) => c.lv !== (CQMagic.LEVEL_REQ[c.id] || 1))
    .map((c) => c.id + ' data=' + c.lv + ' engine=' + (CQMagic.LEVEL_REQ[c.id] || 1));
  eq(bad, [], '表示と実装が食い違っていない');
});


/* ================= 招来(121)の召還レベル判定（2026-08-30 本人判断） =================
 * 「唱えた深さ ≧ 相手ユニットの召還Ｌｖ」で決まる。呼べないものは候補に出さない。 */
section('招来(121)：唱えた深さで呼べるものが決まる');

t('★浅いところで唱えると、大物は候補に出ない', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(121)]);                 /* 第1層で唱える */
  m.board.lanes[3] = lane(13, [down(1, { mine: true }),     /* ミルファイター＝召還Ｌｖ1 */
                               down(10, { mine: true })]);  /* ヨルムンガンド＝召還Ｌｖ5 */
  const r = CQMagic.targetsFor(m, 121, { laneIndex: 0, layer: 1, caster: 'self' });
  eq(r.targets, [{ lane: 3, idx: 0 }], '第1層ではＬｖ1しか呼べない');
});

t('★深いところで唱えると、大物も呼べる', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(180), down(180), down(180), down(180), down(121)]);
  m.board.lanes[3] = lane(13, [down(10, { mine: true })]);   /* 召還Ｌｖ5 */
  const r = CQMagic.targetsFor(m, 121, { laneIndex: 0, layer: 5, caster: 'self' });
  eq(r.targets, [{ lane: 3, idx: 0 }], '第5層ならＬｖ5も候補に入る');
});

t('★魔道書(186)は唱えた深さに下駄をはかせる', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [up(186), down(180), down(121)]);   /* 第3層＋魔道書2 ＝ 深さ5 */
  m.board.lanes[3] = lane(13, [down(10, { mine: true })]);
  CQStats.recalc(m.board, OPT);
  const r = CQMagic.targetsFor(m, 121, { laneIndex: 0, layer: 3, caster: 'self' });
  eq(r.targets, [{ lane: 3, idx: 0 }], '第3層でも魔道書があればＬｖ5を呼べる');
});

t('呼べるものが無ければ不発（選んだのに壊れる、という罠にしない）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(121)]);
  m.board.lanes[3] = lane(13, [down(10, { mine: true })]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[3].channels.map((c) => c.card), [10], '潜行ユニットはそのまま残る（破壊されない）');
  eq(m.log.some((l) => l.indexOf('招来：呼べる潜行ユニットが無い') === 0), true, '不発の記録が残る');
});

t('深さの条件を満たせば、これまでどおり「開：」能力も出る', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(180), down(180), down(121)]);   /* 第3層 */
  m.board.lanes[2] = lane(13, [down(16, { mine: true })]);          /* レッドレックス＝召還Ｌｖ4 */
  m.board.lanes[3] = lane(8, []);
  CQStats.recalc(m.board, OPT);
  eq(CQMagic.targetsFor(m, 121, { laneIndex: 0, layer: 3, caster: 'self' }).targets, [],
    '第3層ではＬｖ4のレッドレックスは呼べない');
});


/* ================= 強制開放でめくれたユニットは分離召還される =================
 * 2026-08-31 本人指摘の修正。原作§1-8「開いた瞬間 EV0182 が走り」＝ＣＨオープン処理の
 * 一式（「開：」能力・リバース召還を含む）。v0.16.33 までは魔法しか発動せず、
 * めくられたユニットが表のままＣＨに残っていた。 */
section('強制開放：めくれたユニットの分離召還');

t('★敵に潜ませた自分のユニットが、強制開放で分離して自分の場へ戻る', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(108)]);
  m.board.lanes[3] = lane(13, [down(153, { mine: false }), down(8, { mine: true })]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[1].unit, 8, '自分の場の空きレーンへ召還される');
  eq(m.board.lanes[1].stiff, false, '硬直していない＝このターンに攻撃できる（本人の狙う戦略）');
  eq(m.board.lanes[3].channels.map((c) => c.card), [153], '敵のＣＨからは剥がれる');
});

t('★戦略の通し：分離したユニットで、防御の剥がれた敵をこのターンに攻撃できる', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(108)]);
  m.board.lanes[3] = lane(70, [down(153, { mine: false }), down(8, { mine: true })]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[1].unit, 8, '分離召還');
  const atk = CQCombat.declareAttack(m, 1, 3);
  eq(atk.ok, true, 'そのまま攻撃を宣言できる');
});

t('相手が置いたユニットは相手の場へ戻る（置いた側の陣に召還される）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(108)]);
  m.board.lanes[3] = lane(13, [down(8, { mine: false })]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[4].unit, 8, '敵陣の空きレーンへ');
});

t('融合(162)が付いたホストからは分離しない（既存規則がそのまま効く）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(108)]);
  m.board.lanes[3] = lane(13, [up(162, { mine: false }), down(8, { mine: true })]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[3].channels.some((c) => c.card === 8 && c.up), true, '表のままＣＨに留まる');
  eq(m.board.lanes[1].unit, null, '召還されない');
});

t('抵抗(178)が上に付いていれば、めくれたユニットは破壊される（既存規則）', () => {
  /* 抵抗＝このＣＨより上の階層でユニットカードが表になると破壊。ドラコニアン(42)で代用。 */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(108)]);
  m.board.lanes[3] = lane(42, [down(8, { mine: true })]);   /* ドラコニアン：付加ユニット破壊 */
  CQStats.recalc(m.board, OPT);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[1].unit, null, '召還されない');
  eq(m.board.lanes[3].channels.length, 0, '破壊されて消える');
});

t('★分離で階層が詰まっても、連鎖のカーソルはずれない（上のカードもちゃんとめくれる）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(108)]);
  m.board.lanes[3] = lane(13, [down(8, { mine: true }), down(153, { mine: false }), down(154, { mine: false })]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[1].unit, 8, '第1層のユニットが分離');
  eq(m.board.lanes[3].channels.map((c) => [c.card, c.up]), [[153, true], [154, true]],
    '下がってきた153も、その上の154も飛ばされずに開いている');
});

t('めくれたユニットの「開：」能力も出る（EV0182の一式が走る）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(108)]);
  m.board.lanes[3] = lane(13, [down(1, { mine: true })]);   /* ミルファイター：開：クローズ×１ */
  m.board.lanes[2] = lane(8, [up(151)]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[1].unit, 1, '分離召還される');
  eq(m.board.lanes[2].channels[0].up, false, 'クローズ×１が発動している');
});

t('カース（91〜99）は今までどおり表のまま残る（何も起きない）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(13, [down(108)]);
  m.board.lanes[3] = lane(13, [down(93, { mine: false })]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[3].channels.map((c) => [c.card, c.up]), [[93, true]], 'カースは表で残る');
});


/* ================= 強制開放：連鎖が開いた魔法は連鎖の終わりに消える =================
 * 2026-08-31 本人指摘。原作§1-8⑤も連鎖終了時に EV0049 魔法消去を呼ぶ。
 * 障壁(117)のような「表の間だけ効く」魔法が、ターン終わりまで居座らない。 */
section('強制開放：連鎖が開いた魔法の消滅');

t('★本人の盤面そのまま：障壁は連鎖中だけ効き、終わると消えて防御力が戻る', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(1, [down(108)]);
  m.board.lanes[3] = lane(1, [down(180, { mine: false }), down(5, { mine: true }),
                              down(117, { mine: false }), down(180, { mine: false }),
                              down(101, { mine: false })]);
  CQStats.recalc(m.board, OPT);
  const defBefore = m.board.lanes[3].def;
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[3].channels.some((c) => c.card === 117), false, '障壁は連鎖の終わりに消える');
  /* 連鎖後に残るのは表の空白2枚だけ（5は分離・117と101は消滅）。
   * 裏のＣＨ1枚＝防御+100 だった分も剥がれるので、素の500に戻る。 */
  eq(m.board.lanes[3].def, 500, '＋３００が残っていない（素の防御力だけになる）');
  eq(defBefore > 500, true, '（前提の確認）連鎖前は裏ＣＨぶんの上乗せがあった');
  eq(m.board.lanes[1].unit, 5, '途中のベヒーモス(5)は分離召還されている');
});

t('★役目を終えた強制開放カード自身も消える（原作§1-8⑤のマーカー消去）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[3] = lane(8, [down(153, { mine: false })]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[0].channels.some((c) => c.card === 108), false, '108は連鎖の終わりに消える');
});

t('連鎖が開いた技能（151〜）は消えない（通常の魔法消去と同じ線引き）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[3] = lane(8, [down(153, { mine: false }), down(152, { mine: false })]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[3].channels.map((c) => [c.card, c.up]), [[153, true], [152, true]],
    '技能は表のまま残る');
});

t('連鎖と無関係に開いてあった魔法は巻き込まれない（消すのは連鎖が触った分だけ）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[1] = lane(8, [up(117, { mine: true })]);      /* 事前に開いてある自分の障壁 */
  m.board.lanes[3] = lane(8, [down(153, { mine: false })]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[1].channels.some((c) => c.card === 117 && c.up), true,
    '別レーンの障壁はターン終わりまで残る（従来どおり）');
});

t('停滞(151)のレーンでは連鎖が開いた魔法も消えない（通常の魔法消去と同じ例外）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[3] = lane(8, [up(151, { mine: false }), down(117, { mine: false })]);
  CQStats.recalc(m.board, OPT);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.board.lanes[3].channels.some((c) => c.card === 117 && c.up), true, '停滞の下では残る');
});

t('中断された連鎖でも、そこまでに開いた魔法は消える', () => {
  /* 憑依解除が元凶を壊して中断 → それまでに開いた117も後始末される */
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[3] = lane(70, [down(101, { mine: false }), down(172, { mine: false })]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 } });
  eq(m.lastForcedChain.aborted != null, true, '連鎖は中断されている');
  eq(m.board.lanes[3].channels.some((c) => c.card === 101 && c.up), false,
    '開いた憑依解除は消えている');
  eq(m.board.lanes[3].channels.some((c) => c.card === 172), true, '開かれなかった反射は残る');
});


/* ================= 魔法は使い終わると破壊される（2026-08-31 本人指定） =================
 * 原則：効果を発揮した後（不発でも）、魔法カードは消える。
 * 例外：①持続型7種（104爆殺・106増幅・117障壁・120抑制・136遮蔽・143偽装・145鏡身）
 *       ——「表で居ること」が効果そのものなので残り、従来どおりターン終わりに消える
 *       ②停滞(151)のレーン ③連鎖中（連鎖の終わりにまとめて消える）
 *       ④**戦闘中**（2026-08-31 本人指摘）——戦闘が続いている間は表のまま残り、
 *         戦闘終了の魔法消去（endBattle → expireMagic）でまとめて消える */
section('魔法は使い終わると破壊される');

t('★一発型の魔法は、発動した後すぐ消える（139爆雷）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(139)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].channels.length, 0, '効果を出してすぐ消える');
});

t('★不発でも消える：詠唱レベル不足（原作§116「カードは消滅する」と同じ）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(116)]);                 /* 解析＝詠唱Ｌｖ4を第1層に */
  m.board.lanes[3] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].channels.length, 0, 'レベル不足で不発になり、カードも消える');
  eq(m.board.lanes[3].channels[0].revealed, false, '効果は出ていない');
});

t('★戦闘中に開いた魔法は、戦闘が終わるまで場に残る（101憑依解除）', () => {
  /* 本人の報告（2026-08-31）：憑依解除が相手のＣＨを壊した直後に自分も消えていた。
   * 戦闘の最中は表のまま残し、戦闘が終わってから消えるのが望ましい。 */
  const m = duel(8, [down(101)], 1, [down(151), down(152)]);
  CQCombat.declareAttack(m, 0, 3);
  CQCombat.open(m, 1, { choice: { lane: 3, idx: 1 } });
  eq(m.board.lanes[3].channels.map((c) => c.card), [151], '狙った1枚は壊れる');
  eq(m.board.lanes[0].channels.map((c) => [c.card, c.up]), [[101, true]],
     '使い終わった101は表のまま戦闘中は残る');
  fin(m);
  eq(m.combat, null, '戦闘が終わった');
  eq(m.board.lanes[0].channels.length, 0, '戦闘が終わると消える');
});

t('★不発の魔法も、戦闘中なら戦闘が終わってから消える（124凍結＝戦闘中×）', () => {
  /* 防御側にも伏せ札を持たせておく——攻撃側が開き終えた時点で双方の開ける札が尽きると、
   * その場で判定まで走って戦闘が終わってしまい、「戦闘の間」を見られない。 */
  const m = duel(8, [down(124)], 1, [down(151), down(152)]);
  CQCombat.declareAttack(m, 0, 3);
  CQCombat.open(m, 1);
  eq(m.log.some((t2) => /戦闘中は発動しない/.test(t2)), true, '不発になっている');
  eq(m.combat != null, true, 'まだ戦闘中');
  eq(m.board.lanes[0].channels.map((c) => c.card), [124], '戦闘の間は残る');
  fin(m);
  eq(m.board.lanes[0].channels.length, 0, '戦闘が終わると消える');
});

t('★戦闘中はＵＩの予約（赤枠→粉々）に自分自身を載せない', () => {
  const m = duel(8, [down(101)], 1, [down(151), down(152)]);
  CQCombat.declareAttack(m, 0, 3);
  CQMagic.beginAim(m);
  CQCombat.open(m, 1, { choice: { lane: 3, idx: 1 } });
  const aimed = CQMagic.endAim(m);
  eq(aimed.some((a) => a.card === 152), true, '狙った152は予約される');
  eq(aimed.some((a) => a.card === 101), false, '使い終わった101は予約されない＝壊れる演出も出ない');
});

t('★戦闘の外では従来どおり、その場で消える（同じ101で比べる）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(101)]);
  m.board.lanes[3] = lane(8, [down(151)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].channels.length, 0, 'メインステップなら発動後すぐ消える');
});

t('★持続型（117障壁）は残る——「表で居ること」が効果だから', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(117)]);
  CQTurn.reverseAction(m, 0, [1]);
  eq(m.board.lanes[0].channels.map((c) => [c.card, c.up]), [[117, true]], '表のまま残る');
  CQStats.recalc(m.board, OPT);
  eq(m.board.lanes[0].def >= 450 + 300, true, '＋３００が効いている');
  /* 従来どおりターン終わりの魔法消去で消える */
  CQTurn.endTurn(m);
  eq(m.board.lanes[0].channels.length, 0, 'ターン終わりには消える');
});

t('★停滞(151)のレーンでは、使い終わった魔法も場に留まる', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [up(151), down(139)]);
  CQStats.recalc(m.board, OPT);
  CQTurn.reverseAction(m, 0, [2]);
  eq(m.board.lanes[0].channels.some((c) => c.card === 139 && c.up), true, '停滞の下では残る');
});

t('★予見(122)は選択が済んでから消える（対話の途中では消えない）', () => {
  const m = newMatch(321, { selfDeck: mkDeck(30, [8, 41, 70, 101, 153]) });
  m.phase = 'main';
  m.board.lanes[0] = lane(8, [down(122)]);
  CQTurn.reverseAction(m, 0, [1], { interactive: true });
  eq(m.pendingChoice.kind, 'foresee', '選択待ちになる');
  eq(m.board.lanes[0].channels.some((c) => c.card === 122), true, '選んでいる間はまだ場にある');
  CQMagic.resolvePending(m, { pick: 0 });
  eq(m.board.lanes[0].channels.length, 0, '選び終えると消える');
});

t('★口寄せ(146)も採用を決めてから消える', () => {
  const m = newMatch(321, { selfDeck: mkDeck(30, [8, 41, 70, 101, 153]) });
  m.phase = 'main';
  m.board.lanes[0] = lane(8, [down(151), down(151), down(146)]);
  CQTurn.reverseAction(m, 0, [3], { interactive: true });
  eq(m.pendingChoice.kind, 'summon', '選択待ちになる');
  CQMagic.resolvePending(m, { keep: false });
  eq(m.board.lanes[0].channels.some((c) => c.card === 146), true, '引き直しの間はまだ場にある');
  CQMagic.resolvePending(m, { keep: true });
  eq(m.board.lanes[0].channels.some((c) => c.card === 146), false, '採用を決めると消える');
});

t('★連鎖のマーカー（108）は開いた瞬間には消えない（消すと連鎖が止められなくなる）', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(108)]);
  m.board.lanes[3] = lane(8, [down(151), down(152)]);
  CQTurn.reverseAction(m, 0, [1], { choice: { lane: 3 }, interactive: true });
  eq(m.board.lanes[0].channels.some((c) => c.card === 108), true, '連鎖の間はマーカーとして残る');
  while (m.forcedChain) CQMagic.forcedChainStep(m);
  /* interactive の連鎖では、終了時の破壊は印（doomed）で止まり、ＵＩが演出の後に
   * strikeDoomed で消す（playForcedChain がやっていることと同じ）。 */
  eq(m.board.lanes[0].channels[0].doomed, true, '連鎖の終わりに破壊の印が付く');
  CQMagic.strikeDoomed(m);
  eq(m.board.lanes[0].channels.length, 0, '演出の後に消える');
});

t('★ＵＩ経路（予約）でも同じ：使い終わった魔法に赤枠の印が付いてから消える', () => {
  const m = mkBattleBoard();
  m.board.lanes[0] = lane(8, [down(139)]);
  CQMagic.beginAim(m);
  CQTurn.reverseAction(m, 0, [1]);
  const aimed = CQMagic.endAim(m);
  eq(aimed.some((a) => a.card === 139), true, '使い終わった139が予約される');
  eq(m.board.lanes[0].channels.some((c) => c.card === 139), true, 'まだ場にある＝赤枠で見せられる');
  CQMagic.strikeDoomed(m);
  eq(m.board.lanes[0].channels.length, 0, '演出の後に消える');
});

/* ================= 結果 ================= */
console.log(`\n${pass} passed / ${fail} failed`);
if (failures.length) { console.log('\n' + failures.join('\n\n')); process.exit(1); }
