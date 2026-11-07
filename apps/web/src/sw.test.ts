// The service worker (public/sw.js) as a phone runs it: a push always shows
// an alert, quietly when the page already showed the same one, and takes
// down the alerts it replaces; a tap focuses, sends or opens a tab on the
// alert's page, and never a page of another site. The worker runs in a
// sandbox with stand-ins for the browser's registration and tabs.

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://poker.example';
const SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

interface Alert {
  title: string;
  options: { body?: string; tag?: string; renotify?: boolean; icon?: string; data?: { url: string } };
  closed: boolean;
}

interface Tab {
  url: string;
  visibilityState: 'visible' | 'hidden';
  focus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

function worker(opts: { tabs?: { path: string; visible?: boolean }[] } = {}) {
  const alerts: Alert[] = [];
  const handlers = new Map<string, (event: unknown) => void>();
  const tabs: Tab[] = (opts.tabs ?? []).map((t) => ({
    url: `${ORIGIN}${t.path}`,
    visibilityState: t.visible ? 'visible' : 'hidden',
    focus: vi.fn(async () => undefined),
    postMessage: vi.fn(),
  }));
  const openWindow = vi.fn(async () => null);
  const handle = (a: Alert) => ({ tag: a.options.tag ?? '', data: a.options.data, close: () => (a.closed = true) });
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
    registration: {
      getNotifications: async () => alerts.filter((a) => !a.closed).map(handle),
      showNotification: async (title: string, options: Alert['options']) => void alerts.push({ title, options, closed: false }),
    },
    clients: { matchAll: async () => tabs, openWindow },
  };
  runInNewContext(SOURCE, { self, URL, Response, fetch: () => Promise.reject(new Error('offline')) });

  /** Fires an event at the worker and waits for what it asked the browser to wait for. */
  async function fire(type: string, event: object) {
    let wait: Promise<unknown> = Promise.resolve();
    handlers.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  }
  const push = (body: unknown) => fire('push', { data: { json: () => (typeof body === 'string' ? JSON.parse(body) : body) } });
  const tap = async (a: Alert) => {
    const n = handle(a);
    await fire('notificationclick', { notification: n });
    expect(a.closed).toBe(true);
  };
  /** The page itself showed an alert (notify.ts goes through the same registration). */
  const pageShowed = (tag: string, url: string) => alerts.push({ title: 'Your turn', options: { tag, data: { url } }, closed: false });
  return { alerts, tabs, openWindow, push, tap, pageShowed };
}

describe('a push', () => {
  it('shows the alert it carries, with its page to open', async () => {
    const w = worker();
    await w.push({ title: 'Your turn', body: 'Friday', url: '/t/t1', tag: 'turn:t1:3:10', replaces: 'turn:t1:' });
    expect(w.alerts).toEqual([
      { title: 'Your turn', options: { body: 'Friday', tag: 'turn:t1:3:10', renotify: true, icon: '/icon-192.png', data: { url: '/t/t1' } }, closed: false },
    ]);
  });

  it('shows it again quietly when the page already showed the same alert', async () => {
    const w = worker();
    w.pageShowed('turn:t1:3:10', '/t/t1');
    await w.push({ title: 'Your turn', body: 'Friday', url: '/t/t1', tag: 'turn:t1:3:10', replaces: 'turn:t1:' });
    expect(w.alerts).toHaveLength(2);
    expect(w.alerts[0].closed).toBe(false);
    expect(w.alerts[1].options.renotify).toBe(false);
  });

  it('takes down the alerts it replaces, and only those', async () => {
    const w = worker();
    await w.push({ title: 'Your turn', body: 'Friday', url: '/t/t1', tag: 'turn:t1:3:10', replaces: 'turn:t1:' });
    await w.push({ title: 'Your turn', body: 'Saturday', url: '/t/t2', tag: 'turn:t2:1:4', replaces: 'turn:t2:' });
    await w.push({ title: "You're seated", body: 'Your tournament table is ready.', url: '/t/tn-t1', tag: 'seat:tn:tn-t1', replaces: 'seat:tn:' });
    // The next turn at the first table, and a move to another table of the tournament.
    await w.push({ title: 'Your turn', body: 'Friday', url: '/t/t1', tag: 'turn:t1:4:2', replaces: 'turn:t1:' });
    await w.push({ title: "You've been moved", body: 'The tournament moved you to another table.', url: '/t/tn-t2', tag: 'seat:tn:tn-t2', replaces: 'seat:tn:' });
    expect(w.alerts.filter((a) => !a.closed).map((a) => a.options.tag)).toEqual(['turn:t2:1:4', 'turn:t1:4:2', 'seat:tn:tn-t2']);
  });

  it("still shows something for a push that isn't one of ours, and never a page of another site", async () => {
    const w = worker();
    await w.push({ title: 5, body: { cards: 'As Kd' } });
    await w.push('not json');
    for (const a of w.alerts) expect(a).toMatchObject({ title: 'RSDP Poker Live!', options: { body: '', data: { url: '/' } } });
    for (const url of ['https://evil.example/x', '//evil.example/x', '/\\evil.example/x', 'javascript:alert(1)']) {
      await w.push({ title: 'Your turn', url, tag: `x:${url}` });
      expect(w.alerts.at(-1)!.options.data).toEqual({ url: '/' });
    }
  });
});

describe('tapping an alert', () => {
  const alert = (path: string): Alert => ({ title: 'Your turn', options: { tag: 'turn:t1:3:10', data: { url: path } }, closed: false });

  it('brings a tab already on its page to the front', async () => {
    const w = worker({ tabs: [{ path: '/', visible: true }, { path: '/t/t1' }] });
    await w.tap(alert('/t/t1'));
    expect(w.tabs[1].focus).toHaveBeenCalledOnce();
    expect(w.tabs[0].focus).not.toHaveBeenCalled();
    expect(w.tabs.every((t) => t.postMessage.mock.calls.length === 0)).toBe(true);
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it('sends an open tab of the site there, the one on screen first', async () => {
    const w = worker({ tabs: [{ path: '/tn/abc' }, { path: '/', visible: true }] });
    await w.tap(alert('/t/t1'));
    expect(w.tabs[1].focus).toHaveBeenCalledOnce();
    expect(w.tabs[1].postMessage).toHaveBeenCalledWith({ open: '/t/t1' });
    expect(w.tabs[0].postMessage).not.toHaveBeenCalled();
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it('opens the page when no tab of the site is open, and the home page for an address elsewhere', async () => {
    const w = worker();
    await w.tap(alert('/t/t1'));
    expect(w.openWindow).toHaveBeenLastCalledWith('/t/t1');
    await w.tap(alert('/\\evil.example/x'));
    expect(w.openWindow).toHaveBeenLastCalledWith('/');
  });
});
