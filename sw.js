/* PorTres: guarda la app para que abra sin conexión */
var CACHE='portres-v1';
var FILES=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(FILES);}).then(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  var url=new URL(e.request.url);
  if(url.origin===location.origin){
    /* la app: primero la red (para recibir mejoras), si no hay conexión, la copia guardada */
    e.respondWith(fetch(e.request).then(function(r){var cp=r.clone();caches.open(CACHE).then(function(c){c.put(e.request,cp);});return r;}).catch(function(){return caches.match(e.request,{ignoreSearch:true}).then(function(m){return m||caches.match('index.html');});}));
  } else if(/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)){
    /* tipografías: se guardan la primera vez */
    e.respondWith(caches.match(e.request).then(function(m){return m||fetch(e.request).then(function(r){var cp=r.clone();caches.open(CACHE).then(function(c){c.put(e.request,cp);});return r;});}));
  }
});
