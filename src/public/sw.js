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
