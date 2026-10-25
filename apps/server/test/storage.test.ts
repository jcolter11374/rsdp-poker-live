import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from '../src/app';
import { closeDb, listHandsByTable, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity, dbStore } from '../src/storage';
import { socketClient, type Client } from './socket-client';

let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
  server = createApp({ identity: dbIdentity(db), store: dbStore(db), log: (m, e) => console.error(m, e) });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await server.close();
  await closeDb(db);
});

describe('database storage', () => {
  it('keeps the same player for a browser secret, saves the table and its hands', async () => {
    const host = client('db-host-secret-0123456789');
    const guest = client('db-guest-secret-0123456789');
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Saved night' } } });
    await host.call('table:join', { tableId });
    await guest.call('table:join', { tableId });
    const hostId = host.view().me.playerId;

    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
    await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 100 });
    const pending = await host.until((v) => v.requests.length === 1);
    await host.call('host:approve', { requestId: pending.requests[0].id });
    await host.call('host:settings', { patch: { timing: { autoStartNextHand: false } } });
    await host.call('host:start');
    const hv = await host.until((v) => !!v.hand);
    await (hv.legal ? host : guest).call('hand:act', { type: 'fold' });
    await host.until((v) => v.hand?.phase === 'complete');

    // Saves are debounced; give them a moment.
    await new Promise((r) => setTimeout(r, 900));
    const { hands } = await listHandsByTable(db, tableId);
    expect(hands).toHaveLength(1);
    expect(hands[0].number).toBe(1);

    // A second tab of the same browser is the same player.
    const again = client('db-host-secret-0123456789');
    await again.call('table:join', { tableId });
    expect(again.view().me.playerId).toBe(hostId);
    expect(again.view().me.seat).toBe(0);

    // Drop the table from memory: it comes back from its snapshot.
    const rt = server.tables.get(tableId)!;
    server.tables.delete(tableId);
    rt.dispose();
    const back = client('db-guest-secret-0123456789');
    await back.call('table:join', { tableId });
    expect(back.view().name).toBe('Saved night');
    expect(back.view().seats[1]?.name).toBe('Guest');
    expect(back.view().history.map((h) => h.handNumber)).toEqual([1]);
  });
});
