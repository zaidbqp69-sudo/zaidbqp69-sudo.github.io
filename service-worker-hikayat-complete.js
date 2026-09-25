/* talevo offline Service Worker */
const VERSION = 'talevo-offline-v13';
const APP_CACHE = `${VERSION}-app`;
const STORY_CACHE = 'talevo-stories';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './service-worker-hikayat-complete.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await Promise.all(APP_SHELL.map(async url => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (error) { console.warn('[talevo] app shell skipped:', url, error); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([APP_CACHE, STORY_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('talevo-offline-') && !keep.has(key)).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
      const cache = await caches.open(APP_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(APP_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request) || await caches.match('./index.html') || await caches.match('./');
    return cached || new Response('التطبيق غير متاح دون اتصال. افتحه مرة واحدة أثناء الاتصال بالإنترنت.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  // Check all caches first, including cross-origin audio explicitly cached by CACHE_STORY.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return fetch(request);
    if (request.mode === 'navigate') return networkFirst(request);
    return cacheFirst(request);
  })());
});

async function reply(event, payload) {
  const port = event.ports && event.ports[0];
  if (port) port.postMessage(payload);
}

async function cacheApp(event) {
  const cache = await caches.open(APP_CACHE);
  const urls = new Set(APP_SHELL);
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => {
    try { urls.add(new URL(client.url).pathname); } catch (_) {}
  });
  const results = await Promise.all([...urls].map(async url => {
    try {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (response.ok || response.type === 'opaque') {
        await cache.put(url, response.clone());
        return true;
      }
    } catch (_) {}
    return false;
  }));
  return { ok: results.some(Boolean), cached: results.filter(Boolean).length, total: results.length };
}

self.addEventListener('message', event => {
  const message = event.data || {};
  event.waitUntil((async () => {
    try {
      if (message.type === 'SKIP_WAITING') {
        await self.skipWaiting();
        return reply(event, { ok: true });
      }
      if (message.type === 'CACHE_APP') {
        return reply(event, await cacheApp(event));
      }
      if (message.type === 'CACHE_STORY') {
        const urls = Array.isArray(message.urls) ? message.urls.filter(Boolean) : [];
        const cache = await caches.open(STORY_CACHE);
        const cached = [];
        const failed = [];
        for (const url of urls) {
          try {
            const request = new Request(url, { mode: 'cors', credentials: 'omit' });
            const response = await fetch(request);
            if (!response.ok && response.type !== 'opaque') throw new Error(`HTTP ${response.status}`);
            await cache.put(request, response.clone());
            cached.push(url);
          } catch (error) {
            failed.push({ url, error: String(error && error.message || error) });
          }
        }
        // Story text, dictionary, and quiz data are embedded in the app shell.
        const appResult = await cacheApp(event);
        return reply(event, { ok: failed.length === 0 && appResult.ok, storyId: message.storyId || null, cached, failed, app: appResult });
      }
      if (message.type === 'DELETE_STORY') {
        const cache = await caches.open(STORY_CACHE);
        const urls = Array.isArray(message.urls) ? message.urls.filter(Boolean) : [];
        const deleted = [];
        for (const url of urls) {
          if (await cache.delete(url)) deleted.push(url);
        }
        return reply(event, { ok: true, storyId: message.storyId || null, deleted });
      }
      return reply(event, { ok: false, error: 'unknown-message' });
    } catch (error) {
      return reply(event, { ok: false, error: String(error && error.message || error) });
    }
  })());
});
