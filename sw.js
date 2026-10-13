/* Hazina Money service worker: offline app shell + background Google Drive backup. */
const VERSION = 'hazina-v4';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './jspdf.umd.min.js', './jspdf.plugin.autotable.min.js'];
const FONT_CACHE = 'hazina-fonts';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== FONT_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts: serve from cache, refresh in the background.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(caches.open(FONT_CACHE).then(async cache => {
      const hit = await cache.match(req);
      const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return; // backups and other sites go straight to the network

  // App files: open instantly from cache, update the cache when online.
  event.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(req, {ignoreSearch: req.mode === 'navigate'}) || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
    const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});

/* ---------- background backup ---------- */
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('hazina', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const get = (db, k) => new Promise(res => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); });
const put = (db, k, v) => new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

async function backgroundBackup() {
  const db = await openDb();
  const meta = await get(db, 'meta');
  const data = await get(db, 'data');
  if (!meta || !meta.auto || !meta.url || !meta.key || !data || !data.S) return;
  const day = today();
  if ((meta.lastDay || '') >= day && !meta.pending) return;
  try {
    const res = await fetch(meta.url, {
      method: 'POST',
      headers: {'Content-Type': 'text/plain;charset=utf-8'},
      body: JSON.stringify({key: meta.key, date: day, data: {app: 'hazina-money', version: 1, exported: new Date().toISOString(), S: data.S, M: data.M}})
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'Backup failed');
    Object.assign(meta, {last: Date.now(), lastDay: day, lastName: j.name || '', lastError: '', pending: false, via: 'background'});
    await put(db, 'meta', meta);
  } catch (e) {
    meta.pending = true; meta.lastError = String(e && e.message || e);
    await put(db, 'meta', meta);
    throw e; // lets one-off Background Sync retry later
  }
}

self.addEventListener('periodicsync', event => {
  if (event.tag === 'hazina-daily-backup') event.waitUntil(backgroundBackup().catch(() => {}));
});
self.addEventListener('sync', event => {
  if (event.tag === 'hazina-backup-retry') event.waitUntil(backgroundBackup());
});
