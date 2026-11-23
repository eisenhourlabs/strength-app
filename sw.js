// Retired site: this service worker removes itself and the old cached app,
// then sends open pages to the new address.
const NEW_ADDRESS = 'https://kardiastrength.pages.dev/';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => { try { c.navigate(NEW_ADDRESS); } catch (e) {} });
  })());
});

// No fetch handler: every request goes straight to the network.
