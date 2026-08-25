/* CardQuest — エンジン検証：自動対戦（開発用）
 *
 * 「エンジン検証」タブから、js/engine/ のターン進行と戦闘を実際に1本走らせて
 * ブラウザ上で目視確認するための画面。ゲームの本編UIではない。
 * 両陣営とも「その場で合法な行動をランダムに選ぶ」だけの単純な方策で、
 * 召還・チャネル・押し込み・リバース・アタック・デッキ攻撃・ターン終了・
 * 手札上限・ドロー・勝敗判定が一通り動くことを確認する。
 * 敵ＡＩ（M5）はまだ無いので、強さの評価には使えない。
 */
'use strict';
(function () {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('sim-run');
  if (!el) return;                              // この画面が無いページでは何もしない

  /* 検証用の簡易デッキ：召還Lv1のユニット中心＋技能・魔法少々＋空白でDECK_SIZE枚に揃える。
   * 55, 167, 169, 181, 184, 186, 199 はM4 v0.12でターン終了時処理・召還特例・
   * 操作権反転を実装した効果で、ここでもファズの対象にする。
   * 101〜148 はM4 v0.13（魔法48種）でファズの対象に追加した。
   * M4 v0.14：ユニット固有能力のうちB型（開：10体）・C型（特：14体）をファズの対象にする */
  const POOL = [8, 1, 2, 5, 7, 19, 21, 46, 55, 151, 152, 158, 165, 167, 169, 181, 184, 186, 199,
    101, 104, 107, 108, 109, 110, 113, 116, 117, 121, 123, 124, 130, 131, 133, 134, 135, 137,
    139, 141, 142, 143, 144, 148, 180,
    1, 16, 23, 24, 25, 27, 29, 30, 31, 40,
    3, 6, 9, 10, 32, 34, 35, 36, 38, 44, 45, 48, 49, 70];
  function makeDeck() {
    const deck = [];
    while (deck.length < CQTurn.DECK_SIZE) deck.push(POOL[deck.length % POOL.length]);
    return deck;
  }

  /** 配置ステップで打てる手をランダムに1つ選んで実行する（何もできなければ何もしない） */
  function autoPlacement(m) {
    const p = m.players[m.active];
    const own = CQState.lanesOf(m.active);
    // 空きレーンがあれば、召還できるユニットを1体だけ出す
    const emptyLane = own.find((i) => m.board.lanes[i].unit == null);
    if (emptyLane !== undefined) {
      const idx = p.hand.findIndex((id) => {
        const c = CARD_BY_ID[id];
        return c && c.t === 'U' && CQState.unitStats(c).lv <= 1;
      });
      if (idx >= 0) CQTurn.summon(m, emptyLane, idx);
    }
    // 自陣にユニットが居れば、手札を1枚ランダムにチャネルしてみる
    const targetLane = own.find((i) => m.board.lanes[i].unit != null);
    if (targetLane !== undefined && p.hand.length) {
      const idx = m.rng.int(0, p.hand.length - 1);
      const lane = m.board.lanes[targetLane];
      CQStats.recalc(m.board, { cards: CARD_BY_ID });
      const opts = lane.count >= lane.cap && lane.channels.length
        ? { layer: m.rng.int(1, lane.channels.length) } : undefined;
      CQTurn.channel(m, targetLane, idx, opts);
    }
  }

  /** 戦闘中のオープンフェイズを、両陣営とも「半々で開く」方策で最後まで進める */
  function autoOpenPhases(m) {
    let guard = 0;
    while (m.combat && guard++ < 40) {
      const layers = CQCombat.openableLayers(m);
      if (layers.length && m.rng.next() < 0.5) CQCombat.open(m, layers[m.rng.int(0, layers.length - 1)]);
      else CQCombat.endOpen(m);
    }
  }

  /** メインステップ：攻撃できるユニットは攻撃し、残りは1階層だけリバースを試みる */
  function autoMain(m) {
    CQState.lanesOf(m.active).forEach((i) => {
      if (m.winner || m.phase !== 'main') return;
      if (m.board.lanes[i].unit == null) return;
      const targets = CQCombat.attackTargets(m, i);
      if (targets.length) {
        CQCombat.declareAttack(m, i, targets[m.rng.int(0, targets.length - 1)]);
        autoOpenPhases(m);
        return;
      }
      if (CQCombat.canDeckAttack(m, i).ok) { CQCombat.deckAttack(m, i); return; }
      // 特殊行動（Ｃ型固有能力。M4 v0.14）：持っていれば半々でリバースより先に試す
      if (CQTurn.canSpecialAction(m, i).ok && m.rng.next() < 0.5) {
        if (CQTurn.specialAction(m, i).ok) return;
      }
      const lane = m.board.lanes[i];
      if (!lane.stiff && lane.reversePtr < lane.channels.length) {
        CQTurn.reverseAction(m, i, [lane.reversePtr + 1]);
      }
      if (CQTurn.canSpecialAction(m, i).ok) CQTurn.specialAction(m, i);
    });
  }

  function runMatch(seed, maxTurns) {
    const rng = CQRng.create(seed);
    const first = rng.next() < 0.5 ? 'self' : 'enemy';
    const m = CQTurn.createMatch({
      cards: CARD_BY_ID, rng,
      selfDeck: makeDeck(), enemyDeck: makeDeck(), first,
      opponentId: 101,                     // フリーユニット戦扱い＝戦利品の記録も確認できる
      hooks: { onMagicOpen: CQMagic.onMagicOpen, onUnitOpen: CQUnits.onUnitOpen }
    });
    let guard = 0;
    while (!m.winner && m.turn < maxTurns && guard++ < 4000) {
      CQTurn.beginTurn(m);
      if (m.winner) break;
      while (m.phase === 'discard') CQTurn.discardCard(m, m.players[m.active].hand.length - 1);
      if (m.phase === 'placement') {
        autoPlacement(m);
        CQTurn.endPlacement(m);
      }
      if (m.phase === 'main') {
        autoMain(m);
        if (m.phase === 'main') CQTurn.endTurn(m);
      }
    }
    return m;
  }

  function render(m) {
    const p1 = m.players.self, p2 = m.players.enemy;
    const resultEl = document.getElementById('sim-result');
    const status = m.winner
      ? `<b class="${m.winner === 'self' ? 'up' : 'dn'}">${m.winner === 'self' ? '自分' : '相手'}の勝ち</b>（${m.turn} 手番）`
      : `<b>決着つかず</b>（ターン上限 ${m.turn} 手番）`;
    resultEl.innerHTML = `${status}
      　自分：ＬＰ${p1.lp} 手札${p1.hand.length} デッキ${p1.deckCount}${p1.reloads ? `（再装填${p1.reloads}回）` : ''}
      　相手：ＬＰ${p2.lp} 手札${p2.hand.length} デッキ${p2.deckCount}${p2.reloads ? `（再装填${p2.reloads}回）` : ''}
      ${m.loot.length ? '　戦利品：' + m.loot.map((id) => CARD_BY_ID[id].n).join('・') : ''}`;
    document.getElementById('sim-log').textContent = m.log.join('\n');
  }

  el.addEventListener('click', () => {
    const seed = parseInt(document.getElementById('sim-seed').value, 10) || 1;
    const m = runMatch(seed, 60);
    render(m);
  });
})();
