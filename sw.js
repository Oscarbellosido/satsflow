// ─── SatsFlow Service Worker ─────────────────────────────────────────────────
// Versión del caché — cambia este número para forzar actualización
const CACHE_VERSION = 'satsflow-v3';
const CACHE_ASSETS  = [
  './',
  './index.html',
  './manifest.json'
];

// ─── Install: pre-cache shell ─────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(CACHE_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate: limpia cachés viejos ──────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch: Network-first con fallback a caché ────────────────────────────────
self.addEventListener('fetch', (event) => {
  // Solo interceptamos GET; dejamos pasar el resto
  if (event.request.method !== 'GET') return;

  // APIs externas: siempre red (sin caché para datos frescos)
  const url = event.request.url;
  if (url.includes('coingecko.com') || url.includes('mempool.space')) {
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // App shell: network-first, caché como fallback
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ─── Push: recibe notificaciones del servidor (o de periodSync) ───────────────
self.addEventListener('push', (event) => {
  let data = { title: '₿ SatsFlow', body: 'Actualización de precio', icon: '/icon-192.png' };
  try { data = { ...data, ...event.data.json() }; } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon || 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/46/Bitcoin.svg/192px-Bitcoin.svg.png',
      badge:   'https://upload.wikimedia.org/wikipedia/commons/thumb/4/46/Bitcoin.svg/96px-Bitcoin.svg.png',
      vibrate: [200, 100, 200],
      data:    { url: data.url || '/' },
      actions: [{ action: 'open', title: 'Ver precio' }]
    })
  );
});

// ─── Notification click: abre / enfoca la app ─────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(self.registration.scope);
    })
  );
});

// ─── Periodic Background Sync: comprueba precio cada ~15 min ─────────────────
// (requiere permisos "periodic-background-sync" — Chrome Android lo soporta)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'price-check') {
    event.waitUntil(checkPriceAndNotify());
  }
});

// ─── Message: la app puede pedir comprobaciones manuales ─────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'CHECK_ALERTS') {
    checkPriceAndNotifyWithAlerts(event.data.alerts);
  }
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ─── Lógica de comprobación de precio ────────────────────────────────────────
async function checkPriceAndNotify() {
  try {
    const res  = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    const json = await res.json();
    const usd  = parseFloat(json?.price);
    if (!usd) return;

    // Recupera alertas guardadas en IndexedDB / cache
    const alertsRaw = await getStoredAlerts();
    await checkPriceAndNotifyWithAlerts(alertsRaw, usd);

    // Guarda el último precio conocido
    await storeLastPrice(usd);
  } catch (e) {
    console.error('[SW] checkPriceAndNotify error:', e);
  }
}

async function checkPriceAndNotifyWithAlerts(alerts = [], currentPriceUsd = null) {
  if (!currentPriceUsd) {
    try {
      const res  = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
      const json = await res.json();
      currentPriceUsd = parseFloat(json?.price);
    } catch { return; }
  }

  for (const alert of alerts) {
    if (alert.triggered) continue;
    const price     = alert.currency === 'usd' ? currentPriceUsd : currentPriceUsd * 0.93; // EUR approx
    const triggered = alert.condition === 'above' ? price >= alert.targetPrice : price <= alert.targetPrice;

    if (triggered) {
      const symbol = alert.currency === 'usd' ? '$' : '€';
      await self.registration.showNotification('⚡ Alerta SatsFlow activada', {
        body:    `Bitcoin ha ${alert.condition === 'above' ? 'subido sobre' : 'bajado de'} ${symbol}${alert.targetPrice.toLocaleString()} — Precio actual: $${currentPriceUsd.toLocaleString()}`,
        icon:    'https://upload.wikimedia.org/wikipedia/commons/thumb/4/46/Bitcoin.svg/192px-Bitcoin.svg.png',
        badge:   'https://upload.wikimedia.org/wikipedia/commons/thumb/4/46/Bitcoin.svg/96px-Bitcoin.svg.png',
        vibrate: [300, 100, 300, 100, 300],
        tag:     `alert-${alert.id}`,
        renotify: true,
        data:    { alertId: alert.id }
      });

      // Marca alerta como disparada en storage
      await markAlertTriggered(alert.id);
    }
  }
}

// ─── IndexedDB helpers ────────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('satsflow', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('alerts'))     db.createObjectStore('alerts',    { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta'))       db.createObjectStore('meta',      { keyPath: 'key' });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

async function getStoredAlerts() {
  try {
    const db    = await openDB();
    const tx    = db.transaction('alerts', 'readonly');
    const store = tx.objectStore('alerts');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => resolve([]);
    });
  } catch { return []; }
}

async function markAlertTriggered(id) {
  try {
    const db    = await openDB();
    const tx    = db.transaction('alerts', 'readwrite');
    const store = tx.objectStore('alerts');
    return new Promise((resolve) => {
      const req = store.get(id);
      req.onsuccess = () => {
        const alert = req.result;
        if (alert) { alert.triggered = true; store.put(alert); }
        resolve();
      };
      req.onerror = () => resolve();
    });
  } catch {}
}

async function storeLastPrice(usd) {
  try {
    const db    = await openDB();
    const tx    = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: 'lastPrice', value: usd, ts: Date.now() });
  } catch {}
}
