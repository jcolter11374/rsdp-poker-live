import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, type Db } from '../src/db/client';
import { StorageError } from '../src/db/errors';
import {
  checkLedger,
  closeSeatSession,
  ledgerFor,
  listMovements,
  openSeatSession,
  openSeatSessions,
  recordMovement,
  type MovementInput,
} from '../src/db/ledger';
import { chipMovements } from '../src/db/schema';
import { createTable } from '../src/db/tables';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { resolveToken } from '../src/identity';

let db: Db;
let tableId: string;
let host: string;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  await resetTestDb(db);
  host = (await resolveToken(db, 'host-browser-secret-0001')).id;
  alice = (await resolveToken(db, 'alice-browser-secret-001')).id;
  bob = (await resolveToken(db, 'bob-browser-secret-00001')).id;
  tableId = (await createTable(db, { ownerPlayerId: host, settings: {} })).id;
});

async function expectStorageError(p: Promise<unknown>, code: StorageError['code']) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StorageError);
  expect((err as StorageError).code).toBe(code);
}

const move = (input: Omit<MovementInput, 'tableId'>) => recordMovement(db, { tableId, ...input });

describe('seat sessions', () => {
  it('allows one open session per seat and per player', async () => {
    const s = await openSeatSession(db, { tableId, playerId: alice, seat: 0 });
    await expectStorageError(openSeatSession(db, { tableId, playerId: bob, seat: 0 }), 'conflict');
    await expectStorageError(openSeatSession(db, { tableId, playerId: alice, seat: 3 }), 'conflict');
    await expectStorageError(openSeatSession(db, { tableId, playerId: bob, seat: -1 }), 'invalid');

    const t = new Date('2026-07-01T00:00:00Z');
    const closed = await closeSeatSession(db, s.id, t);
    expect(closed.endedAt).toEqual(t);
    expect((await closeSeatSession(db, s.id, new Date('2026-07-02T00:00:00Z'))).endedAt).toEqual(t);

    // After leaving, the seat and the player are free again.
    await openSeatSession(db, { tableId, playerId: bob, seat: 0 });
    await openSeatSession(db, { tableId, playerId: alice, seat: 4 });
    expect((await openSeatSessions(db, tableId)).map((x) => [x.seat, x.playerId])).toEqual([
      [0, bob],
      [4, alice],
    ]);
    await expectStorageError(closeSeatSession(db, 'missing'), 'not-found');
  });
});

