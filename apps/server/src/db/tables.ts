/**
 * Tables, their versioned settings with a change log, and the runtime
 * snapshot saved at every hand boundary.
 */

import { and, desc, eq, lt, ne, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { clampLimit, StorageError } from './errors';
import { newId, newTableId } from './ids';
import { chipMovements, hands, hiddenTables, seatSessions, settingsChanges, sharedHands, tables, tableSnapshots, type TableMode, type TableStatus } from './schema';

type TableRow = typeof tables.$inferSelect;

/** A table row with its settings typed by the caller (the runtime owns the settings schema). */
export type TableRecord<S = unknown> = Omit<TableRow, 'settings'> & { settings: S };

export type SettingsChange = typeof settingsChanges.$inferSelect & { changes: SettingsDiff };

/** One changed leaf. A missing `from` means the key was added, a missing `to` that it was removed. */
export interface SettingsDiffEntry {
  path: string;
  from?: unknown;
  to?: unknown;
}

export type SettingsDiff = SettingsDiffEntry[];

export interface TableSnapshot<T = unknown> {
  tableId: string;
  /** Snapshot format version (bump it when the runtime's state changes shape). */
  version: number;
  state: T;
  savedAt: Date;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!jsonEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/**
 * Leaf-level diff of two JSON settings objects, for the change log. Objects
 * are walked key by key (dotted paths); arrays and scalars compare as a whole.
 */
export function diffSettings(before: unknown, after: unknown, prefix = ''): SettingsDiff {
  if (isPlainObject(before) && isPlainObject(after)) {
    const out: SettingsDiff = [];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const k of keys) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (!(k in after) || after[k] === undefined) {
        if (before[k] !== undefined) out.push({ path, from: before[k] });
      } else if (!(k in before) || before[k] === undefined) {
        out.push({ path, to: after[k] });
      } else {
        out.push(...diffSettings(before[k], after[k], path));
      }
    }
    return out;
  }
  return jsonEqual(before, after) ? [] : [{ path: prefix, from: before, to: after }];
}

function typed<S>(row: TableRow): TableRecord<S> {
  return row as TableRecord<S>;
}

export interface CreateTableInput<S> {
  /** Defaults to a short random id for share links. */
  id?: string;
  ownerPlayerId: string;
  settings: S;
  mode?: TableMode;
  tournamentId?: string | null;
  clubId?: string | null;
  now?: Date;
}

export async function createTable<S>(db: Db, input: CreateTableInput<S>): Promise<TableRecord<S>> {
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(tables)
    .values({
      id: input.id ?? newTableId(),
      ownerPlayerId: input.ownerPlayerId,
      settings: input.settings,
      mode: input.mode ?? 'cash',
      tournamentId: input.tournamentId ?? null,
      clubId: input.clubId ?? null,
      createdAt: now,
      lastActivityAt: now,
    })
    .returning();
  return typed<S>(row);
}

export async function getTable<S = unknown>(db: Db, tableId: string): Promise<TableRecord<S> | null> {
  const [row] = await db.select().from(tables).where(eq(tables.id, tableId));
  return row ? typed<S>(row) : null;
}

export interface UpdateSettingsInput<S> {
  /** The complete new settings; the stored diff is computed against the current ones. */
  settings: S;
  /** Null for system changes (tournament director, scheduler). */
  actorPlayerId: string | null;
  /** Hand number from which the change applies (edits queue for the next hand). */
  effectiveHand: number;
  /** Reject with a conflict unless the table is still at this settings version. */
  expectedVersion?: number;
  now?: Date;
}

/**
 * Replaces a table's settings, bumps settings_version and logs the diff with
 * who made it, in one transaction. A no-op (nothing changed) writes nothing
 * and returns change: null.
 */
export async function updateTableSettings<S>(
  db: Db,
  tableId: string,
  input: UpdateSettingsInput<S>,
): Promise<{ table: TableRecord<S>; change: SettingsChange | null }> {
  if (!Number.isSafeInteger(input.effectiveHand) || input.effectiveHand < 0) {
    throw new StorageError('invalid', 'effectiveHand must be a hand number');
  }
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(tables).where(eq(tables.id, tableId)).for('update');
    if (!current) throw new StorageError('not-found', 'no such table');
    if (current.status === 'archived') throw new StorageError('conflict', 'the table is archived');
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.settingsVersion) {
      throw new StorageError('conflict', `settings changed (now version ${current.settingsVersion})`);
    }
    const diff = diffSettings(current.settings, input.settings);
    if (diff.length === 0) return { table: typed<S>(current), change: null };

    const [table] = await tx
      .update(tables)
      .set({ settings: input.settings, settingsVersion: sql`${tables.settingsVersion} + 1`, lastActivityAt: now })
      .where(eq(tables.id, tableId))
      .returning();
    const [change] = await tx
      .insert(settingsChanges)
      .values({
        id: newId(),
        tableId,
        actorPlayerId: input.actorPlayerId,
        changes: diff,
        effectiveHand: input.effectiveHand,
        createdAt: now,
      })
      .returning();
    return { table: typed<S>(table), change: change as SettingsChange };
  });
}

/** The settings change log, newest first. */
export async function listSettingsChanges(db: Db, tableId: string, opts: { limit?: number } = {}): Promise<SettingsChange[]> {
  const rows = await db
    .select()
    .from(settingsChanges)
    .where(eq(settingsChanges.tableId, tableId))
    .orderBy(desc(settingsChanges.createdAt), desc(settingsChanges.id))
    .limit(clampLimit(opts.limit, 100));
  return rows as SettingsChange[];
}

