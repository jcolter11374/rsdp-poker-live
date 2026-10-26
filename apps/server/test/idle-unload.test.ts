// Idle cash tables are put away: saved and let go from memory once nobody has
// had them open for a while, then loaded again, unchanged, from their link.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp, memoryStore } from '../src/app';
import { closeDb, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity, dbStore } from '../src/storage';
import { FakeClock } from './fake-clock';
import { socketClient, type Client } from './socket-client';

const MINUTE = 60_000;
let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const clock = new FakeClock();
const clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const closeClient = async (c: { socket: Client }) => {
  c.socket.close();
  await pause(100);
};

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
  server = createApp({ clock, identity: dbIdentity(db), store: dbStore(db), log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients.splice(0)) c.close();
  await server.close();
  await closeDb(db);
});

/** A host and a guest sit down and play one hand (someone folds). */
async function playedTable(name: string, hostToken: string, guestToken: string) {
  const host = client(hostToken);
  const guest = client(guestToken);
  const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name }, seating: { requireApproval: false }, timing: { autoStartNextHand: false } } });
  await host.call('table:join', { tableId });
  await guest.call('table:join', { tableId });
  await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
  await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 100 });
  await host.until((v) => v.seats.filter(Boolean).length === 2);
  await host.call('host:start');
  const hv = await host.until((v) => !!v.hand);
  await (hv.legal ? host : guest).call('hand:act', { type: 'fold' });
  await host.until((v) => v.hand?.phase === 'complete');
  await host.call('chat:send', { text: 'good game' });
  return { host, guest, tableId };
}

describe('putting idle cash tables away', () => {
  it('keeps a table loaded while anyone has it open, then puts it away and brings it back unchanged', async () => {
    const { host, guest, tableId } = await playedTable('Idle one', 'idle-host-secret-0123456789', 'idle-guest-secret-0123456789');
    const before = structuredClone(server.tables.get(tableId)!.state);

    // The host walks away; the guest stays on the page for an hour.
    await closeClient(host);
    clock.advance(60 * MINUTE);
    expect(server.unloadIdle()).not.toContain(tableId);
    expect(server.tables.has(tableId)).toBe(true);

    // Once the guest leaves too, the table waits its 45 minutes before it goes.
    await closeClient(guest);
    clock.advance(30 * MINUTE);
    expect(server.unloadIdle()).not.toContain(tableId);
    clock.advance(16 * MINUTE);
    expect(server.unloadIdle()).toEqual([tableId]);
    expect(server.tables.has(tableId)).toBe(false);

    // Opening the link loads it again with seats, stacks, ledger, chat and hands as they were.
    const back = client('idle-host-secret-0123456789');
    await back.call('table:join', { tableId });
    const v = await back.until((x) => x.seats.filter(Boolean).length === 2);
    expect(v.seats.filter(Boolean)).toHaveLength(2);
    expect(server.tables.get(tableId)!.state.handNumber).toBe(1);
    const after = server.tables.get(tableId)!.state;
    expect(after.seats.map((s) => s && { name: s.name, stack: s.stack })).toEqual(before.seats.map((s) => s && { name: s.name, stack: s.stack }));
    expect(after.ledger).toEqual(before.ledger);
    expect(after.chat.map((c) => c.text)).toContain('good game');
    const { hands } = await back.call<{ hands: unknown[] }>('table:export');
    expect(hands).toHaveLength(1);
    await closeClient(back);
  });

  it('puts away a table left in the middle of a hand', async () => {
    const host = client('stuck-host-secret-0123456789');
    const guest = client('stuck-guest-secret-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Left mid-hand' }, seating: { requireApproval: false }, timing: { autoStartNextHand: false } } });
    await host.call('table:join', { tableId });
    await guest.call('table:join', { tableId });
    await host.call('seat:request', { seat: 0, name: 'A', stack: 100 });
    await guest.call('seat:request', { seat: 1, name: 'B', stack: 100 });
    await host.until((v) => v.seats.filter(Boolean).length === 2);
    await host.call('host:start');
    await host.until((v) => !!v.hand && v.hand.phase !== 'complete');
    await closeClient(host);
    await closeClient(guest);
    // Not straight away, even with nobody there.
    expect(server.unloadIdle()).not.toContain(tableId);
    clock.advance(46 * MINUTE);
    expect(server.unloadIdle()).toContain(tableId);
    // Back from its save, the hand is not lost: it's the same hand number.
    const back = client('stuck-host-secret-0123456789');
    await back.call('table:join', { tableId });
    expect(server.tables.get(tableId)!.state.handNumber).toBe(1);
    await closeClient(back);
  });

  it('a practice table stops dealing once its player leaves, and is put away later', async () => {
    const me = client('bots-only-secret-0123456789');
    const { tableId } = await me.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Practice' } }, practice: { name: 'Me', bots: 2 } });
    await me.call('table:join', { tableId });
    await me.until((v) => !!v.hand);
    await closeClient(me);

    // Past the offline grace the bots stop: no hands run with only bots there.
    clock.advance(10 * MINUTE);
    const stopped = server.tables.get(tableId)!.state.handNumber;
    clock.advance(30 * MINUTE);
    expect(server.tables.get(tableId)!.state.handNumber).toBe(stopped);

    clock.advance(10 * MINUTE);
    expect(server.unloadIdle()).toContain(tableId);
  });

  it('keeps a table loaded when its last save fails, so nothing is lost', async () => {
    const store = memoryStore();
    let failing = false;
    const flaky = { ...store, saveTable: (st: Parameters<typeof store.saveTable>[0]) => (failing ? Promise.reject(new Error('db down')) : store.saveTable(st)) };
    const own = new FakeClock();
    const app2 = createApp({ clock: own, store: flaky, idleUnloadMs: 45 * MINUTE, log: () => {} });
    await new Promise<void>((resolve) => app2.http.listen(0, resolve));
    const c = socketClient(`http://localhost:${(app2.http.address() as AddressInfo).port}`, 'flaky-save-secret-0123456789', clients);
    const { tableId } = await c.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Flaky' } } });
    await c.call('table:join', { tableId });
    await c.call('chat:send', { text: 'only in memory' });
    await closeClient(c);
    failing = true;
    own.advance(46 * MINUTE);
    expect(app2.unloadIdle()).toEqual([tableId]);
    await pause(50);
    expect(app2.tables.get(tableId)?.state.chat.map((m) => m.text)).toContain('only in memory');
    // Once saving works again it goes on the next sweep.
    failing = false;
    own.advance(46 * MINUTE);
    expect(app2.unloadIdle()).toEqual([tableId]);
    await pause(50);
    expect((await store.loadTable(tableId))?.chat.map((m) => m.text)).toContain('only in memory');
    await app2.close();
  });
});