describe('recordMovement', () => {
  it('derives stack_after and keeps chips as exact integers', async () => {
    const s = await openSeatSession(db, { tableId, playerId: alice, seat: 1 });
    const big = 2 ** 52;
    const m = await move({ kind: 'buy-in', playerId: alice, seatSessionId: s.id, amount: big, stackBefore: 0, actorPlayerId: alice });
    expect(m).toMatchObject({ kind: 'buy-in', amount: big, stackBefore: 0, stackAfter: big, seatSessionId: s.id, handNumber: null });
    expect(typeof m.amount).toBe('number');
    const [row] = await listMovements(db, tableId);
    expect(row.amount).toBe(big);
  });

  it('enforces the sign of each kind', async () => {
    const base = { playerId: alice, stackBefore: 100 };
    await expectStorageError(move({ ...base, kind: 'buy-in', amount: 0 }), 'invalid');
    await expectStorageError(move({ ...base, kind: 'rebuy', amount: -5 }), 'invalid');
    await expectStorageError(move({ ...base, kind: 'host-remove', amount: 5 }), 'invalid');
    await expectStorageError(move({ ...base, kind: 'escrow-in', amount: 5 }), 'invalid');
    await expectStorageError(move({ ...base, kind: 'host-set', amount: 0 }), 'invalid');
    await expectStorageError(move({ ...base, kind: 'bounty', amount: 0 }), 'invalid');
    await expectStorageError(move({ kind: 'rake', amount: 3 }), 'invalid');
    await move({ ...base, kind: 'host-set', amount: -40 });
    await move({ ...base, kind: 'bounty', amount: 7 });
    await move({ kind: 'rake', amount: -3, handNumber: 9 });
    expect(await listMovements(db, tableId)).toHaveLength(3);
  });

  it('rejects fractional chips, negative stacks and partial cash-outs', async () => {
    await expectStorageError(move({ kind: 'buy-in', playerId: alice, stackBefore: 0, amount: 1.5 }), 'invalid');
    await expectStorageError(move({ kind: 'buy-in', playerId: alice, stackBefore: 0.5, amount: 1 }), 'invalid');
    await expectStorageError(move({ kind: 'buy-in', playerId: alice, stackBefore: 0, amount: Number.MAX_SAFE_INTEGER + 2 }), 'invalid');
    await expectStorageError(move({ kind: 'host-remove', playerId: alice, stackBefore: 10, amount: -11 }), 'invalid');
    await expectStorageError(move({ kind: 'buy-in', playerId: alice, stackBefore: -1, amount: 5 }), 'invalid');
    await expectStorageError(move({ kind: 'cash-out', playerId: alice, stackBefore: 100, amount: -60 }), 'invalid');
    await expectStorageError(move({ kind: 'buy-in', playerId: alice, stackBefore: 0, amount: 5, handNumber: -1 }), 'invalid');
    await move({ kind: 'cash-out', playerId: alice, stackBefore: 100, amount: -100 });
    await move({ kind: 'cash-out', playerId: bob, stackBefore: 0, amount: 0 });
  });

  it('needs a player and a stack for everything but rake', async () => {
    await expectStorageError(move({ kind: 'buy-in', amount: 100, stackBefore: 0 }), 'invalid');
    await expectStorageError(move({ kind: 'buy-in', amount: 100, playerId: alice }), 'invalid');
  });

  it('checks that the seat session belongs to the same table and player', async () => {
    const other = await createTable(db, { ownerPlayerId: host, settings: {} });
    const elsewhere = await openSeatSession(db, { tableId: other.id, playerId: alice, seat: 0 });
    const bobs = await openSeatSession(db, { tableId, playerId: bob, seat: 0 });
    const buyIn = (seatSessionId: string) => move({ kind: 'buy-in', playerId: alice, seatSessionId, stackBefore: 0, amount: 100 });
    await expectStorageError(buyIn(elsewhere.id), 'invalid');
    await expectStorageError(buyIn(bobs.id), 'invalid');
    await expectStorageError(buyIn('missing'), 'invalid');
  });

  it('is append-only in the database itself', async () => {
    const m = await move({ kind: 'buy-in', playerId: alice, stackBefore: 0, amount: 100 });
    await expect(db.update(chipMovements).set({ amount: 1_000_000 }).where(eq(chipMovements.id, m.id))).rejects.toThrow(/append-only/);
    await expect(db.delete(chipMovements).where(eq(chipMovements.id, m.id))).rejects.toThrow(/append-only/);
    expect((await listMovements(db, tableId))[0].amount).toBe(100);
  });

  it('has database checks behind the application checks', async () => {
    const raw = (amount: number, before: number, after: number) =>
      db.execute(
        sql`insert into chip_movements (id, table_id, player_id, kind, amount, stack_before, stack_after)
            values (${`raw-${amount}-${after}`}, ${tableId}, ${alice}, 'buy-in', ${amount}, ${before}, ${after})`,
      );
    await expect(raw(100, 0, 90)).rejects.toThrow();
    await expect(raw(100, -10, 90)).rejects.toThrow();
    await expect(
      db.execute(
        sql`insert into chip_movements (id, table_id, player_id, kind, amount, stack_before) values ('raw-half', ${tableId}, ${alice}, 'buy-in', 5, 10)`,
      ),
    ).rejects.toThrow();
    await expect(raw(100, 0, 100)).resolves.toBeDefined();
    await expect(
      db.execute(sql`insert into chip_movements (id, table_id, kind, amount) values ('raw-x', ${tableId}, 'jackpot', 5)`),
    ).rejects.toThrow();
  });
});

