// Keeps a copy of Earmark's own files on the phone, so the app opens without internet. It always
// tries the internet first, so a new version arrives as soon as there's a connection. Lectures and
// progress aren't here: they're in the app's own storage. Requests to Gemini are never touched.
const CACHE = "earmark-v1";
const FILES = ["./", "index.html", "app.js", "style.css", "manifest.json", "icon-192.png", "icon-512.png",
               "core/server.js", "core/store.js", "core/ai.js", "core/text.js", "core/audio.js"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  event.respondWith(fetch(event.request)
    .then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(event.request, copy)); }
      return res;
    })
    .catch(() => caches.match(event.request, { ignoreSearch: true })));
});
