const CACHE='daily-study-shell-v2';
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/','/style.css','/app.js']))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('daily-study-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.origin===self.location.origin&&u.pathname.startsWith('/images/')){e.respondWith(new Response('',{status:404}));return;}if(e.request.method!=='GET'||u.origin!==self.location.origin||u.pathname.startsWith('/api/')||u.pathname.startsWith('/cdn-cgi/'))return;
 e.respondWith(fetch(e.request).then(r=>{if(r.ok&&!r.redirected&&r.headers.get('Content-Type')?.includes('text/html')&&u.pathname!=='/')return r;if(r.ok&&!r.redirected){const copy=r.clone();e.waitUntil(caches.open(CACHE).then(c=>c.put(e.request,copy)))}return r}).catch(()=>caches.match(e.request)));
});