describe('ledgerFor', () => {
  /** Alice buys in 200, rebuys 100, adds on 50 and is still seated; Bob buys in 200, gets 25 from the host and leaves with 120. */
  async function playSession() {
    const sa = await openSeatSession(db, { tableId, playerId: alice, seat: 2 });
    const sb = await openSeatSession(db, { tableId, playerId: bob, seat: 5 });
    await move({ kind: 'buy-in', playerId: alice, seatSessionId: sa.id, stackBefore: 0, amount: 200, actorPlayerId: alice });
    await move({ kind: 'buy-in', playerId: bob, seatSessionId: sb.id, stackBefore: 0, amount: 200, actorPlayerId: bob });
    // Hands happen: Alice busts to Bob.
    await move({ kind: 'rebuy', playerId: alice, seatSessionId: sa.id, stackBefore: 0, amount: 100, handNumber: 4 });
    await move({ kind: 'host-add', playerId: bob, seatSessionId: sb.id, stackBefore: 395, amount: 25, actorPlayerId: host });
    // More hands, with 5 chips raked along the way.
    await move({ kind: 'rake', amount: -5, handNumber: 6 });
    await move({ kind: 'add-on', playerId: alice, seatSessionId: sa.id, stackBefore: 300, amount: 50, handNumber: 8 });
    await move({ kind: 'cash-out', playerId: bob, seatSessionId: sb.id, stackBefore: 120, amount: -120, actorPlayerId: bob });
    await closeSeatSession(db, sb.id);
    return { sa, sb };
  }

  it('aggregates buy-in, rebuys, add-ons, host adjustments and cash-out per player', async () => {
    const { sa } = await playSession();
    // Alice's live stack: everything in (200 + 100 + 50 + Bob's 225) - Bob's 120 - rake 5 = 450.
    const ledger = await ledgerFor(db, tableId, { [alice]: 450 });
    expect(ledger.players).toEqual([
      expect.objectContaining({
        playerId: alice,
        buyIn: 200,
        rebuys: 100,
        addOns: 50,
        hostAdjust: 0,
        cashOut: 0,
        totalIn: 350,
        seated: true,
        seat: 2,
        seatSessionId: sa.id,
        stack: 450,
        net: 100,
      }),
      expect.objectContaining({
        playerId: bob,
        buyIn: 200,
        rebuys: 0,
        addOns: 0,
        hostAdjust: 25,
        cashOut: 120,
        totalIn: 225,
        seated: false,
        seat: null,
        stack: 0,
        net: -105,
      }),
    ]);
    expect(ledger.totals).toEqual({
      buyIns: 400,
      rebuys: 100,
      addOns: 50,
      hostAdjust: 25,
      cashOut: 120,
      rake: 5,
      escrowHeld: 0,
      bounty: 0,
      onTable: 450,
    });
    // Results plus rake account for every chip.
    expect(ledger.players.reduce((n, p) => n + p.net, 0) + ledger.totals.rake).toBe(0);
  });

  it('falls back to the last recorded stack without live stacks', async () => {
    await playSession();
    const ledger = await ledgerFor(db, tableId);
    expect(ledger.players.find((p) => p.playerId === alice)?.stack).toBe(350);
  });

  it('is empty for a table with no movements', async () => {
    const ledger = await ledgerFor(db, tableId);
    expect(ledger.players).toEqual([]);
    expect(ledger.totals.onTable).toBe(0);
    expect(await checkLedger(db, tableId, {})).toMatchObject({ ok: true, expectedOnTable: 0, actualOnTable: 0 });
  });

  it('tracks escrow and bounty transfers', async () => {
    const sa = await openSeatSession(db, { tableId, playerId: alice, seat: 0 });
    const sb = await openSeatSession(db, { tableId, playerId: bob, seat: 1 });
    await move({ kind: 'buy-in', playerId: alice, seatSessionId: sa.id, stackBefore: 0, amount: 100 });
    await move({ kind: 'buy-in', playerId: bob, seatSessionId: sb.id, stackBefore: 0, amount: 100 });
    await move({ kind: 'escrow-in', playerId: alice, stackBefore: 100, amount: -10, handNumber: 1 });
    await move({ kind: 'escrow-in', playerId: bob, stackBefore: 100, amount: -10, handNumber: 1 });
    await move({ kind: 'escrow-out', playerId: bob, stackBefore: 90, amount: 15, handNumber: 2 });
    await move({ kind: 'bounty', playerId: alice, stackBefore: 90, amount: -4, handNumber: 3 });
    await move({ kind: 'bounty', playerId: bob, stackBefore: 105, amount: 4, handNumber: 3 });

    const stacks = { [alice]: 86, [bob]: 109 };
    const ledger = await ledgerFor(db, tableId, stacks);
    expect(ledger.totals.escrowHeld).toBe(5);
    expect(ledger.totals.onTable).toBe(195);
    expect(ledger.players.map((p) => [p.playerId, p.escrow, p.bounty, p.net])).toEqual([
      [alice, -10, -4, -14],
      [bob, 5, 4, 9],
    ]);
    expect(await checkLedger(db, tableId, stacks)).toEqual({ ok: true, problems: [], expectedOnTable: 195, actualOnTable: 195 });
  });
});

