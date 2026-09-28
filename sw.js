/* Gouri Medical Stores — service worker (offline-first app shell) */

/* Bump on each release so old caches are discarded on activate. */
const VERSION = "gms-v1.4.4";
const CORE_CACHE = `${VERSION}-core`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

/** Runtime cache is capped so storage can't creep up over months of use. */
const RUNTIME_MAX_ENTRIES = 60;

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CORE_CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop every cache that isn't part of this version — this is what
      // reclaims space after an update.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))
      );
      await trimCache(RUNTIME_CACHE, RUNTIME_MAX_ENTRIES);
      await self.clients.claim();

      // Tell open tabs a new version is live so they can refresh.
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach((c) => c.postMessage({ type: "SW_ACTIVATED", version: VERSION }));
    })()
  );
});

/** Oldest-first eviction once a cache exceeds `max` entries. */
async function trimCache(name, max) {
  try {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    if (keys.length <= max) return;
    await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
  } catch {
    /* ignore */
  }
}

const NEVER_CACHE = [
  "firebaseio.com",
  "firebasedatabase.app",
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "firebaseinstallations.googleapis.com",
  // Uploaded prescriptions can be large — always stream them from the network
  "api.cloudinary.com",
  "res.cloudinary.com",
];

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (NEVER_CACHE.some((host) => url.hostname.includes(host))) return;

  // Google Fonts — cache first (fonts are immutable)
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        cache.put(request, fresh.clone());
        void trimCache(RUNTIME_CACHE, RUNTIME_MAX_ENTRIES);
        return fresh;
      })
    );
    return;
  }

  // Navigations — network first so a new deploy is picked up immediately,
  // falling back to the cached shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CORE_CACHE).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() =>
          caches.match("./index.html").then((cached) => cached || Response.error())
        )
    );
    return;
  }

  // Same-origin static assets — stale while revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const freshPromise = fetch(request)
          .then((response) => {
            if (response.ok) {
              cache.put(request, response.clone());
              void trimCache(RUNTIME_CACHE, RUNTIME_MAX_ENTRIES);
            }
            return response;
          })
          .catch(() => cached || Response.error());
        return cached || freshPromise;
      })
    );
  }
});
