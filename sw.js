const CACHE_NAME = 'top10-v1';
const ASSETS = [
  './',
  './index.html',
  './icon.svg',
  './manifest.json',
];

// Install — cache app shell
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network-first for API/images, cache-first for app shell
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Wikipedia API & external images — network only (don't cache large images)
  if (url.hostname !== location.hostname) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // App shell — cache first, fallback to network
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetched = fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return resp;
      });
      return cached || fetched;
    })
  );
});
