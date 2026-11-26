// Ticket Office service worker — caches the app shell so the app OPENS
// offline after the first load (venue Wi-Fi is not required to open it).
// Live data still needs a connection; sales/check-ins are never faked offline.
const CACHE = "ticket-office-v26";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./vendor/qrcode.min.js",
  "./vendor/jsQR.min.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // NEVER cache API calls — ticket data must always be live.
  if (url.pathname.includes("/rest/v1/") || url.hostname.endsWith("supabase.co")) return;
  if (e.request.method !== "GET") return;
  // NETWORK-FIRST for the shell: an update can never serve a stale/mixed
  // copy of the app (the mixed-version trap). Cache is the offline fallback
  // only — the app needs a connection for live data anyway.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && res.status === 200 && url.origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
