// The leaderboard's "This month" and "This year" start at midnight where the group is (the browser sends its
// time zone), not at UTC midnight, so the last evening of a month still counts in that month.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from '../src/app';
import { closeDb, createTable, saveHand, saveSnapshot, schema, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';
import { dbIdentity, dbStore } from '../src/storage';
import { FakeClock } from './fake-clock';

let db: Db;
let server: ReturnType<typeof createApp>;
let url = '';
const clock = new FakeClock();

beforeAll(async () => {
  registerAllVariants(variants);
  db = await createTestDb();
  server = createApp({ clock, identity: dbIdentity(db), store: dbStore(db), accounts: db, log: () => {}, idleUnloadMs: 0 });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
  await db.insert(schema.players).values([
    { id: 'ann', displayName: 'Ann' },
    { id: 'ben', displayName: 'Ben' },
  ]);
});

afterAll(async () => {
  await server.close();
  await closeDb(db);
});

/** A finished real cash game between Ann and Ben: Ann won `annWon` cents; its hands started at the given times. */
async function game(id: string, annWon: number, handTimes: string[]) {
  await createTable(db, { id, ownerPlayerId: 'ann', settings: { table: { name: id } }, mode: 'cash' });
  await saveSnapshot(db, id, {
    version: 1,
    state: {
      id,
      settings: { table: { name: id }, stakes: { centsMode: true } },
      seats: [null, null],
      ledger: { ann: { playerId: 'ann', name: 'Ann', buyIn: 10000, cashOut: 10000 + annWon }, ben: { playerId: 'ben', name: 'Ben', buyIn: 10000, cashOut: 10000 - annWon } },
      handNames: { ann: 'Ann', ben: 'Ben' },
    },
  });
  for (const [i, at] of handTimes.entries()) {
    await saveHand(db, {
      id: `${id}-${i + 1}`,
      tableId: id,
      number: i + 1,
      gameId: 'nlhe',
      startedAt: new Date(at),
      endedAt: new Date(at),
      header: { input: {}, seats: [{ seat: 0, playerId: 'ann', startStack: 10000 }, { seat: 1, playerId: 'ben', startStack: 10000 }] },
      events: [],
    });
  }
}

/** Ann's line on the board at the clock's time, and where the period starts. */
async function board(query: string) {
  const res = (await (await fetch(`${url}/api/leaderboard?${query}`, { headers: { 'x-guest-token': 'a-guest-secret-0123456789' } })).json()) as {
    since: string | null;
    rows: { name: string; profit: number; sessions: number }[];
  };
  const ann = res.rows.find((r) => r.name === 'Ann');
  return { since: res.since, profit: ann?.profit ?? 0, games: ann?.sessions ?? 0 };
}

describe('leaderboard periods', () => {
  it('starts this month and this year at midnight in the browser’s time zone', async () => {
    // Two games earlier in October, and one on Halloween night from 7pm to 10pm in New York (23:00Z on the 31st to 02:00Z on 1 November).
    await game('oct-9', 5000, ['2026-10-09T23:00:00Z', '2026-10-10T02:00:00Z']);
    await game('oct-23', -2000, ['2026-10-23T23:00:00Z', '2026-10-24T02:00:00Z']);
    await game('halloween', 1000, ['2026-10-31T23:00:00Z', '2026-11-01T02:00:00Z']);
    const ny = `tz=${encodeURIComponent('America/New_York')}`;

    // 11:30pm in New York on 31 October: it is still October there, so all three games count.
    clock.t = Date.parse('2026-11-01T03:30:00Z');
    expect(await board(`period=month&${ny}`)).toEqual({ since: '2026-10-01T04:00:00.000Z', profit: 4000, games: 3 });
    expect((await board(`period=year&${ny}`)).since).toBe('2026-01-01T05:00:00.000Z');

    // The next morning it is November, and Halloween stays in October.
    clock.t = Date.parse('2026-11-01T14:00:00Z');
    expect(await board(`period=month&${ny}`)).toEqual({ since: '2026-11-01T04:00:00.000Z', profit: 0, games: 0 });

    // No time zone, or one that isn't real, counts in UTC as before.
    clock.t = Date.parse('2026-11-01T03:30:00Z');
    expect((await board('period=month')).since).toBe('2026-11-01T00:00:00.000Z');
    expect((await board('period=month&tz=Mars%2FOlympus')).since).toBe('2026-11-01T00:00:00.000Z');
    expect((await board(`period=month&tz=${'A'.repeat(500)}`)).since).toBe('2026-11-01T00:00:00.000Z');
  });
});
