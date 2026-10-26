// Cash table records: hiding a table from my profile, the host deleting a test
// table, and the admin deleting any cash table for good.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from '../src/app';
import { closeDb, getTable, listHandsByTable, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity, dbStore } from '../src/storage';
import { socketClient, type Client } from './socket-client';

const KEY = 'admin-key-for-tests-0123';
let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function start() {
  server = createApp({ identity: dbIdentity(db), store: dbStore(db), accounts: db, adminKey: KEY, log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
}

async function stop() {
  for (const c of clients.splice(0)) c.close();
  await server.close();
}

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
  await start();
});

afterAll(async () => {
  await stop();
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
  await host.until((v) => v.hand?.phase === 'complete' && v.realGame);
  // Hand and table saves are debounced.
  await pause(900);
  return { host, guest, tableId };
}

const me = async (guest: string) =>
  (await (await fetch(`${url}/api/account/me`, { headers: { 'x-guest-token': guest } })).json()) as {
    tables: { tableId: string }[];
    hiddenTables: { tableId: string }[];
  };

const post = (path: string, body: object | null, headers: Record<string, string>) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

describe('hiding a table from my profile', () => {
  it('moves it to my hidden list only, and back', async () => {
    const { tableId } = await playedTable('Hide me', 'hide-host-secret-0123456789', 'hide-guest-secret-0123456789');
    expect((await me('hide-host-secret-0123456789')).tables.map((t) => t.tableId)).toContain(tableId);

    const hid = await post('/api/account/tables/hide', { tableId, hidden: true }, { 'x-guest-token': 'hide-host-secret-0123456789' });
    expect(hid.status).toBe(200);
    const after = await me('hide-host-secret-0123456789');
    expect(after.tables.map((t) => t.tableId)).not.toContain(tableId);
    expect(after.hiddenTables.map((t) => t.tableId)).toEqual([tableId]);
    // The other player still sees it, and the hands are all there.
    expect((await me('hide-guest-secret-0123456789')).tables.map((t) => t.tableId)).toContain(tableId);
    expect((await listHandsByTable(db, tableId)).hands).toHaveLength(1);

    await post('/api/account/tables/hide', { tableId, hidden: false }, { 'x-guest-token': 'hide-host-secret-0123456789' });
    const back = await me('hide-host-secret-0123456789');
    expect(back.tables.map((t) => t.tableId)).toContain(tableId);
    expect(back.hiddenTables).toEqual([]);
  });

  it('answers 404 for a table that does not exist', async () => {
    const res = await post('/api/account/tables/hide', { tableId: 'nope-nope-1', hidden: true }, { 'x-guest-token': 'hide-host-secret-0123456789' });
    expect(res.status).toBe(404);
  });
});

describe('the host deleting a table', () => {
  it('deletes a table nobody played a real game at, and tells everyone there', { timeout: 20_000 }, async () => {
    const host = client('del-host-secret-0123456789');
    const watcher = client('del-watch-secret-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Oops' } } });
    await host.call('table:join', { tableId });
    await watcher.call('table:join', { tableId });
    // A practice bot hand doesn't count as a real game.
    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
    await host.call('bot:add', { seat: 1 });
    await host.call('host:settings', { patch: { timing: { autoStartNextHand: false } } });
    await host.call('host:start');
    // The bot takes a moment to think; the host folds on their turn.
    const done = await host.until((v) => {
      if (v.legal && v.hand?.phase !== 'complete') void host.call('hand:act', { type: 'fold' }).catch(() => {});
      return v.hand?.phase === 'complete';
    });
    expect(done.realGame).toBe(false);
    await pause(900);
    expect(await getTable(db, tableId)).not.toBeNull();
    expect((await listHandsByTable(db, tableId)).hands).toHaveLength(1);

    const told = new Promise<{ id: string }>((resolve) => watcher.socket.once('table:deleted', resolve));
    await host.call('host:deleteTable');
    expect(await told).toEqual({ id: tableId });
    expect(await getTable(db, tableId)).toBeNull();
    expect((await listHandsByTable(db, tableId)).hands).toHaveLength(0);
    await expect(watcher.call('table:join', { tableId })).rejects.toThrow('table not found');
    await expect(watcher.call('host:start')).rejects.toThrow('join a table first');
  });

  it('refuses once two people have played a hand, and for anyone but the host', async () => {
    const { host, guest, tableId } = await playedTable('Real night', 'real-host-secret-0123456789', 'real-guest-secret-0123456789');
    await expect(guest.call('host:deleteTable')).rejects.toThrow('only the host');
    await expect(host.call('host:deleteTable')).rejects.toThrow('people have played real hands here');
    expect(await getTable(db, tableId)).not.toBeNull();
  });

  it('remembers a real game for tables saved before the runtime counted them', async () => {
    const { tableId } = await playedTable('Old table', 'old-host-secret-0123456789', 'old-guest-secret-0123456789');
    await stop();
    await db.execute(sql`update table_snapshots set state = state - 'realGame' where table_id = ${tableId}`);
    await start();
    const host = client('old-host-secret-0123456789');
    await host.call('table:join', { tableId });
    expect(host.view().realGame).toBe(true);
    await expect(host.call('host:deleteTable')).rejects.toThrow('people have played real hands here');
  });
});

describe('the admin deleting a table', () => {
  it('needs the admin key, shows what the table is, then deletes it with its hands', async () => {
    const { guest, tableId } = await playedTable('Mistake', 'adm-host-secret-0123456789', 'adm-guest-secret-0123456789');
    expect((await fetch(`${url}/api/admin/tables/${tableId}`)).status).toBe(401);

    const look = await (await fetch(`${url}/api/admin/tables/${tableId}`, { headers: { 'x-admin-key': KEY } })).json();
    expect(look).toMatchObject({ id: tableId, name: 'Mistake', mode: 'cash', hands: 1, realGame: true, live: true });
    expect(look.players.sort()).toEqual(['Guest', 'Host']);

    expect((await post(`/api/admin/tables/${tableId}/delete`, null, {})).status).toBe(401);
    const told = new Promise((resolve) => guest.socket.once('table:deleted', resolve));
    const res = await post(`/api/admin/tables/${tableId}/delete`, null, { 'x-admin-key': KEY });
    expect(res.status).toBe(200);
    await told;
    expect(await getTable(db, tableId)).toBeNull();
    expect((await listHandsByTable(db, tableId)).hands).toHaveLength(0);
    expect((await me('adm-guest-secret-0123456789')).tables.map((t) => t.tableId)).not.toContain(tableId);
    expect((await post(`/api/admin/tables/${tableId}/delete`, null, { 'x-admin-key': KEY })).status).toBe(404);
  });
});
