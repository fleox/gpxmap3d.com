/**
 * Minimal service worker for the GPX Map PWA.
 *
 * Why we need one at all: Chrome's "Add to Home Screen" / install prompt
 * requires a service worker that intercepts fetch events. The manifest +
 * icons are necessary but not sufficient.
 *
 * Strategy: stale-while-revalidate, same-origin only.
 *   - We never touch cross-origin requests (OpenFreeMap tiles, AWS
 *     terrain, Traileasy API): they're huge, frequently updated, and the
 *     browser's HTTP cache already does the right thing for them.
 *   - For our own JS / CSS / HTML / library JSON, we serve cached version
 *     instantly when available, then refresh in the background. Means the
 *     app shell is instant on every load and works offline once it's been
 *     visited at least once.
 *
 * The cache name has a version suffix; bumping it on a deploy invalidates
 * the previous cache entirely (used in the `activate` handler below).
 */

const CACHE = 'gpx-map-v2';

self.addEventListener('install', (event) => {
  // Activate immediately — don't wait for all tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Same-origin only. Map tiles, terrain DEM and external APIs are left
  // to the browser HTTP cache — they're far too large to keep in the SW
  // cache and they'd push out the app shell that actually benefits.
  if (url.origin !== self.location.origin) return;
  // Don't try to cache the SW itself or the manifest (they're served
  // fresh by the browser's update flow).
  if (url.pathname.endsWith('/sw.js')) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((response) => {
          // Only put successful, non-opaque responses in the cache.
          if (response && response.ok && response.type === 'basic') {
            // Clone before consuming — the Response stream is one-shot.
            cache.put(req, response.clone()).catch(() => {});
          }
          return response;
        })
        .catch(() => null);
      // Serve from cache when possible (instant), refresh in background.
      // Fall through to network on cache miss; if network also fails
      // (offline + never visited), return a minimal 503.
      return (
        cached ??
        (await networkFetch) ??
        new Response('Offline', { status: 503, statusText: 'Offline' })
      );
    })(),
  );
});