/** Marks the table as used now, so idle cleanup leaves it alone. */
export async function touchTable(db: Db, tableId: string, now: Date = new Date()): Promise<void> {
  await db.update(tables).set({ lastActivityAt: now }).where(eq(tables.id, tableId));
}

/** Open, paused or stopped. Archiving has its own call because it is final. */
export async function setTableStatus(
  db: Db,
  tableId: string,
  status: Exclude<TableStatus, 'archived'>,
  now: Date = new Date(),
): Promise<TableRecord> {
  const [row] = await db
    .update(tables)
    .set({ status, lastActivityAt: now })
    .where(and(eq(tables.id, tableId), ne(tables.status, 'archived')))
    .returning();
  if (row) return row;
  const exists = await getTable(db, tableId);
  throw exists ? new StorageError('conflict', 'the table is archived') : new StorageError('not-found', 'no such table');
}

/** Archives a table for good; history (hands, ledger) stays. Archiving twice keeps the first time. */
export async function archiveTable(db: Db, tableId: string, now: Date = new Date()): Promise<TableRecord> {
  const [row] = await db
    .update(tables)
    .set({ status: 'archived', archivedAt: sql`coalesce(${tables.archivedAt}, ${now})` })
    .where(eq(tables.id, tableId))
    .returning();
  if (!row) throw new StorageError('not-found', 'no such table');
  return row;
}

/**
 * Deletes a cash table for good: its hands, share links, snapshot, settings
 * log and every player's "hidden" mark. Returns false when there was no such
 * table. Tournament tables go with their tournament and are refused, and so
 * is a table with rows in the append-only chip ledger.
 */
export async function deleteTableForGood(db: Db, tableId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ tournamentId: tables.tournamentId, mode: tables.mode }).from(tables).where(eq(tables.id, tableId));
    if (!row) return false;
    if (row.tournamentId || row.mode === 'tournament') throw new StorageError('conflict', 'tournament tables are kept with their tournament');
    const [moved] = await tx.select({ n: sql<number>`count(*)::int` }).from(chipMovements).where(eq(chipMovements.tableId, tableId));
    if (Number(moved?.n ?? 0) > 0) throw new StorageError('conflict', 'the table has chip ledger entries, which are never deleted');
    await tx.delete(sharedHands).where(eq(sharedHands.tableId, tableId));
    await tx.delete(hiddenTables).where(eq(hiddenTables.tableId, tableId));
    await tx.delete(hands).where(eq(hands.tableId, tableId));
    await tx.delete(seatSessions).where(eq(seatSessions.tableId, tableId));
    // The snapshot and the settings log go with the table (on delete cascade).
    await tx.delete(tables).where(eq(tables.id, tableId));
    return true;
  });
}

/**
 * Tables that are not archived, most recently active first. With idleBefore,
 * only tables untouched since then (candidates for auto-archive).
 */
export async function listActiveTables(db: Db, opts: { idleBefore?: Date; limit?: number } = {}): Promise<TableRecord[]> {
  return db
    .select()
    .from(tables)
    .where(and(ne(tables.status, 'archived'), opts.idleBefore ? lt(tables.lastActivityAt, opts.idleBefore) : undefined))
    .orderBy(desc(tables.lastActivityAt), tables.id)
    .limit(clampLimit(opts.limit, 500));
}

/** Upserts the runtime's state for a table. Call at every hand boundary. */
export async function saveSnapshot(
  db: Db,
  tableId: string,
  snapshot: { version: number; state: unknown },
  now: Date = new Date(),
): Promise<void> {
  if (!Number.isSafeInteger(snapshot.version)) throw new StorageError('invalid', 'snapshot version must be an integer');
  if (snapshot.state === undefined || snapshot.state === null) throw new StorageError('invalid', 'snapshot state is empty');
  await db
    .insert(tableSnapshots)
    .values({ tableId, version: snapshot.version, state: snapshot.state, savedAt: now })
    .onConflictDoUpdate({
      target: tableSnapshots.tableId,
      set: { version: snapshot.version, state: snapshot.state, savedAt: now },
    });
}

/**
 * The cash tables whose last save (in snapshot format `version`, the one that still loads) has this player in a
 * seat or asking for one, with their names. Tables put away while idle keep their seats only there.
 */
export async function tablesSeatingInSaves(db: Db, playerId: string, version: number): Promise<{ id: string; name: string }[]> {
  const me = JSON.stringify([{ playerId }]);
  return db
    .select({ id: tables.id, name: sql<string>`coalesce(${tableSnapshots.state} -> 'settings' -> 'table' ->> 'name', '')` })
    .from(tables)
    .innerJoin(tableSnapshots, eq(tableSnapshots.tableId, tables.id))
    .where(
      and(
        ne(tables.status, 'archived'),
        eq(tables.mode, 'cash'),
        eq(tableSnapshots.version, version),
        or(sql`${tableSnapshots.state} -> 'seats' @> ${me}::jsonb`, sql`${tableSnapshots.state} -> 'requests' @> ${me}::jsonb`),
      ),
    );
}

export async function loadSnapshot<T = unknown>(db: Db, tableId: string): Promise<TableSnapshot<T> | null> {
  const [row] = await db.select().from(tableSnapshots).where(eq(tableSnapshots.tableId, tableId));
  return row ? (row as TableSnapshot<T>) : null;
}
