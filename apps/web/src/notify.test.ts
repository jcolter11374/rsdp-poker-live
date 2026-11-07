// @vitest-environment jsdom
// Alerts in the browser (notify.ts): which devices can have them (Android
// through the service worker, iPhone only from the home screen), push
// subscribing and unsubscribing with the server, and one alert per tag when
// the page and a push both have it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./socket', () => ({ guestToken: () => 'guest-secret-0123456789', sessionToken: () => 'session-token-abc' }));

const KEY = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : i));
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface Shown {
  title: string;
  options: NotificationOptions & { renotify?: boolean };
  closed: boolean;
}

/** A browser with alerts, push and a running service worker, as far as notify.ts can tell. */
function fakeBrowser(opts: { ua?: string; permission?: NotificationPermission; standalone?: boolean; existing?: { key: Uint8Array } } = {}) {
  const posts: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const shown: Shown[] = [];
  let permission: NotificationPermission = opts.permission ?? 'default';
  const makeSub = (key: Uint8Array, n: number) => ({
    endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
    options: { applicationServerKey: key.buffer },
    toJSON: () => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: 'BKey', auth: 'auth' } }),
    unsubscribe: vi.fn(async () => {
      current = null;
      return true;
    }),
  });
  let made = 0;
  let current: ReturnType<typeof makeSub> | null = opts.existing ? makeSub(opts.existing.key, made++) : null;
  const subscribeCalls: PushSubscriptionOptionsInit[] = [];
  const reg = {
    pushManager: {
      getSubscription: async () => current,
      subscribe: async (o: PushSubscriptionOptionsInit) => {
        subscribeCalls.push(o);
        current = makeSub(new Uint8Array(o.applicationServerKey as Uint8Array), made++);
        return current;
      },
    },
    getNotifications: async (filter?: { tag?: string }) =>
      shown.filter((n) => !n.closed && (!filter?.tag || n.options.tag === filter.tag)).map((n) => ({ tag: n.options.tag ?? '', close: () => (n.closed = true) })),
    showNotification: async (title: string, options: NotificationOptions) => void shown.push({ title, options, closed: false }),
  };
  Object.defineProperty(navigator, 'userAgent', { value: opts.ua ?? 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130', configurable: true });
  Object.defineProperty(navigator, 'standalone', { value: opts.standalone ?? false, configurable: true });
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { ready: Promise.resolve(reg), getRegistration: async () => reg, addEventListener: () => {}, startMessages: () => {} },
    configurable: true,
  });
  (window as unknown as { PushManager: unknown }).PushManager = class {};
  class FakeNotification {
    static get permission() {
      return permission;
    }
    static requestPermission = vi.fn(async () => (permission = 'granted'));
  }
  (globalThis as unknown as { Notification: unknown }).Notification = FakeNotification;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/push/key') return { ok: true, json: async () => ({ key: b64(KEY) }) };
      posts.push({ path, body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
      return { ok: true, json: async () => ({ ok: true }) };
    }),
  );
  return { posts, shown, subscribeCalls, reg, current: () => current, requestPermission: FakeNotification.requestPermission };
}

async function load() {
  vi.resetModules();
  return import('./notify');
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { Notification?: unknown }).Notification;
});

