/*
 * The service worker that makes the site installable as an app. It keeps
 * nothing stale: pages and files always come from the network, and only
 * when the network is down does a page load get the offline note.
 * Game traffic (Socket.IO) and /api never pass through it.
 *
 * It also shows the alerts the server pushes to a device that turned them on
 * (a tournament starting soon, seated, moved, your turn), and opens the right
 * page when one is tapped. Each push is encrypted for this browser alone; it
 * carries only the alert's words, the page to open and a tag.
 */
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RSDP Live!</title><body style="margin:0;background:#10161d;color:#e8eef4;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center">
<div><h1 style="color:#f2b84b">No connection</h1><p>RSDP Live! needs the internet to deal.</p><button onclick="location.reload()" style="font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#c0392b;color:#fff">Try again</button></div>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate') return;
  event.respondWith(fetch(req).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});

/** A page of this site (/t/…, /tn/…), or the home page for anything else: never another site. */
const pageOf = (url) => {
  if (typeof url !== 'string') return '/';
  try {
    // Resolved as the browser would: '/\\other.example/x' and '//other.example' are other sites.
    const u = new URL(url, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/';
  } catch {
    return '/';
  }
};
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

self.addEventListener('push', (event) => {
  let alert = {};
  try {
    alert = event.data ? event.data.json() : {};
  } catch {
    // Not one of ours: it still has to show something, or the browser shows its own note.
  }
  const title = text(alert.title, 100) || 'RSDP Poker Live!';
  const tag = text(alert.tag, 200) || undefined;
  const replaces = text(alert.replaces, 200);
  event.waitUntil(
    (async () => {
      // The page itself may have shown this alert already (a tab in the background): then it is shown again quietly.
      // Every push must show an alert, so a browser that can't list them still shows this one.
      const showing = await self.registration.getNotifications().catch(() => []);
      const same = tag ? showing.filter((n) => n.tag === tag) : [];
      // An earlier turn at the same table is over by now.
      if (replaces) for (const n of showing) if (n.tag.startsWith(replaces) && n.tag !== tag) n.close();
      await self.registration.showNotification(title, {
        body: text(alert.body, 300),
        tag,
        renotify: !!tag && same.length === 0,
        icon: '/icon-192.png',
        data: { url: pageOf(alert.url) },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const page = pageOf(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const pathOf = (c) => new URL(c.url).pathname;
      // A tab already on that page comes to the front; otherwise a tab of the site goes there; otherwise a new one opens.
      const there = tabs.find((c) => pathOf(c) === page);
      if (there) return there.focus();
      const tab = tabs.find((c) => c.visibilityState === 'visible') || tabs[0];
      if (tab) {
        await tab.focus();
        tab.postMessage({ open: page });
        return;
      }
      await self.clients.openWindow(page);
    })(),
  );
});
