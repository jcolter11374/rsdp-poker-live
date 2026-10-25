/**
 * The same storage code on real Postgres through node-postgres. Skipped unless
 * TEST_DATABASE_URL points at a throwaway database: every table in it is wiped.
 *
 *   TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/rsdp_test npx vitest run test/postgres.test.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, createDb, MIGRATIONS_DIR, queryRows, type Db } from '../src/db/client';
import { ledgerFor, openSeatSession, recordMovement } from '../src/db/ledger';
import { createTable, loadSnapshot, saveSnapshot } from '../src/db/tables';
import { resetTestDb } from '../src/db/testing';
import { createAccount, login, resolveSession, resolveToken } from '../src/identity';
import { Scheduler } from '../src/scheduler';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('on Postgres (node-postgres)', () => {
  let a: Db;
  let b: Db;

  beforeAll(async () => {
    // Two processes booting at once: the advisory lock serialises the migrations.
    [a, b] = await Promise.all([createDb({ url }), createDb({ url })]);
    await resetTestDb(a);
  }, 60_000);

  afterAll(async () => {
    if (a) await closeDb(a);
    if (b) await closeDb(b);
  });

  it('applied each migration once', async () => {
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as { entries: unknown[] };
    const rows = await queryRows<{ n: number }>(a, sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(rows[0].n).toBe(journal.entries.length);
  });

  it('round-trips identity, timestamps and big chip counts', async () => {
    const player = await resolveToken(a, 'pg-browser-secret-000001');
    expect(player.createdAt).toBeInstanceOf(Date);
    const account = await createAccount(a, 'PgUser', 'hunter2hunter2', player.id);
    const { token } = await login(b, 'pguser', 'hunter2hunter2');
    expect((await resolveSession(b, token))?.account).toEqual(account);

    const table = await createTable(a, { ownerPlayerId: player.id, settings: { game: 'nlh' } });
    await saveSnapshot(a, table.id, { version: 1, state: { big: 2 ** 53 - 1 } });
    expect((await loadSnapshot(b, table.id))?.state).toEqual({ big: 2 ** 53 - 1 });

    const seat = await openSeatSession(a, { tableId: table.id, playerId: player.id, seat: 0 });
    const m = await recordMovement(a, {
      tableId: table.id,
      seatSessionId: seat.id,
      playerId: player.id,
      kind: 'buy-in',
      amount: 2 ** 52,
      stackBefore: 0,
    });
    expect(m.amount).toBe(2 ** 52);
    expect((await ledgerFor(b, table.id)).totals.onTable).toBe(2 ** 52);
  });

  it('never runs a job twice across two connection pools', async () => {
    const runs = new Map<number, number>();
    const handler = async (p: { n: number }) => {
      runs.set(p.n, (runs.get(p.n) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 2));
    };
    const now = () => Date.parse('2030-01-01T00:00:00Z');
    const quiet = { now, setTimer: () => () => {}, onError: () => {} };
    const sa = new Scheduler(a, { ping: handler }, quiet);
    const sb = new Scheduler(b, { ping: handler }, quiet);
    for (let n = 0; n < 40; n++) await sa.schedule('ping', now() - 1000, { n });
    await Promise.all([sa.runDue(), sb.runDue(), sa.runDue(), sb.runDue()]);
    await Promise.all([sa.idle(), sb.idle()]);
    expect(runs.size).toBe(40);
    expect([...runs.values()].every((c) => c === 1)).toBe(true);
  });
});