describe('which devices can have alerts', () => {
  it('asks an iPhone to add the site to the home screen first, and offers alerts once it is opened from there', async () => {
    fakeBrowser({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' });
    let notify = await load();
    expect(notify.notifyState()).toBe('install');
    expect(await notify.enableNotifications()).toBe('install');
    fakeBrowser({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1', standalone: true });
    notify = await load();
    expect(notify.notifyState()).toBe('off');
  });

  it('offers them on Android Chrome now that they go through the service worker', async () => {
    fakeBrowser({ ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130 Mobile' });
    const notify = await load();
    expect(notify.notifyState()).toBe('off');
    expect(notify.pushAvailable()).toBe(true);
    expect(await notify.enableNotifications()).toBe('on');
  });

  it('says blocked when the browser refused them', async () => {
    fakeBrowser({ permission: 'denied' });
    const notify = await load();
    expect(notify.notifyState()).toBe('denied');
  });
});

describe('push', () => {
  it("turning alerts on subscribes the device with the server's key and tells the server who it is", async () => {
    const b = fakeBrowser();
    const notify = await load();
    expect(await notify.enableNotifications()).toBe('on');
    expect(b.requestPermission).toHaveBeenCalledOnce();
    expect(b.subscribeCalls).toHaveLength(1);
    expect(b.subscribeCalls[0].userVisibleOnly).toBe(true);
    expect([...(b.subscribeCalls[0].applicationServerKey as Uint8Array)]).toEqual([...KEY]);
    expect(b.posts).toEqual([
      {
        path: '/api/push/subscribe',
        body: { endpoint: 'https://fcm.googleapis.com/fcm/send/0', keys: { p256dh: 'BKey', auth: 'auth' } },
        headers: expect.objectContaining({ 'x-guest-token': 'guest-secret-0123456789', 'x-session-token': 'session-token-abc' }),
      },
    ]);
  });

  it('turning them off tells the server to forget the device and drops the subscription', async () => {
    const b = fakeBrowser();
    const notify = await load();
    await notify.enableNotifications();
    const sub = b.current()!;
    notify.disableNotifications();
    expect(notify.notifyState()).toBe('off');
    await vi.waitFor(() => expect(sub.unsubscribe).toHaveBeenCalled());
    expect(b.posts.at(-1)).toMatchObject({ path: '/api/push/unsubscribe', body: { endpoint: sub.endpoint } });
  });

  it('on each visit keeps the subscription, and makes a new one if the server has a new key', async () => {
    const same = fakeBrowser({ permission: 'granted', existing: { key: KEY } });
    localStorage.setItem('rsdp.notify', 'on');
    let notify = await load();
    expect(await notify.syncPush()).toBe(true);
    expect(same.subscribeCalls).toHaveLength(0);
    expect(same.posts.map((p) => p.path)).toEqual(['/api/push/subscribe']);

    const stale = fakeBrowser({ permission: 'granted', existing: { key: new Uint8Array(65).fill(9) } });
    const old = stale.current()!;
    notify = await load();
    expect(await notify.syncPush()).toBe(true);
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(stale.subscribeCalls).toHaveLength(1);
    expect(stale.posts[0].body.endpoint).toBe('https://fcm.googleapis.com/fcm/send/1');
  });

  it('does nothing with alerts off', async () => {
    const b = fakeBrowser({ permission: 'granted' });
    const notify = await load();
    expect(await notify.syncPush()).toBe(false);
    expect(b.posts).toEqual([]);
  });
});

describe('showing alerts', () => {
  const hide = (hidden: boolean) => Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  afterEach(() => hide(false));

  it('shows them through the service worker, once per tag, replacing an earlier turn at the same table', async () => {
    const b = fakeBrowser({ permission: 'granted' });
    localStorage.setItem('rsdp.notify', 'on');
    const notify = await load();
    hide(true);
    notify.notify('Your turn', 'Friday', { tag: 'turn:t1:3:10', url: '/t/t1', replaces: 'turn:t1:' });
    await vi.waitFor(() => expect(b.shown).toHaveLength(1));
    expect(b.shown[0]).toMatchObject({ title: 'Your turn', options: { body: 'Friday', tag: 'turn:t1:3:10', renotify: true, data: { url: '/t/t1' } } });
    // Already showing (a push for the same turn got there first): the page doesn't show it again.
    notify.notify('Your turn', 'Friday', { tag: 'turn:t1:3:10', url: '/t/t1', replaces: 'turn:t1:' });
    await new Promise((r) => setTimeout(r, 10));
    expect(b.shown).toHaveLength(1);
    // The next turn replaces it.
    notify.notify('Your turn', 'Friday', { tag: 'turn:t1:4:2', url: '/t/t1', replaces: 'turn:t1:' });
    await vi.waitFor(() => expect(b.shown).toHaveLength(2));
    expect(b.shown[0].closed).toBe(true);
    // Acting takes it down.
    notify.closeNotifications('turn:');
    await vi.waitFor(() => expect(b.shown[1].closed).toBe(true));
  });

  it('stays quiet while the tab is in front, unless asked to show anyway', async () => {
    const b = fakeBrowser({ permission: 'granted' });
    localStorage.setItem('rsdp.notify', 'on');
    const notify = await load();
    hide(false);
    notify.notify('Your turn', 'Friday', { tag: 'turn:t1:1:1' });
    notify.notify('Starting soon', 'Weekly starts in 5 minutes.', { tag: 'start:tn:1', whenVisible: true });
    await vi.waitFor(() => expect(b.shown.map((n) => n.title)).toEqual(['Starting soon']));
  });
});
