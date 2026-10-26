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
  it('graphs my result at each real game and ranks everyone', { timeout: 40_000 }, async () => {
    const first = await play('Monday', 1);
    const second = await play('Tuesday', 2, true);

    // A practice table with a bot never counts.
    const ann = client(ANN);
    const { tableId: practice } = await ann.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Practice' } }, practice: { name: 'Ann', bots: 1 } });
    await ann.call('table:join', { tableId: practice });
    await ann.until((v) => {
      if (v.legal && v.hand?.handNumber === 1 && v.hand.phase !== 'complete') void ann.call('hand:act', { type: 'fold' }).catch(() => {});
      return (v.hand?.handNumber ?? 0) > 1 || (v.hand?.handNumber === 1 && v.hand.phase === 'complete');
    });
    await pause(900);

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
    // The leaderboard's graph: each game's result, oldest first.
    expect((byName.Ann as unknown as { games: { net: number }[] }).games.map((g) => g.net)).toEqual([first.stacks.Ann * 100, second.stacks.Ann]);

    // The profile keeps practice apart: bots, or nobody else, is practice.
    const solo = client(ANN);
    const { tableId: alone } = await solo.call<{ tableId: string }>('table:create', { settings: { table: { name: 'Alone' } } });
    expect(alone).toBeTruthy();
    const me = await get<{ tables: { name: string; practice: boolean }[] }>('/api/account/me');
    expect(Object.fromEntries(me.tables.map((t) => [t.name, t.practice]))).toEqual({ Monday: false, Tuesday: false, Practice: true });

    // Hiding a table takes it off my graph, not off the leaderboard.
    await fetch(`${url}/api/account/tables/hide`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-guest-token': ANN }, body: JSON.stringify({ tableId: first.tableId, hidden: true }) });
    expect((await get<{ sessions: { name: string }[] }>('/api/account/graph')).sessions.map((s) => s.name)).toEqual(['Tuesday']);
  });

  it('leaves tournament tables out of the graph, the leaderboard and the profile', { timeout: 30_000 }, async () => {
    // A real game, then the same game saved the way tournament tables are: mode 'tournament', no tournament_id.
    const { tableId } = await play('Wednesday', 1);
    const graph = (await get<{ sessions: { tableId: string }[] }>('/api/account/graph')).sessions.map((s) => s.tableId);
    const listed = (await get<{ tables: { tableId: string }[] }>('/api/account/me')).tables.map((t) => t.tableId);
    expect(graph).toContain(tableId);
    expect(listed).toContain(tableId);
    await queryRows(db, sql`update tables set mode = 'tournament' where id = ${tableId}`);
    expect((await get<{ sessions: { tableId: string }[] }>('/api/account/graph')).sessions.map((s) => s.tableId)).toEqual(graph.filter((id) => id !== tableId));
    expect((await get<{ tables: { tableId: string }[] }>('/api/account/me')).tables.map((t) => t.tableId)).toEqual(listed.filter((id) => id !== tableId));
    // The board caches for a minute per period; this period has not been asked for yet, so it is worked out now.
    const board = await get<{ rows: { name: string; hands: number }[] }>('/api/leaderboard?period=year');
    const ann = board.rows.find((r) => r.name === 'Ann');
    const before = (await get<{ rows: { name: string; hands: number }[] }>('/api/leaderboard?period=all')).rows.find((r) => r.name === 'Ann');
    // 'all' was cached by the first test, before Wednesday was played.
    expect(ann?.hands).toBe(before?.hands);
  });

  it('answers an empty board for a period with no games', async () => {
    const board = await get<{ period: string; rows: unknown[] }>('/api/leaderboard?period=nonsense');
    expect(board.period).toBe('month');
    expect(Array.isArray(board.rows)).toBe(true);
  });
});
