/*
 * Service worker.
 *
 * Its job is installability, not offline capability: JARVIS is a window onto a
 * workstation, and an offline window would show a stale investigation while
 * implying it were current. So the shell is cached to make the app launch
 * instantly, and everything under /api is never cached or served from cache.
 */
const SHELL = 'jarvis-shell-v1'

self.addEventListener('install', (e) => {
  self.skipWaiting()
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest'])))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  // Live data and the event stream must always hit the workstation.
  if (url.pathname.startsWith('/api/') || e.request.method !== 'GET') return

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone()
          void caches.open(SHELL).then((c) => c.put(e.request, copy))
        }
        return res
      })
      // Only the shell falls back to cache — enough to launch and say it is
      // offline, never enough to present stale intelligence as current.
      .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match('/')))
  )
})

/**
 * A development arrived while the app was closed (§18).
 *
 * The notification deliberately carries no findings — it is displayed by the
 * operating system on a lock screen, so it says that something happened and in
 * which investigation, and the substance stays inside the app behind the
 * device's own authentication.
 */
self.addEventListener('push', (event) => {
  let payload = { title: 'JARVIS', body: 'A development was detected.', data: {} }
  try {
    if (event.data) payload = { ...payload, ...event.data.json() }
  } catch {
    /* keep the default */
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-180.png',
      badge: '/icon-180.png',
      // Replaces rather than stacks: five notifications about one investigation
      // is worse than one that is current.
      tag: payload.data?.watchId || 'jarvis',
      renotify: true,
      data: payload.data
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const subject = event.notification.data?.subject
  const url = subject ? `/#watch=${encodeURIComponent(subject)}` : '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Focus the app if it is already open rather than opening it twice.
      for (const client of list) {
        if (client.url.includes(self.location.origin)) {
          client.focus()
          client.navigate(url)
          return
        }
      }
      return self.clients.openWindow(url)
    })
  )
})
