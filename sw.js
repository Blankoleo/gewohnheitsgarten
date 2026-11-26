/* Gewohnheits-Garten – Service Worker.
   Bei jeder Änderung an den Dateien den Cache-Namen erhöhen (garten-v4, …). */
const CACHE = 'garten-v15';
const FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './widget/gewohnheitsgarten-widget.js',
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
    // no-cache: am Server nachfragen (ETag) statt bis zu 10 Min. alten HTTP-Cache zu nehmen
    fetch(req, { cache: 'no-cache' }).then((res) => {
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

/* 2.1: Push-Mitteilungen (Herzen & Kommentare, Gieß-Erinnerung, neue Fotos).
   Jede Mitteilung wird angezeigt (iOS verlangt das). Gleicher tag = ersetzt die vorige. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  const title = String(d.title || 'Gewohnheits-Garten').slice(0, 80);
  const url = /^\.\/(\?[A-Za-z0-9=._&-]*)?$/.test(String(d.url || '')) ? d.url : './';
  e.waitUntil(self.registration.showNotification(title, {
    body: String(d.body || '').slice(0, 160),
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: String(d.tag || 'garten').slice(0, 80),
    data: { url }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const offen = list.find((c) => c.url.startsWith(self.registration.scope));
    if (offen) {
      offen.postMessage({ type: 'garten-oeffnen', url }); // App ist schon da: direkt zum Foto
      return offen.focus();
    }
    return self.clients.openWindow(url);
  }));
});
