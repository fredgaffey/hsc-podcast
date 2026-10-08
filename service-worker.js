// STOP (2026-07-09): Repo locked until 6 Nov 2026 (after the HSC). No work here without tangible study gain. See STOP-UNTIL-NOV-6.md. Go do past papers.
// Two caches:
//   APP_SHELL  — the app itself (HTML/JS/CSS + vendored libs). Versioned; bumping the
//                version replaces it on the next activate. Precached on install.
//   DOWNLOADS  — content fetched for offline use: audio (.m4a) + script/supplementary
//                markdown + quiz JSON. Populated on demand (browsing) and by explicit
//                "download" actions from the page. NEVER wiped on a shell version bump,
//                so app updates don't delete the user's downloads.
// Hosts serving authenticated private audio: never intercepted (see fetch handler).
const PRIVATE_AUDIO_HOSTS = new Set(['hsc-podcast-private-audio.fredgaffey08.workers.dev']);
const APP_SHELL = 'podcast-shell-__BUILD__'; // __BUILD__ stamped per deploy (tools/deploy.sh)
const DOWNLOADS = 'podcast-downloads-v1';

// NOTE: '/index.html' is deliberately NOT listed — Cloudflare Pages 308-redirects it
// to '/', and the Cache API refuses to store a redirected response. Listing it would
// make precache reject and the whole SW install fail (see precache() below). '/' alone
// carries the document; navigations resolve to it.
const SHELL = [
  '/', '/app.js', '/auth.js', '/speed-engine.js', '/style.css', '/app.webmanifest', '/build.json',
  '/vendor/marked.min.js', '/vendor/highlight.min.js', '/vendor/sortable.min.js', '/vendor/fsrs.umd.js',
  '/vendor/github-dark-dimmed.min.css', '/vendor/github.min.css',
  '/vendor/katex/katex.min.css', '/vendor/katex/katex.min.js', '/vendor/katex/auto-render.min.js',
  '/vendor/speechwarp/speechwarp-processor.js', '/vendor/speechwarp/index.js', '/vendor/speechwarp/wasm.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-180.png', '/icons/icon-32.png',
];

// Precache the shell resiliently: cache each entry on its own so a single bad asset
// (404, redirect, transient network error) can't reject the whole install. A failed
// install never activates, which would pin every device to the previously-cached shell
// and silently block all future updates — exactly the bug this avoids. Anything that
// fails to precache still works online via cacheFirst's network fallback.
async function precache() {
  const cache = await caches.open(APP_SHELL);
  await Promise.all(SHELL.map(async (url) => {
    try {
      const res = await fetch(url, { cache: 'reload' });
      // Don't store redirects (Cache API throws) or error responses.
      if (res && res.ok && !res.redirected) await cache.put(url, res);
    } catch (_) { /* skip this asset; it'll be fetched from network on demand */ }
  }));
}

self.addEventListener('install', (e) => {
  // Precache the new shell, but DO NOT skipWaiting — the new worker sits in "waiting" until the
  // page explicitly asks it to take over (SKIP_WAITING message below). This is what lets the app
  // control WHEN it refreshes (user swipe-up, or a build that's been in production ≥6h) instead of
  // force-reloading mid-session the instant a deploy lands. See the SW block in app.js.
  e.waitUntil(precache());
});

// The page sends this when it decides to apply a pending update (swipe-up / 6h-stale). Taking over
// fires `controllerchange` in the page, which then reloads once onto the new shell.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // Drop only stale shell caches; keep DOWNLOADS (and the current shell).
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('podcast-shell-') && k !== APP_SHELL)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Build a 206 Partial Content response by slicing a fully-cached audio body. iOS
// Safari's <audio> element requests audio with a Range header; if we've downloaded
// the whole file we can satisfy those ranges from cache so playback works offline.
async function rangeFromCache(request) {
  const cache = await caches.open(DOWNLOADS);
  const cached = await cache.match(request.url); // match the full GET, ignoring Range
  if (!cached) return fetch(request);            // not downloaded → stream from network

  const buf = await cached.arrayBuffer();
  const total = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('Range') || '');
  let start, end;
  if (m && m[1] === '' && m[2] !== '') {
    // Suffix range: "bytes=-N" → the last N bytes (MP4 players probe the tail).
    start = Math.max(0, total - parseInt(m[2], 10));
    end = total - 1;
  } else {
    start = m && m[1] ? parseInt(m[1], 10) : 0;
    end = m && m[2] ? parseInt(m[2], 10) : total - 1;
  }
  if (isNaN(start) || start < 0) start = 0;
  if (isNaN(end) || end >= total) end = total - 1;
  if (start > end) { start = 0; end = total - 1; }

  const slice = buf.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'audio/mp4',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(slice.byteLength),
      'Accept-Ranges': 'bytes',
    },
  });
}

// Cache-first against a named cache; on miss, fetch and store the result.
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
  return res;
}

// Return cache immediately if present, refresh it in the background; otherwise wait
// on the network and cache the result. Good for markdown/quiz that rarely change.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => { if (res && res.ok) cache.put(request, res.clone()); return res; })
    .catch(() => null);
  // Await the revalidation on a cache miss; if it failed (offline), fall through to a
  // real network fetch so the caller gets a genuine error, not a null response.
  return cached || (await network) || fetch(request);
}

// Network-first: keep the cached copy fresh, fall back to it offline. Used for
// manifest.json so new episodes show up online but the app still loads offline.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const path = url.pathname;

  // Never intercept the worker script itself — let the browser's update check always
  // hit the network. If the SW ever cached its own script, a device could be pinned to
  // a stale worker with no way to update (the exact failure this app has hit on iOS).
  if (sameOrigin && path === '/service-worker.js') return;

  // manifest.json — always try the network first so new content appears.
  if (sameOrigin && path.endsWith('/manifest.json')) {
    e.respondWith(networkFirst(req, APP_SHELL));
    return;
  }

  // Audio (.m4a). Now served cross-origin from R2 (audio.hsc.pebnum.com/<subject>/…),
  // so this matches by extension regardless of origin and runs BEFORE the same-origin
  // checks below. Range requests (iOS <audio>) are served from a downloaded full body
  // when available; plain GETs (speed engine + downloads) are cache-first in DOWNLOADS.
  // PIN-gated private audio is authenticated per-request and must never be cached or
  // range-served from DOWNLOADS: those paths exist for public R2 episodes. Intercepting
  // it leaves <audio> in networkState=LOADING forever with no error. Straight to network.
  if (PRIVATE_AUDIO_HOSTS.has(url.hostname)) return;

  if (path.endsWith('.m4a')) {
    if (req.headers.get('Range')) e.respondWith(rangeFromCache(req));
    else e.respondWith(cacheFirst(req, DOWNLOADS));
    return;
  }

  // App shell — cache-first from the per-build versioned cache. Each deploy stamps
  // a fresh APP_SHELL version, so install precaches the whole shell atomically and
  // index.html + app.js can never be served as a mismatched pair.
  if (sameOrigin && SHELL.includes(path)) {
    e.respondWith(cacheFirst(req, APP_SHELL));
    return;
  }

  // Other same-origin content (script/supplementary markdown, quiz JSON, etc.):
  // serve cached instantly, refresh in the background, and cache on first fetch so
  // it's available offline after being viewed or downloaded.
  if (sameOrigin) {
    e.respondWith(staleWhileRevalidate(req, DOWNLOADS));
    return;
  }

  // Cross-origin (shouldn't be much after vendoring): network, fall back to any cache.
  e.respondWith(fetch(req).catch(() => caches.match(req)));
});
