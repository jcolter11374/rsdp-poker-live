// @vitest-environment jsdom
// Starting soon in the browser (TournamentAlerts): held back while the event's lobby or one of its tables is on screen
// in some tab of the site, and given once the player looks away. One a push already showed on this device isn't given
// again, and one counts as given only once it is shown.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const alerts = vi.hoisted(() => ({ notify: vi.fn(), pushed: new Set<string>() }));
vi.mock('../notify', () => ({
  useNotifyState: () => 'on',
  usePushAvailable: () => true,
  syncPush: async () => true,
  enableNotifications: async () => 'on',
  disableNotifications: () => {},
  notify: alerts.notify,
  // What the service worker noted it showed from a push.
  shownByPush: async (tags: string[]) => new Set(tags.filter((t) => alerts.pushed.has(t))),
}));
vi.mock('../socket', () => ({ socket: { on: () => {}, off: () => {}, emit: () => {} } }));
const event = vi.hoisted(() => ({ startAt: 0 }));
vi.mock('./client', () => ({
  tournamentClient: () => ({
    list: async () => ({
      serverNow: Date.now(),
      tournaments: [
        {
          id: 'abc', name: 'Friday', status: 'registering', start: 'scheduled', startAt: event.startAt, finishedAt: null, games: ['nlhe'], startingStack: 1000,
          entrants: 4, maxEntrants: 600, playersLeft: 4, playersNeeded: null, levelNumber: null, winner: null, nextId: null,
          me: { hosting: false, registered: true, alive: true, place: null },
        },
      ],
    }),
  }),
}));

const { TournamentAlerts } = await import('./TournamentAlerts');

let hidden = false;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

const startingSoon = () => alerts.notify.mock.calls.filter(([title]) => title === 'Starting soon');
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
async function open(path: string) {
  history.replaceState(null, '', path);
  render(<TournamentAlerts />);
  await wait(0);
}
async function lookAway() {
  hidden = true;
  await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
}

const fired = () => JSON.parse(localStorage.getItem('rsdp.notified') ?? '[]') as string[];

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  alerts.notify.mockReset();
  alerts.notify.mockResolvedValue(true);
  alerts.pushed.clear();
  hidden = false;
  // Four minutes to the start: Starting soon is due from the first check.
  event.startAt = Date.now() + 4 * 60_000;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Starting soon in the browser', () => {
  it('waits while its lobby is on screen, and comes the moment the player looks away, once', async () => {
    await open('/tn/abc');
    await wait(60_000);
    expect(startingSoon()).toEqual([]);
    await lookAway();
    expect(startingSoon()).toHaveLength(1);
    expect(startingSoon()[0][2]).toMatchObject({ tag: `start:abc:${event.startAt}`, url: '/tn/abc' });
    // Looking back and away again doesn't bring a second one.
    hidden = false;
    await wait(30_000);
    await lookAway();
    await wait(30_000);
    expect(startingSoon()).toHaveLength(1);
  });

  it("waits while another tab has one of the event's tables on screen, until that tab stops saying so", async () => {
    // Another tab of the site noted it had the event on screen just now; this one is on a cash table.
    localStorage.setItem('rsdp.notified.onScreen', JSON.stringify({ 'other|abc': Date.now() }));
    await open('/t/cash1');
    await wait(30_000);
    expect(startingSoon()).toEqual([]);
    // That tab closed or looked away 35 seconds ago and hasn't noted it since.
    await wait(15_000);
    expect(startingSoon()).toHaveLength(1);
  });

  it('without push, comes once the player leaves the lobby for another page', async () => {
    await open('/tn/abc');
    await wait(30_000);
    expect(startingSoon()).toEqual([]);
    history.replaceState(null, '', '/t/cash1');
    await wait(15_000);
    expect(startingSoon()).toHaveLength(1);
  });

  it("isn't given again once a push showed it on this device, even after the lobby held it back or it was tapped", async () => {
    // The server's push came at T-5 (the player may have tapped it, which closes it, and opened the lobby).
    alerts.pushed.add(`start:abc:${event.startAt}`);
    await open('/tn/abc');
    await wait(5_000);
    await lookAway();
    history.replaceState(null, '', '/t/cash1');
    hidden = false;
    await wait(60_000);
    await lookAway();
    expect(startingSoon()).toEqual([]);
    expect(fired()).toEqual([`start:abc:${event.startAt}`]);
  });

  it('is still given on looking away when no push showed it here (push turned on after the server sent it)', async () => {
    await open('/tn/abc');
    await wait(30_000);
    expect(fired()).toEqual([]);
    await lookAway();
    expect(startingSoon()).toHaveLength(1);
    expect(fired()).toEqual([`start:abc:${event.startAt}`]);
  });

  it("isn't counted as given by a tab that closes before it could show it: another tab gives it", async () => {
    // Closing or reloading the lobby: it looks away as it goes, and the alert never gets shown.
    alerts.notify.mockReturnValueOnce(new Promise(() => {}));
    await open('/tn/abc');
    await wait(20_000);
    await lookAway();
    await act(async () => void window.dispatchEvent(new Event('pagehide')));
    expect(startingSoon()).toHaveLength(1);
    expect(fired()).toEqual([]);
    cleanup();
    // The tab left on a cash table gives it at its next check.
    hidden = false;
    await open('/t/cash1');
    expect(startingSoon()).toHaveLength(2);
    expect(fired()).toEqual([`start:abc:${event.startAt}`]);
  });

  it("doesn't raise it twice while the first is still on its way", async () => {
    let shown!: (ok: boolean) => void;
    alerts.notify.mockReturnValueOnce(new Promise<boolean>((r) => (shown = r)));
    await open('/t/cash1');
    await wait(45_000);
    expect(startingSoon()).toHaveLength(1);
    await act(async () => shown(true));
    await wait(30_000);
    expect(startingSoon()).toHaveLength(1);
  });

  it("takes this tab's note down when it closes, so other tabs don't wait for it", async () => {
    await open('/tn/abc');
    expect(Object.keys(JSON.parse(localStorage.getItem('rsdp.notified.onScreen') ?? '{}'))).toHaveLength(1);
    await act(async () => void window.dispatchEvent(new Event('pagehide')));
    expect(JSON.parse(localStorage.getItem('rsdp.notified.onScreen') ?? '{}')).toEqual({});
  });
});
