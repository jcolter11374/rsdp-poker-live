import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, queryRows, type Db } from '../src/db/client';
import { StorageError } from '../src/db/errors';
import {
  archiveTable,
  createTable,
  deleteTableForGood,
  diffSettings,
  getTable,
  listActiveTables,
  listSettingsChanges,
  loadSnapshot,
  saveSnapshot,
  setTableStatus,
  touchTable,
  updateTableSettings,
} from '../src/db/tables';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { resolveToken } from '../src/identity';

interface Settings {
  stakes: { smallBlind: number; bigBlind: number };
  game: string;
  turnSeconds: number;
  modifiers: string[];
  straddle?: boolean;
}

const SETTINGS: Settings = {
  stakes: { smallBlind: 1, bigBlind: 2 },
  game: 'nlh',
  turnSeconds: 30,
  modifiers: ['bomb-pot'],
};

let db: Db;
let host: string;
let cohost: string;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  await resetTestDb(db);
  host = (await resolveToken(db, 'host-browser-secret-0001')).id;
  cohost = (await resolveToken(db, 'cohost-browser-secret-01')).id;
});

async function expectStorageError(p: Promise<unknown>, code: StorageError['code']) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StorageError);
  expect((err as StorageError).code).toBe(code);
}

describe('diffSettings', () => {
  it('reports changed leaves by dotted path and compares arrays whole', () => {
    const after = { ...SETTINGS, stakes: { smallBlind: 2, bigBlind: 4 }, modifiers: ['bomb-pot', 'double-board'] };
    expect(diffSettings(SETTINGS, after)).toEqual([
      { path: 'modifiers', from: ['bomb-pot'], to: ['bomb-pot', 'double-board'] },
      { path: 'stakes.bigBlind', from: 2, to: 4 },
      { path: 'stakes.smallBlind', from: 1, to: 2 },
    ]);
  });

  it('marks added and removed keys and ignores equal values', () => {
    expect(diffSettings(SETTINGS, { ...SETTINGS })).toEqual([]);
    expect(diffSettings(SETTINGS, { ...SETTINGS, straddle: true })).toEqual([{ path: 'straddle', to: true }]);
    expect(diffSettings({ ...SETTINGS, straddle: true }, SETTINGS)).toEqual([{ path: 'straddle', from: true }]);
    expect(diffSettings({ a: { b: 1 } }, { a: null })).toEqual([{ path: 'a', from: { b: 1 }, to: null }]);
  });
});

