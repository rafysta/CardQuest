/* CardQuest Service Worker
 * 方針: アプリ本体(同一オリジン)はHTTPキャッシュを完全に迂回して取得する。
 *       GitHub Pagesが返す Cache-Control によって古いファイルが使われ続けるのを防ぐため、
 *       fetch に cache:'no-store' を指定する。ネットワークが使えないときだけ Cache Storage を使う。
 */
const CACHE_VERSION = 'cardquest-v13';
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/data.js',
  './js/engine/rng.js',
  './js/engine/state.js',
  './js/engine/stats.js',
  './js/engine/turn.js',
  './js/simulate.js',
  './js/version.js',
  './js/layout.js',
  './js/update.js',
  './manifest.json',
  './version.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.allSettled(APP_SHELL.map((u) =>
        fetch(new Request(u, { cache: 'no-store' })).then((res) => res.ok && cache.put(u, res))
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(new Request(event.request.url, { cache: 'no-store', credentials: 'same-origin' }))
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request, { ignoreSearch: true }).then((c) => c || Response.error())
      )
  );
});
