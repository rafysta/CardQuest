/* CardQuest エンジン — 能力値計算
 *
 * 『SOULGATE 能力値計算とチャンネル』（04_channel_stats）の2段構成を忠実に移植する。
 *   第1段 aggregate()    … 原作 EV0019 page3（集計）
 *   第2段 resolveStats() … 原作 EV0171 page1（確定）
 *   recalc() が両方を順に呼ぶ。盤面が変化したら必ず recalc() を呼ぶこと。
 *
 * 忠実性の方針（実装計画 M1）：
 *   ・適用順序（突然変異→ＣＨボーナス→磁場変動→…→気化→爆殺→修練の拳）を厳守
 *   ・最終攻撃力・防御力にクランプは無い（負の値になりうる）
 *   ・「テキストと実装の食い違い」は原作実装に合わせる
 *     （五つ星は上書き／突然変異・磁場変動は奇数枚(1,3,5)のみ／膨張は2枚で打ち止め 等）
 *   ・明確なバグのみ修正する：
 *     [修正1] 超過ＣＨ消滅の無限ループ（count==2/1 の分岐欠落）→ while で書き直し
 *     [修正2] 無効(190)のレーン3が隣のレーンの魔法フラグを消す誤番地 → 自レーンを消す
 *     [修正3] 修練の拳の加算先の誤番地（攻2×防6の組み合わせ）→ 正しいレーンに加算
 *     [修正4] 突然変異＋増幅＋無効で素値が前フレームのまま残る → 「増幅中は入れ換え無効」に統一
 * DOMには依存しない。
 */
