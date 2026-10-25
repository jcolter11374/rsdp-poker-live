import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, createDb, queryRows, type Db } from '../src/db/client';
import { createTestDb } from '../src/db/testing';

let db: Db | undefined;
afterEach(async () => {
  if (db) await closeDb(db);
  db = undefined;
});

describe('createDb', () => {
  it('applies every migration to a fresh in-memory database', async () => {
    db = await createTestDb();
    const rows = await queryRows<{ table_name: string }>(
      db,
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'accounts',
      'chip_movements',
      'hands',
      'jobs',
      'player_tokens',
      'players',
      'seat_sessions',
      'sessions',
      'settings_changes',
      'table_snapshots',
      'tables',
      'tournaments',
    ]);
  });

  it('gives each test database its own data', async () => {
    db = await createTestDb();
    const other = await createTestDb();
    try {
      await db.execute(sql`insert into players (id) values ('only-here')`);
      expect(await queryRows(db, sql`select id from players`)).toHaveLength(1);
      expect(await queryRows(other, sql`select id from players`)).toHaveLength(0);
    } finally {
      await closeDb(other);
    }
  });

  it('ignores DATABASE_URL and PGLITE_DIR when asked to', async () => {
    const saved = { url: process.env.DATABASE_URL, dir: process.env.PGLITE_DIR };
    process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/nothing';
    process.env.PGLITE_DIR = '/nonexistent/should-not-be-used';
    try {
      db = await createDb({ ignoreEnv: true });
      expect(await queryRows(db, sql`select 1 as one`)).toEqual([{ one: 1 }]);
    } finally {
      if (saved.url === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved.url;
      if (saved.dir === undefined) delete process.env.PGLITE_DIR;
      else process.env.PGLITE_DIR = saved.dir;
    }
  });

  it('keeps PGlite data in a directory across restarts and migrates only once', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rsdp-pglite-'));
    try {
      const first = await createDb({ pgliteDir: dir, ignoreEnv: true });
      await first.execute(sql`insert into players (id, display_name) values ('kept', 'Kept')`);
      await closeDb(first);

      db = await createDb({ pgliteDir: dir, ignoreEnv: true });
      expect(await queryRows(db, sql`select id, display_name from players`)).toEqual([{ id: 'kept', display_name: 'Kept' }]);
      const migrations = await queryRows<{ n: number }>(db, sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
      expect(migrations[0].n).toBe(3);
      await closeDb(db);
      db = undefined;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
