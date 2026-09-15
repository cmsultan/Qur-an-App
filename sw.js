/*
 * Quran - Read, Listen, Save — Service Worker
 * ---------------------------------------------------------------------
 * Bump CACHE_VERSION whenever the app shell (this HTML file, icons, or
 * manifest) changes, so old caches get cleaned up on the next activate.
 */
const CACHE_VERSION   = 'v1';
const SHELL_CACHE      = `qa-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE    = `qa-runtime-${CACHE_VERSION}`;
const AUDIO_CACHE      = `qa-audio-${CACHE_VERSION}`;
const API_CACHE        = `qa-api-${CACHE_VERSION}`;

// The app is a single HTML file plus its icons/manifest - everything
// else (fonts, Font Awesome, html2canvas/jsPDF) is fetched from CDNs and
// handled by the runtime strategies below instead of being precached,
// so an install never fails just because a CDN hiccups.
const SHELL_ASSETS = [
  './',
  './Quran-Kareem.html',
  './manifest.json',
  './icon-dark-192.png',
  './icon-dark-512.png',
  './icon-light-192.png',
  './icon-light-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png'
];

// Keep runtime caches from growing forever - audio in particular can be
// large, so only the most recently used N entries are kept.
const MAX_ENTRIES = { [AUDIO_CACHE]: 60, [API_CACHE]: 120 };

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  // Delete oldest first (Cache API preserves insertion order in `keys()`).
  const excess = keys.length - maxEntries;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll would fail the whole install if even one asset 404s -
    // add them individually so a missing icon doesn't break install.
    await Promise.all(SHELL_ASSETS.map((url) =>
      cache.add(url).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const current = new Set([SHELL_CACHE, RUNTIME_CACHE, AUDIO_CACHE, API_CACHE]);
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => !current.has(n)).map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

// Quran/translation text API (alquran.cloud) and word-lookup translation
// (mymemory) - network first so text is always fresh when online, but
// fall back to a cached copy so previously opened sūrahs still open offline.
function isTextApi(url) {
  return url.hostname.endsWith('api.alquran.cloud') ||
         url.hostname.endsWith('api.mymemory.translated.net');
}

// Per-āyah recitation/translation audio - large files, so they're cached
// opportunistically (network first) with an entry cap, never precached.
function isAudio(url) {
  return url.pathname.endsWith('.mp3') || url.pathname.endsWith('.m4a');
}

// Fonts + Font Awesome + on-demand libraries (html2canvas/jsPDF) from
// CDNs - versioned/immutable in practice, so cache-first with a
// background refresh (stale-while-revalidate) is safe and fast.
function isStaticCdn(url) {
  return url.hostname.endsWith('fonts.googleapis.com') ||
         url.hostname.endsWith('fonts.gstatic.com') ||
         url.hostname.endsWith('cdnjs.cloudflare.com');
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

async function networkFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
      if (maxEntries) trimCache(cacheName, maxEntries);
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    // Offline and not precached (e.g. first-ever visit had no network) -
    // fall back to the main shell page so the app still opens.
    const shell = await cache.match('./Quran-Kareem.html');
    if (shell) return shell;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // don't intercept POST/etc.

  const url = new URL(request.url);

  if (isAudio(url)) {
    event.respondWith(networkFirst(request, AUDIO_CACHE, MAX_ENTRIES[AUDIO_CACHE]));
    return;
  }

  if (isTextApi(url)) {
    event.respondWith(networkFirst(request, API_CACHE, MAX_ENTRIES[API_CACHE]));
    return;
  }

  if (isStaticCdn(url)) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
    return;
  }

  if (isSameOrigin(url) && (request.mode === 'navigate' || SHELL_ASSETS.some((a) => url.pathname.endsWith(a.replace('./', '/'))))) {
    event.respondWith(cacheFirstShell(request));
    return;
  }

  // Everything else: just go to the network, no interception.
});
