// Kairos service worker: makes the site installable (Dock / Home Screen) and keeps the last copy
// of the pages for when the network drops. Network first; never touches the local API or other sites.
const CACHE = 'kairos-v2';
// The web build lists the app's own files here, so the app opens offline after the very first visit.
const PRECACHE = [];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE)
  .then(c => Promise.allSettled(PRECACHE.map(p => c.add(new URL(p, self.registration.scope).href))))
  .then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/api/')) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && r.type === 'basic') { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then(m => m || caches.match(new URL('./app/', self.registration.scope).href))));
});