describe('tables', () => {
  it('creates a table with defaults and reads it back', async () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const table = await createTable(db, { ownerPlayerId: host, settings: SETTINGS, now });
    expect(table).toMatchObject({
      ownerPlayerId: host,
      settings: SETTINGS,
      settingsVersion: 1,
      status: 'open',
      mode: 'cash',
      tournamentId: null,
      clubId: null,
      createdAt: now,
      lastActivityAt: now,
      archivedAt: null,
    });
    expect(table.id).toMatch(/^[\w-]{10}$/);
    expect(await getTable<Settings>(db, table.id)).toEqual(table);
    expect(await getTable(db, 'missing')).toBeNull();
  });

  it('keeps tournament and club links', async () => {
    const t = await createTable(db, {
      id: 'tourney-t1',
      ownerPlayerId: host,
      settings: SETTINGS,
      mode: 'tournament',
      tournamentId: 'tour-1',
      clubId: 'club-1',
    });
    expect(t).toMatchObject({ id: 'tourney-t1', mode: 'tournament', tournamentId: 'tour-1', clubId: 'club-1' });
  });

  it('updates settings, bumps the version and logs the diff with the actor and effective hand', async () => {
    const table = await createTable(db, { ownerPlayerId: host, settings: SETTINGS });
    const at = new Date('2026-06-01T12:05:00Z');
    const next = { ...SETTINGS, stakes: { smallBlind: 2, bigBlind: 4 } };
    const { table: updated, change } = await updateTableSettings(db, table.id, {
      settings: next,
      actorPlayerId: cohost,
      effectiveHand: 13,
      now: at,
    });
    expect(updated.settings).toEqual(next);
    expect(updated.settingsVersion).toBe(2);
    expect(updated.lastActivityAt).toEqual(at);
    expect(change).toMatchObject({
      tableId: table.id,
      actorPlayerId: cohost,
      effectiveHand: 13,
      createdAt: at,
      changes: [
        { path: 'stakes.bigBlind', from: 2, to: 4 },
        { path: 'stakes.smallBlind', from: 1, to: 2 },
      ],
    });
    expect(await listSettingsChanges(db, table.id)).toEqual([change]);
  });

  it('writes nothing when the settings did not change', async () => {
    const table = await createTable(db, { ownerPlayerId: host, settings: SETTINGS });
    const res = await updateTableSettings(db, table.id, { settings: { ...SETTINGS }, actorPlayerId: host, effectiveHand: 1 });
    expect(res.change).toBeNull();
    expect(res.table.settingsVersion).toBe(1);
    expect(await listSettingsChanges(db, table.id)).toEqual([]);
  });

  it('logs system changes without an actor, newest first', async () => {
    const table = await createTable(db, { ownerPlayerId: host, settings: SETTINGS });
    const t0 = new Date('2026-06-01T12:00:00Z');
    await updateTableSettings(db, table.id, {
      settings: { ...SETTINGS, turnSeconds: 20 },
      actorPlayerId: host,
      effectiveHand: 2,
      now: t0,
    });
    await updateTableSettings(db, table.id, {
      settings: { ...SETTINGS, turnSeconds: 20, stakes: { smallBlind: 5, bigBlind: 10 } },
      actorPlayerId: null,
      effectiveHand: 3,
      now: new Date(t0.getTime() + 1000),
    });
    const log = await listSettingsChanges(db, table.id);
    expect(log.map((c) => [c.actorPlayerId, c.effectiveHand])).toEqual([
      [null, 3],
      [host, 2],
    ]);
    expect((await getTable(db, table.id))?.settingsVersion).toBe(3);
  });

  it('rejects a stale expected version without writing', async () => {
    const table = await createTable(db, { ownerPlayerId: host, settings: SETTINGS });
    await updateTableSettings(db, table.id, {
      settings: { ...SETTINGS, game: 'plo' },
      actorPlayerId: host,
      effectiveHand: 1,
      expectedVersion: 1,
    });
    await expectStorageError(
      updateTableSettings(db, table.id, {
        settings: { ...SETTINGS, game: 'stud' },
        actorPlayerId: cohost,
        effectiveHand: 1,
        expectedVersion: 1,
      }),
      'conflict',
    );
    const current = await getTable<Settings>(db, table.id);
    expect(current?.settings.game).toBe('plo');
    expect(await listSettingsChanges(db, table.id)).toHaveLength(1);
  });

  it('refuses settings changes on missing or archived tables and bad hand numbers', async () => {
    const table = await createTable(db, { ownerPlayerId: host, settings: SETTINGS });
    await expectStorageError(
      updateTableSettings(db, 'missing', { settings: SETTINGS, actorPlayerId: host, effectiveHand: 1 }),
      'not-found',
    );
    await expectStorageError(
      updateTableSettings(db, table.id, { settings: SETTINGS, actorPlayerId: host, effectiveHand: 1.5 }),
      'invalid',
    );
    await archiveTable(db, table.id);
    await expectStorageError(
      updateTableSettings(db, table.id, { settings: { ...SETTINGS, game: 'plo' }, actorPlayerId: host, effectiveHand: 1 }),
      'conflict',
    );
  });

  it('touches, changes status and archives once', async () => {
    const t0 = new Date('2026-06-01T00:00:00Z');
    const table = await createTable(db, { ownerPlayerId: host, settings: SETTINGS, now: t0 });
    const t1 = new Date('2026-06-01T01:00:00Z');
    await touchTable(db, table.id, t1);
    expect((await getTable(db, table.id))?.lastActivityAt).toEqual(t1);

    expect((await setTableStatus(db, table.id, 'paused')).status).toBe('paused');
    expect((await setTableStatus(db, table.id, 'stopped')).status).toBe('stopped');

    const t2 = new Date('2026-06-02T00:00:00Z');
    const archived = await archiveTable(db, table.id, t2);
    expect(archived).toMatchObject({ status: 'archived', archivedAt: t2 });
    const again = await archiveTable(db, table.id, new Date('2026-06-03T00:00:00Z'));
    expect(again.archivedAt).toEqual(t2);

    await expectStorageError(setTableStatus(db, table.id, 'open'), 'conflict');
    await expectStorageError(setTableStatus(db, 'missing', 'open'), 'not-found');
    await expectStorageError(archiveTable(db, 'missing'), 'not-found');
  });

  it('lists tables that are not archived, most recent first, optionally only idle ones', async () => {
    const day = (d: number) => new Date(Date.UTC(2026, 5, d));
    const a = await createTable(db, { id: 'table-a', ownerPlayerId: host, settings: SETTINGS, now: day(1) });
    const b = await createTable(db, { id: 'table-b', ownerPlayerId: host, settings: SETTINGS, now: day(2) });
    const c = await createTable(db, { id: 'table-c', ownerPlayerId: host, settings: SETTINGS, now: day(3) });
    await setTableStatus(db, b.id, 'paused', day(4));
    await archiveTable(db, c.id);

    expect((await listActiveTables(db)).map((t) => t.id)).toEqual([b.id, a.id]);
    expect((await listActiveTables(db, { idleBefore: day(3) })).map((t) => t.id)).toEqual([a.id]);
    expect((await listActiveTables(db, { limit: 1 })).map((t) => t.id)).toEqual([b.id]);
  });
});

