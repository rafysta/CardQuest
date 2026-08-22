/* CardQuest — 更新の確認とService Workerの登録
 * 仕組みは confquest と同じです。
 *   1. 起動時に version.json をキャッシュ抜きで取りに行く
 *   2. APP_VERSION と違っていたら画面上部に「更新」ボタンを出す
 *   3. 押すと Cache Storage と Service Worker を全部消して読み直す
 */
'use strict';

async function fetchServerVersion() {
  const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`サーバーから取得できません (${res.status})`);
  return res.json();
}

async function purgeAll() {
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }
}

function hardReload() {
  const base = location.href.split('?')[0].split('#')[0];
  location.replace(`${base}?v=${Date.now()}`);
}

function showUpdateBar(v) {
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;left:0;right:0;top:0;z-index:99;display:flex;align-items:center;gap:14px;' +
    'padding:10px 16px;background:#facc15;color:#241c00;font-weight:800;font-size:18px';
  bar.innerHTML = `<span>新しいバージョン v${v} があります</span>`;
  const btn = document.createElement('button');
  btn.textContent = '更新';
  btn.style.cssText =
    'margin-left:auto;height:44px;padding:0 24px;border-radius:10px;background:#241c00;' +
    'color:#facc15;font-weight:800;font-size:18px;border:none';
  btn.onclick = async () => { bar.firstChild.textContent = '更新中...'; await purgeAll(); setTimeout(hardReload, 400); };
  bar.appendChild(btn);
  document.body.appendChild(bar);
}

(async function checkUpdateOnStart() {
  try {
    const info = await fetchServerVersion();
    if (info.version !== APP_VERSION) showUpdateBar(info.version);
  } catch (_) { /* オフライン時は何もしない */ }
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) sw.postMessage('skipWaiting');
      });
    });
    reg.update().catch(() => {});
  }).catch(() => {});

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}
