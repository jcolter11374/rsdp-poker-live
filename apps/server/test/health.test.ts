// /api/health: what Fly's health check and the site-down alert read.

import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, DB_HEALTH_MS, DISK_HEALTH_MS, diskHealth, diskUse } from '../src/app';

const open: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) await new Promise((r) => server.http.close(r));
});

async function serve(checkDb?: () => Promise<unknown>, dataDir?: string) {
  const logged: string[] = [];
  const server = createApp({ checkDb, dataDir, log: (m) => logged.push(m) });
  open.push(server);
  await new Promise<void>((r) => server.http.listen(0, r));
  const url = `http://localhost:${(server.http.address() as AddressInfo).port}/api/health`;
  const health = async () => {
    const res = await fetch(url);
    return { status: res.status, body: (await res.json()) as { ok: boolean; db?: string; memoryMb: number; diskUsedPct?: number; diskFreeMb?: number } };
  };
  return { health, logged };
}

describe('/api/health', () => {
  it('answers ok, with no db or disk fields when there is no database to ask', async () => {
    const { health } = await serve();
    const r = await health();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.memoryMb).toBeGreaterThan(0);
    expect(r.body).not.toHaveProperty('db');
    expect(r.body).not.toHaveProperty('diskUsedPct');
    expect(r.body).not.toHaveProperty('diskFreeMb');
  });

  it("says how full the database's disk is", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rsdp-health-'));
    try {
      const { health } = await serve(async () => {}, dir);
      const r = await health();
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, db: 'ok' });
      expect(Number.isInteger(r.body.diskUsedPct)).toBe(true);
      expect(r.body.diskUsedPct).toBeGreaterThanOrEqual(0);
      expect(r.body.diskUsedPct).toBeLessThanOrEqual(100);
      expect(Number.isInteger(r.body.diskFreeMb)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps ok and the 200 when the disk can't be read, leaves its fields out, and logs it once", async () => {
    const { health, logged } = await serve(undefined, path.join(tmpdir(), 'rsdp-health-no-such-folder', 'pglite'));
    const r = await health();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body).not.toHaveProperty('diskUsedPct');
    expect(r.body).not.toHaveProperty('diskFreeMb');
    await health();
    expect(logged.filter((m) => m.includes('data disk'))).toHaveLength(1);
  });

  it('says the database answers', async () => {
    const { health } = await serve(async () => {});
    expect((await health()).body).toMatchObject({ ok: true, db: 'ok' });
  });

  it('keeps ok and the 200 when the database fails, says so in db, and logs it once', async () => {
    let broken = true;
    const { health, logged } = await serve(async () => {
      if (broken) throw new Error('connection refused');
    });
    for (let i = 0; i < 3; i++) {
      const r = await health();
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, db: 'error' });
    }
    expect(logged.filter((m) => m.includes('failed'))).toHaveLength(1);
    broken = false;
    expect((await health()).body.db).toBe('ok');
    expect(logged.at(-1)).toContain('answering again');
  });

  it("calls a database that doesn't answer slow, without waiting for it or asking it again meanwhile", async () => {
    let asked = 0;
    let answer = () => {};
    const { health } = await serve(() => {
      asked++;
      // Stuck the first time only.
      return asked === 1 ? new Promise<void>((r) => (answer = r)) : Promise.resolve();
    });
    const started = Date.now();
    const [a, b] = await Promise.all([health(), health()]);
    expect(Date.now() - started).toBeLessThan(DB_HEALTH_MS + 1_000);
    expect([a.body.db, b.body.db]).toEqual(['slow', 'slow']);
    expect(a.body.ok).toBe(true);
    // One stuck query, not one per health check.
    expect(asked).toBe(1);
    answer();
    await new Promise((r) => setTimeout(r, 10));
    expect((await health()).body.db).toBe('ok');
    expect(asked).toBe(2);
  });
});

describe('the disk fields', () => {
  it('count space kept back for the system as used, as df does', () => {
    // 1,000 blocks of 1 MB: 700 used, 300 free of which 50 only the system may use.
    expect(diskUse({ blocks: 1_000, bfree: 300, bavail: 250, bsize: 1_048_576 })).toEqual({ diskUsedPct: 74, diskFreeMb: 250 });
    expect(diskUse({ blocks: 0, bfree: 0, bavail: 0, bsize: 4_096 })).toBeNull();
  });

  it('read the disk at most once a minute, and say whatever was last read if it is slow', async () => {
    let now = 0;
    let reads = 0;
    let answer: ((s: { blocks: number; bfree: number; bavail: number; bsize: number }) => void) | null = null;
    const space = { blocks: 100, bfree: 60, bavail: 60, bsize: 1_048_576 };
    const read = () => {
      reads++;
      // The third read never answers.
      return reads === 3 ? new Promise<typeof space>((r) => (answer = r)) : Promise.resolve(space);
    };
    const disk = diskHealth('/data', () => {}, () => now, read);
    expect(await disk()).toEqual({ diskUsedPct: 40, diskFreeMb: 60 });
    now += DISK_HEALTH_MS - 1;
    await disk();
    expect(reads).toBe(1);
    now += 1;
    space.bfree = space.bavail = 30;
    expect(await disk()).toEqual({ diskUsedPct: 70, diskFreeMb: 30 });
    expect(reads).toBe(2);
    now += DISK_HEALTH_MS;
    const started = Date.now();
    // Stuck: the last answer, without waiting long and without a second read meanwhile.
    expect(await Promise.all([disk(), disk()])).toEqual([
      { diskUsedPct: 70, diskFreeMb: 30 },
      { diskUsedPct: 70, diskFreeMb: 30 },
    ]);
    expect(Date.now() - started).toBeLessThan(DB_HEALTH_MS + 1_000);
    expect(reads).toBe(3);
    answer!({ blocks: 100, bfree: 10, bavail: 10, bsize: 1_048_576 });
    await new Promise((r) => setTimeout(r, 10));
    expect(await disk()).toEqual({ diskUsedPct: 90, diskFreeMb: 10 });
  });
});
