// Keeps the app usable at gigs with bad signal: the page, fonts and merch photos come from the
// phone's cache when the network is slow or gone. API calls always go to the network.
const CACHE = 'bbi-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function networkFirst(req, key, ms) {
  return caches.open(CACHE).then(cache => new Promise(resolve => {
    let done = false;
    const fallback = () => cache.match(key).then(hit => { if (!done && hit) { done = true; resolve(hit); } });
    const timer = setTimeout(fallback, ms);
    fetch(req).then(res => {
      clearTimeout(timer);
      if (res.ok) cache.put(key, res.clone());
      if (!done) { done = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      cache.match(key).then(hit => { if (!done) { done = true; resolve(hit || Response.error()); } });
    });
  }));
}
function cacheFirst(req) {
  return caches.open(CACHE).then(cache => cache.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  })));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (same && url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate' || (same && url.pathname === '/')) { e.respondWith(networkFirst(req, '/', 4000)); return; }
  if (same && SHELL.includes(url.pathname)) { e.respondWith(networkFirst(req, url.pathname, 4000)); return; }
  if ((same && url.pathname.startsWith('/img/')) || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req));
  }
});
