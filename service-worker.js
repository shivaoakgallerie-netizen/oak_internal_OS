const CACHE = 'oak-shell-secure-v8';
const SHELL = [
  './', './index.html', './styles.css', './prototype.css', './app.js',
  './workflow-rules.js', './live-client.js', './legacy-cleanup.js', './config.js', './vendor/supabase.js', './icons/logo.png', './icons/symbol.png', './manifest.webmanifest', './icons/oak-mark.svg'
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
    return cached || new Response('Oak Gallerie is unavailable offline. Connect once to load the application.', {
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
self.addEventListener('push',event=>{
 let data;try{data=event.data?.json()||{};}catch{data={};}
 // The lock-screen message contains no confidential request notes.
 event.waitUntil(self.registration.showNotification('Oak Gallerie',{body:'You have a workflow notification. Sign in to view it.',icon:'icons/oak-mark.svg',tag:typeof data.tag==='string'?data.tag:'oak-work',data:{url:data.url}}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 const url=new URL(event.notification.data?.url||'./',self.registration.scope);
 if(url.origin!==self.location.origin||!url.href.startsWith(self.registration.scope))return;
 event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{
  for(const client of clients)if(client.url.startsWith(self.registration.scope)){await client.navigate(url.href);return client.focus();}
  return self.clients.openWindow(url.href);
 }));
});
