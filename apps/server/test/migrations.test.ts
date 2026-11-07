/**
 * The migration files, upgrading a database that already has data in it, and
 * whether the migrations build what schema.ts describes.
 *
 * Why the journal must stay in order: Drizzle's migrator (the same code for
 * node-postgres and PGlite) reads only the newest row of
 * drizzle.__drizzle_migrations and runs the journal entries whose "when" is
 * newer than that row. An entry that is not newer is skipped for good, with
 * no error, on every database that already has the later one, while a fresh
 * database (every other test, a new install) still runs it. A migration from a
 * branch merged after a newer one would go missing only in production.
 *
 * The upgrade runs on PGlite, and also on Postgres when TEST_DATABASE_URL is
 * set: it makes (and drops) a scratch database there, so its role needs
 * CREATEDB, as the CI service user has.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import { closeDb, createDb, MIGRATIONS_DIR, pgliteFor, queryRows, type Db } from '../src/db/client';
import { dbCause, StorageError } from '../src/db/errors';
import * as schema from '../src/db/schema';
import { deleteTableForGood } from '../src/db/tables';
import { createTestDb } from '../src/db/testing';
import { databaseBefore, fill, fillLedger, journal, migrationsUpTo } from './backup-fixture';

const { entries } = journal;

describe('migration journal', () => {
  it('numbers its entries 0, 1, 2… in order', () => {
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
  });

  it('has a .sql file for every entry and an entry for every .sql file', () => {
    // The migrator reads `<tag>.sql`; a file with no entry never runs.
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(entries.map((e) => `${e.tag}.sql`)).toEqual(files);
  });

  it('names each file after its number', () => {
    for (const e of entries) expect(e.tag).toMatch(new RegExp(`^${String(e.idx).padStart(4, '0')}_[\\w-]+$`));
  });

  it('stamps every entry later than the one before it', () => {
    // See the top of this file: an entry that is not newer is skipped on existing databases.
    // After merging two branches that each added a migration, give the later file a "when" newer than every earlier one.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].when, `${entries[i].tag} must be newer than ${entries[i - 1].tag}`).toBeGreaterThan(entries[i - 1].when);
    }
  });

  it('stamps no entry in the future', () => {
    // drizzle-kit stamps a new migration with the time it is made, so after one stamped in the future it would come out older.
    expect(entries[entries.length - 1].when).toBeLessThanOrEqual(Date.now());
  });
});

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected name ${name}`);
  return `"${name}"`;
};

/** Each table's columns, in order. */
async function columnsOf(db: Db): Promise<Record<string, string[]>> {
  const rows = await queryRows<{ t: string; c: string }>(
    db,
    sql`select c.table_name as t, c.column_name as c from information_schema.columns c join information_schema.tables t using (table_schema, table_name) where c.table_schema = 'public' and t.table_type = 'BASE TABLE' order by c.table_name, c.ordinal_position`,
  );
  const out: Record<string, string[]> = {};
  for (const { t, c } of rows) (out[t] ??= []).push(c);
  return out;
}

/**
 * Copies every row of `from` into the tables `to` has, and only the columns it has, as a backup restore does.
 * The rows come from the backup test's fixture, so they keep up with the schema as it grows. A table `from` no
 * longer has (a later migration dropped it) stays empty.
 */
async function copyRows(from: Db, to: Db) {
  const columns = await columnsOf(to);
  const current = await columnsOf(from);
  await to.transaction(async (tx) => {
    // Players and accounts point at each other: skip the foreign key checks while the rows go in.
    await tx.execute(sql.raw('set local session_replication_role = replica'));
    for (const [table, cols] of Object.entries(columns)) {
      if (!current[table]) continue;
      const rows = await queryRows<{ j: string }>(from, sql.raw(`select row_to_json(x)::text as j from ${ident(table)} x`));
      if (!rows.length) continue;
      const kept = Object.keys(JSON.parse(rows[0].j)).filter((c) => cols.includes(c));
      const list = kept.map(ident).join(', ');
      await tx.execute(
        sql`insert into ${sql.raw(ident(table))} (${sql.raw(list)}) overriding system value select ${sql.raw(list)} from json_populate_recordset(null::${sql.raw(ident(table))}, ${`[${rows.map((r) => r.j).join(',')}]`}::json)`,
      );
    }
  });
}

