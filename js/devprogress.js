/* CardQuest — デバッグメニュー「⏩ 進行を進める」のパネル（2026-09-06・本人指定）
 *
 * 全部を自分で通しプレイして確認するのが難しくなってきたので、ゲームの進行を次の段階まで
 * 進めた状態を作れるようにする。中身の組み立ては js/devpresets.js（DOM非依存・Nodeから
 * テスト可）に置き、ここは**フォームと localStorage への読み書きだけ**を持つ。
 *
 *   💾 セーブスロット … 手動3つ（cqdev_slot1〜3）＋「直前の状態」1つ（cqdev_slot_auto）。
 *                 いまの cq_meta／cq_run を文字列のまま（バックアップと同じ「1バイトも変えない」
 *                 方式）日時・版・要約と一緒に取っておき、いつでも読み込める。①と③は適用の前に
 *                 **自動枠だけ**を上書きする——手動スロットには決して触らない（2026-09-06：
 *                 1世代の自動退避だけだったときに、続けて2回適用して元の状態を失った反省）。
 *                 キーを cq_ で始めないのは、バックアップ（js/meta/backup.js＝cq_* 全部）に
 *                 混ぜないため。開発者モードの中に置くのは、ラン途中まで戻せるスロットが
 *                 プレイヤーに渡るとリタイヤ／ゲームオーバーの清算が意味を失うため。
 *   ① プリセット … 5つの到達点から cq_meta を丸ごと作り直してホームへ。
 *   ② 少し動かす … 記憶データを +N種（19→20種でLv2、のような境目の確認）／
 *                 いまのランを勝利で終える（清算→称号→日誌→エリア解放の一連を本物の流れで）。
 *   ③ ボス戦へ直行 … エリア・ＬＰ・初回／周回・顔／客分・累計クリア数・初回撃破済みかを指定して、
 *                 ボスマスの1つ手前に立った状態のランを作る。そこから先は本物の流れ。
 *
 * デバッグメニュー（js/debug.js）から開かれる。開発者モードのときだけ届く画面なので、
 * ここで作った状態が本番のセーブに残ることはある——それが目的なので、スロットで守る。
 */
'use strict';

