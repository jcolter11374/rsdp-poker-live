/*
 * The service worker that makes the site installable as an app. It keeps
 * nothing stale: pages and files always come from the network, and only
 * when the network is down does a page load get the offline note.
 * Game traffic (Socket.IO) and /api never pass through it.
 */
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RSDP Poker Live!</title><body style="margin:0;background:#10161d;color:#e8eef4;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center">
<div><h1 style="color:#f2b84b">No connection</h1><p>RSDP Poker Live! needs the internet to deal.</p><button onclick="location.reload()" style="font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#c0392b;color:#fff">Try again</button></div>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate') return;
  event.respondWith(fetch(req).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
