// Service Worker — Push Notifications + Background Keepalive
const CACHE = 'crm-v1';

// ── Install & Activate ───────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ── Push Notification (servidor → SW) ────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  let data;
  try { data = e.data.json(); } catch { data = { title: 'Nova mensagem', body: e.data.text() }; }

  const title   = data.title || 'CRM Odonto';
  const options = {
    body:    data.body || '',
    icon:    '/tooth.png',
    badge:   '/tooth.png',
    tag:     data.chatId || 'msg',        // agrupa por conversa
    renotify: true,                        // vibra mesmo se já tem notif do mesmo chat
    data:    { chatId: data.chatId, url: data.url || '/' },
    actions: [
      { action: 'open',   title: 'Abrir' },
      { action: 'close',  title: 'Fechar' },
    ],
    vibrate: [200, 100, 200],
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// ── Notificação local — página envia mensagem ao SW ──────────────
// Quando a aba está em segundo plano mas ainda aberta, o app envia
// { type: 'SHOW_NOTIFICATION', title, body, chatId } e o SW mostra.
self.addEventListener('message', e => {
  const data = e.data || {};

  if (data.type === 'SHOW_NOTIFICATION') {
    const title = data.title || 'CRM Odonto';
    const options = {
      body:     data.body || '',
      icon:     '/tooth.png',
      badge:    '/tooth.png',
      tag:      data.chatId || 'msg',
      renotify: true,
      data:     { chatId: data.chatId, url: '/' },
      actions:  [
        { action: 'open',  title: 'Abrir' },
        { action: 'close', title: 'Fechar' },
      ],
      vibrate:  [200, 100, 200],
    };
    self.registration.showNotification(title, options);
  }
});

// ── Clique na notificação ────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'close') return;

  const chatId = e.notification.data?.chatId;
  const url    = e.notification.data?.url || '/';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes(location.origin));
      if (existing) {
        existing.focus();
        if (chatId) existing.postMessage({ type: 'OPEN_CHAT', chatId });
        return;
      }
      return self.clients.openWindow(url);
    })
  );
});

// ── Background Sync (keepalive) ──────────────────────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'keepalive') {
    e.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({ type: 'PING' }));
      })
    );
  }
});
