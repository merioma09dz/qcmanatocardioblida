/* =========================================================
   Anatomy Question Bank – Heart Unit  |  Phase 7 service worker
   - Precaches the app shell (HTML / CSS / JS / data / icons)
   - Caches the CDN files (Font Awesome, Google Fonts, jsPDF, html2canvas)
   - Works fully offline once cached
   Bump VERSION whenever you deploy new files so old caches are replaced.
   ========================================================= */
'use strict';

const VERSION = 'v7.0.0';
const CACHE_PREFIX = 'heart-qb-';
const CACHE_NAME = CACHE_PREFIX + VERSION;
const NETWORK_TIMEOUT = 3500;   // same-origin files: wait this long for the network, then use the cache

// Same-origin app shell (relative to the service worker's scope)
const CORE = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'data.js',
  'translations.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon.svg'
];

// Third-party files. "blocking" ones must be cached for the "ready offline" confirmation.
const CDN = [
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css', css: true, blocking: true },
  { url: 'https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&family=Poppins:wght@400;500;600;700;800&display=swap', css: true, blocking: true },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', blocking: true },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', blocking: true }
];
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

const abs = path => new URL(path, self.registration.scope).href;

/* ---------- Helpers ---------- */
function fetchWithTimeout(request, ms) {
  if (!ms) return fetch(request);
  if (request.mode === 'navigate') {
    // navigations must not be re-created with an init object (keeps redirects working)
    return Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(request, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// Downloads one file and stores it. Returns the response text for CSS files.
async function download(cache, url, opts) {
  opts = opts || {};
  const init = opts.cdn ? { mode: 'cors', credentials: 'omit' } : { cache: 'reload' };
  const res = await fetchWithTimeout(new Request(url, init), opts.timeout || 20000);
  if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status) + ' for ' + url);
  await cache.put(url, res.clone());
  return opts.text ? res.text() : null;
}

// Font files referenced by a stylesheet (woff2 only — every modern browser uses it).
function fontUrlsFrom(cssText, cssUrl) {
  const out = new Set();
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(cssText))) {
    let u;
    try { u = new URL(m[2], cssUrl).href; } catch (e) { continue; }
    if (!/\.woff2(\?|#|$)/i.test(u)) continue;
    if (/fa-brands|fa-v4compat/i.test(u)) continue;   // not used by the site
    out.add(u);
  }
  return Array.from(out);
}

const isEssentialFont = u => /fa-solid-900|fa-regular-400/i.test(u);

async function hasCached(cache, url) {
  return !!(await cache.match(url, { ignoreVary: true }));
}

/* Caches every CDN file. Returns { missing: [urls that are blocking and absent], failed: [all failures] } */
async function cacheCdn(cache) {
  const failed = [];
  const missing = [];

  await Promise.all(CDN.map(async item => {
    let cssText = null;
    try {
      cssText = await download(cache, item.url, { cdn: true, text: !!item.css });
    } catch (e) {
      if (await hasCached(cache, item.url)) {
        // offline right now, but an earlier download is still there
        if (item.css) {
          try { cssText = await (await cache.match(item.url, { ignoreVary: true })).text(); } catch (e2) { /* ignore */ }
        }
      } else {
        failed.push(item.url);
        if (item.blocking) missing.push(item.url);
        return;
      }
    }
    if (!item.css || !cssText) return;
    await Promise.all(fontUrlsFrom(cssText, item.url).map(async fu => {
      try {
        if (await hasCached(cache, fu)) return;
        await download(cache, fu, { cdn: true });
      } catch (e) {
        failed.push(fu);
        if (isEssentialFont(fu)) missing.push(fu);
      }
    }));
  }));

  return { missing: missing, failed: failed };
}

async function cacheCore(cache) {
  const missing = [];
  await Promise.all(CORE.map(async p => {
    const url = abs(p);
    try {
      await download(cache, url);
    } catch (e) {
      if (!(await hasCached(cache, url))) missing.push(p);
    }
  }));
  return missing;
}

/* ---------- Install: app shell is mandatory, CDN is best effort ---------- */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const missing = await cacheCore(cache);
    if (missing.length) throw new Error('Could not cache: ' + missing.join(', '));
    try { await cacheCdn(cache); } catch (e) { /* the "Download for offline" button retries */ }
    await self.skipWaiting();
  })());
});

/* ---------- Activate: drop old versions, take control of open tabs ---------- */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => n.indexOf(CACHE_PREFIX) === 0 && n !== CACHE_NAME)
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* ---------- Fetch ---------- */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(sameOrigin(req));
  } else if (CDN_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(cdnFirst(req));
  }
});

// Network first (always fresh when online), instantly falls back to the cache when offline or slow.
async function sameOrigin(req) {
  const cache = await caches.open(CACHE_NAME);
  const isNav = req.mode === 'navigate';
  try {
    const res = await fetchWithTimeout(req, NETWORK_TIMEOUT);
    if (res && res.ok && res.type === 'basic') cache.put(req.url, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await cache.match(req.url, { ignoreSearch: true });
    if (hit) return hit;
    if (isNav) {
      const shell = (await cache.match(abs('index.html'))) || (await cache.match(abs('./')));
      if (shell) return shell;
    }
    return Response.error();
  }
}

// Cache first for third-party files (versioned URLs never change).
async function cdnFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(req.url, { ignoreVary: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req.url, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    return Response.error();
  }
}

/* ---------- Messages from the page ---------- */
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'CACHE_ALL') {
    const port = event.ports && event.ports[0];
    const reply = msg => { try { if (port) port.postMessage(msg); else if (event.source) event.source.postMessage(msg); } catch (e) { /* ignore */ } };
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        const coreMissing = await cacheCore(cache);
        const cdn = await cacheCdn(cache);
        reply({
          type: 'CACHE_ALL_RESULT',
          ok: coreMissing.length === 0 && cdn.missing.length === 0,
          version: VERSION,
          coreMissing: coreMissing,
          cdnMissing: cdn.missing,
          cdnFailed: cdn.failed
        });
      } catch (e) {
        reply({ type: 'CACHE_ALL_RESULT', ok: false, error: String(e) });
      }
    })());
  }
});
