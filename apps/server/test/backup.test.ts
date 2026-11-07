import { readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app';
import { AuditLog, dbAuditStore } from '../src/audit';
import { closeDb, createDb, dbCause, queryRows, type Db } from '../src/db';
import { BackupError, backupLines, nextSizeFetch, PAGE_BYTES, pageCounts, restoreBackup, writeBackup } from '../src/db/backup';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { RESTORE_FILE, restoreIfWaiting } from '../src/db/restoreOnStart';
import { backupOf, BIG, everything, fill, linesOf } from './backup-fixture';

const KEY = 'test-admin-key-0123456789';
let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await closeDb(db);
});

describe('backups', { timeout: 30_000 }, () => {
  it('restore gives back every row of every table, exactly', async () => {
    await resetTestDb(db);
    await fill(db);
    const { text, summary } = await backupOf(db);
    expect(summary.rows.players).toBe(2);
    expect(Object.keys(summary.rows)).toHaveLength(24);

    const copy = await createTestDb();
    try {
      const restored = await restoreBackup(copy, linesOf(text));
      expect(restored.rows).toEqual(summary.rows);
      expect(await everything(copy)).toEqual(await everything(db));
      // Counters carry on after the restored rows, and the append-only guards still guard.
      await copy.execute(sql`insert into suggestions (name, title) values ('Al', 'Badugi')`);
      expect((await queryRows<{ id: number }>(copy, sql`select max(id)::int as id from suggestions`))[0].id).toBe(3);
      await copy.execute(sql`insert into chip_movements (id, table_id, player_id, kind, amount, stack_before, stack_after) values ('m2', 't1', 'p2', 'rebuy', 100, 200, 300)`);
      expect((await queryRows<{ seq: number }>(copy, sql`select seq::int from chip_movements where id = 'm2'`))[0].seq).toBe(2);
      await expect(
        copy.execute(sql`update audit_log set kind = 'x'`).catch((e) => {
          throw dbCause(e);
        }),
      ).rejects.toThrow(/append-only/);
      expect((await queryRows<{ at: string }>(copy, sql`select at::text from audit_log`))[0].at).toBe(BIG);
    } finally {
      await closeDb(copy);
    }
  });

  it('refuses a backup that was cut short, and restores nothing', async () => {
    await resetTestDb(db);
    await fill(db);
    const { text } = await backupOf(db);
    const lines = text.trimEnd().split('\n');
    const copy = await createTestDb();
    try {
      // No end line.
      await expect(restoreBackup(copy, linesOf(lines.slice(0, -1).join('\n')))).rejects.toThrow(/cut short/);
      // An end line that counts rows that aren't there.
      await expect(restoreBackup(copy, linesOf([...lines.slice(0, 3), lines.at(-1)].join('\n')))).rejects.toThrow(/cut short/);
      expect(await queryRows(copy, sql`select * from players`)).toHaveLength(0);
      await expect(restoreBackup(copy, linesOf('{"hello":1}\n'))).rejects.toThrow(BackupError);
    } finally {
      await closeDb(copy);
    }
  });

  it('never hands out an id again that was used before the backup', async () => {
    await resetTestDb(db);
    await fill(db);
    await db.execute(sql`delete from suggestions where id = 2`);
    const { text } = await backupOf(db);
    const copy = await createTestDb();
    try {
      await restoreBackup(copy, linesOf(text));
      await copy.execute(sql`insert into suggestions (name, title) values ('Al', 'Badugi')`);
      expect((await queryRows<{ id: number }>(copy, sql`select max(id)::int as id from suggestions`))[0].id).toBe(3);
    } finally {
      await closeDb(copy);
    }
  });

  it('keeps every counter where it had got to through a restore and a backup of the restored copy (#376)', async () => {
    await resetTestDb(db);
    await fill(db);
    await db.execute(sql`delete from suggestions where id = 2`);
    const first = await backupOf(db);
    const copy = await createTestDb();
    const again = await createTestDb();
    try {
      await restoreBackup(copy, linesOf(first.text));
      // Nothing has been added since the restore, so every counter is where the restore left it.
      const second = await backupOf(copy);
      const ends = [first, second].map(({ text }) => JSON.parse(text.trimEnd().split('\n').at(-1)!).sequences);
      expect(ends[1]).toEqual(ends[0]);
      expect(ends[0]['suggestions.id']).toBe(2);

      await restoreBackup(again, linesOf(second.text));
      await again.execute(sql`insert into suggestions (name, title) values ('Al', 'Badugi')`);
      expect((await queryRows<{ id: number }>(again, sql`select max(id)::int as id from suggestions`))[0].id).toBe(3);
    } finally {
      await closeDb(copy);
      await closeDb(again);
    }
  });

  it('backs up and restores saved tables too big for one round trip on PGlite 0.2 (#403)', { timeout: 120_000 }, async () => {
    // 36 saved tables of about 512 KB each: 18 MB, which PGlite 0.2 can't return in one result (it fails over about
    // 16 MB). In-memory test databases run PGlite 0.2, as the live site does.
    await resetTestDb(db);
    await db.execute(sql`insert into players (id) values ('p1')`);
    const blob = 'x'.repeat(512 * 1024);
    for (let i = 0; i < 36; i++) {
      await db.execute(sql`insert into tables (id, owner_player_id, settings, mode) values (${`big${i}`}, 'p1', '{}', 'cash')`);
      await db.execute(sql`insert into table_snapshots (table_id, version, state) values (${`big${i}`}, 1, ${JSON.stringify({ i, blob })}::jsonb)`);
    }
    const { text, summary } = await backupOf(db);
    expect(summary.rows.table_snapshots).toBe(36);
    const copy = await createTestDb();
    try {
      expect((await restoreBackup(copy, linesOf(text))).rows).toEqual(summary.rows);
      const got = await queryRows<{ id: string; n: number; i: number }>(copy, sql`select table_id as id, length(state->>'blob')::int as n, (state->>'i')::int as i from table_snapshots order by i`);
      expect(got).toEqual(Array.from({ length: 36 }, (_, i) => ({ id: `big${i}`, n: blob.length, i })));
    } finally {
      await closeDb(copy);
    }
  });

  it('backs up every row once when updates and deletes have moved rows around the table, over many fetches', { timeout: 120_000 }, async () => {
    // 2500 suggestions (more than one first-pass fetch), then updates that move rows to new places, deletes that
    // leave gaps, and new rows that may fill them: the rows' order on disk no longer follows their ids.
    await resetTestDb(db);
    for (let i = 0; i < 2500; i += 250) {
      const values = Array.from({ length: 250 }, (_, k) => sql`(${`N${i + k}`}, ${`T${i + k}`})`);
      await db.execute(sql`insert into suggestions (name, title) values ${sql.join(values, sql`, `)}`);
    }
    await db.execute(sql`update suggestions set title = title || repeat('y', 3000) where id % 7 = 0`);
    await db.execute(sql`delete from suggestions where id % 11 = 0`);
    await db.execute(sql`insert into suggestions (name, title) select 'late' || g, 'L' || g from generate_series(1, 300) g`);
    const want = await queryRows<{ id: number; title: string }>(db, sql`select id::int as id, title from suggestions order by id`);
    const { text, summary } = await backupOf(db);
    expect(summary.rows.suggestions).toBe(want.length);
    const ids = text.split('\n').filter((l) => l.startsWith('{"t":"suggestions"')).map((l) => JSON.parse(l).r.id as number);
    expect(new Set(ids).size).toBe(want.length);
    const copy = await createTestDb();
    try {
      await restoreBackup(copy, linesOf(text));
      expect(await queryRows(copy, sql`select id::int as id, title from suggestions order by id`)).toEqual(want);
    } finally {
      await closeDb(copy);
    }
  });

  it("sizes the first pass's fetches by the JSON they make, so big rows are measured a few at a time", () => {
    const MB = 1_048_576;
    // Saved tables of 1.3 MB each: three at a time after the first fetch, not up to a thousand in one go.
    expect(nextSizeFetch(16, 16 * 1.3 * MB)).toBe(3);
    expect(nextSizeFetch(3, 3 * 1.3 * MB)).toBe(3);
    expect(nextSizeFetch(1, 10 * MB)).toBe(1);
    // Small rows: twice as many each time, up to the most a fetch takes, since the next rows may be far bigger.
    expect(nextSizeFetch(16, 16 * 2000)).toBe(32);
    expect(nextSizeFetch(32, 32 * 2000)).toBe(64);
    expect(nextSizeFetch(64, 64 * 2000)).toBe(64);
    expect(nextSizeFetch(64, 0)).toBe(64);
  });

  it("measures big rows after small ones a few at a time too, in writeBackup's own first pass", { timeout: 60_000 }, async () => {
    // 40 small suggestions first, then 60 of about 600 KB. stopped() is asked once after each full fetch, so it counts
    // them: 16 and 32 rows, then fewer and fewer as the big rows are measured (27, then 6 at a time) make seven.
    // Sizing every fetch after the first by the small rows alone would make one, and only doubling would make two.
    await resetTestDb(db);
    await db.execute(sql`insert into suggestions (name, title) select 'n' || g, 't' || g from generate_series(1, 40) g`);
    await db.execute(sql`insert into suggestions (name, title) select 'big' || g, repeat(md5(g::text), 19000) from generate_series(1, 60) g`);
    let asked = 0;
    const counting = () => {
      asked++;
      return false;
    };
    const lines: string[] = [];
    const summary = await writeBackup(db, (l) => void lines.push(l), new Date(), counting);
    expect(summary.rows.suggestions).toBe(100);
    // Every other table is empty, so ends on its first fetch without being asked.
    expect(asked).toBe(7);
  });

  it('stops in the first pass when the server is shutting down', async () => {
    await resetTestDb(db);
    await db.execute(sql`insert into suggestions (name, title) select 'n' || g, 't' || g from generate_series(1, 100) g`);
    const lines: string[] = [];
    let asked = 0;
    // Stopped after the first fetch of the first table with more rows than that.
    await expect(writeBackup(db, (l) => void lines.push(l), new Date(), () => ++asked > 0)).rejects.toThrow(/stopped/);
    expect(asked).toBe(1);
    expect(lines.filter((l) => l.startsWith('{"t":'))).toEqual([]);
  });

  it('fetches as many rows at a time as fit, and at least one', () => {
    const MB = 1_048_576;
    expect(pageCounts([])).toEqual([]);
    expect(pageCounts(Array(1200).fill(10))).toEqual([500, 500, 200]);
    expect(pageCounts(Array(10).fill(MB))).toEqual([4, 4, 2]);
    // A row bigger than the budget goes on its own.
    expect(pageCounts([10, 6 * MB, 10, 10])).toEqual([1, 1, 2]);
    expect(pageCounts([PAGE_BYTES])).toEqual([1]);
  });

  it('refuses to restore over data', async () => {
    await resetTestDb(db);
    await fill(db);
    const { text } = await backupOf(db);
    await expect(restoreBackup(db, linesOf(text))).rejects.toThrow(/empty database/);
  });

  it('restores an older backup into a newer schema, keeping new columns at their defaults', async () => {
    await resetTestDb(db);
    await fill(db);
    const { text } = await backupOf(db);
    // As if the backup predated accounts.has_password.
    const older = text
      .split('\n')
      .map((l) => (l.startsWith('{"t":"accounts"') ? l.replace(/,"has_password":[a-z]+/, '') : l))
      .join('\n');
    expect(older).not.toContain('has_password');
    const copy = await createTestDb();
    try {
      await restoreBackup(copy, linesOf(older));
      const [row] = await queryRows<{ has_password: boolean }>(copy, sql`select has_password from accounts`);
      expect(row.has_password).toBe(true);
    } finally {
      await closeDb(copy);
    }
  });

  it('restores into a PGlite folder that a server can then open', async () => {
    await resetTestDb(db);
    await fill(db);
    const { text } = await backupOf(db);
    const dir = await mkdtemp(path.join(tmpdir(), 'rsdp-restore-'));
    try {
      const file = path.join(dir, 'backup.jsonl.gz');
      await writeFile(file, gzipSync(text));
      const target = path.join(dir, 'pglite');
      const first = await createDb({ ignoreEnv: true, pgliteDir: target });
      await restoreBackup(first, backupLines(file));
      await closeDb(first);
      const reopened = await createDb({ ignoreEnv: true, pgliteDir: target });
      try {
        expect(await everything(reopened)).toEqual(await everything(db));
      } finally {
        await closeDb(reopened);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the admin download is the whole database, needs the admin key, and goes in the public record', async () => {
    await resetTestDb(db);
    await fill(db);
    await db.execute(sql`truncate audit_log`);
    const audit = await AuditLog.open(dbAuditStore(db));
    const server = createApp({ accounts: db, adminKey: KEY, audit, log: () => {} });
    await new Promise<void>((resolve) => server.http.listen(0, resolve));
    const url = `http://localhost:${(server.http.address() as AddressInfo).port}/api/admin/backup`;
    try {
      expect((await fetch(url)).status).toBe(401);
      const res = await fetch(url, { headers: { 'x-admin-key': KEY } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/gzip');
      const text = gunzipSync(Buffer.from(await res.arrayBuffer())).toString();
      const copy = await createTestDb();
      try {
        await restoreBackup(copy, linesOf(text));
        const tables = await everything(copy);
        expect(tables.players).toEqual((await everything(db)).players);
      } finally {
        await closeDb(copy);
      }
      await audit.flush();
      const entries = await queryRows<{ data: { action: string; target: string } }>(db, sql`select data from audit_log where kind = 'admin'`);
      expect(entries.map((e) => e.data.action)).toEqual(['backup']);
    } finally {
      await server.close();
    }
  });
});

// Each opens several PGlite databases on disk, which takes seconds on a busy machine.
describe('restoring the live site on start', { timeout: 30_000 }, () => {
  it('swaps a waiting backup in before the database opens, keeping the old data', async () => {
    await resetTestDb(db);
    await fill(db);
    const { text } = await backupOf(db);
    const dir = await mkdtemp(path.join(tmpdir(), 'rsdp-onstart-'));
    try {
      const live = path.join(dir, 'pglite');
      const old = await createDb({ ignoreEnv: true, pgliteDir: live });
      await old.execute(sql`insert into players (id) values ('only-in-old')`);
      await closeDb(old);
      await writeFile(path.join(dir, RESTORE_FILE), gzipSync(text));
      await restoreIfWaiting(live, () => {});
      const names = readdirSync(dir).sort();
      expect(names.some((n) => n.startsWith('pglite-before-restore-'))).toBe(true);
      expect(names.some((n) => n.startsWith(`${RESTORE_FILE}.done-`))).toBe(true);
      expect(names).not.toContain(RESTORE_FILE);
      const reopened = await createDb({ ignoreEnv: true, pgliteDir: live });
      try {
        expect(await everything(reopened)).toEqual(await everything(db));
      } finally {
        await closeDb(reopened);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves the data alone when the backup is bad', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rsdp-onstart-'));
    try {
      const live = path.join(dir, 'pglite');
      const old = await createDb({ ignoreEnv: true, pgliteDir: live });
      await old.execute(sql`insert into players (id) values ('keep-me')`);
      await closeDb(old);
      await writeFile(path.join(dir, RESTORE_FILE), gzipSync('{"backup":"rsdp","version":1,"at":"x","migrations":0,"tables":[]}\n'));
      await restoreIfWaiting(live, () => {});
      const names = readdirSync(dir).sort();
      expect(names).toEqual(['pglite', expect.stringMatching(new RegExp(`^${RESTORE_FILE}\\.failed-`))]);
      const reopened = await createDb({ ignoreEnv: true, pgliteDir: live });
      try {
        expect(await queryRows(reopened, sql`select id from players`)).toEqual([{ id: 'keep-me' }]);
      } finally {
        await closeDb(reopened);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("logs the database's reason when it refuses a row, not the rows themselves", async () => {
    await resetTestDb(db);
    await fill(db);
    const { text } = await backupOf(db);
    // A movement the ledger's check constraint refuses.
    const bad = text.replace('"kind":"buy-in"', '"kind":"not-a-kind"');
    const dir = await mkdtemp(path.join(tmpdir(), 'rsdp-onstart-'));
    try {
      await writeFile(path.join(dir, RESTORE_FILE), gzipSync(bad));
      const logged: string[] = [];
      await restoreIfWaiting(path.join(dir, 'pglite'), (m) => logged.push(m));
      const failed = logged.find((m) => m.startsWith('restore failed'));
      expect(failed).toMatch(/check constraint/);
      expect(failed).not.toContain('not-a-kind');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
