/* FuelBunk Pro — Service Worker v1.0 */
'use strict';

const CACHE_NAME  = 'fuelbunk-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// ── Install: cache static assets ─────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] Cache add failed:', err);
      });
    })
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ───────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch Strategy ───────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls: network-first, no caching for sensitive data
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(
          JSON.stringify({ success: false, error: 'You are offline. Please check your connection.', offline: true }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Fallback to index.html for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

// ── Background Sync (offline sale queue) ─────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-sales') {
    event.waitUntil(syncOfflineSales());
  }
});

async function syncOfflineSales() {
  // Open IndexedDB and flush offline queue
  const db = await openIDB();
  const tx  = db.transaction('offlineQueue', 'readwrite');
  const store = tx.objectStore('offlineQueue');
  const items = await getAllFromStore(store);

  for (const item of items) {
    try {
      const resp = await fetch('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${item.token}` },
        body: JSON.stringify(item.data)
      });
      if (resp.ok) {
        await deleteFromStore(tx.objectStore('offlineQueue'), item.id);
      }
    } catch(e) {
      console.warn('[SW] Sync failed for item', item.id);
    }
  }
}

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('fuelbunk', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('offlineQueue', { keyPath: 'id', autoIncrement: true });
    };
  });
}
function getAllFromStore(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function deleteFromStore(store, key) {
  return new Promise((resolve) => { store.delete(key).onsuccess = resolve; });
}
