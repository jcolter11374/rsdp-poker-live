// Alerts: a tournament starting soon, being seated or moved, and your turn.
// Off until the player turns them on (the browser asks for permission then);
// the choice is kept per browser. With alerts on, an open tab shows them while
// it is in the background, and the browser is also subscribed for push, so
// the server can send them to a locked phone or a closed site
// (apps/server/src/push/alerts.ts; the service worker, public/sw.js, shows
// those). An alert has the same tag from the page and from a push, so one
// device shows it once.

import { useSyncExternalStore } from 'react';
import { guestToken, sessionToken } from './socket';

const KEY = 'rsdp.notify';
const ICON = '/icon-192.png';

/** `install`: an iPhone or iPad, where alerts work only once the site is on the home screen and opened from there. */
export type NotifyState = 'unsupported' | 'install' | 'denied' | 'off' | 'on';

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((cb) => cb());

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

function store(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Private windows may refuse; alerts stay as they were.
  }
}

const iPhone = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
/** Phone browsers that show alerts only through a service worker (Android Chrome refuses `new Notification()`). */
const workerOnly = () => /Android/i.test(navigator.userAgent);
const hasWorker = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
/** Push needs a service worker and the browser's PushManager (Safari on iPhone has it only from the home screen). */
const canPush = () => hasWorker() && typeof window !== 'undefined' && 'PushManager' in window;

export function notifyState(): NotifyState {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  // Safari on iPhone offers alerts only to a site added to the home screen and opened from there.
  if (iPhone() && !standalone()) return 'install';
  if (typeof Notification === 'undefined' || (workerOnly() && !hasWorker())) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && stored() ? 'on' : 'off';
}

/** Whether the last try to set this device up for push worked; null before one, and while alerts are off. */
let pushReached: boolean | null = null;
function setReached(v: boolean | null) {
  if (pushReached === v) return;
  pushReached = v;
  changed();
}

/**
 * Whether alerts on this device can also come with the site closed (push), not only to an open tab: the browser
 * has push, and setting it up didn't fail (a copy of the site has no key, a push service it won't send to, a
 * busy moment).
 */
export const pushAvailable = () => canPush() && pushReached !== false;
export const usePushAvailable = () => useSyncExternalStore(subscribe, pushAvailable);

/** Asks the browser for permission if needed, then turns alerts on, and push with them where the browser has it. */
export async function enableNotifications(): Promise<NotifyState> {
  const state = notifyState();
  if (state === 'unsupported' || state === 'install') return state;
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  store(permission === 'granted');
  changed();
  // Open-tab alerts work whatever happens here.
  if (permission === 'granted') await syncPush().catch(() => false);
  return notifyState();
}

export function disableNotifications() {
  void turnOffAlerts();
}

/**
 * Turns alerts off on this browser, and waits until the server and the browser have dropped its push subscription.
 * Signing out and deleting the account do this too, so a phone never goes on alerting for someone who left it.
 */
export async function turnOffAlerts(): Promise<void> {
  store(false);
  pushReached = null;
  changed();
  await unsubscribePush().catch(() => {});
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  // Permission can change in the browser's site settings, and alerts in another tab, while the page is open.
  document.addEventListener('visibilitychange', cb);
  window.addEventListener('storage', cb);
  return () => {
    listeners.delete(cb);
    document.removeEventListener('visibilitychange', cb);
    window.removeEventListener('storage', cb);
  };
}

export function useNotifyState(): NotifyState {
  return useSyncExternalStore(subscribe, notifyState);
}

// ---------------------------------------------------------------- push

/** The service worker, once it is running; null where there is none (the dev server registers none). */
async function worker(waitMs = 10_000): Promise<ServiceWorkerRegistration | null> {
  if (!hasWorker()) return null;
  const ready = navigator.serviceWorker.ready.catch(() => null);
  return Promise.race([ready, new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs))]);
}

let serverKey: Promise<string | null> | null = null;
/** The server's public key for push, or null when it sends none (a copy of the site, or the dev server). */
function pushKey(): Promise<string | null> {
  serverKey ??= fetch('/api/push/key', { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<{ key?: unknown }>) : { key: null }))
    .then((b) => (typeof b.key === 'string' ? b.key : null))
    .catch(() => null)
    .then((key) => {
      if (key === null) serverKey = null;
      return key;
    });
  return serverKey;
}

const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const toB64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function post(path: string, body: object) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-guest-token': guestToken() };
  const session = sessionToken();
  if (session) headers['x-session-token'] = session;
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
}

/**
 * With alerts on, makes sure the server can reach this device: subscribes it for push if it isn't (or was with a
 * key the server no longer has), and tells the server who it is for now. Runs on every page load, so a browser
 * that signed in or out alerts the right player, and the server knows the device still opens the site.
 */
export async function syncPush(): Promise<boolean> {
  if (notifyState() !== 'on' || !canPush()) return false;
  let ok = false;
  try {
    ok = await reach();
  } finally {
    setReached(ok);
  }
  return ok;
}

async function reach(): Promise<boolean> {
  const reg = await worker();
  const key = reg && (await pushKey());
  if (!reg || !key) return false;
  let sub = await reg.pushManager.getSubscription();
  const kept = sub?.options.applicationServerKey;
  if (sub && (!kept || toB64(kept) !== key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64(key) });
  await post('/api/push/subscribe', sub.toJSON());
  return true;
}

/** Stops push to this device: the server forgets the subscription and the browser drops it. */
export async function unsubscribePush(): Promise<void> {
  const reg = await worker(2_000);
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

// ---------------------------------------------------------------- showing alerts

/** Alerts this page showed without the service worker, by tag, so they can be taken down once they are out of date. */
const shown = new Map<string, Notification>();
/** Tags of the alerts this tab raised through the service worker (the newest few), so coming back to it takes those down. */
const mine = new Set<string>();
const MINE_MAX = 50;

/** The service worker's registration if there is one now, without waiting for it. */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!hasWorker()) return null;
  return (await navigator.serviceWorker.getRegistration().catch(() => undefined)) ?? null;
}