describe('checkLedger', () => {
  it('passes when seated stacks match the ledger', async () => {
    const sa = await openSeatSession(db, { tableId, playerId: alice, seat: 0 });
    const sb = await openSeatSession(db, { tableId, playerId: bob, seat: 1 });
    await move({ kind: 'buy-in', playerId: alice, seatSessionId: sa.id, stackBefore: 0, amount: 300 });
    await move({ kind: 'buy-in', playerId: bob, seatSessionId: sb.id, stackBefore: 0, amount: 200 });
    await move({ kind: 'rake', amount: -10, handNumber: 1 });
    expect(await checkLedger(db, tableId, { [alice]: 0, [bob]: 490 })).toEqual({
      ok: true,
      problems: [],
      expectedOnTable: 490,
      actualOnTable: 490,
    });
  });

  it('flags chips that appeared or vanished', async () => {
    const sa = await openSeatSession(db, { tableId, playerId: alice, seat: 0 });
    await move({ kind: 'buy-in', playerId: alice, seatSessionId: sa.id, stackBefore: 0, amount: 300 });
    const res = await checkLedger(db, tableId, { [alice]: 301 });
    expect(res.ok).toBe(false);
    expect(res.problems).toEqual(['seated stacks add up to 301 but the ledger expects 300']);
  });

  it('flags missing, extra and malformed stacks', async () => {
    const sa = await openSeatSession(db, { tableId, playerId: alice, seat: 0 });
    await move({ kind: 'buy-in', playerId: alice, seatSessionId: sa.id, stackBefore: 0, amount: 300 });
    const missing = await checkLedger(db, tableId, {});
    expect(missing.problems).toContain(`no stack given for seated player ${alice}`);
    const extra = await checkLedger(db, tableId, { [alice]: 300, [bob]: 0 });
    expect(extra.problems).toEqual([`stack given for ${bob}, who has no open seat session`]);
    const fractional = await checkLedger(db, tableId, { [alice]: 299.5 });
    expect(fractional.problems).toContain(`stack for ${alice} is not a whole, non-negative number`);
  });

  it('flags escrow paying out more than it holds and unbalanced bounties', async () => {
    await move({ kind: 'escrow-out', playerId: alice, stackBefore: 0, amount: 10 });
    await move({ kind: 'bounty', playerId: alice, stackBefore: 10, amount: 3 });
    const res = await checkLedger(db, tableId);
    expect(res.problems).toEqual(['escrow paid out 10 more than it took in', 'bounty transfers net to 3, not 0']);
    expect(res.actualOnTable).toBeNull();
  });
});
