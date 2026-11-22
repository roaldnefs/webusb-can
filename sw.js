// Offline support. Everything the app needs is cached at install; after that
// the network is always tried first, so a new deploy is picked up on the next
// load and the cache only serves when offline.

const CACHE = 'webusb-can';

const APP_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'logo.svg',
  'css/style.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'js/api.js',
  'js/app.js',
  'js/connection.js',
  'js/frames.js',
  'js/fuzzer.js',
  'js/gsusb.js',
  'js/icsim.js',
  'js/isotp.js',
  'js/reader.js',
  'js/send.js',
  'js/signals.js',
  'js/sim-ecu.js',
  'js/sim-vehicle.js',
  'js/sniffer.js',
  'js/state.js',
  'js/tester-present.js',
  'js/uds.js',
  'js/ui.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_FILES)));
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
        }
        return response;
      })
      .catch(async () => (await caches.match(request)) || Response.error())
  );
});