/** The rows of the given tables and columns, as Postgres prints them, so a table that gained columns compares equal. */
async function rowsOf(db: Db, columns: Record<string, string[]>) {
  const out: Record<string, string[]> = {};
  for (const [table, cols] of Object.entries(columns)) {
    const rows = await queryRows<{ j: string }>(db, sql.raw(`select row_to_json(x)::text as j from (select ${cols.map(ident).join(', ')} from ${ident(table)}) x`));
    out[table] = rows.map((r) => r.j).sort();
  }
  return out;
}

/** Columns (type, nullability, default, identity), indexes and constraints: what schema.ts describes, as Postgres prints it. */
async function tablesOf(db: Db) {
  const rows = await queryRows<{ s: string }>(
    db,
    sql`select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') || ' ' || is_identity || ' ' || coalesce(identity_generation, '') as s from information_schema.columns where table_schema = 'public'
        union all select indexdef from pg_indexes where schemaname = 'public'
        union all select conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace`,
  );
  // Sorted here: PGlite and a Postgres server may sort text differently.
  return rows.map((r) => r.s).sort();
}

/** The tables plus the triggers, which only hand-written SQL makes, to compare an upgraded database with a fresh one. */
async function shapeOf(db: Db) {
  const triggers = await queryRows<{ s: string }>(db, sql`select tgrelid::regclass::text || ' ' || tgname as s from pg_trigger where not tgisinternal`);
  return [...(await tablesOf(db)), ...triggers.map((r) => r.s).sort()];
}

async function migrationsRecorded(db: Db) {
  return queryRows<{ hash: string; when: string }>(db, sql`select hash, created_at::text as when from drizzle.__drizzle_migrations order by id`);
}

const expectedRecords = entries.map((e) => ({
  hash: createHash('sha256').update(readFileSync(path.join(MIGRATIONS_DIR, `${e.tag}.sql`))).digest('hex'),
  when: String(e.when),
}));

interface Driver {
  /** Opens the database with only the migrations in `folder`, the way an older release left it. */
  openOld(folder: string): Promise<{ db: Db; close(): Promise<void> }>;
  /** Opens it the way the server does on start-up, which applies the rest. */
  openNew(): Promise<Db>;
}

