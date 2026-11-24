/* Gewohnheits-Garten – Service Worker.
   Bei jeder Änderung an den Dateien den Cache-Namen erhöhen (garten-v4, …). */
const CACHE = 'garten-v4';
const FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Netz zuerst (mit kurzer Wartezeit), sonst Cache – so ist die App offline nutzbar
// und online immer aktuell.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Supabase (anderer Origin, auch Fotos über die RPCs) und alles Fremde nie cachen
  if (url.origin !== self.location.origin) return;

  const fromCache = () => caches.match(req, { ignoreSearch: true })
    .then((m) => m || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));

  e.respondWith(new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      fromCache().then((m) => { if (m && !done) { done = true; resolve(m); } });
    }, 2500);
    fetch(req).then((res) => {
      if (res && res.ok && !url.search) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      clearTimeout(timer);
      if (!done) { done = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      fromCache().then((m) => {
        if (!done) { done = true; resolve(m || new Response('Offline', { status: 503 })); }
      });
    });
  }));
});
