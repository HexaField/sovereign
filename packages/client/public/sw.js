// Sovereign Service Worker — handles Web Push notifications for agent
// thread-turn completions and dismisses outstanding notifications when the
// thread is iterated.
//
// Two push types:
//   { type: 'thread.turn',  threadId, title, body, tag, unreadCount }
//   { type: 'thread.clear', threadId, tag }
//
// `tag: 'thread-<id>'` lets a fresh push replace an outstanding one for the
// same thread, and lets us dismiss by tag on clear.

const SW_VERSION = 'sovereign-v1'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let data
  try {
    data = event.data ? event.data.json() : null
  } catch {
    data = null
  }
  if (!data || typeof data !== 'object') return

  if (data.type === 'thread.clear' && data.tag) {
    event.waitUntil(
      self.registration.getNotifications({ tag: data.tag }).then((notifs) => {
        for (const n of notifs) n.close()
      })
    )
    return
  }

  if (data.type !== 'thread.turn') return

  const title = data.title || 'Sovereign'
  const body = data.body || 'Agent finished a turn.'
  const tag = data.tag || (data.threadId ? `thread-${data.threadId}` : undefined)
  const options = {
    body,
    tag,
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { threadId: data.threadId, unreadCount: data.unreadCount }
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const threadId = event.notification.data && event.notification.data.threadId
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const target = threadId ? `/#thread=${threadId}` : '/'
      for (const client of clientsList) {
        // Same-origin window already open — focus it and ask it to navigate.
        if ('focus' in client) {
          try {
            await client.focus()
            client.postMessage({ type: 'sovereign:navigate', threadId })
            return
          } catch {
            /* fall through to openWindow */
          }
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(target)
      }
    })()
  )
})

// In-page → SW: explicit dismiss request (used by the client when it knows a
// thread has just been read).
self.addEventListener('message', (event) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'sovereign:dismiss-thread' && typeof msg.threadId === 'string') {
    const tag = `thread-${msg.threadId}`
    self.registration.getNotifications({ tag }).then((notifs) => {
      for (const n of notifs) n.close()
    })
  }
})
