/* La portada ya no es una app: este archivo retira el servicio antiguo que guardaba la demo aquí. La demo vive ahora en /demo/. */
self.addEventListener('install',function(){self.skipWaiting();});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return /^(portres|revo)-v\d/.test(k);}).map(function(k){return caches.delete(k);}));}).then(function(){return self.registration.unregister();}).then(function(){return self.clients.matchAll();}).then(function(cs){cs.forEach(function(c){c.navigate(c.url);});}));});
