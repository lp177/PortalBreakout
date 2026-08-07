// PortalBreakout service worker — SOURCE TEMPLATE.
// scripts/build-sw.mjs fills in the version and precache placeholders below
// after every Vite build and writes the result to docs/sw.js.
// Never edit docs/sw.js by hand — and never mention the placeholder tokens
// anywhere but their one real use site, or the stamping rewrites this comment.
//
// Strategy (see CONTRACT.md "Offline and updates"):
//   navigation  → network-first, cache fallback   (a refresh always gets the
//                 newest HTML when online — this is the stale-version fix)
//   /assets/*   → cache-first                     (Vite hashes them, so the
//                 filename changes when the content does: safe forever)
//   other same-origin → stale-while-revalidate    (instant, refreshes behind you)
//   cross-origin → untouched                      (PeerJS broker, TURN /ice)

const VERSION = 'c2aa165a8b8c';
const CACHE = `pb-${VERSION}`;
const PRECACHE = [
  "./",
  "./assets/index-0lxNWakZ.css",
  "./assets/index-BUpdrqyb.js",
  "./icon.svg",
  "./index.html",
  "./manifest.webmanifest",
  "./vendor/peerjs.min.js"
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // reload: bypass the HTTP cache so a new worker never precaches a stale copy
    await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
    // NOTE: no skipWaiting() here on purpose. The new worker waits until the
    // player accepts the update, so a build never swaps assets mid-game.
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('pb-') && k !== CACHE)
      .map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable();
    }
    await self.clients.claim();
  })());
});

// the page asks for the waiting worker to take over (player pressed Reload)
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'VERSION') e.source?.postMessage({ type: 'VERSION', version: VERSION });
});

const networkFirst = async (e) => {
  const cache = await caches.open(CACHE);
  try {
    const preload = await e.preloadResponse;
    const fresh = preload || await fetch(e.request);
    if (fresh && fresh.ok) cache.put(e.request, fresh.clone());
    return fresh;
  } catch {
    // offline: serve the shell we precached
    return (await cache.match(e.request))
      ?? (await cache.match('./index.html'))
      ?? Response.error();
  }
};

const cacheFirst = async (req) => {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
};

const staleWhileRevalidate = async (req) => {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit ?? (await net) ?? Response.error();
};

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // broker / TURN / anything remote

  if (request.mode === 'navigate') {
    e.respondWith(networkFirst(e));
    return;
  }
  if (url.pathname.includes('/assets/')) {           // content-hashed: immutable
    e.respondWith(cacheFirst(request));
    return;
  }
  e.respondWith(staleWhileRevalidate(request));
});
