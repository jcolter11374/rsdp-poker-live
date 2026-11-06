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
import { backupOf, everything, fill, linesOf } from './backup-fixture';

let dir = '';
const open: Db[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rsdp-pglite-versions-'));
});

afterEach(async () => {
  for (const db of open.splice(0)) await closeDb(db);
  await rm(dir, { recursive: true, force: true });
});

async function openDb(folder: string) {
  const db = await createDb({ ignoreEnv: true, pgliteDir: folder, vacuumEveryMs: 2 ** 30 });
  open.push(db);
  return db;
}

async function close(db: Db) {
  open.splice(open.indexOf(db), 1);
  await closeDb(db);
}

/** A new, empty folder in Postgres 18's format, as PGlite 0.5 makes it. */
async function postgres18Folder(name: string) {
  const folder = path.join(dir, name);
  const raw = new PGlite(folder);
  await raw.query('select 1');
  await raw.close();
  return folder;
}

const majorVersion = async (db: Db) => Math.floor(Number((await queryRows<{ v: string }>(db, sql`select current_setting('server_version_num') as v`))[0].v) / 10_000);
const migrationCount = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).length;

describe('PGlite versions', { timeout: 60_000 }, () => {
  it('ships the Postgres versions the server expects', async () => {
    for (const [raw, expected] of [
      [new LegacyPGlite(), LEGACY_PGLITE_POSTGRES],
      [new PGlite(), PGLITE_POSTGRES],
    ] as const) {
      const { rows } = await raw.query<{ v: string }>("select current_setting('server_version_num') as v");
      expect(Math.floor(Number(rows[0].v) / 10_000)).toBe(expected);
      await raw.close();
    }
  });

  it('keeps new folders in Postgres 16 files, as the live site has them, for now', async () => {
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
  });

  it('restores a Postgres 16 backup into Postgres 18 with every row exactly, and back again', async () => {
    const old = await openDb(path.join(dir, 'pg16'));
    await fill(old);
    const fromOld = await backupOf(old);

    const next = await openDb(await postgres18Folder('pg18'));
    expect((await restoreBackup(next, linesOf(fromOld.text))).rows).toEqual(fromOld.summary.rows);
    expect(await everything(next)).toEqual(await everything(old));

    // Going back, as a rollback would: a backup of the Postgres 18 copy restores into a new Postgres 16 folder.
    const fromNext = await backupOf(next);
    const back = await openDb(path.join(dir, 'pg16-again'));
    expect(await majorVersion(back)).toBe(LEGACY_PGLITE_POSTGRES);
    await restoreBackup(back, linesOf(fromNext.text));
    expect(await everything(back)).toEqual(await everything(old));
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
