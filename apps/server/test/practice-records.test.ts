// Practice games on my profile: deleting them, and the practice graph I can reset.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from '../src/app';
import { closeDb, getTable, listHandsByTable, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity, dbStore } from '../src/storage';
import { socketClient, type Client } from './socket-client';

let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
  server = createApp({ identity: dbIdentity(db), store: dbStore(db), accounts: db, log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients.splice(0)) c.close();
  await server.close();
  await closeDb(db);
});

type Row = { tableId: string; net: number | null; practice: boolean; centsMode: boolean };
const me = async (guest: string) =>
  (await (await fetch(`${url}/api/account/me`, { headers: { 'x-guest-token': guest } })).json()) as { tables: Row[]; hiddenTables: Row[] };
const practiceGraph = async (guest: string) =>
  (await (await fetch(`${url}/api/account/practice-graph`, { headers: { 'x-guest-token': guest } })).json()) as {
    since: string | null;
    sessions: { tableId: string; hands: number; net: number }[];
  };
const realGraph = async (guest: string) =>
  (await (await fetch(`${url}/api/account/graph`, { headers: { 'x-guest-token': guest } })).json()) as { sessions: { tableId: string }[] };
const post = (path: string, body: object, guest: string) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-guest-token': guest }, body: JSON.stringify(body) });

/** Plays `count` more hands, folding whenever it's my turn. */
async function playHands(c: ReturnType<typeof client>, count: number) {
  for (let n = 0; n < count; n++) {
    const last = c.view()?.hand?.handNumber ?? 0;
    await c.call(last === 0 ? 'host:start' : 'host:deal');
    await c.until((v) => {
      if (v.legal && v.hand?.phase !== 'complete') void c.call('hand:act', { type: 'fold' }).catch(() => {});
      return (v.hand?.handNumber ?? 0) > last && v.hand?.phase === 'complete';
    });
  }
  // Hand and table saves are debounced.
  await pause(900);
}

/** I sit down with one bot and play `hands` hands, then (unless `stay`) leave the page. */
async function soloPractice(token: string, hands = 1, stay = false) {
  const c = client(token);
  const { tableId } = await c.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Bots' }, timing: { autoStartNextHand: false } } });
  await c.call('table:join', { tableId });
  await c.call('seat:request', { seat: 0, name: 'Me', stack: 100 });
  await c.call('bot:add', { seat: 1 });
  await playHands(c, hands);
  if (!stay) {
    c.socket.close();
    await pause(200);
  }
  return { c, tableId };
}

