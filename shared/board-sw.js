/* THE.BOARD push worker. No fetch handler and no cached odds or private account data. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  let data; try { data = event.data?.json(); } catch { return; }
  if (data?.kind !== 'board-opportunity' || typeof data.id !== 'string' || typeof data.title !== 'string' || typeof data.body !== 'string' || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) return;
  let url; try { url = new URL(data.url, self.location.origin); } catch { return; }
  if (url.origin !== self.location.origin || !/^\/(?:opportunities|(?:nfl|ncaaf|mlb|nhl)\/)$/.test(url.pathname)) return;
  event.waitUntil(self.registration.showNotification(data.title.slice(0, 120), {
    body: data.body.slice(0, 240), tag: `board-opportunity:${data.id.slice(0, 256)}`, renotify: false,
    data: { kind: 'board-opportunity', url: url.href, expiresAt: data.expiresAt },
  }));
});
self.addEventListener('notificationclick', (event) => {
  if (event.notification.data?.kind !== 'board-opportunity') {
    // A legacy MLB notification may be shown by a page controlled by this root worker.
    event.notification.close();
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const client = list.find((c) => { try { const url = new URL(c.url); return url.origin === self.location.origin && url.pathname.startsWith('/mlb/'); } catch { return false; } });
      return client ? client.focus() : self.clients.openWindow('/mlb/');
    }));
    return;
  }
  event.notification.close();
  let url; try { url = new URL(event.notification.data.url, self.location.origin); } catch { return; }
  if (url.origin !== self.location.origin || !/^\/(?:opportunities|(?:nfl|ncaaf|mlb|nhl)\/)$/.test(url.pathname)) return;
  // Expired offers open the board without an old price selection.
  if (!(event.notification.data.expiresAt > Date.now())) { url.search = ''; url.hash = ''; }
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
    const client = list.find((c) => { try { const u = new URL(c.url); return u.origin === url.origin && u.pathname.startsWith(url.pathname); } catch { return false; } });
    if (client) { if (typeof client.navigate === 'function') await client.navigate(url.href); return client.focus(); }
    return self.clients.openWindow(url.href);
  }));
});
