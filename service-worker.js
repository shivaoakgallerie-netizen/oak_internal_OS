const CACHE = 'oak-shell-role-prototype-v2';
const SHELL = [
  './', './index.html', './styles.css', './prototype.css', './app.js',
  './demo-model.js', './demo-storage.js', './manifest.webmanifest', './icons/oak-mark.svg'
];
const shellUrls = new Set(SHELL.map(path => new URL(path, self.registration.scope).href));
const indexUrl = new URL('./index.html', self.registration.scope).href;
const homeUrl = new URL('./', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([...shellUrls])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith('oak-shell-') && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

async function networkFirst(request, navigation) {
  try {
    const response = await fetch(request);
    // Never cache unknown URLs, errors, API data, request records, or uploads.
    if (response.ok && shellUrls.has(request.url)) {
      const key = navigation && (request.url === homeUrl || request.url === indexUrl) ? indexUrl : request.url;
      try { await (await caches.open(CACHE)).put(key, response.clone()); } catch { /* Keep a usable response when browser storage is full. */ }
    }
    return response;
  } catch {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(navigation ? indexUrl : request.url);
    return cached || new Response('Oak Gallerie is unavailable offline. Connect once to load the prototype.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const navigation = request.mode === 'navigate' && request.url.startsWith(self.registration.scope);
  if (!navigation && !shellUrls.has(request.url)) return;
  event.respondWith(networkFirst(request, navigation));
});
