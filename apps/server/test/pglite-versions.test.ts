// PGlite 0.2 runs Postgres 16 and 0.5 runs Postgres 18, and Postgres can't open another major version's files. Both
// ship until the live site's folder is moved to Postgres 18 (#367). These check which one opens which folder, and that
// the backup format carries every row from one to the other, both ways: that is how the folder will be moved, and how
// a release that moved it could be rolled back.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PGlite as LegacyPGlite } from 'pglite-0.2';
import { closeDb, createDb, LEGACY_PGLITE_POSTGRES, MIGRATIONS_DIR, PGLITE_POSTGRES, pgliteFolderVersion, queryRows, type Db } from '../src/db/client';
import { restoreBackup } from '../src/db/backup';
import { dbCause } from '../src/db/errors';
import { createTable, saveSnapshot } from '../src/db/tables';
import { createTestDb } from '../src/db/testing';
import { backupOf, everything, fill, linesOf } from './backup-fixture';

let dir = '';
const open: Db[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rsdp-pglite-versions-'));
});

afterEach(async () => {
  await Promise.allSettled(open.splice(0).map(closeDb));
  await rm(dir, { recursive: true, force: true });
});

function keep(db: Db) {
  open.push(db);
  return db;
}

const openDb = async (folder: string, vacuumEveryMs = 2 ** 30) => keep(await createDb({ ignoreEnv: true, pgliteDir: folder, vacuumEveryMs }));

async function close(db: Db) {
  const at = open.indexOf(db);
  if (at >= 0) open.splice(at, 1);
  await closeDb(db);
}

/** A new, empty folder in Postgres 18's format, as PGlite 0.5 makes it. */
async function postgres18Folder(name: string) {
  const folder = path.join(dir, name);
  const raw = new PGlite(folder);
  try {
    await raw.query('select 1');
  } finally {
    await raw.close();
  }
  return folder;
}

const setting = async (db: Db, name: string) => (await queryRows<{ v: string }>(db, sql`select current_setting(${name}) as v`))[0].v;
const majorVersion = async (db: Db) => Math.floor(Number(await setting(db, 'server_version_num')) / 10_000);
const migrationCount = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).length;

