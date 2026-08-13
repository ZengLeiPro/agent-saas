/* Web Push 事件扩展：由 vite-plugin-pwa 生成的 Service Worker 通过 importScripts 加载。 */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  event.waitUntil((async () => {
    let payload;
    try {
      payload = event.data.json();
    } catch {
      return;
    }
    const title = typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim().slice(0, 120)
      : 'Agent 任务';
    const body = typeof payload.body === 'string' ? payload.body.trim().slice(0, 120) : '状态已更新';
    const url = safeRelativeUrl(payload.url);
    const tag = typeof payload.tag === 'string' ? payload.tag.slice(0, 200) : undefined;
    await self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-96x96.png',
      tag,
      renotify: false,
      data: { url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safeRelativeUrl(event.notification.data && event.notification.data.url);
  const absoluteTarget = new URL(target, self.location.origin);
  if (absoluteTarget.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.navigate(absoluteTarget.href);
      return client.focus();
    }
    return self.clients.openWindow(absoluteTarget.href);
  })());
});

function safeRelativeUrl(value) {
  return typeof value === 'string'
    && value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('\\')
    ? value
    : '/';
}
