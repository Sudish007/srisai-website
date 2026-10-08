// sw.js — Sri Sai Hospital service worker.
// BUMP `VERSION` ON EVERY DEPLOY: the static cache name is derived from it, so a new
// version replaces the old shell on the next visit (old srisai-* caches are deleted on activate).
// All paths are relative to this file's URL, which keeps the GitHub Pages subpath working.
//
// Routing rules (GET + http(s) only — anything else is not handled):
//   same-origin static            → stale-while-revalidate (instant from cache, refreshed in the
//                                   background so a deploy without a VERSION bump still reaches
//                                   returning visitors on their next visit; navigate failures fall
//                                   back to ./index.html)
//   SUPABASE /storage/v1/*        → cache-first (doctor photos, product images)
//   SUPABASE public REST tables   → network-first, cached copy when offline
//   esm.sh + Google Fonts         → stale-while-revalidate
//   Supabase auth, edge functions, RPC, appointments, any non-GET → never touched

const VERSION = 'v2.0.0';
const STATIC = 'srisai-static-' + VERSION;
const DATA = 'srisai-data-v1';
const SUPABASE = 'https://blpptbmezfzkdctzxafs.supabase.co';
const SWR_ORIGINS = ['https://esm.sh', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
const PUBLIC_REST = /^\/rest\/v1\/(settings|categories|medicines|doctors|services|banners|reviews)(\?|$)/;

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './i18n.js',
  './ui.js',
  './content-i18n.js',
  './manifest.webmanifest',
  './icon.svg',
  './privacy.html',
  './terms.html',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('srisai-') && k !== STATIC && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName, evt) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const refresh = fetch(req)
    .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
    .catch((err) => { if (hit) return hit; throw err; }); // offline refresh must not surface as an unhandled rejection
  if (hit) evt?.waitUntil(refresh.catch(() => {})); // keep the worker alive until the background refresh lands
  return hit || refresh;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  if (url.origin === self.location.origin) {
    e.respondWith(staleWhileRevalidate(req, STATIC, e).catch(async (err) => {
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }));
    return;
  }

  if (url.origin === SUPABASE) {
    if (url.pathname.startsWith('/storage/v1/')) { e.respondWith(cacheFirst(req, DATA)); return; }
    if (PUBLIC_REST.test(url.pathname + url.search)) { e.respondWith(networkFirst(req, DATA)); return; }
    return; // auth, functions, rpc, appointments, … → browser handles it
  }

  if (SWR_ORIGINS.includes(url.origin)) e.respondWith(staleWhileRevalidate(req, DATA, e));
});
