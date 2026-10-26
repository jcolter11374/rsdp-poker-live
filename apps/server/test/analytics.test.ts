// Cash game analytics: the profit graph on a profile and the group's leaderboards.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from '../src/app';
import { closeDb, type Db } from '../src/db';
import { queryRows } from '../src/db/client';
import { createTestDb } from '../src/db/testing';
import { sql } from 'drizzle-orm';
import { dbIdentity, dbStore } from '../src/storage';
import { socketClient, type Client } from './socket-client';

let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const clients: Client[] = [];
const client = (token: string) => socketClient(url, token, clients);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ANN = 'an-ann-secret-0123456789';
const BEN = 'an-ben-secret-0123456789';

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
  server = createApp({ identity: dbIdentity(db), store: dbStore(db), accounts: db, log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await server.close();
  await closeDb(db);
});

/** Ann and Ben play `hands` hands where whoever acts first folds. */
async function play(name: string, hands: number, centsMode = false) {
  const ann = client(ANN);
  const ben = client(BEN);
  const { tableId } = await ann.call<{ tableId: string }>('table:create', {
    settings: { table: { name }, stakes: { centsMode }, seating: { requireApproval: false }, timing: { autoStartNextHand: false } },
  });
  await ann.call('table:join', { tableId });
  await ben.call('table:join', { tableId });
  await ann.call('seat:request', { seat: 0, name: 'Ann', stack: 100 });
  await ben.call('seat:request', { seat: 1, name: 'Ben', stack: 100 });
  await ann.until((v) => v.seats.filter(Boolean).length === 2);
  await ann.call('host:start');
  for (let i = 0; i < hands; i++) {
    const v = await ann.until((x) => !!x.hand && x.hand.phase !== 'complete' && x.hand.handNumber === i + 1);
    await (v.legal ? ann : ben).call('hand:act', { type: 'fold' });
    await ann.until((x) => x.hand?.handNumber === i + 1 && x.hand.phase === 'complete');
    if (i + 1 < hands) await ann.call('host:deal');
  }
  const view = ann.view();
  await pause(900);
  const stacks = Object.fromEntries(view.seats.filter(Boolean).map((s) => [s!.name, s!.stack - 100]));
  return { tableId, stacks };
}

const get = async <T>(path: string, guest = ANN) => (await (await fetch(`${url}${path}`, { headers: { 'x-guest-token': guest } })).json()) as T;

describe('analytics', () => {
  it('graphs my result at each real game and ranks everyone', { timeout: 30_000 }, async () => {
    const first = await play('Monday', 1);
    const second = await play('Tuesday', 2, true);

    // A practice table with a bot never counts.
    const ann = client(ANN);
    const { tableId: practice } = await ann.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Practice' } }, practice: { name: 'Ann', bots: 1 } });
    await ann.call('table:join', { tableId: practice });
    await ann.until((v) => (v.hand?.handNumber ?? 0) >= 1);

    const { sessions } = await get<{ sessions: { tableId: string; name: string; net: number; hands: number }[] }>('/api/account/graph');
    expect(sessions.map((s) => s.name)).toEqual(['Monday', 'Tuesday']);
    // Chip tables count a chip as 100; cents tables are already cents.
    expect(sessions[0]).toMatchObject({ tableId: first.tableId, hands: 1, net: first.stacks.Ann * 100 });
    expect(sessions[1]).toMatchObject({ tableId: second.tableId, hands: 2, net: second.stacks.Ann });

    const board = await get<{ rows: { name: string; profit: number; hands: number; sessions: number; biggestPot: number }[] }>('/api/leaderboard?period=all');
    const byName = Object.fromEntries(board.rows.map((r) => [r.name, r]));
    expect(Object.keys(byName).sort()).toEqual(['Ann', 'Ben']);
    expect(byName.Ann).toMatchObject({ hands: 3, sessions: 2, profit: first.stacks.Ann * 100 + second.stacks.Ann });
    expect(byName.Ben.profit).toBe(-byName.Ann.profit);
    expect(board.rows[0].profit).toBeGreaterThanOrEqual(board.rows[1].profit);
    expect(Math.max(byName.Ann.biggestPot, byName.Ben.biggestPot)).toBeGreaterThan(0);

    // Hiding a table takes it off my graph, not off the leaderboard.
    await fetch(`${url}/api/account/tables/hide`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-guest-token': ANN }, body: JSON.stringify({ tableId: first.tableId, hidden: true }) });
    expect((await get<{ sessions: { name: string }[] }>('/api/account/graph')).sessions.map((s) => s.name)).toEqual(['Tuesday']);
  });

  it('leaves tournament tables out of the graph, the leaderboard and the profile', { timeout: 30_000 }, async () => {
    const before = {
      graph: await get<{ sessions: unknown[] }>('/api/account/graph'),
      board: await get<{ rows: unknown[] }>('/api/leaderboard?period=all'),
      me: await get<{ tables: unknown[] }>('/api/account/me'),
    };
    // A copy of a real game saved the way tournament tables are: mode 'tournament', no tournament_id.
    const { tableId } = await play('Wednesday', 1);
    await queryRows(db, sql`update tables set mode = 'tournament' where id = ${tableId}`);
    expect((await get<{ sessions: unknown[] }>('/api/account/graph')).sessions).toEqual(before.graph.sessions);
    expect((await get<{ tables: unknown[] }>('/api/account/me')).tables).toEqual(before.me.tables);
    // The board caches for a minute; a fresh period is worked out now.
    const board = await get<{ rows: { name: string; hands: number }[] }>('/api/leaderboard?period=year');
    expect(board.rows.every((r) => r.hands === 3)).toBe(true);
    expect(before.board.rows.length).toBeGreaterThan(0);
  });

  it('answers an empty board for a period with no games', async () => {
    const board = await get<{ period: string; rows: unknown[] }>('/api/leaderboard?period=nonsense');
    expect(board.period).toBe('month');
    expect(Array.isArray(board.rows)).toBe(true);
  });
});