describe('deleting practice games', () => {
  it('erases a table only I and my bots played at, and notes it in the public record', { timeout: 20_000 }, async () => {
    const token = 'pr-solo-secret-0123456789';
    const { tableId } = await soloPractice(token);
    expect((await me(token)).tables.find((t) => t.tableId === tableId)?.practice).toBe(true);

    const res = await post('/api/account/tables/delete-practice', { tableId }, token);
    expect(await res.json()).toMatchObject({ ok: true, deleted: 1, hidden: 0 });
    expect(await getTable(db, tableId)).toBeNull();
    expect((await listHandsByTable(db, tableId)).hands).toHaveLength(0);
    expect((await me(token)).tables.map((t) => t.tableId)).not.toContain(tableId);

    const { entries } = (await (await fetch(`${url}/api/audit/entries?kind=deleted`)).json()) as { entries: { data: { by: string } }[] };
    expect(entries.at(-1)?.data.by).toBe('player');
  });

  it('refuses while the table is open, and for real games', { timeout: 20_000 }, async () => {
    const token = 'pr-open-secret-0123456789';
    const { tableId } = await soloPractice(token, 1, true);
    const open = await post('/api/account/tables/delete-practice', { tableId }, token);
    expect(open.status).toBe(409);
    expect(await getTable(db, tableId)).not.toBeNull();

    // A real game: two people, one hand.
    const host = client('pr-real-host-secret-0123456789');
    const guest = client('pr-real-guest-secret-0123456789');
    const real = (await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Real' }, seating: { requireApproval: false }, timing: { autoStartNextHand: false } } })).tableId;
    await host.call('table:join', { tableId: real });
    await guest.call('table:join', { tableId: real });
    await host.call('seat:request', { seat: 0, name: 'Host', stack: 100 });
    await guest.call('seat:request', { seat: 1, name: 'Guest', stack: 100 });
    await host.until((v) => v.seats.filter(Boolean).length === 2);
    await host.call('host:start');
    const hv = await host.until((v) => !!v.hand);
    await (hv.legal ? host : guest).call('hand:act', { type: 'fold' });
    await host.until((v) => v.hand?.phase === 'complete' && v.realGame);
    host.socket.close();
    guest.socket.close();
    await pause(900);
    const refused = await post('/api/account/tables/delete-practice', { tableId: real }, 'pr-real-host-secret-0123456789');
    expect(refused.status).toBe(409);
    expect(await getTable(db, real)).not.toBeNull();
    expect((await realGraph('pr-real-host-secret-0123456789')).sessions.map((s) => s.tableId)).toContain(real);
  });

  it("only hides a practice table someone else also played at, so their record stays", { timeout: 20_000 }, async () => {
    const mine = 'pr-shared-a-secret-0123456789';
    const theirs = 'pr-shared-b-secret-0123456789';
    const a = client(mine);
    const b = client(theirs);
    const { tableId } = await a.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Shared' }, seating: { requireApproval: false }, timing: { autoStartNextHand: false } } });
    await a.call('table:join', { tableId });
    await b.call('table:join', { tableId });
    await a.call('seat:request', { seat: 0, name: 'A', stack: 100 });
    await b.call('seat:request', { seat: 1, name: 'B', stack: 100 });
    await a.call('bot:add', { seat: 2 });
    await a.until((v) => v.seats.filter(Boolean).length === 3);
    await a.call('host:start');
    await Promise.all(
      [a, b].map((c) =>
        c.until((v) => {
          if (v.legal && v.hand?.phase !== 'complete') void c.call('hand:act', { type: 'fold' }).catch(() => {});
          return v.hand?.phase === 'complete';
        }),
      ),
    );
    a.socket.close();
    b.socket.close();
    await pause(900);

    const res = await post('/api/account/tables/delete-practice', { all: true }, mine);
    expect(await res.json()).toMatchObject({ deleted: 0, hidden: 1 });
    expect(await getTable(db, tableId)).not.toBeNull();
    expect((await me(mine)).tables.map((t) => t.tableId)).not.toContain(tableId);
    expect((await me(theirs)).tables.map((t) => t.tableId)).toContain(tableId);
  });
});

describe("someone else's practice table", () => {
  it('is only hidden for me, even when its host never played', { timeout: 20_000 }, async () => {
    const hostToken = 'pr-own-host-secret-0123456789';
    const meToken = 'pr-own-me-secret-0123456789';
    const host = client(hostToken);
    const p = client(meToken);
    const { tableId } = await host.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Theirs' }, seating: { requireApproval: false }, timing: { autoStartNextHand: false } } });
    await host.call('table:join', { tableId });
    await p.call('table:join', { tableId });
    await host.call('bot:add', { seat: 1 });
    await p.call('seat:request', { seat: 0, name: 'Me', stack: 100 });
    await host.until((v) => v.seats.filter(Boolean).length === 2);
    await host.call('host:start');
    await p.until((v) => {
      if (v.legal && v.hand?.phase !== 'complete') void p.call('hand:act', { type: 'fold' }).catch(() => {});
      return v.hand?.phase === 'complete';
    });
    host.socket.close();
    p.socket.close();
    await pause(900);

    const res = await post('/api/account/tables/delete-practice', { tableId }, meToken);
    expect(await res.json()).toMatchObject({ deleted: 0, hidden: 1 });
    expect(await getTable(db, tableId)).not.toBeNull();
    expect((await me(meToken)).tables.map((t) => t.tableId)).not.toContain(tableId);
  });
});

describe('the practice graph', () => {
  it('adds up practice hands, stays out of the real graph, and starts again from a reset', { timeout: 30_000 }, async () => {
    const token = 'pr-graph-secret-0123456789';
    const { c, tableId } = await soloPractice(token, 2, true);
    const before = await practiceGraph(token);
    expect(before.since).toBeNull();
    expect(before.sessions).toHaveLength(1);
    expect(before.sessions[0]).toMatchObject({ tableId, hands: 2 });
    // Hand by hand comes to what the ledger says.
    const row = (await me(token)).tables.find((t) => t.tableId === tableId)!;
    expect(before.sessions[0].net).toBe(row.centsMode ? row.net : row.net! * 100);
    expect((await realGraph(token)).sessions).toHaveLength(0);

    expect((await post('/api/account/practice-graph/reset', {}, token)).status).toBe(200);
    const after = await practiceGraph(token);
    expect(after.since).not.toBeNull();
    expect(after.sessions).toHaveLength(0);

    // The same table keeps going: only hands after the reset count.
    await pause(20);
    await playHands(c, 1);
    const later = await practiceGraph(token);
    expect(later.sessions).toHaveLength(1);
    expect(later.sessions[0].hands).toBe(1);
    // The table is still on my profile.
    expect((await me(token)).tables.map((t) => t.tableId)).toContain(tableId);
  });
});
