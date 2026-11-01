import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, queryRows, type Db } from '../src/db/client';
import { jobs } from '../src/db/schema';
import { createTestDb, resetTestDb } from '../src/db/testing';
import { defaultBackoffMs, getJob, Scheduler, type JobContext, type SchedulerOptions } from '../src/scheduler';

/** A clock and timer queue the test moves by hand. */
class FakeClock {
  t = Date.parse('2026-09-01T12:00:00Z');
  private timers: { at: number; fn: () => void }[] = [];

  now = (): number => this.t;

  setTimer = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: this.t + ms, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
    };
  };

  /** Armed timers' due times, soonest first. */
  get armed(): number[] {
    return this.timers.map((x) => x.at).sort((a, b) => a - b);
  }

  /** Moves time forward, firing due timers in order, and waits for the schedulers to settle. */
  async advance(ms: number, ...schedulers: Scheduler[]): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.fn();
      for (const s of schedulers) await s.idle();
    }
    this.t = end;
  }
}

let db: Db;
let clock: FakeClock;
const started: Scheduler[] = [];

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  await resetTestDb(db);
  clock = new FakeClock();
});
afterEach(async () => {
  for (const s of started.splice(0)) await s.stop();
});

type Payload = { n: number };

function makeScheduler(
  handler: (p: Payload, job: JobContext) => Promise<void>,
  opts: SchedulerOptions = {},
  c: FakeClock = clock,
) {
  const s = new Scheduler(
    db,
    { ping: handler },
    { now: c.now, setTimer: c.setTimer, maxSleepMs: 10 * 60_000, onError: () => {}, ...opts },
  );
  started.push(s as unknown as Scheduler);
  return s;
}

const SEC = 1000;

