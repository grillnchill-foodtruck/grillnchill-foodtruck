/* ====================================================================
   GRILL'N CHILL – Service Worker
   Macht die Seite installierbar & offline-fähig.

   WICHTIG zur Strategie (nach Bugfix):
   - HTML, JS (index.html, i18n.js): IMMER Network-First.
     Code-Dateien dürfen NIE veraltet aus dem Cache kommen, sonst
     passen index.html und i18n.js nicht zusammen → Fehler.
   - Bilder/Icons: Stale-While-Revalidate (ändern sich selten, dürfen
     aus dem Cache kommen).
   - Netlify Functions / externe APIs: NIE cachen.
   ==================================================================== */

// Bei jedem Deploy mit Code-Änderung hochzählen!
const CACHE_VERSION = 'gnc-v153';
const CACHE_NAME = `grillnchill-${CACHE_VERSION}`;

// Nur unkritische, statische Assets vorladen (KEIN HTML/JS – die kommen frisch)
const PRECACHE_URLS = [
  '/fonts/bowlby-one-latin-400-normal.woff2',
  '/fonts/inter-latin-400-normal.woff2',
  '/fonts/inter-latin-500-normal.woff2',
  '/fonts/inter-latin-600-normal.woff2',
  '/fonts/inter-latin-700-normal.woff2',
  '/fonts/inter-latin-800-normal.woff2',
  '/logo.png',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.webmanifest',
];

// Code-Dateien, die IMMER frisch aus dem Netz geladen werden
function isCodeFile(url) {
  return url.pathname === '/' ||
         url.pathname.endsWith('.html') ||
         url.pathname.endsWith('.js');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k.startsWith('grillnchill-') && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // NIE cachen: Netlify Functions, SumUp, externe Domains (immer Netzwerk)
  if (
    url.pathname.startsWith('/.netlify/') ||
    url.pathname.startsWith('/sumup-checkout') ||
    url.pathname.startsWith('/send-email') ||
    url.pathname.startsWith('/status-update') ||
    url.pathname.startsWith('/shop-status') ||
    url.pathname.startsWith('/google-reviews') ||
    url.pathname.startsWith('/track') ||
    url.pathname.startsWith('/push-subscribe') ||
    url.pathname.startsWith('/push-send') ||
    url.pathname.startsWith('/voucher-check') ||
    url.pathname.startsWith('/retarget-optout') ||
    url.hostname !== self.location.hostname
  ) {
    return; // normaler Netzwerk-Request
  }

  // HTML + JS: NETWORK-FIRST (Code immer aktuell, Cache nur Offline-Fallback)
  if (isCodeFile(url) || request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(request).then((r) => r || caches.match('/index.html'))
        )
    );
    return;
  }

  // Bilder/Icons/sonstiges: Stale-While-Revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// Push-Benachrichtigungen (für später)
self.addEventListener('push', (event) => {
  let data = { title: 'Grilln Chill', body: 'Es gibt Neuigkeiten vom Foodtruck.' };
  try { if (event.data) data = event.data.json(); } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Grilln Chill', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(target) && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