describe('snapshots', () => {
  it('round-trips the runtime state exactly', async () => {
    const table = await createTable(db, { ownerPlayerId: host, settings: SETTINGS });
    const state = {
      handNumber: 42,
      button: 3,
      seats: [
        { seat: 0, playerId: host, stack: 1500, away: false, cards: ['As', 'Td'] },
        null,
        { seat: 2, playerId: cohost, stack: 0, away: true, cards: [] },
      ],
      pots: [{ amount: 9_007_199_254_740_991, eligible: [0, 2] }],
      note: 'unicode ♠♥ "quotes" \\ backslash',
      nested: { deep: { deeper: [1, [2, [3]]] } },
    };
    const savedAt = new Date('2026-06-01T12:00:00Z');
    await saveSnapshot(db, table.id, { version: 1, state }, savedAt);
    expect(await loadSnapshot(db, table.id)).toEqual({ tableId: table.id, version: 1, state, savedAt });
  });

  it('overwrites the previous snapshot at each hand boundary', async () => {
    const table = await createTable(db, { ownerPlayerId: host, settings: SETTINGS });
    await saveSnapshot(db, table.id, { version: 1, state: { handNumber: 1 } });
    await saveSnapshot(db, table.id, { version: 2, state: { handNumber: 2 } });
    const snap = await loadSnapshot<{ handNumber: number }>(db, table.id);
    expect(snap?.version).toBe(2);
    expect(snap?.state.handNumber).toBe(2);
  });

  it('returns null without a snapshot and refuses empty state', async () => {
    const table = await createTable(db, { ownerPlayerId: host, settings: SETTINGS });
    expect(await loadSnapshot(db, table.id)).toBeNull();
    await expectStorageError(saveSnapshot(db, table.id, { version: 1, state: null }), 'invalid');
    await expectStorageError(saveSnapshot(db, table.id, { version: 1.5, state: {} }), 'invalid');
  });
});

describe('deleting a table for good', () => {
  /** How many rows each of a table's records has. */
  async function rowsFor(tableId: string) {
    const out: Record<string, number> = {};
    for (const t of ['tables', 'table_snapshots', 'settings_changes', 'hands', 'table_log', 'hidden_tables', 'shared_hands']) {
      const [row] = await queryRows<{ n: number }>(db, sql.raw(`select count(*)::int as n from ${t} where ${t === 'tables' ? 'id' : 'table_id'} = '${tableId}'`));
      out[t] = row.n;
    }
    return out;
  }

  async function tableWithRecords() {
    const table = await createTable(db, { ownerPlayerId: host, settings: SETTINGS });
    await saveSnapshot(db, table.id, { version: 1, state: { handNumber: 1 } });
    await updateTableSettings<Settings>(db, table.id, { settings: { ...SETTINGS, turnSeconds: 20 }, actorPlayerId: host, effectiveHand: 2 });
    const q = (s: string) => db.execute(sql.raw(s));
    await q(`insert into hands (id, table_id, number, game_id, started_at, header, events) values ('h-${table.id}', '${table.id}', 1, 'nlh', now(), '{}', '[]')`);
    await q(`insert into table_log (table_id, kind, at, item) values ('${table.id}', 'chat', now(), '{"text":"gl"}')`);
    await q(`insert into hidden_tables (player_id, table_id) values ('${cohost}', '${table.id}')`);
    await q(`insert into shared_hands (id, table_id, hand_number, created_by, snapshot) values ('sh-${table.id}', '${table.id}', 1, '${host}', '{}')`);
    return table;
  }

  it('deletes a cash table with its hands, log, snapshot, settings log, hidden marks and share links', async () => {
    const table = await tableWithRecords();
    const other = await tableWithRecords();
    expect(await rowsFor(table.id)).toEqual({ tables: 1, table_snapshots: 1, settings_changes: 1, hands: 1, table_log: 1, hidden_tables: 1, shared_hands: 1 });
    expect(await deleteTableForGood(db, table.id)).toBe(true);
    expect(await rowsFor(table.id)).toEqual({ tables: 0, table_snapshots: 0, settings_changes: 0, hands: 0, table_log: 0, hidden_tables: 0, shared_hands: 0 });
    // Another table's records stay.
    expect(Object.values(await rowsFor(other.id)).every((n) => n === 1)).toBe(true);
    expect(await deleteTableForGood(db, table.id)).toBe(false);
  });

  it('refuses a tournament table', async () => {
    await createTable(db, { id: 'tourney-del', ownerPlayerId: host, settings: SETTINGS, mode: 'tournament', tournamentId: 'tour-1' });
    await expectStorageError(deleteTableForGood(db, 'tourney-del'), 'conflict');
    expect(await getTable(db, 'tourney-del')).not.toBeNull();
  });

  it('refuses, and deletes nothing, while a row it does not know about still points at the table', async () => {
    const table = await tableWithRecords();
    await db.execute(sql`create table delete_test_refs (table_id text not null references tables (id))`);
    try {
      await db.execute(sql`insert into delete_test_refs (table_id) values (${table.id})`);
      await expectStorageError(deleteTableForGood(db, table.id), 'conflict');
      expect(Object.values(await rowsFor(table.id)).every((n) => n === 1)).toBe(true);
    } finally {
      await db.execute(sql`drop table delete_test_refs`);
    }
  });
});
