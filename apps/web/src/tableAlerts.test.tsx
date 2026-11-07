// @vitest-environment jsdom
// The table page's own alerts (useTableEffects in TablePage.tsx): "Your turn", and "Your pick" while the table waits
// for my Dealer's choice pick, are both under the table's turn alerts, so each comes down once it is over and the
// next one at the table replaces it.

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChoiceView, TableView } from '@rsdp/engine/wire';
import { CHECKED_TO_ME, tableView } from './test-table';

const alerts = vi.hoisted(() => ({ notify: vi.fn(), closeNotifications: vi.fn() }));
vi.mock('./notify', async (actual) => ({ ...(await actual<typeof import('./notify')>()), ...alerts }));
// The table's parts that talk to the server load with the page; nothing is ever sent here.
vi.mock('./socket', () => ({
  call: vi.fn(() => new Promise(() => {})),
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
  guestToken: () => 'guest-secret-0123456789',
  sessionToken: () => '',
  savedName: () => '',
  NoAnswerError: class extends Error {},
}));

const { enterPresses, useTableEffects } = await import('./TablePage');

/** Between hands 7 and 8, the table waiting for Ann's (seat 0) pick, or for nobody's once `deadline` is null. */
function waiting(deadline: number | null, chip = 0): TableView {
  const choice: ChoiceView = { chip, current: null, handsLeft: 0, next: null, open: deadline !== null, deadline, count: 3, cap: null, closed: false, defaultIndex: 0, canKeep: true };
  return tableView({ hand: { phase: 'complete', toAct: null }, view: { choice } });
}

/** The page's hook through a list of views, in order. */
function through(...views: TableView[]) {
  const preQueued = { current: false };
  const { rerender, unmount } = renderHook(({ view }) => useTableEffects(view, 0, preQueued), { initialProps: { view: views[0] } });
  for (const view of views.slice(1)) rerender({ view });
  return unmount;
}

const shown = () => alerts.notify.mock.calls.map(([title, , opts]) => ({ title: title as string, tag: (opts as { tag: string }).tag, replaces: (opts as { replaces?: string }).replaces }));
const closed = () => alerts.closeNotifications.mock.calls.map(([prefix]) => prefix as string);

afterEach(() => vi.clearAllMocks());

describe("the table page's alerts", () => {
  it('takes down the alert for my pick once the pick is over, here or elsewhere', () => {
    // Picked on the phone (or the clock ran out): the table no longer waits for me.
    through(waiting(null), waiting(20_000), waiting(null));
    expect(shown()).toEqual([{ title: 'Your pick: choose the next game', tag: 'turn:t1:pick:7', replaces: 'turn:t1:' }]);
    expect(closed()).toHaveLength(1);
    expect(shown()[0].tag.startsWith(closed()[0])).toBe(true);
  });

  it("is replaced by the first turn of the hand it picked, which comes down in turn; another table's stay", () => {
    const dealt = tableView({ hand: { handNumber: 8, events: [] }, legal: CHECKED_TO_ME, view: { choice: waiting(null).choice } });
    const acted = tableView({ hand: { handNumber: 8, toAct: 1, events: [] }, view: { choice: waiting(null).choice } });
    through(waiting(null), waiting(20_000), dealt, acted);
    const [pick, turn] = shown();
    expect(pick.title).toBe('Your pick: choose the next game');
    expect(turn).toEqual({ title: 'Your turn', tag: 'turn:t1:8:0', replaces: 'turn:t1:' });
    expect(pick.tag.startsWith(turn.replaces!)).toBe(true);
    expect(closed()).toEqual(['turn:t1:']);
    expect('turn:t2:pick:3'.startsWith(closed()[0])).toBe(false);
  });

  it('calls me when the table opens on my turn (following my seat from the lobby in a tab behind), and only once', () => {
    const dealt = tableView({ hand: { handNumber: 1, events: [] }, legal: CHECKED_TO_ME });
    // The next update on the same turn (a chat line, a clock) is a new view.
    through(dealt, { ...dealt, chat: [] });
    expect(shown()).toEqual([{ title: 'Your turn', tag: 'turn:t1:1:0', replaces: 'turn:t1:' }]);
    vi.clearAllMocks();
    // Opening it on someone else's turn says nothing.
    through(tableView({ hand: { handNumber: 1, toAct: 1, events: [] } }));
    expect(shown()).toEqual([]);
  });

  it("doesn't call me for someone else's pick", () => {
    through(waiting(null, 1), waiting(20_000, 1), waiting(null, 1));
    expect(shown()).toEqual([]);
  });
});

describe('Enter at the table (#320)', () => {
  it('presses a button reached with the keyboard, not one pressed with the mouse or that focus went back to', () => {
    const menu = document.createElement('button');
    const item = document.createElement('button');
    document.body.append(menu, item);
    expect(enterPresses(menu, null)).toBe(true);
    expect(enterPresses(menu, menu)).toBe(false);
    expect(enterPresses(menu, item)).toBe(true);
    // The Menu's item that was clicked has gone with its list, and focus went back to Menu.
    item.remove();
    expect(enterPresses(menu, item)).toBe(false);
    expect(enterPresses(null, null)).toBe(false);
    menu.remove();
  });
});