/** Migrates all but the newest migration, adds rows, then lets the server start on it: nothing is lost or run twice. */
async function upgrade(driver: Driver, filled: Db) {
  const folder = migrationsUpTo(entries.length - 1);
  try {
    const old = await driver.openOld(folder);
    let columns: Record<string, string[]>;
    let before: Record<string, string[]>;
    try {
      expect(await migrationsRecorded(old.db)).toEqual(expectedRecords.slice(0, -1));
      await copyRows(filled, old.db);
      columns = await columnsOf(old.db);
      before = await rowsOf(old.db, columns);
    } finally {
      await old.close();
    }
    // The fixture puts a row in every table; an empty one here would prove nothing about that table.
    const current = await columnsOf(filled);
    for (const [table, rows] of Object.entries(before)) {
      if (current[table]) expect(rows.length, `add a row to ${table} in fill() (backup-fixture.ts)`).toBeGreaterThan(0);
    }

    const db = await driver.openNew();
    try {
      expect(await migrationsRecorded(db)).toEqual(expectedRecords);
      // Every row is still there: a migration drops a table only when it has none.
      const kept = await columnsOf(db);
      for (const [table, rows] of Object.entries(before)) if (!kept[table]) expect(rows, `${table} was dropped with rows in it`).toEqual([]);
      const keptOnly = <T>(byTable: Record<string, T>) => Object.fromEntries(Object.entries(byTable).filter(([t]) => kept[t]));
      expect(await rowsOf(db, keptOnly(columns))).toEqual(keptOnly(before));
      expect(await shapeOf(db)).toEqual(await shapeOf(filled));
    } finally {
      await closeDb(db);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe('upgrading a database with data in it', { timeout: 60_000 }, () => {
  let filled: Db;

  beforeAll(async () => {
    filled = await createTestDb();
    await fill(filled);
  });

  afterAll(async () => {
    if (filled) await closeDb(filled);
  });

  it('on PGlite, kept on disk as in production', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rsdp-upgrade-'));
    const dataDir = path.join(dir, 'pglite');
    try {
      await upgrade(
        {
          async openOld(folder) {
            const client = pgliteFor(dataDir);
            const db = drizzlePglite(client, { schema });
            await migratePglite(db, { migrationsFolder: folder });
            return { db, close: () => client.close() };
          },
          openNew: () => createDb({ pgliteDir: dataDir, ignoreEnv: true }),
        },
        filled,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const url = process.env.TEST_DATABASE_URL;
  it.skipIf(!url)('on Postgres', async () => {
    // A database of its own: the other Postgres tests share TEST_DATABASE_URL's, fully migrated, and may run meanwhile.
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const name = `rsdp_upgrade_${randomBytes(6).toString('hex')}`;
    await admin.query(`create database ${name}`);
    const scratch = new URL(url!);
    scratch.pathname = `/${name}`;
    try {
      await upgrade(
        {
          async openOld(folder) {
            const pool = new pg.Pool({ connectionString: scratch.toString() });
            const db = drizzlePg(pool, { schema });
            await migratePg(db, { migrationsFolder: folder });
            return { db, close: () => pool.end() };
          },
          openNew: () => createDb({ url: scratch.toString() }),
        },
        filled,
      );
    } finally {
      // A pool's end() resolves before its sockets close: let them go, rather than cut them off (which logs an error).
      for (let i = 0; i < 100; i++) {
        const { rows } = await admin.query('select count(*)::int as n from pg_stat_activity where datname = $1', [name]);
        if (!rows[0].n) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    }
  });
});

describe('dropping the unused chip ledger tables (0017)', { timeout: 60_000 }, () => {
  const TAG = '0017_drop_unused_ledger';
  const ledgerTables = async (db: Db) =>
    (
      await queryRows<{ t: string }>(
        db,
        sql`select table_name as t from information_schema.tables where table_schema = 'public' and table_name in ('chip_movements', 'seat_sessions') order by 1`,
      )
    ).map((r) => r.t);
  const appendOnlyFunction = async (db: Db) => (await queryRows(db, sql`select 1 from pg_proc where proname = 'chip_movements_append_only'`)).length > 0;
  const runAgain = async (db: Db) => {
    for (const statement of readFileSync(path.join(MIGRATIONS_DIR, `${TAG}.sql`), 'utf8').split('--> statement-breakpoint')) await db.execute(sql.raw(statement));
  };

  it('drops them when they are empty, and is safe to run twice', async () => {
    const old = await databaseBefore(TAG);
    try {
      await fill(old.db);
      expect(await ledgerTables(old.db)).toEqual(['chip_movements', 'seat_sessions']);
      await old.upgrade();
      expect(await ledgerTables(old.db)).toEqual([]);
      expect(await appendOnlyFunction(old.db)).toBe(false);
      await runAgain(old.db);
      expect(await ledgerTables(old.db)).toEqual([]);
    } finally {
      await old.close();
    }
  });

  it('keeps one with rows, and the server starts and works on it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rsdp-ledger-'));
    const dataDir = path.join(dir, 'pglite');
    try {
      const old = await databaseBefore(TAG, dataDir);
      let columns: Record<string, string[]>;
      let before: Record<string, string[]>;
      try {
        await fill(old.db);
        await fillLedger(old.db);
        await old.db.execute(sql`insert into tables (id, owner_player_id, settings) values ('t2', 'p1', '{}')`);
        columns = await columnsOf(old.db);
        before = await rowsOf(old.db, columns);
      } finally {
        await old.close();
      }

      const db = await createDb({ pgliteDir: dataDir, ignoreEnv: true });
      try {
        expect(await migrationsRecorded(db)).toEqual(expectedRecords);
        expect(await ledgerTables(db)).toEqual(['chip_movements', 'seat_sessions']);
        expect(await rowsOf(db, columns)).toEqual(before);
        // Tables made by the migrations after it (0018's push tables) start empty.
        const made = Object.fromEntries(Object.entries(await columnsOf(db)).filter(([t]) => !columns[t]));
        expect(Object.values(await rowsOf(db, made)).flat()).toEqual([]);
        expect(await appendOnlyFunction(db)).toBe(true);
        await expect(
          db.execute(sql`update chip_movements set amount = 1`).catch((e) => {
            throw dbCause(e);
          }),
        ).rejects.toThrow(/append-only/);
        await runAgain(db);
        expect(await ledgerTables(db)).toEqual(['chip_movements', 'seat_sessions']);

        // The ledger rows still point at t1, so deleting it is refused and nothing goes. Other tables delete as usual.
        await expect(deleteTableForGood(db, 't1')).rejects.toThrow(StorageError);
        expect(await queryRows(db, sql`select id from tables where id = 't1'`)).toHaveLength(1);
        expect(await queryRows(db, sql`select id from hands where table_id = 't1'`)).toHaveLength(1);
        expect(await deleteTableForGood(db, 't2')).toBe(true);
      } finally {
        await closeDb(db);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps seat_sessions while chip_movements, which points at it, stays', async () => {
    const onlySeats = await databaseBefore(TAG);
    try {
      await fill(onlySeats.db);
      await onlySeats.db.execute(sql`insert into seat_sessions (id, table_id, player_id, seat) values ('ss1', 't1', 'p2', 3)`);
      await onlySeats.upgrade();
      expect(await ledgerTables(onlySeats.db)).toEqual(['seat_sessions']);
      expect(await appendOnlyFunction(onlySeats.db)).toBe(false);
    } finally {
      await onlySeats.close();
    }

    const onlyMovements = await databaseBefore(TAG);
    try {
      await fill(onlyMovements.db);
      await onlyMovements.db.execute(
        sql`insert into chip_movements (id, table_id, player_id, kind, amount, stack_before, stack_after) values ('m1', 't1', 'p2', 'buy-in', 200, 0, 200)`,
      );
      await onlyMovements.upgrade();
      expect(await ledgerTables(onlyMovements.db)).toEqual(['chip_movements', 'seat_sessions']);
      expect(await appendOnlyFunction(onlyMovements.db)).toBe(true);
    } finally {
      await onlyMovements.close();
    }
  });
});

describe('the migrations', () => {
  it('build the tables schema.ts describes', { timeout: 60_000 }, async () => {
    // CI's drift step compares schema.ts with the snapshots drizzle-kit keeps in meta/, never with the SQL the
    // server runs, and every generated migration is edited by hand (docs/ARCHITECTURE.md). So build the tables
    // twice, from the migrations and from schema.ts alone (drizzle-kit's own CREATE statements), and compare:
    // a slip while editing, such as a lost NOT NULL or default, shows here.
    const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
    const client = pgliteFor();
    const migrated = await createTestDb();
    try {
      const described = drizzlePglite(client, { schema });
      for (const statement of statements) await described.execute(sql.raw(statement));
      expect(await tablesOf(migrated), 'the migrations build other tables than schema.ts describes: run npm run db:generate, or fix the SQL').toEqual(
        await tablesOf(described),
      );
    } finally {
      await closeDb(migrated);
      await client.close();
    }
  });
});
