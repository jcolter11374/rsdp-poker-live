// A tab that closes, leaves, or moves on to another table while its table:join is still loading the table (a table put
// away when idle, or any cash table after a restart, loads from the database) must not be joined to it when the load
// finishes: the player would show online for good (their seat gets the full clock and time bank, the deal waits for
// their fairness seed, a missing host is never handed off), and the table would never be put away.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { defaultSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp, memoryStore, type TableStore } from '../src/app';
import { TableRuntime } from '../src/runtime/table';
import { FakeClock } from './fake-clock';
import { socketClient, type Client } from './socket-client';

const MINUTE = 60_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let server: ReturnType<typeof createApp>;
let url = '';
const clock = new FakeClock();
const clients: Client[] = [];
const inner = memoryStore();
/** A database that takes a moment to read a table, as a real one does. */
const store: TableStore = {
  ...inner,
  async loadTable(id) {
    await pause(150);
    return inner.loadTable(id);
  },
};

beforeAll(async () => {
  registerAllVariants(variants);
  server = createApp({ clock, store, log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await server.close();
});

describe('a tab that closes while its table is loading', () => {
  it('is not left counted as connected', async () => {
    // A cash table saved earlier (put away, or from before a restart), with its host seated.
    const host = socketClient(url, 'join-race-host-0123456789', clients);
    const hostId = (await new Promise<{ playerId: string }>((r) => host.socket.once('session', r as never))).playerId;
    const settings = defaultSettings('cash');
    settings.stakes.centsMode = true;
    const saved = TableRuntime.create({ hostId, settings }, { clock });
    saved.state.seats[0] = { ...saved.state.seats[0], seat: 0, playerId: hostId, name: 'Host', stack: 1000, sittingOut: false, sitOutReason: null, isNew: false, missedSmallBlind: false, missedBigBlind: false, waitForBigBlind: false, straddle: false, timeouts: 0, timeBank: 30, handsSinceRefill: 0, leaveAfterHand: false, pendingChips: 0, pendingStack: null } as never;
    saved.dispose();
    await store.createTable(saved.state);
    const tableId = saved.state.id;

    // The host opens the link and closes the tab (or loses signal) before the table has loaded.
    host.socket.emit('table:join', { tableId }, () => {});
    await pause(20);
    host.socket.close();
    await pause(400);

    const rt = server.tables.get(tableId)!;
    expect(rt, 'the table was loaded').toBeTruthy();
    expect(rt.isOnline(hostId), 'host shown online with no tab open').toBe(false);

    // Hours later, with nobody there, the table should have been put away.
    clock.advance(3 * 60 * MINUTE);
    expect(server.unloadIdle(), 'idle table put away').toContain(tableId);
  });

  /** A saved table whose host opens it, then closes the tab: `early` closes it while the table is still loading. */
  async function hostLeaves(token: string, early: boolean) {
    const host = socketClient(url, token, clients);
    const hostId = (await new Promise<{ playerId: string }>((r) => host.socket.once('session', r as never))).playerId;
    const settings = defaultSettings('cash');
    settings.stakes.centsMode = true;
    settings.seating.requireApproval = false;
    const saved = TableRuntime.create({ hostId, settings }, { clock });
    saved.dispose();
    await store.createTable(saved.state);
    const tableId = saved.state.id;
    if (early) {
      host.socket.emit('table:join', { tableId }, () => {});
      await pause(20);
    } else await host.call('table:join', { tableId });
    host.socket.close();
    await pause(400);
    // A friend arrives and sits down; the table should pass to them once the host has been gone for HOST_HANDOFF_MS.
    const friend = socketClient(url, `${token}-friend`, clients);
    await friend.call('table:join', { tableId });
    await friend.call('seat:request', { seat: 1, name: 'Friend', stack: 1000 });
    clock.advance(10 * MINUTE);
    await pause(50);
    return server.tables.get(tableId)!.state.hostId === hostId ? 'still the gone host' : 'handed off';
  }

  it('control: a host who closes the tab after the table loaded is handed off', async () => {
    expect(await hostLeaves('join-race-host3-0123456789', false)).toBe('handed off');
  });

  it('a host whose tab closed while the table loaded is handed off too', async () => {
    expect(await hostLeaves('join-race-host2-0123456789', true), 'host after 10 minutes away').toBe('handed off');
  });

  it('a tab that moves on to another table before the first one loaded stays at the other one', async () => {
    const me = socketClient(url, 'join-race-hop-0123456789', clients);
    const myId = (await new Promise<{ playerId: string }>((r) => me.socket.once('session', r as never))).playerId;
    const settings = defaultSettings('cash');
    settings.stakes.centsMode = true;
    const old = TableRuntime.create({ hostId: 'someone-else', settings }, { clock });
    old.dispose();
    await store.createTable(old.state);
    const other = socketClient(url, 'join-race-hop-host-0123456789', clients);
    const { tableId: b } = await other.call<{ tableId: string }>('table:create', {});
    await other.call('table:join', { tableId: b });

    // The page opens table A (put away, so it loads from the database), then the player goes to table B.
    me.socket.emit('table:join', { tableId: old.state.id }, () => {});
    me.socket.emit('table:leave');
    await me.call('table:join', { tableId: b });
    await pause(400);

    // On table B's page: the chat line goes to table A, and B's page no longer gets B's updates.
    await me.call('chat:send', { text: 'hello B' });
    await pause(50);
    expect(server.tables.get(b)!.state.chat.map((c) => c.text), "B's chat").toContain('hello B');
    expect(server.tables.get(old.state.id)!.state.chat.map((c) => c.text), "A's chat").not.toContain('hello B');
    expect(server.tables.get(b)!.isOnline(myId), 'shown at B').toBe(true);
  });
});
