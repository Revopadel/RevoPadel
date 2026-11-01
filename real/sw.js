/* Revo Real: guarda la pantalla de la app; los datos siempre vienen de Supabase */
var CACHE='revo-real-v27';
var FILES=['./','index.html','supabase.js','manifest.webmanifest'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(FILES);}).then(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return /-real-v/.test(k)&&k!==CACHE;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  var url=new URL(e.request.url);
  if(url.origin!==location.origin)return;
  e.respondWith(fetch(e.request).then(function(r){var cp=r.clone();caches.open(CACHE).then(function(c){c.put(e.request,cp);});return r;}).catch(function(){return caches.match(e.request,{ignoreSearch:true}).then(function(m){return m||caches.match('index.html');});}));
});
/* Notificaciones en el móvil */
self.addEventListener('push',function(e){var d={};try{d=e.data?e.data.json():{};}catch(_){d={body:e.data?e.data.text():''};}
  e.waitUntil(self.registration.showNotification(d.title||'Revo Pádel',{body:d.body||'',icon:'../icon-192.png',badge:'../icon-192.png',data:{url:d.url||'./'},lang:'es'}));});
self.addEventListener('notificationclick',function(e){e.notification.close();var url=(e.notification.data&&e.notification.data.url)||'./';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(ws){
    for(var i=0;i<ws.length;i++){var w=ws[i];if(w.url.indexOf('/real/')>=0&&'focus' in w){return w.focus().then(function(f){return f&&f.navigate?f.navigate(url):null;});}}
    return self.clients.openWindow(url);}));});