'use strict';
(function (global) {

  const S = (typeof require === 'function' && typeof window === 'undefined')
    ? require('./state.js') : global.CQState;

  /* ---- アキュムレータ ---------------------------------------------------
   * 原作のレーン別変数（V501..V881）を名前付きで持つ。
   * 「点数型」…効果量そのものを足す／「枚数型」…枚数を数え、使う側で意味づけする */
  function blankAcc() {
    return {
      berserk: 0,      // 152 狂戦士化（枚数・ブール的）
      multiAtk: 0,     // 154 連続攻撃（枚数。固有は+10）
      mShieldDef: 0,   // 153 魔力の盾：防御へ +200/枚（点数）
      mShieldAtk: 0,   // 153 魔力の盾：攻撃へ -100/枚（点数）
      plague: 0,       // 155 疫障・カース97：-250/枚（点数）
      seal: 0,         // 156 封印（枚数）
      fiveStar: 0,     // 157 五つ星（枚数）
      expand: 0,       // 158 膨張（枚数。増幅で2倍）
      lock: 0,         // 159 固定・168 石化・カース98：リバース全面禁止（枚数）
      stasis: 0,       // 151 停滞（枚数）
      mageKnight: 0,   // 161 魔道剣士（枚数・ブール的）
      fusion: 0,       // 162 融合（枚数。固有は+10）
      leap: 0,         // 163 跳躍（枚数）
      mutation: 0,     // 164 突然変異（枚数。1/3/5のみ有効）
      loner: 0,        // 165 孤高の戦士：+100/枚（点数。ソルブレードは+150）
      selfKnow: 0,     // 166 自己認識（枚数）
      rot: 0,          // 167 腐食（枚数）
      petrify: 0,      // 168 石化：防御 +200/枚（点数）
      puppet: 0,       // 169 傀儡・カース92（枚数。能力値には影響しない）
      converge: 0,     // 170 収束（枚数。×(自陣他ユニット数)×100）
      counter: 0,      // 171 迎撃（枚数）
      reflect: 0,      // 172 反射（枚数）
      pierce: 0,       // 173 貫通（枚数）
      chant: 0,        // 174 連唱（枚数）
      hide: 0,         // 175 隠遁（枚数。固有は+10）
      vapor: 0,        // 176 気化（枚数）
      undying: 0,      // 177 不死（枚数）
      resist: 0,       // 178 抵抗（枚数。固有は+10）
      salvation: 0,    // 179 救済（枚数）
      blank: 0,        // 180 空白（枚数。効果なし）
      soulGate: 0,     // 181 魂の門（枚数）
      honeymoon: 0,    // 182 蜜月：飽和時 +100/枚（点数。キリンは+150）
      shell: 0,        // 183 甲殻（枚数。固有由来はちょうど10）
      closedSkill: 0,  // 184 閉鎖・カース98（枚数）
      magnet: 0,       // 185 磁力（枚数。固有は+10）
      tome: 0,         // 186 魔道書：レベル-2/枚（点数=2/枚）
      fist: 0,         // 187 修練の拳（枚数）
      giant: 0,        // 188 巨大化：+100/枚（点数）
      kikou: 0,        // 189 気孔術：特殊攻撃+100/枚（点数）
      nullify: 0,      // 190 無効・アイスエイジ（枚数。抑制は10を書き込む）
      fieldSwap: 0,    // 191 磁場変動（枚数。1/3/5のみ有効）
      valor: 0,        // 192 勇猛：+100/枚（点数。デアデビルも+100）
      zoneRed: 0,      // 193 赤の聖霊陣（枚数）
      zoneBlue: 0,     // 194 青の聖霊陣（枚数）
      zoneWhite: 0,    // 195 白の聖霊陣（枚数）
      zoneBlack: 0,    // 196 黒の邪霊陣（枚数）
      chain: 0,        // 197 縛鎖（枚数。効きは階層単位で別管理）
      pursuit: 0,      // 198 追跡・パイロウイング・ベヒーモス（枚数）
      advent: 0,       // 199 光臨・アッシュメイカー（枚数）
      drain: 0,        // ニドヘッグ固有：戦闘開始時ＬＰドレイン（枚数）
      curseDef: 0,     // カース93/96(-150)・99(-300)：防御減（点数）
      curseChain: 0,   // カース97：憑依連鎖（枚数）
      doom: 0,         // カース94/95：ターン終了時自滅（枚数）
      /* 魔法フラグ（スイッチ型＝重複しない） */
      swBomb: false,     // 104 爆殺
      swAmplify: false,  // 106 増幅／ラクシュミー
      swBarrier: false,  // 117 障壁
      swSuppress: false, // 120 抑制
      swShroud: false,   // 136 遮蔽
      swDisguise: false, // 143 偽装
      swMirror: false    // 145 鏡身／ミラージョア
    };
  }

  /* 増幅(106)が2倍にする「数値系」21種（原作 EV0019 page3 (8)） */
  const AMP_KEYS = ['mShieldDef', 'plague', 'expand', 'mutation', 'loner', 'petrify',
    'converge', 'soulGate', 'honeymoon', 'tome', 'giant', 'kikou', 'fieldSwap', 'valor',
    'zoneRed', 'zoneBlue', 'zoneWhite', 'zoneBlack', 'mShieldAtk', 'curseDef', 'curseChain'];

  /** 封印(156)／ジャガーノート(37) の「このレーンの集計を全部消す」（M7.8 WP1）。
   *
   * 原作 06_skill.md §1-3(d)：`EV0243 page7〜12` は**1枚処理するごとに末尾で**
   * `if (S(527,L) >= 1)` を見て、そのレーンの技能値・カース値・魔法フラグを全部0にする。
   * **消えないもの**＝封印自身／抑制由来の無効(=10)／抑制フラグ／ユニット固有能力
   * （固有能力は集計の後（原作⑨）に入るので、ここで消しても後から入り直す）。
   *
   * 「1枚ごと」ではなく「そのレーンを積み終えてから1回」で等価になる——封印自身が
   * クリア対象外なので、走査順に関係なく最終結果は同じになるため（§1-3の注記）。 */
  function sealClear(acc) {
    const keepSeal = acc.seal;
    const keepSuppress = acc.swSuppress;        /* 原作は SW[732+L] をクリアしない */
    const keepNullify = (acc.nullify === 10) ? 10 : 0;   /* 抑制由来の10だけ残る */
    const b = blankAcc();
    Object.keys(b).forEach(function (k) { acc[k] = b[k]; });
    acc.seal = keepSeal;
    acc.swSuppress = keepSuppress;
    acc.nullify = keepNullify;
  }

  /* 表向きの技能カード(151〜199) → アキュムレータ加算（原作 EV0243 page7〜12） */
  function accSkill(acc, id) {
    switch (id) {
      case 151: acc.stasis += 1; break;
      case 152: acc.berserk += 1; break;
      case 153: acc.mShieldDef += 200; acc.mShieldAtk += 100; break;
      case 154: acc.multiAtk += 1; break;
      case 155: acc.plague += 250; break;
      case 156: acc.seal += 1; break;
      case 157: acc.fiveStar += 1; break;
      case 158: acc.expand += 1; break;
      case 159: acc.lock += 1; break;
      case 160: /* 放出：消滅処理側で扱う */ break;
      case 161: acc.mageKnight += 1; break;
      case 162: acc.fusion += 1; break;
      case 163: acc.leap += 1; break;
      case 164: acc.mutation += 1; break;
      case 165: acc.loner += 100; break;
      case 166: acc.selfKnow += 1; break;
      case 167: acc.rot += 1; break;
      case 168: acc.petrify += 200; acc.lock += 1; break;
      case 169: acc.puppet += 1; break;
      case 170: acc.converge += 1; break;
      case 171: acc.counter += 1; break;
      case 172: acc.reflect += 1; break;
      case 173: acc.pierce += 1; break;
      case 174: acc.chant += 1; break;
      case 175: acc.hide += 1; break;
      case 176: acc.vapor += 1; break;
      case 177: acc.undying += 1; break;
      case 178: acc.resist += 1; break;
      case 179: acc.salvation += 1; break;
      case 180: acc.blank += 1; break;
      case 181: acc.soulGate += 1; break;
      case 182: acc.honeymoon += 100; break;
      case 183: acc.shell += 1; break;
      case 184: acc.closedSkill += 1; break;
      case 185: acc.magnet += 1; break;
      case 186: acc.tome += 2; break;
      case 187: acc.fist += 1; break;
      case 188: acc.giant += 100; break;
      case 189: acc.kikou += 100; break;
      case 190: acc.nullify += 1; break;
      case 191: acc.fieldSwap += 1; break;
      case 192: acc.valor += 100; break;
      case 193: acc.zoneRed += 1; break;
      case 194: acc.zoneBlue += 1; break;
      case 195: acc.zoneWhite += 1; break;
      case 196: acc.zoneBlack += 1; break;
      case 197: acc.chain += 1; break;
      case 198: acc.pursuit += 1; break;
      case 199: acc.advent += 1; break;
    }
  }

  /* 表向きのカース(91〜99) → アキュムレータ加算 */
  function accCurse(acc, id) {
    switch (id) {
      case 91: acc.berserk += 1; break;              // 狂戦士化
      case 92: acc.puppet += 1; break;               // 傀儡化
      case 93: acc.curseDef += 150; break;
      case 94: acc.doom += 1; break;
      case 95: acc.doom += 1; break;
      case 96: acc.curseDef += 150; break;
      case 97: acc.plague += 250; acc.curseChain += 1; break;
      case 98: acc.closedSkill += 1; acc.lock += 1; break;
      case 99: acc.curseDef += 300; break;
    }
  }

  /* 表向きの魔法カード → 魔法フラグ（原作 EV0243 page1〜6） */
  function accMagicFlag(acc, id) {
    switch (id) {
      case 104: acc.swBomb = true; break;
      case 106: acc.swAmplify = true; break;
      case 117: acc.swBarrier = true; break;
      case 120: acc.swSuppress = true; break;
      case 136: acc.swShroud = true; break;
      case 143: acc.swDisguise = true; break;
      case 145: acc.swMirror = true; break;
    }
  }

  /* ユニット固有能力（原作 EV0244。26/54/62 は第1段(2)(7)で別扱い） */
  function accInnate(acc, id, lane) {
    switch (id) {
      case 2: case 5: acc.pursuit += 1; break;
      case 7: case 14: acc.counter += 1; break;
      case 11: acc.salvation += 1; break;
      case 12: case 39: case 52: acc.chant += 1; break;
      case 13: acc.drain += 1; break;
      case 15: acc.shell += 10; break;               // 値10＝防御時もオープン可の特例
      case 17: case 21: acc.multiAtk += 10; break;
      case 18: acc.honeymoon += 150; break;
      case 19: acc.leap += 1; break;
      case 20: acc.fusion += 10; break;
      case 33: acc.rot += 1; break;
      case 37: {                                     // ジャガーノート：自レーンの集計を全消去
        /* M7.8 WP1：原作（06_skill.md §4-6・07_unit_abilities.md §2-1）は魔法フラグ
         * （爆殺・増幅・障壁・遮蔽・鏡身・偽装）を**落とす**。従来はこの6つを残していて
         * 逆になっていた（＝ジャガーノートの封印が弱すぎた）。残すのは抑制だけ。 */
        sealClear(acc);
        acc.seal += 1;
        break;
      }
      case 41: acc.valor += 100; break;
      case 42: acc.resist += 10; break;
      case 43: acc.mageKnight += 1; break;
      case 46: acc.hide += 10; break;
      case 47: acc.magnet += 10; break;
      case 50: acc.loner += 150; break;
      case 51: acc.converge += 1; break;
      case 53: acc.tome += 2; break;
      case 55: acc.advent += 1; break;
      case 57: acc.reflect += 1; break;
      case 59: acc.soulGate += 1; break;
      case 60: acc.selfKnow += 1; break;
      case 61: acc.pierce += 1; break;
      case 63: acc.reflect += 1; break;              // 反射ダメージ2倍は戦闘処理側で扱う
      case 64: {                                     // マスターズソウル：装備[Ｓ]の能力
        if (lane && lane.msEquip && lane.msEquip.skill) accSkill(acc, lane.msEquip.skill);
        break;
      }
    }
  }

  /* ---- 第1段：集計（原作 EV0019 page3） -------------------------------- */
  function aggregate(board, opts) {
    const cards = opts.cards;
    const combat = opts.combat || null;
    const lanes = board.lanes;

    // (1) 全アキュムレータ消去・枚数の数え直し
    lanes.forEach(function (ln) { ln.acc = blankAcc(); ln.count = 0; });
    board.chainLocked = null;

    // (2) ユニット本体の「常時」フラグ
    lanes.forEach(function (ln) {
      if (ln.unit === 54) ln.acc.swMirror = true;                    // ミラージョア
      if (ln.unit === 62) ln.acc.swAmplify = true;                   // ラクシュミー
      if (ln.unit === 26) ln.acc.nullify += 1;                       // アイスエイジ
      if (ln.unit === 64 && ln.msEquip && ln.msEquip.skill === 190) ln.acc.nullify += 1;
    });

    // (3) 表向きチャンネル → 魔法フラグ（ユニット有無は見ない）
    lanes.forEach(function (ln) {
      ln.channels.forEach(function (ch) { if (ch.up) accMagicFlag(ln.acc, ch.card); });
    });

    // (4) 枚数カウント＋表向きチャンネルの技能・カースを積算（ユニットの居るレーンのみ）
    lanes.forEach(function (ln) {
      if (ln.unit == null) return;
      ln.channels.forEach(function (ch) {
        ln.count += 1;
        if (!ch.up) return;
        if (ch.card >= 151) accSkill(ln.acc, ch.card);
        else if (ch.card >= 91 && ch.card <= 99) accCurse(ln.acc, ch.card);
      });
      /* M7.8 WP1：封印(156) の効果本体。このレーンに封印があれば、いま積んだ技能・カースと
       * (3)で立てた魔法フラグを全部落とす（原作 06_skill.md §4-6）。
       * ユニット固有能力は (9) で後から入るので影響を受けない。 */
      if (ln.acc.seal >= 1) sealClear(ln.acc);
    });

    // (5) 戦闘中のみ：鏡身・抑制・縛鎖
    if (combat) {
      const A = lanes[combat.attacker], D = lanes[combat.defender];
      // 鏡身：相手の表向きチャンネルの技能を自分に流し込む
      [[A, D], [D, A]].forEach(function (pair) {
        const me = pair[0], other = pair[1];
        if (!me || !other || !me.acc.swMirror) return;
        other.channels.forEach(function (ch) {
          if (ch.up && ch.card >= 151) accSkill(me.acc, ch.card);
        });
      });
      /* 抑制(120)：当事者の一方が持つと**相手**の無効値を10にする（＝魔法・固有能力を封殺）。
       * M7.8 WP1：原作 06_skill.md §1-4(3) は当事者2レーンの**相互適用**。
       * 従来は攻撃側→防御側の一方向だけで、防御側に貼っても効かなかった。 */
      if (A && D) {
        if (A.acc.swSuppress) D.acc.nullify = 10;
        if (D.acc.swSuppress) A.acc.nullify = 10;
      }
      // 縛鎖：攻撃側の表向き縛鎖(197)がある階層は、防御側がオープンできない（封印で無効）
      if (A && A.acc.seal === 0) {
        const locked = [];
        A.channels.forEach(function (ch, i) {
          if (ch.up && ch.card === 197) locked.push(i + 1);        // 階層は1始まり
        });
        if (locked.length) board.chainLocked = locked;
      }
    }

    // (6) 無効(190)が魔法フラグを消す
    //     [修正2] 原作はレーン3が隣レーンのフラグを消す誤番地。自レーンを消すよう修正済み
    lanes.forEach(function (ln) {
      if (ln.acc.nullify >= 1) {
        ln.acc.swBomb = ln.acc.swAmplify = ln.acc.swBarrier = ln.acc.swShroud =
          ln.acc.swMirror = ln.acc.swDisguise = ln.acc.swSuppress = false;
      }
    });

    // (7) ミラージョア／ラクシュミーのフラグを再設定（無効の後＝無効化されない）
    lanes.forEach(function (ln) {
      if (ln.unit === 54) ln.acc.swMirror = true;
      if (ln.unit === 62) ln.acc.swAmplify = true;
    });

    // (8) 増幅：数値系アキュムレータ21種を2倍（無効があるレーンでは倍化しない）
    lanes.forEach(function (ln) {
      if (ln.acc.nullify === 0 && ln.acc.swAmplify) {
        AMP_KEYS.forEach(function (k) { ln.acc[k] *= 2; });
      }
    });

    // (9) ユニット固有能力（増幅の後＝倍化されない）
    lanes.forEach(function (ln) {
      if (ln.unit != null) accInnate(ln.acc, ln.unit, ln);
    });

    // (10) 抵抗(178)は融合(162)を打ち消す
    lanes.forEach(function (ln) {
      if (ln.acc.resist >= 1 && ln.acc.fusion >= 1) ln.acc.fusion = 0;
    });

    // (10b) 傀儡ロック（★M7.8 WP6・原作 EV0019 page3 ⑪）。
    //   傀儡(169)・カース92は**レーンごと相手陣営へ移動する**方式になった（移動そのものは
    //   盤面を書き換える処理なので、純粋な集計であるここには置かず combat.js の enforcePost が
    //   `acc.puppet` を見て行う）。ここでは、**敵レーン(3〜5)に移されているユニット**に
    //   固定(159)相当のロックを掛けるだけ——原作はＡＩが傀儡カードをリバースして外すのを
    //   封じるためにこれを敵レーン限定で入れている（自陣レーン1〜3には同等処理が無い）。
    //   従来の `flipped`（操作権の反転）は廃止。操作側＝居る場の陣営になった。
    //   ロックは**非戦闘時だけ**（原作⑪「敵レーンのみ・非戦闘時」）——戦闘中に掛けると
    //   防御側オープンフェイズが丸ごと飛ばされてしまう（固定・石化と同じ扱いになる）
    if (!combat) {
      lanes.forEach(function (ln, i) {
        if (ln.unit != null && ln.puppeted && S.sideOf(i) === 'enemy') ln.acc.lock += 1;
      });
    }

    // (11) 陣営集計（霊陣）・(12) ユニット数など
    board.sideAgg = {};
    ['self', 'enemy'].forEach(function (side) {
      const ls = S.lanesOf(side).map(function (i) { return lanes[i]; });
      const sum = function (k) {
        return ls.reduce(function (s, ln) { return s + (ln.unit != null ? ln.acc[k] : 0); }, 0);
      };
      board.sideAgg[side] = {
        red: sum('zoneRed') * 50,
        blue: sum('zoneBlue') * 50,
        white: sum('zoneWhite'),
        black: sum('zoneBlack') * 150,
        units: ls.filter(function (ln) { return ln.unit != null; }).length
      };
    });
  }

  /* ---- 第2段：確定（原作 EV0171 page1） -------------------------------- */
  function resolveStats(board, opts) {
    const cards = opts.cards;
    const combat = opts.combat || null;
    const lanes = board.lanes;
    const removed = [];

    let again = true;
    while (again) {
      again = false;

      lanes.forEach(function (ln, L) {
        // 戦闘中は当事者以外のレーンを更新しない（値が凍結される。原作準拠）
        if (combat && L !== combat.attacker && L !== combat.defender) return;
        if (ln.unit == null) { ln.atk = 0; ln.def = 0; ln.cap = 0; ln.free = 0; ln.atkBonus = 0; return; }

        const side = S.sideOf(L);
        const myHand = board.hand[side];
        const opHand = board.hand[S.otherSide(side)];
        const acc = ln.acc;
        const us = S.unitStats(cards[ln.unit], ln.msEquip);

        // ① 素の攻撃力・防御力
        let baseAtk = us.a, baseDef = us.d;
        if (ln.unit === 4) { baseAtk = baseDef = myHand * 100; }     // スキュラセル

        // ② 突然変異(164)：素値の入れ換え（1/3/5枚のときのみ）
        //    [修正4] 増幅併用時は「入れ換え無効」に統一（原作は前フレーム値が残るバグ）
        const mutOdd = acc.mutation === 1 || acc.mutation === 3 || acc.mutation === 5;
        let midAtk, midDef;
        if (mutOdd && !acc.swAmplify) { midAtk = baseDef; midDef = baseAtk; }
        else { midAtk = baseAtk; midDef = baseDef; }

        // ③ ＣＨ上限
        let cap;
        if (acc.fiveStar === 0) {
          cap = ln.baseCh;
          if (acc.expand >= 1) cap += 2;
          if (acc.expand >= 2) cap += 2;                              // 3枚以上でも+4で打ち止め
          cap += board.sideAgg[side].white;                           // 白の聖霊陣（陣営全体）
        } else {
          cap = 5;                                                    // 五つ星は完全上書き
        }
        if (cap > 6) cap = 6;
        if (acc.swShroud) cap = ln.count;                             // 遮蔽
        if (acc.closedSkill >= 1) cap = ln.count;                     // 閉鎖
        // M6 戦場ルール laneCap（「石詰まり」）：そのレーンの上限を最後に頭打ちにする。
        // 五つ星(157)の上書きも膨張(158)の加算も遮蔽・閉鎖も済んだ後に掛けるので、
        // 既存の上限解決順序に新しい規則を足さずに「岩でそれより上に置けない」だけが実現される
        const fcap = board.fieldCap ? board.fieldCap[L] : null;
        if (fcap != null && cap > fcap) cap = fcap;
        ln.cap = cap;

        // ④ 最終値を素値で初期化＋リヴァイバー（ＣＨボーナス扱いになる）
        let atk = midAtk, def = midDef;
        if (ln.unit === 58) { atk += opHand * 50; def += opHand * 50; }

        // ⑤ 空き枠
        const free = cap - ln.count;
        ln.free = free;

        // ⑥ チャンネル1枚ごとの±100（種別を問わず一律）
        ln.channels.forEach(function (ch) {
          if (!ch.up) {
            if (acc.berserk >= 1) atk += 100;                         // 狂戦士化：裏も攻撃力へ
            else def += 100;
          } else {
            atk += 100;
            if (acc.mageKnight >= 1 && ch.card >= 101 && ch.card <= 150) atk += 50;  // 魔道剣士
          }
        });

        // ⑦ ＣＨボーナス量を退避
        let atkBonus = atk - midAtk;
        let defBonus = def - midDef;

        // ⑧ 磁場変動(191)：ボーナスの入れ換え（1/3/5枚のときのみ）
        const fsOdd = acc.fieldSwap === 1 || acc.fieldSwap === 3 || acc.fieldSwap === 5;
        if (fsOdd) {
          atk = midAtk + defBonus;
          def = midDef + atkBonus;
          const t = atkBonus; atkBonus = defBonus; defBonus = t;
        }
        ln.atkBonus = atkBonus;                                       // 修練の拳・ＡＩが参照

        // ⑨ 霊陣（陣営全体）
        const agg = board.sideAgg[side];
        if (agg.red >= 1) atk += agg.red;
        if (agg.blue >= 1) def += agg.blue;
        if (agg.black >= 1) { atk -= agg.black; def -= agg.black; }

        // ⑩ 勇猛(192)：戦闘中・自分が攻撃側・相手のＣＨ上限が自分より大きいとき
        if (combat && L === combat.attacker && acc.valor >= 1) {
          const D = lanes[combat.defender];
          if (D && D.unit != null && D.cap > cap) atk += acc.valor;
        }

        // ⑪〜⑲ 個別の加減算（互いに独立）
        if (acc.giant >= 1) { atk += acc.giant; def += acc.giant; }                  // 巨大化
        if (acc.converge >= 1) atk += (agg.units - 1) * acc.converge * 100;          // 収束
        if (acc.mShieldDef >= 1) { atk -= acc.mShieldAtk; def += acc.mShieldDef; }   // 魔力の盾
        if (acc.curseDef >= 1) def -= acc.curseDef;                                  // カース
        if (acc.plague >= 1) { atk -= acc.plague; def -= acc.plague; }               // 疫障
        const aloneMates = S.lanesOf(side).filter(function (i) {
          return i !== L && lanes[i].unit != null;
        }).length;
        if (aloneMates === 0 && acc.loner >= 1) atk += acc.loner;                    // 孤高の戦士
        if (acc.petrify >= 1) def += acc.petrify;                                    // 石化
        if (acc.swBarrier) def += 300;                                               // 障壁（重複しない）
        if (acc.swDisguise) atk += free * 100;                                       // 偽装
        if (acc.honeymoon >= 1 && free === 0) atk += acc.honeymoon;                  // 蜜月

        // ⑳ 気化(176)：すべて上書き
        if (acc.vapor >= 1) { atk = 0; def = 0; }

        ln.atk = atk;
        ln.def = def;
      });

      // ㉑ 爆殺(104)：全レーン計算後、飽和しているレーンだけ +250（気化の後なので気化でも+250される）
      //    ※戦闘中の凍結レーンには適用しない（原作は凍結レーンにも重ね掛けされうるが、
      //      繰り返し再計算で値が際限なく増えるため、更新したレーンだけに限定する）
      lanes.forEach(function (ln, L) {
        if (combat && L !== combat.attacker && L !== combat.defender) return;
        if (ln.unit == null) return;
        if (ln.acc.swBomb && ln.cap === ln.count) ln.atk += 250;
      });

      // ㉒ 修練の拳(187)：戦闘中・攻撃側のみ。相手のＣＨ攻撃ボーナスを丸ごと奪う
      //    [修正3] 原作の誤番地（別レーンに加算）は正しいレーンに修正済み
      if (combat) {
        const A = lanes[combat.attacker], D = lanes[combat.defender];
        if (A && D && A.unit != null && D.unit != null && A.acc.fist >= 1) {
          A.atk += D.atkBonus;
          D.atk -= D.atkBonus;
        }
      }

      // ㉓ 超過ＣＨ消滅：上限を超えた枚数を最上段から消し、全体を計算し直す
      //    [修正1] 原作の分岐欠落による無限ループを while で解消
      lanes.forEach(function (ln, L) {
        while (ln.unit != null && ln.count > ln.cap) {
          const ch = ln.channels.pop();
          ln.count -= 1;
          removed.push({ lane: L, card: ch ? ch.card : 0 });
          again = true;                       // 枚数が変わったので再計算（原作の goto label 1）
        }
      });
    }

    // ㉔ 自己認識(166)：相手が置いた裏向きカードの中身が判明する
    board.lanes.forEach(function (ln, L) {
      if (ln.unit == null || ln.acc.selfKnow < 1) return;
      const mineSide = S.sideOf(L) === 'self';
      ln.channels.forEach(function (ch) {
        const placedByOpponent = mineSide ? !ch.mine : ch.mine;
        if (placedByOpponent && !ch.up) ch.revealed = true;
      });
    });

    return removed;
  }

  /** 集計→確定を通しで行う。盤面が変化したら必ず呼ぶこと。
   * opts = { cards: CARD_BY_ID, combat: null | { attacker, defender } }
   * 返り値 { removed: [{lane, card}] } … 超過ＣＨ消滅で消えたカード */
  function recalc(board, opts) {
    aggregate(board, opts);
    const removed = resolveStats(board, opts);
    return { removed: removed };
  }

  const api = { recalc, aggregate, resolveStats, blankAcc, AMP_KEYS };
  global.CQStats = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
