self.addEventListener('fetch', e => {
  // network-first: always try network, fall back to cache
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

self.addEventListener('push', e => {
  if (!e.data) return;
  let data;
  try { data = e.data.json(); } catch { return; }

  const { title, body, roomId, url } = data;

  e.waitUntil(
    // Check if user already has the room open and focused
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      const roomUrl = url || `/room.html?room=${roomId}`;
      const already = wins.some(w => w.url.includes(roomId) && w.focused);
      if (already) return; // skip notification if room is already open and focused
      return self.registration.showNotification(title, {
        body,
        icon: '/babel-fish.png',
        badge: '/babel-fish.png',
        tag: roomId,          // group notifications per room
        renotify: true,
        data: { url: roomUrl }
      });
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/home.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      // Focus existing window if found
      for (const w of wins) {
        if (w.url.includes(url.split('?')[0])) { return w.focus(); }
      }
      return clients.openWindow(url);
    })
  );
});