describe('PGlite versions', { timeout: 60_000 }, () => {
  it('ships the Postgres versions the server expects', async () => {
    // Written out rather than read from client.ts: if an update changes either, the live folder can't be opened by
    // the new one, and the way through is D32's three releases, not a new number here.
    expect([LEGACY_PGLITE_POSTGRES, PGLITE_POSTGRES], 'a new Postgres major version: see D32 in docs/DECISIONS.md').toEqual([16, 18]);
    for (const [make, expected] of [
      [() => new LegacyPGlite(), 16],
      [() => new PGlite(), 18],
    ] as const) {
      const raw = make();
      try {
        const { rows } = await raw.query<{ v: string }>("select current_setting('server_version_num') as v");
        expect(Math.floor(Number(rows[0].v) / 10_000), 'a new Postgres major version: see D32 in docs/DECISIONS.md').toBe(expected);
      } finally {
        await raw.close();
      }
    }
  });

  it('keeps new folders and in-memory databases on Postgres 16, as the live site has them, for now', async () => {
    expect(await majorVersion(keep(await createTestDb()))).toBe(LEGACY_PGLITE_POSTGRES);

    const folder = path.join(dir, 'pglite');
    let db = await openDb(folder);
    expect(await majorVersion(db)).toBe(LEGACY_PGLITE_POSTGRES);
    await db.execute(sql`insert into players (id, display_name) values ('kept', 'Kept')`);
    await close(db);
    expect(pgliteFolderVersion(folder)).toBe(LEGACY_PGLITE_POSTGRES);

    db = await openDb(folder);
    expect(await queryRows(db, sql`select id from players`)).toEqual([{ id: 'kept' }]);
  });

  it('opens a Postgres 18 folder with PGlite 0.5, migrates it once and keeps its data', async () => {
    const folder = await postgres18Folder('pglite');
    let db = await openDb(folder);
    expect(await majorVersion(db)).toBe(PGLITE_POSTGRES);
    await db.execute(sql`insert into players (id, display_name) values ('kept', 'Kept')`);
    await close(db);

    db = await openDb(folder);
    expect(await majorVersion(db)).toBe(PGLITE_POSTGRES);
    expect(await queryRows(db, sql`select id from players`)).toEqual([{ id: 'kept' }]);
    expect((await queryRows<{ n: number }>(db, sql`select count(*)::int as n from drizzle.__drizzle_migrations`))[0].n).toBe(migrationCount);
    expect(pgliteFolderVersion(folder)).toBe(PGLITE_POSTGRES);
    // 0.5 would otherwise keep up to 1 GB of old write-ahead log after a checkpoint; 0.2 keeps 64 MB.
    expect(await setting(db, 'max_wal_size')).toBe('64MB');
  });

  it('vacuums and checkpoints a Postgres 18 folder as it goes, and gives back old snapshots when it opens', async () => {
    const folder = await postgres18Folder('pglite');
    const snapshot = (n: number) => ({ version: n, state: { n, log: Array.from({ length: 300 }, () => Math.random().toString(36).repeat(3)) } });
    const checkpointAt = async (db: Db) => (await queryRows<{ redo: string }>(db, sql`select redo_lsn::text as redo from pg_control_checkpoint()`))[0].redo;
    const snapshotBytes = async (db: Db) => Number((await queryRows<{ size: string }>(db, sql`select pg_total_relation_size('table_snapshots') as size`))[0].size);

    // PGlite never checkpoints by itself: the server's own VACUUM and CHECKPOINT every few minutes keep the disk in check.
    let db = await openDb(folder, 20);
    const from = await checkpointAt(db);
    await db.execute(sql`insert into players (id) values ('host')`);
    const table = await createTable(db, { id: 'vacuum-t', ownerPlayerId: 'host', settings: {} });
    for (let n = 1; n <= 60; n++) {
      await saveSnapshot(db, table.id, snapshot(n));
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await checkpointAt(db)).not.toBe(from);
    await close(db);

    // Without vacuuming, every save leaves its old snapshot behind; VACUUM FULL on the next open gives them back.
    db = await openDb(folder);
    for (let n = 61; n <= 210; n++) await saveSnapshot(db, table.id, snapshot(n));
    const bloated = await snapshotBytes(db);
    await close(db);
    db = await openDb(folder);
    expect(await snapshotBytes(db)).toBeLessThan(bloated / 10);
  });

  it('restores a Postgres 16 backup into Postgres 18 with every row exactly, opens it again, and goes back', async () => {
    const old = await openDb(path.join(dir, 'pg16'));
    await fill(old);
    const fromOld = await backupOf(old);
    const want = await everything(old);

    const folder18 = await postgres18Folder('pg18');
    let next = await openDb(folder18);
    expect((await restoreBackup(next, linesOf(fromOld.text))).rows).toEqual(fromOld.summary.rows);
    expect(await everything(next)).toEqual(want);

    // A rollback from the release that moves the folder starts this code on such a folder.
    await close(next);
    next = await openDb(folder18);
    expect(await majorVersion(next)).toBe(PGLITE_POSTGRES);
    expect(await everything(next)).toEqual(want);
    await expect(
      next.execute(sql`update audit_log set kind = 'x'`).catch((e) => {
        throw dbCause(e);
      }),
    ).rejects.toThrow(/append-only/);

    // Going back, as a rollback would: a backup of the Postgres 18 copy restores into a new Postgres 16 folder.
    const fromNext = await backupOf(next);
    const back = await openDb(path.join(dir, 'pg16-again'));
    expect(await majorVersion(back)).toBe(LEGACY_PGLITE_POSTGRES);
    await restoreBackup(back, linesOf(fromNext.text));
    expect(await everything(back)).toEqual(want);
  });

  it("refuses a folder from a Postgres version it can't read, and says what to do", async () => {
    const folder = path.join(dir, 'pglite');
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'PG_VERSION'), '15\n');
    await expect(openDb(folder)).rejects.toThrow(/holds Postgres 15 files.*Restore a backup/);
    writeFileSync(path.join(folder, 'PG_VERSION'), 'sixteen\n');
    expect(() => pgliteFolderVersion(folder)).toThrow(/should be a Postgres version/);
    expect(pgliteFolderVersion(path.join(dir, 'nothing-here'))).toBeNull();
  });
});
