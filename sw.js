/*
 * Service worker: lets the dashboard open even when the tablet starts up offline,
 * and makes it installable as an app.
 *
 * Network first for the app's own files, so a published update arrives on the next
 * load; the cache is only the fallback. Sunsynk and weather requests are never
 * touched — stale live data served from a cache would be worse than none.
 */
const CACHE = 'solar-dashboard-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './core.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/version.json')) return;   // always ask the network

  // 'no-cache' revalidates with the host every time (a cheap 304 when nothing changed),
  // so the browser's own HTTP cache can never hold back a published update.
  event.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html')))
  );
});
