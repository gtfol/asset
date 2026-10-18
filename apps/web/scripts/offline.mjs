import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../dist/', import.meta.url);
const assets = ['/index.html', ...(await readdir(new URL('assets/', root))).map(f => '/assets/' + f),
  ...(await readdir(new URL('fonts/', root))).map(f => '/fonts/' + f)];
const version = createHash('sha256').update(await readFile(new URL('index.html', root))).digest('hex').slice(0, 16);
await writeFile(new URL('sw.js', root), `
const name = 'asset-shell-${version}';
const assets = ${JSON.stringify(assets)};
self.addEventListener('install', event => event.waitUntil(caches.open(name).then(cache => cache.addAll(assets)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('asset-shell-') && k !== name).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Account data and authentication responses are never cached by the worker.
  if (event.request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(fetch(event.request).catch(() => caches.open(name).then(cache => cache.match('/index.html'))));
  } else if (assets.includes(url.pathname)) {
    event.respondWith(caches.open(name).then(cache => cache.match(event.request)).then(saved => saved || fetch(event.request)));
  }
});
`);
