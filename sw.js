const CACHE = 'strength-v6';
const ASSETS = [
  './index.html', './manifest.json',
  './styles.css',
  './core.js', './week.js', './session.js', './exercises.js',
  './conditioning.js', './wellness.js', './tests.js',
  './history.js', './trends.js', './checkin.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.0/Sortable.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks =>
      Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Always pass Supabase API calls straight through — never cache these
  if (e.request.url.includes('supabase.co')) return;

  // Network-first for all app files (HTML, JS, CSS, manifest)
  // Falls back to cache when offline — app still works without connectivity
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request)
          .then(hit => hit || caches.match('./index.html'))
      )
  );
});
