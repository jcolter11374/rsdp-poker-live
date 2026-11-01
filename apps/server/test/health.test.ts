// /api/health: what Fly's health check and the site-down alert read.

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, DB_HEALTH_MS } from '../src/app';

const open: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) await new Promise((r) => server.http.close(r));
});

async function serve(checkDb?: () => Promise<unknown>) {
  const logged: string[] = [];
  const server = createApp({ checkDb, log: (m) => logged.push(m) });
  open.push(server);
  await new Promise<void>((r) => server.http.listen(0, r));
  const url = `http://localhost:${(server.http.address() as AddressInfo).port}/api/health`;
  const health = async () => {
    const res = await fetch(url);
    return { status: res.status, body: (await res.json()) as { ok: boolean; db?: string } };
  };
  return { health, logged };
}

describe('/api/health', () => {
  it('answers ok, with no db field when there is no database to ask', async () => {
    const { health } = await serve();
    const r = await health();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body).not.toHaveProperty('db');
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