const CQDevProgress = (function () {

  const SLOT_KEYS = { 1: 'cqdev_slot1', 2: 'cqdev_slot2', 3: 'cqdev_slot3', auto: 'cqdev_slot_auto' };
  const OLD_STASH_KEY = 'cqdev_stash';   /* 1世代退避だった頃のキー。見つけたら自動枠へ移す */

  function storage() { return (typeof RUN_STORAGE !== 'undefined') ? RUN_STORAGE : null; }

  /* ---- 💾 セーブスロット ----------------------------------------------------- */

  function readSlot(id) {
    const s = storage();
    if (!s || !SLOT_KEYS[id]) return null;
    try { const raw = s.getItem(SLOT_KEYS[id]); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }

  /** いまの cq_meta／cq_run をスロットへ。中身は文字列のまま。要約は保存時に作って持たせる
   * （読むたびに JSON.parse しなくてよいように）。 */
  function saveSlot(id) {
    const s = storage();
    if (!s || !SLOT_KEYS[id]) return false;
    const metaStr = s.getItem('cq_meta'), runStr = s.getItem('cq_run');
    let meta = null, run = null;
    try { meta = metaStr ? JSON.parse(metaStr) : null; run = runStr ? JSON.parse(runStr) : null; } catch (_) { /* 要約だけ諦める */ }
    const data = {
      savedAt: new Date().toISOString(),
      version: (typeof APP_VERSION === 'string') ? APP_VERSION : '',
      summary: CQDevPresets.summarize(meta, run),
      meta: metaStr, run: runStr
    };
    try { s.setItem(SLOT_KEYS[id], JSON.stringify(data)); } catch (_) { return false; }
    return true;
  }

  function loadSlot(id) {
    const s = storage();
    const st = readSlot(id);
    if (!s || !st) return false;
    if (st.meta != null) s.setItem('cq_meta', st.meta); else s.removeItem('cq_meta');
    if (st.run != null) s.setItem('cq_run', st.run); else s.removeItem('cq_run');
    return true;
  }

  /** 旧・1世代退避（cqdev_stash）が残っていれば自動枠へ移す（自動枠が空のときだけ）。 */
  function migrateOldStash() {
    const s = storage();
    if (!s) return;
    const raw = s.getItem(OLD_STASH_KEY);
    if (!raw) return;
    try {
      if (!s.getItem(SLOT_KEYS.auto)) {
        const old = JSON.parse(raw);
        let meta = null, run = null;
        try { meta = old.meta ? JSON.parse(old.meta) : null; run = old.run ? JSON.parse(old.run) : null; } catch (_) { /* 要約だけ諦める */ }
        s.setItem(SLOT_KEYS.auto, JSON.stringify({
          savedAt: old.savedAt, version: '', summary: CQDevPresets.summarize(meta, run), meta: old.meta, run: old.run
        }));
      }
      s.removeItem(OLD_STASH_KEY);
    } catch (_) { /* 壊れていたら捨てる */ s.removeItem(OLD_STASH_KEY); }
  }

  function slotLabel(id) {
    const st = readSlot(id);
    if (!st) return '<span class="dbg-dim">（空）</span>';
    const d = new Date(st.savedAt);
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    return '<b>' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hh + ':' + mm + '</b>　' + esc(st.summary || '');
  }

  function slotsHTML() {
    const rows = [1, 2, 3].map(function (i) {
      const has = !!readSlot(i);
      return '<div class="dbg-slot"><span class="dbg-slot-n">スロット' + i + '</span>'
        + '<span class="dbg-slot-l" data-slot-label="' + i + '">' + slotLabel(i) + '</span>'
        + '<button class="tiny" data-act="slot-save" data-slot="' + i + '">保存</button>'
        + '<button class="tiny" data-act="slot-load" data-slot="' + i + '"' + (has ? '' : ' disabled') + '>読み込み</button></div>';
    }).join('');
    const hasAuto = !!readSlot('auto');
    return rows
      + '<div class="dbg-slot dbg-slot-auto"><span class="dbg-slot-n">直前の状態<small>（自動）</small></span>'
      + '<span class="dbg-slot-l" data-slot-label="auto">' + slotLabel('auto') + '</span>'
      + '<span></span>'
      + '<button class="tiny" data-act="slot-load" data-slot="auto"' + (hasAuto ? '' : ' disabled') + '>読み込み</button></div>';
  }

  function refreshSlots() {
    const box = panel && panel.querySelector('#dp-slots');
    if (box) box.innerHTML = slotsHTML();
  }

  function confirmThen(msg, yesLabel, then) {
    if (typeof showConfirm === 'function') return showConfirm(msg, then, yesLabel);
    then();
  }

  function onSlotSave(id) {
    const doSave = function () {
      say(saveSlot(id) ? 'スロット' + id + 'に保存しました。' : '保存できませんでした（localStorage が使えない？）。');
      refreshSlots();
    };
    if (readSlot(id)) return confirmThen('スロット' + id + 'には既に保存があります。\n上書きしますか？', '上書き', doSave);
    doSave();
  }

  function onSlotLoad(id) {
    if (inBattle()) return say('<b>戦闘中は使えません。</b>決着してから使ってください。');
    if (!readSlot(id)) return say('そのスロットは空です。');
    const name = id === 'auto' ? '直前の状態' : 'スロット' + id;
    confirmThen(name + 'を読み込みます。\nいまの状態は消えます（必要なら先に別のスロットへ保存）。\nよろしいですか？', '読み込む', function () {
      if (!loadSlot(id)) return say('読み込めませんでした。');
      reloadFromSave();
      closeAll();
    });
  }

  /* ---- 共通 ------------------------------------------------------------------- */

  function inBattle() {
    return (typeof RUN_ACTIVE !== 'undefined') && RUN_ACTIVE
      && typeof M !== 'undefined' && M && !M.winner && !M.fled;
  }

  /** ラン画面の状態を捨てて、セーブから読み直す（プリセット適用・復元の後）。 */
  function reloadFromSave() {
    if (typeof RUN_ACTIVE !== 'undefined') { RUN_ACTIVE = false; runOverHook = null; }
    RUI.run = null;
    runInit();
    showScreen('screen-run');
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---- 描画 ------------------------------------------------------------------- */

  let panel = null, out = null, back = null;

  function areaOptions() {
    return CQAreas.list().map(function (a) {
      return '<option value="' + a.id + '">' + esc(a.name) + '</option>';
    }).join('');
  }

  function masterOptions(areaId) {
    const area = CQAreas.get(areaId);
    if (!area || area.bossId == null) return '<option value="">（なし）</option>';
    const pool = area.bossPool || [area.bossId];
    return '<option value="">自動（初回＝顔／周回＝抽選）</option>' + pool.map(function (mid) {
      const nm = CQOpponents.displayName(mid) || ('マスター' + mid);
      return '<option value="' + mid + '">' + esc(nm) + (mid === area.bossId ? '（顔）' : '（客分）') + '</option>';
    }).join('');
  }

  function html() {
    const presets = CQDevPresets.list().map(function (p, i) {
      return '<label class="dbg-radio"><input type="radio" name="dp-preset" value="' + p.key + '"' + (i === 0 ? ' checked' : '') + '>'
        + '<span><b>' + esc(p.label) + '</b><small>' + esc(p.hint) + '</small></span></label>';
    }).join('');
    const lp0 = (RUI.meta ? CQCollection.startLp(CQCollection.masterLevelOf(RUI.meta)) : 10);
    return '<div class="dbg-menu-h"><button class="dbg-back" data-act="back">←</button>⏩ 進行を進める'
      + '<span class="dbg-menu-v">dev</span></div>'
      + '<div class="dbg-form">'
      /* 💾 */
      + '<div class="dbg-sec">💾 セーブスロット<small>①③を使う前に、戻りたい状態を好きなスロットへ保存。「直前の状態」は①③の適用時に自動で上書きされる保険</small></div>'
      + '<div id="dp-slots">' + slotsHTML() + '</div>'
      /* ① */
      + '<div class="dbg-sec">① 進行状態のプリセット<small>いまの状態は「直前の状態」に残るだけです。中断中のランは消えます</small></div>'
      + presets
      + '<label class="dbg-check"><input type="checkbox" id="dp-milestone" checked> ホームで節目の演出（レベルアップ・エリア解放）を出す</label>'
      + '<div class="dbg-btn-row"><button class="tiny ok" data-act="preset">適用</button></div>'
      /* ② */
      + '<div class="dbg-sec">② 少し動かす<small>退避はしません（+Nは本に1枚ずつ増えるだけ）</small></div>'
      + '<div class="dbg-btn-row">記憶データを <button class="tiny" data-act="known" data-n="1">+1種</button>'
      + '<button class="tiny" data-act="known" data-n="5">+5種</button>'
      + '<button class="tiny" data-act="known" data-n="10">+10種</button></div>'
      + '<div class="dbg-btn-row"><button class="tiny" data-act="win-run">🏁 いまのランを勝利で終える</button>'
      + '<small>清算・称号・日誌・エリア解放まで本物の流れで通す</small></div>'
      /* ③ */
      + '<div class="dbg-sec">③ ボス戦へ直行<small>ランを作り、ボスマスの1つ手前に立ちます（いまの状態は「直前の状態」に残ります）</small></div>'
      + '<div class="dbg-grid">'
      + '<label>エリア<select id="dp-area">' + areaOptions() + '</select></label>'
      + '<label>マスター<select id="dp-master">' + masterOptions(CQAreas.ORDER[0]) + '</select></label>'
      + '<label>ＬＰ<input type="number" id="dp-lp" min="1" max="' + CQCollection.LP_CAP + '" value="' + lp0 + '"></label>'
      + '<label>訪問<select id="dp-repeat"><option value="">セーブどおり</option><option value="0">初回</option><option value="1">周回</option></select></label>'
      + '<label>累計クリア（適用前）<select id="dp-clears">' + [0, 1, 2, 3, 4, 5, 6].map(function (n) {
        return '<option value="' + n + '"' + (n === 0 ? ' selected' : '') + '>' + n + '回' + (n === 2 || n === 4 || n === 6 ? '（次で部屋報酬）' : '') + '</option>';
      }).join('') + '</select></label>'
      + '<label>そのマスター<select id="dp-beaten"><option value="">セーブどおり</option><option value="0">まだ倒していない（初回の一枚が出る）</option><option value="1">倒したことがある</option></select></label>'
      + '</div>'
      + '<div class="dbg-btn-row"><button class="tiny ok" data-act="boss">直行</button></div>'
      + '</div>'
      + '<div class="dbg-out" id="dbg-out"></div>';
  }

  function say(msg) {
    const el = panel && panel.querySelector('#dbg-out');
    if (el) el.innerHTML = msg;
  }

  /* ---- 操作 ------------------------------------------------------------------- */

  function applyPreset() {
    if (inBattle()) return say('<b>戦闘中は使えません。</b>決着してから使ってください。');
    const key = (panel.querySelector('input[name="dp-preset"]:checked') || {}).value;
    const milestone = !!panel.querySelector('#dp-milestone').checked;
    if (!key) return say('プリセットを選んでください。');
    if (!saveSlot('auto')) return say('「直前の状態」を残せませんでした（localStorage が使えない？）。中止します。');
    const meta = CQDevPresets.build(key, CARD_BY_ID, { milestone: milestone });
    CQSave.saveMeta(RUN_STORAGE, meta);
    CQSave.clearRun(RUN_STORAGE);
    reloadFromSave();
    closeAll();
  }

  function addKnown(n) {
    if (!RUI.meta) return say('メタが読み込まれていません。');
    const before = CQCollection.masterLevelOf(RUI.meta);
    const added = CQDevPresets.addKnown(RUI.meta, CARD_BY_ID, n);
    CQSave.saveMeta(RUN_STORAGE, RUI.meta);
    const after = CQCollection.masterLevelOf(RUI.meta);
    const names = added.map(function (id) { return CARD_BY_ID[id] ? CARD_BY_ID[id].n : id; }).join('・');
    say('記憶データ ' + RUI.meta.known.length + '種（+' + added.length + '：' + esc(names) + '）'
      + (after > before ? '<br><b>マスターレベル ' + before + '→' + after + '</b>。ホームへ戻ると節目が出ます。' : ''));
    if (typeof runRender === 'function') runRender();
  }

  function winRun() {
    const run = RUI.run;
    if (!run) return say('進行中のランがありません。');
    if (inBattle()) return say('<b>戦闘中は使えません。</b>「⚔ バトルをスキップ」で決着させてから。');
    if (run.outcome) return say('このランはもう終わっています。');
    run.outcome = 'win';
    run.lootPending = [];
    run.log.push('（デバッグ）勝利で終了');
    advanceAfterBattle();
    showScreen('screen-run');
    runRender();
    closeAll();
  }

  function bossJump() {
    if (inBattle()) return say('<b>戦闘中は使えません。</b>決着してから使ってください。');
    const areaId = panel.querySelector('#dp-area').value;
    const area = CQAreas.get(areaId);
    if (!area) return say('エリアが不明です。');
    const masterV = panel.querySelector('#dp-master').value;
    const lpV = panel.querySelector('#dp-lp').value;
    const repeatV = panel.querySelector('#dp-repeat').value;
    const clearsV = panel.querySelector('#dp-clears').value;
    const beatenV = panel.querySelector('#dp-beaten').value;
    if (!saveSlot('auto')) return say('「直前の状態」を残せませんでした。中止します。');

    const meta = RUI.meta;
    CQCollection.ensure(meta);
    /* 周回を指定したら、そのエリアは踏破済みでなければ辻褄が合わない（ファイトマネー半額の
     * 判定は meta.cleared を見る）ので足す。初回を指定しても cleared からは外さない
     * （砂漠の解放が山地の踏破に依存する等、他への影響が大きいため）。 */
    if (repeatV === '1' && meta.cleared.indexOf(areaId) < 0) meta.cleared.push(areaId);
    meta.clears[areaId] = +clearsV;
    const masterId = masterV !== '' ? +masterV : null;
    const pool = area.bossPool || [area.bossId];
    if (beatenV !== '') {
      /* 指定が無ければ組の全員に同じ記録を付ける（どちらが出ても同じ条件になるように） */
      (masterId != null ? [masterId] : pool).forEach(function (mid) {
        if (beatenV === '1') meta.bossWins[mid] = Math.max(1, meta.bossWins[mid] || 0);
        else delete meta.bossWins[mid];
      });
    }
    CQSave.markVisit(meta, areaId);
    CQSave.saveMeta(RUN_STORAGE, meta);

    const run = CQDevPresets.bossJumpRun(CARD_BY_ID, meta, {
      areaId: areaId,
      lp: lpV !== '' ? +lpV : null,
      repeatVisit: repeatV !== '' ? repeatV === '1' : null,
      masterId: masterId
    });
    if (typeof RUN_ACTIVE !== 'undefined') { RUN_ACTIVE = false; runOverHook = null; }
    RUI.run = run;
    RUI.nodeId = null;
    RUI.view = 'map';
    RUI.mapFadeIn = true;
    runSave();
    showScreen('screen-run');
    runRender();
    closeAll();
  }

  /* ---- 開閉 ------------------------------------------------------------------- */

  function closeAll() { if (typeof back === 'function') back(true); }

  /** debug.js から呼ばれる。panelEl の中身をこのパネルに差し替える。
   * onBack(closeMenu) … ←で元のメニューに戻す／true を渡すとメニューごと閉じる。 */
  function open(panelEl, onBack) {
    panel = panelEl; back = onBack;
    migrateOldStash();
    panel.classList.add('dbg-wide');
    panel.innerHTML = html();
    panel.querySelector('#dp-area').addEventListener('change', function (ev) {
      panel.querySelector('#dp-master').innerHTML = masterOptions(ev.target.value);
    });
    panel.addEventListener('click', function (ev) {
      const b = ev.target.closest('[data-act]');
      if (!b || !panel.contains(b)) return;
      switch (b.dataset.act) {
        case 'back': return back(false);
        case 'slot-save': return onSlotSave(isNaN(+b.dataset.slot) ? b.dataset.slot : +b.dataset.slot);
        case 'slot-load': return onSlotLoad(isNaN(+b.dataset.slot) ? b.dataset.slot : +b.dataset.slot);
        case 'preset': return applyPreset();
        case 'known': return addKnown(+b.dataset.n);
        case 'win-run': return winRun();
        case 'boss': return bossJump();
      }
    });
  }

  return { open, saveSlot, loadSlot, readSlot, SLOT_KEYS };
})();
