/* -------------------------------------------------------------------------
 * conet Phone Agent — Service Worker (KILL SWITCH v6)
 *
 * Older versions (v1..v5) cache `index.html` cache-first, which means the
 * page never picks up new JS until the user manually nukes browser data.
 * That's catastrophic for TV browsers (Tizen / webOS), where the user
 * cannot easily clear caches.
 *
 * This v6 SW does ONE thing: unregister itself and delete every cache.
 * After it activates, the page that loaded it will reload as a plain
 * HTML+JS document with no SW interception, so subsequent reloads
 * always fetch fresh `index.html` / `sw.js`. PWA features (push,
 * periodic-sync, offline) are temporarily disabled — we'll reintroduce
 * them once the TV mining loop is verified end-to-end.
 * ------------------------------------------------------------------------- */

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) {
      console.warn("[em-sw v6] cache nuke failed", e);
    }
    try {
      await self.registration.unregister();
    } catch (e) {
      console.warn("[em-sw v6] unregister failed", e);
    }
    try {
      const clients = await self.clients.matchAll({ type: "window" });
      for (const c of clients) {
        try { c.navigate(c.url); } catch {}
      }
    } catch (e) {
      console.warn("[em-sw v6] reload failed", e);
    }
  })());
});

// no fetch / push / sync handlers on purpose — page runs in foreground
// only for now.
