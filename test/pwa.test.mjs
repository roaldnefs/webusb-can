import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));

// Runs sw.js against stubbed globals and returns its listeners and cache.
function loadServiceWorker(fetchImpl) {
  const listeners = {};
  const cache = new Map();
  const cacheApi = {
    addAll: async urls => urls.forEach(url => cache.set(new URL(url, 'https://app.test/base/').href, 'precached')),
    put: async (request, response) => cache.set(request.url, response),
  };
  const context = {
    URL,
    Response: { error: () => 'network-error' },
    self: {
      location: { origin: 'https://app.test' },
      addEventListener: (type, fn) => { listeners[type] = fn; },
    },
    caches: {
      open: async () => cacheApi,
      match: async request => cache.get(request.url),
    },
    fetch: fetchImpl,
  };
  const appFiles = vm.runInNewContext(`${read('sw.js')}; APP_FILES`, context);
  return { listeners, cache, appFiles };
}

// Dispatches a fetch event; resolves to the response, or undefined when the
// service worker leaves the request to the browser.
async function dispatchFetch(listeners, request) {
  let responded;
  const pending = [];
  listeners.fetch({
    request,
    respondWith: p => { responded = p; },
    waitUntil: p => pending.push(p),
  });
  const response = await responded;
  await Promise.all(pending);
  return response;
}

const get = path => ({ method: 'GET', url: `https://app.test/base/${path}` });
const okResponse = body => ({ ok: true, body, clone() { return this; } });

test('manifest makes the app installable', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.ok(manifest.name);
  assert.equal(manifest.display, 'standalone');
  // Relative, so it works under the GitHub Pages sub-path.
  assert.equal(manifest.start_url, '.');

  const sizes = manifest.icons.map(icon => icon.sizes);
  assert.ok(sizes.includes('192x192'));
  assert.ok(sizes.includes('512x512'));
});

test('manifest icons exist at their declared size', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  for (const icon of manifest.icons) {
    const png = read(icon.src);
    assert.equal(png.toString('latin1', 1, 4), 'PNG', icon.src);
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes, icon.src);
  }
});

test('page links the manifest and the entry module registers the service worker', () => {
  assert.match(read('index.html').toString(), /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(read('js/app.js').toString(), /serviceWorker\.register\('sw\.js'\)/);
});

test('service worker precaches every file the app ships', () => {
  const shipped = [
    './', 'index.html', 'manifest.webmanifest', 'logo.svg',
    ...readdirSync(new URL('css/', root)).map(f => `css/${f}`),
    ...readdirSync(new URL('icons/', root)).map(f => `icons/${f}`),
    ...readdirSync(new URL('js/', root)).map(f => `js/${f}`),
  ];
  const { appFiles } = loadServiceWorker();
  assert.deepEqual([...appFiles].sort(), shipped.sort());
});

test('service worker caches the app at install', async () => {
  const { listeners, cache, appFiles } = loadServiceWorker();
  let installed;
  listeners.install({ waitUntil: p => { installed = p; } });
  await installed;
  assert.equal(cache.size, appFiles.length);
  assert.ok(cache.has('https://app.test/base/js/app.js'));
});

test('service worker prefers the network and refreshes the cache', async () => {
  const { listeners, cache } = loadServiceWorker(async () => okResponse('fresh'));
  cache.set(get('js/app.js').url, okResponse('stale'));

  const response = await dispatchFetch(listeners, get('js/app.js'));
  assert.equal(response.body, 'fresh');
  assert.equal(cache.get(get('js/app.js').url).body, 'fresh');
});

test('service worker serves from cache when offline', async () => {
  const { listeners, cache } = loadServiceWorker(async () => { throw new TypeError('offline'); });
  cache.set(get('js/app.js').url, okResponse('cached'));

  assert.equal((await dispatchFetch(listeners, get('js/app.js'))).body, 'cached');
  assert.equal(await dispatchFetch(listeners, get('missing.js')), 'network-error');
});

test('service worker does not cache error responses', async () => {
  const { listeners, cache } = loadServiceWorker(async () => ({ ok: false }));
  await dispatchFetch(listeners, get('nope.js'));
  assert.equal(cache.size, 0);
});

test('service worker ignores cross-origin and non-GET requests', async () => {
  const { listeners } = loadServiceWorker(async () => okResponse('x'));
  assert.equal(await dispatchFetch(listeners, { method: 'GET', url: 'https://fonts.googleapis.com/css2' }), undefined);
  assert.equal(await dispatchFetch(listeners, { method: 'POST', url: get('x').url }), undefined);
});