describe('Scheduler', () => {
  it('runs a job at its time, not before', async () => {
    const ran: number[] = [];
    const s = makeScheduler(async (p) => {
      ran.push(p.n);
    });
    await s.start();
    const id = await s.schedule('ping', clock.t + 10 * SEC, { n: 1 });
    expect(clock.armed).toEqual([clock.t + 10 * SEC]);

    await clock.advance(10 * SEC - 1, s);
    expect(ran).toEqual([]);
    await clock.advance(1, s);
    expect(ran).toEqual([1]);

    const job = await getJob(db, id);
    expect(job).toMatchObject({ status: 'done', attempts: 1, lockedUntil: null });
  });

  it('runs jobs in time order and passes the payload and context', async () => {
    const seen: [number, JobContext][] = [];
    const s = makeScheduler(async (p, job) => {
      seen.push([p.n, job]);
    });
    await s.start();
    const t = clock.t;
    await s.schedule('ping', t + 3 * SEC, { n: 3 });
    await s.schedule('ping', t + 1 * SEC, { n: 1 });
    await s.schedule('ping', new Date(t + 2 * SEC), { n: 2 }, { dedupeKey: 'two' });
    await clock.advance(5 * SEC, s);
    expect(seen.map(([n]) => n)).toEqual([1, 2, 3]);
    expect(seen[1][1]).toMatchObject({ kind: 'ping', attempt: 1, runAt: new Date(t + 2 * SEC), dedupeKey: 'two' });
  });

  it('keeps a single timer and re-arms it when a sooner job is scheduled', async () => {
    const ran: number[] = [];
    const s = makeScheduler(async (p) => {
      ran.push(p.n);
    });
    await s.start();
    const t = clock.t;
    expect(clock.armed).toEqual([t + 10 * 60_000]); // idle poll only

    await s.schedule('ping', t + 60 * SEC, { n: 60 });
    expect(clock.armed).toEqual([t + 60 * SEC]);
    await s.schedule('ping', t + 5 * SEC, { n: 5 });
    expect(clock.armed).toEqual([t + 5 * SEC]);
    await s.schedule('ping', t + 30 * SEC, { n: 30 });
    expect(clock.armed).toEqual([t + 5 * SEC]);
    expect(s.nextWakeAt).toBe(t + 5 * SEC);

    await clock.advance(5 * SEC, s);
    expect(ran).toEqual([5]);
    // Re-armed after the run for the next soonest job.
    expect(clock.armed).toEqual([t + 30 * SEC]);

    await clock.advance(55 * SEC, s);
    expect(ran).toEqual([5, 30, 60]);
  });

  it('runs a job scheduled in the past right away', async () => {
    const ran: number[] = [];
    const s = makeScheduler(async (p) => {
      ran.push(p.n);
    });
    await s.start();
    await s.schedule('ping', clock.t - 60 * SEC, { n: 1 });
    expect(clock.armed).toEqual([clock.t]);
    await clock.advance(0, s);
    expect(ran).toEqual([1]);
  });

  it('treats a dedupe key as one timer: scheduling again moves it', async () => {
    const ran: number[] = [];
    const s = makeScheduler(async (p) => {
      ran.push(p.n);
    });
    await s.start();
    const t = clock.t;
    const a = await s.schedule('ping', t + 10 * SEC, { n: 1 }, { dedupeKey: 'tournament:t1:start' });
    const b = await s.schedule('ping', t + 20 * SEC, { n: 2 }, { dedupeKey: 'tournament:t1:start' });
    expect(b).toBe(a);
    const rows = await db.select().from(jobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runAt: new Date(t + 20 * SEC), payload: { n: 2 } });

    await clock.advance(15 * SEC, s);
    expect(ran).toEqual([]);
    await clock.advance(5 * SEC, s);
    expect(ran).toEqual([2]);

    // Once done, the same key can be armed again.
    const c = await s.schedule('ping', clock.t + SEC, { n: 3 }, { dedupeKey: 'tournament:t1:start' });
    expect(c).toBe(a);
    await clock.advance(SEC, s);
    expect(ran).toEqual([2, 3]);
  });

  it('lets a handler re-schedule its own dedupe key without the run marking it done', async () => {
    let s!: ReturnType<typeof makeScheduler>;
    const ran: number[] = [];
    s = makeScheduler(async (p) => {
      ran.push(p.n);
      if (p.n < 3) await s.schedule('ping', clock.t + 10 * SEC, { n: p.n + 1 }, { dedupeKey: 'tick' });
    });
    await s.start();
    const id = await s.schedule('ping', clock.t + 10 * SEC, { n: 1 }, { dedupeKey: 'tick' });
    await clock.advance(10 * SEC, s);
    expect(ran).toEqual([1]);
    expect(await getJob(db, id)).toMatchObject({ status: 'pending', payload: { n: 2 }, attempts: 0 });
    await clock.advance(20 * SEC, s);
    expect(ran).toEqual([1, 2, 3]);
    expect((await getJob(db, id))?.status).toBe('done');
  });

  it('cancels by id or dedupe key', async () => {
    const ran: number[] = [];
    const s = makeScheduler(async (p) => {
      ran.push(p.n);
    });
    await s.start();
    const t = clock.t;
    const id = await s.schedule('ping', t + 5 * SEC, { n: 1 });
    await s.schedule('ping', t + 6 * SEC, { n: 2 }, { dedupeKey: 'waitlist:offer:p1' });
    await s.schedule('ping', t + 7 * SEC, { n: 3 });

    expect(await s.cancel(id)).toBe(true);
    expect(await s.cancel('waitlist:offer:p1')).toBe(true);
    expect(await s.cancel('waitlist:offer:p1')).toBe(false);
    expect(await s.cancel('no-such-job')).toBe(false);

    await clock.advance(10 * SEC, s);
    expect(ran).toEqual([3]);
    expect((await getJob(db, id))?.status).toBe('cancelled');
    expect(await s.cancel(id)).toBe(false);
  });

  it('does not retry or complete a job cancelled while it runs', async () => {
    let s!: ReturnType<typeof makeScheduler>;
    let id = '';
    s = makeScheduler(async () => {
      await s.cancel(id);
      throw new Error('fails after being cancelled');
    });
    await s.start();
    id = await s.schedule('ping', clock.t + SEC, { n: 1 });
    await clock.advance(SEC, s);
    expect(await getJob(db, id)).toMatchObject({ status: 'cancelled', attempts: 1 });
  });

  it('retries a failing job with backoff, then succeeds', async () => {
    let calls = 0;
    const errors: string[] = [];
    const s = makeScheduler(
      async () => {
        calls++;
        if (calls < 3) throw new Error(`boom ${calls}`);
      },
      { onError: (err) => errors.push((err as Error).message) },
    );
    await s.start();
    const t = clock.t;
    const id = await s.schedule('ping', t, { n: 1 });
    await clock.advance(0, s);
    expect(calls).toBe(1);
    expect(await getJob(db, id)).toMatchObject({ status: 'pending', attempts: 1, lastError: 'boom 1', runAt: new Date(t + 1000) });

    await clock.advance(999, s);
    expect(calls).toBe(1);
    await clock.advance(1, s);
    expect(calls).toBe(2);
    expect(await getJob(db, id)).toMatchObject({ status: 'pending', attempts: 2, runAt: new Date(t + 1000 + 2000) });

    await clock.advance(2000, s);
    expect(calls).toBe(3);
    expect(await getJob(db, id)).toMatchObject({ status: 'done', attempts: 3 });
    expect(errors).toEqual(['boom 1', 'boom 2']);
  });

  it('gives up after 5 attempts and keeps the last error', async () => {
    let calls = 0;
    const s = makeScheduler(async () => {
      calls++;
      throw new Error(`still broken ${calls}`);
    });
    await s.start();
    const id = await s.schedule('ping', clock.t, { n: 1 });
    await clock.advance(60 * 60_000, s);
    expect(calls).toBe(5);
    expect(await getJob(db, id)).toMatchObject({ status: 'failed', attempts: 5, lastError: 'still broken 5', lockedUntil: null });
  });

  it("keeps the database's reason when a job fails on a query, not the query's values", async () => {
    const s = makeScheduler(async () => {
      await db.execute(sql`insert into players (id, display_name) values (${'secret-ish value'}, null)`);
    });
    await s.start();
    const id = await s.schedule('ping', clock.t, { n: 1 });
    await clock.advance(0, s);
    const { lastError } = (await getJob(db, id))!;
    expect(lastError).toMatch(/null value/);
    expect(lastError).not.toContain('secret-ish value');
  });

  it('uses doubling backoff by default, capped at five minutes', () => {
    expect([1, 2, 3, 4, 5].map(defaultBackoffMs)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(defaultBackoffMs(20)).toBe(5 * 60_000);
  });

  it('runs jobs missed while the server was down as soon as it starts', async () => {
    const before = makeScheduler(async () => {});
    const t = clock.t;
    await before.schedule('ping', t + 1 * SEC, { n: 1 });
    await before.schedule('ping', t + 2 * SEC, { n: 2 });
    await before.schedule('ping', t + 60 * 60_000, { n: 3 });
    // "Down" for ten minutes: nobody started a scheduler.
    clock.t += 10 * 60_000;

    const ran: number[] = [];
    const runningDuringRun: number[] = [];
    const after = makeScheduler(async (p) => {
      ran.push(p.n);
      const [row] = await queryRows<{ n: number }>(db, sql`select count(*)::int as n from jobs where status = 'running'`);
      runningDuringRun.push(row.n);
    });
    await after.start();
    expect(ran).toEqual([1, 2]);
    // Each claim takes exactly one job, even with several overdue.
    expect(runningDuringRun).toEqual([1, 1]);
    expect(clock.armed).toEqual([t + 20 * 60_000]); // capped by maxSleepMs, before job 3 at +60 min
  });

  it('takes over a job whose previous runner died mid-run once its lease ends', async () => {
    const t = clock.t;
    await db.insert(jobs).values({
      id: 'orphan',
      kind: 'ping',
      runAt: new Date(t - 60_000),
      payload: { n: 7 },
      status: 'running',
      attempts: 1,
      lockedBy: 'dead-process',
      lockedUntil: new Date(t + 30 * SEC),
    });
    const ran: number[] = [];
    const s = makeScheduler(async (p) => {
      ran.push(p.n);
    });
    await s.start();
    expect(ran).toEqual([]);
    expect(clock.armed).toEqual([t + 30 * SEC]);
    await clock.advance(30 * SEC, s);
    expect(ran).toEqual([7]);
    expect(await getJob(db, 'orphan')).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('marks a job failed instead of running it a sixth time after a crash on its last attempt', async () => {
    await db.insert(jobs).values({
      id: 'cursed',
      kind: 'ping',
      runAt: new Date(clock.t - 60_000),
      payload: { n: 1 },
      status: 'running',
      attempts: 5,
      lockedBy: 'dead-process',
      lockedUntil: new Date(clock.t - 1),
    });
    let calls = 0;
    const s = makeScheduler(async () => {
      calls++;
    });
    await s.start();
    expect(calls).toBe(0);
    expect((await getJob(db, 'cursed'))?.status).toBe('failed');
  });

  it('never runs a job twice with two schedulers on the same database', async () => {
    const runs = new Map<number, number>();
    const handler = async (p: Payload) => {
      runs.set(p.n, (runs.get(p.n) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 1));
    };
    const a = makeScheduler(handler);
    const b = makeScheduler(handler);
    await Promise.all([a.start(), b.start()]);
    for (let n = 0; n < 20; n++) await a.schedule('ping', clock.t + (n % 3) * SEC, { n });

    clock.t += 5 * SEC;
    await Promise.all([a.runDue(), b.runDue(), a.runDue(), b.runDue()]);
    await Promise.all([a.idle(), b.idle()]);
    expect([...runs.keys()].sort((x, y) => x - y)).toEqual([...Array(20).keys()]);
    expect([...runs.values()].every((count) => count === 1)).toBe(true);

    expect(await queryRows(db, sql`select count(*)::int as n from jobs where status = 'done'`)).toEqual([{ n: 20 }]);
  });

  it('leaves kinds it has no handler for to other processes', async () => {
    const ran: string[] = [];
    const tournaments = new Scheduler(db, { 'tournament-tick': async () => void ran.push('tick') }, {
      now: clock.now,
      setTimer: clock.setTimer,
      onError: () => {},
    });
    started.push(tournaments as unknown as Scheduler);
    const pings = makeScheduler(async () => void ran.push('ping'));
    await pings.start();
    await tournaments.schedule('tournament-tick', clock.t, undefined);
    await pings.runDue();
    expect(ran).toEqual([]);
    await tournaments.start();
    expect(ran).toEqual(['tick']);
  });

  it('picks up jobs another process scheduled on its next idle poll', async () => {
    const ran: number[] = [];
    const s = makeScheduler(
      async (p) => {
        ran.push(p.n);
      },
      { maxSleepMs: 30 * SEC },
    );
    await s.start();
    const elsewhere = new Scheduler(db, { ping: async () => {} }, { now: clock.now, setTimer: () => () => {} });
    await elsewhere.schedule('ping', clock.t + SEC, { n: 1 });
    expect(clock.armed).toEqual([clock.t + 30 * SEC]);
    await clock.advance(30 * SEC, s);
    expect(ran).toEqual([1]);
  });

  it('stops: no timer, and pending jobs wait for the next start', async () => {
    const ran: number[] = [];
    const s = makeScheduler(async (p) => {
      ran.push(p.n);
    });
    await s.start();
    await s.schedule('ping', clock.t + SEC, { n: 1 });
    await s.stop();
    expect(clock.armed).toEqual([]);
    await clock.advance(5 * SEC, s);
    expect(ran).toEqual([]);
    await s.start();
    expect(ran).toEqual([1]);
  });

  it('stores a missing payload as null and rejects invalid times', async () => {
    const seen: unknown[] = [];
    const s = new Scheduler(db, { bare: async (p: unknown) => void seen.push(p) }, { now: clock.now, setTimer: clock.setTimer });
    started.push(s as unknown as Scheduler);
    await s.start();
    const id = await s.schedule('bare', clock.t, undefined);
    await clock.advance(0, s);
    expect(seen).toEqual([null]);
    expect((await getJob(db, id))?.payload).toBeNull();
    await expect(s.schedule('bare', Number.NaN, null)).rejects.toThrow(/valid time/);
    expect(await db.select().from(jobs).where(eq(jobs.status, 'pending'))).toEqual([]);
  });
});