/**
 * Showing an alert waits on the service worker, and so does taking alerts down: a turn that is over within moments
 * (acted on from another device, or a move queued ahead) can have its alert still on the way when the table takes it
 * down. Each show and each take-down gets the next number, and a show checks the take-downs that came after it began.
 */
let ticket = 0;
const takenDown: { prefix: string; at: number }[] = [];
const TAKEN_DOWN_MAX = 50;

function takeDown(prefix: string) {
  takenDown.push({ prefix, at: ++ticket });
  if (takenDown.length > TAKEN_DOWN_MAX) takenDown.shift();
}

/** Whether alerts with this tag were taken down after ticket `at`. */
const takenDownSince = (tag: string, at: number) => takenDown.some((c) => c.at > at && tag.startsWith(c.prefix));

/** Takes down alerts whose tag starts with `prefix` (all of them for ''), including ones a push showed. */
export function closeNotifications(prefix = '') {
  takeDown(prefix);
  for (const [tag, n] of shown) {
    if (!tag.startsWith(prefix)) continue;
    n.close();
    shown.delete(tag);
  }
  void registration()
    .then((reg) => reg?.getNotifications())
    .then((list) => list?.forEach((n) => n.tag.startsWith(prefix) && n.close()))
    .catch(() => {});
}

/**
 * Back on the page: takes down the alerts this tab raised, and any alert (a push's too) that opens the page now on
 * screen. The rest stay: a turn at another table, open in another tab or on no tab, still needs its player.
 */
function closeSeen() {
  // This tab's own alerts still on the way are seen too.
  takeDown('');
  for (const [tag, n] of shown) {
    n.close();
    shown.delete(tag);
  }
  const own = new Set(mine);
  mine.clear();
  const here = location.pathname;
  void registration()
    .then((reg) => reg?.getNotifications())
    .then((list) => list?.forEach((n) => (own.has(n.tag) || sitePage((n.data as { url?: unknown } | null)?.url) === here) && n.close()))
    .catch(() => {});
}

/** A page of this site, from an alert or a message: its path, or null for anything that would leave the site. */
function sitePage(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    // Resolved as the browser would: '/\\other.example' and '//other.example' are other sites.
    const u = new URL(url, location.origin);
    return u.origin === location.origin ? u.pathname + u.search + u.hash : null;
  } catch {
    return null;
  }
}

/** Goes to a page of the site the way a link inside it does. */
function open(url: string) {
  window.focus();
  if (location.pathname !== url) {
    history.pushState(null, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  }
}

if (typeof document !== 'undefined') {
  // Back on the page: what its alerts said is on screen now.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && closeSeen());
  // A tap on an alert in a tab that is already open (sw.js) goes to its page here, without loading the site again.
  if (hasWorker()) {
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
      const url = sitePage((e.data as { open?: unknown } | null)?.open);
      if (url) open(url);
    });
    navigator.serviceWorker.startMessages?.();
  }
}

export interface NotifyOptions {
  /** One alert per tag: the page and a push for the same thing show once. */
  tag: string;
  /** Page to open when the alert is tapped. */
  url?: string;
  /** Alerts whose tag starts with this are out of date once this one shows (an earlier turn at the same table). */
  replaces?: string;
  /** Show it even when this tab is in front (the default is only when it is hidden). */
  whenVisible?: boolean;
}

/** Shows an alert if the player turned them on and this tab is in the background. */
export function notify(title: string, body: string, opts: NotifyOptions) {
  if (notifyState() !== 'on') return;
  if (!document.hidden && !opts.whenVisible) return;
  void show(title, body, opts).catch(() => {
    // Some phone browsers only show notifications from an installed app.
  });
}

/** Notes that this tab raised the alert with this tag (the newest MINE_MAX are kept). */
function remember(tag: string) {
  mine.delete(tag);
  mine.add(tag);
  for (const old of mine) {
    if (mine.size <= MINE_MAX) break;
    mine.delete(old);
  }
}

async function show(title: string, body: string, opts: NotifyOptions) {
  // What this one replaces is out of date, even one still on the way.
  if (opts.replaces) takeDown(opts.replaces);
  const at = ++ticket;
  const stale = () => takenDownSince(opts.tag, at);
  const reg = await registration();
  if (stale()) return;
  if (reg) {
    remember(opts.tag);
    // A push for the same thing got here first.
    if ((await reg.getNotifications({ tag: opts.tag })).length) return;
    if (opts.replaces) for (const n of await reg.getNotifications()) if (n.tag.startsWith(opts.replaces)) n.close();
    if (stale()) return;
    // renotify: a new alert with the tag of one still in the tray sounds again instead of replacing it silently.
    await reg.showNotification(title, { body, tag: opts.tag, icon: ICON, data: { url: opts.url ?? '/' }, renotify: true } as NotificationOptions);
    // Taken down while it was being shown: the take-down found nothing yet, so this one goes now.
    if (stale()) for (const n of await reg.getNotifications({ tag: opts.tag })) n.close();
    return;
  }
  if (opts.replaces) closeNotifications(opts.replaces);
  const n = new Notification(title, { body, tag: opts.tag, icon: ICON, renotify: true } as NotificationOptions);
  shown.set(opts.tag, n);
  n.onclose = () => shown.get(opts.tag) === n && shown.delete(opts.tag);
  n.onclick = () => {
    if (opts.url) open(opts.url);
    else window.focus();
    n.close();
  };
}
