/* Territoires — service worker (PWA + push)
 * À servir depuis la racine (/sw.js) pour couvrir tout le site. */

const VERSION = "v1"; // incrémente à chaque déploiement du front
const SHELL_CACHE = `territoires-shell-${VERSION}`;
const TILE_CACHE = "territoires-tiles"; // survit aux versions

// ADAPTE : les fichiers de ta coquille (CSS/JS séparés si tu en as)
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png"];

// Fond de carte (index.html : source raster OSM)
const TILE_HOSTS = ["tile.openstreetmap.org", "a.tile.openstreetmap.org", "b.tile.openstreetmap.org", "c.tile.openstreetmap.org"];
const TILE_MAX_ENTRIES = 300;

// CDN du front (MapLibre, Google Fonts) : sans eux en cache, l'app
// installée n'aurait ni carte ni typo en mode hors-ligne
const CDN_HOSTS = ["unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  const sameOrigin = url.origin === self.location.origin;

  // Jamais de cache pour l'API ni l'auth : données perso + territoire vivant
  if (sameOrigin && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/webhook/"))) {
    return;
  }

  // Navigation : réseau d'abord, coquille en secours (mode hors-ligne)
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/")));
    return;
  }

  // Fond de carte : cache d'abord, plafonné
  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(tileCacheFirst(req));
    return;
  }

  // Statique même origine + CDN du front : stale-while-revalidate
  // (les fetch no-cors des <link>/<script> renvoient des réponses
  // « opaques » : ok=false mais parfaitement cachables)
  if (sameOrigin || CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const refresh = fetch(req)
          .then((res) => {
            if (res.ok || res.type === "opaque") {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => hit);
        return hit || refresh;
      })
    );
  }
  // Autre cross-origin (avatars Strava…) : réseau par défaut
});

async function tileCacheFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    trimTileCache(cache); // sans await, en tâche de fond
  }
  return res;
}

async function trimTileCache(cache) {
  const keys = await cache.keys();
  if (keys.length > TILE_MAX_ENTRIES) {
    await Promise.all(keys.slice(0, keys.length - TILE_MAX_ENTRIES).map((k) => cache.delete(k)));
  }
}

// --- Notifications push ---

self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { body: e.data ? e.data.text() : "" };
  }
  const title = data.title || "Territoires";
  e.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: data.tag || "territoires",
      renotify: true,
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        for (const c of list) {
          if ("focus" in c) return c.focus();
        }
        return clients.openWindow(url);
      })
  );
});
