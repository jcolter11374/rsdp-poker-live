/**
 * Durable scheduler: jobs live in the `jobs` table so timers survive a
 * restart (tournament auto-start, recurring events, waitlist offers).
 *
 * One timer per process is armed for the soonest job. A job is claimed with a
 * single conditional UPDATE that sets status 'running', a lease
 * (locked_until) and a claim token (locked_by), so two processes never run
 * the same job; a lease that runs out (crashed process) lets another process
 * claim it again. Delivery is therefore at least once: handlers must be
 * idempotent.
 */

import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { dbCause } from '../db/errors';
import { newId } from '../db/ids';
import { jobs } from '../db/schema';

export type Job = typeof jobs.$inferSelect;

export interface JobContext {
  id: string;
  kind: string;
  /** 1 on the first run, 2 on the first retry, and so on. */
  attempt: number;
  runAt: Date;
  dedupeKey: string | null;
}

export type JobHandler<P = unknown> = (payload: P, job: JobContext) => Promise<void>;

/** `never` lets each handler declare its own payload type; schedule() then checks payloads per kind. */
export type JobHandlers = Record<string, (payload: never, job: JobContext) => Promise<void>>;

export type PayloadOf<F> = F extends (payload: infer P, job: JobContext) => Promise<void>
  ? [P] extends [never]
    ? unknown
    : P
  : unknown;

export interface SchedulerOptions {
  /** Epoch milliseconds. Inject a fake clock in tests. */
  now?: () => number;
  /** Arms a one-shot timer and returns a function that cancels it. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Runs per job before it is marked failed. Default 5. */
  maxAttempts?: number;
  /** Delay before retry number `attempt` (1 after the first failure). Default 1s, 2s, 4s, 8s... up to 5 min. */
  backoffMs?: (attempt: number) => number;
  /** How long a claim is held before another process may take the job over. Default 5 min. */
  leaseMs?: number;
  /** Never sleep longer than this, so jobs scheduled by other processes are picked up. Default 1 min. */
  maxSleepMs?: number;
  /** Handler failures (with the job) and scheduler failures (job null). Default console.error. */
  onError?: (err: unknown, job: JobContext | null) => void;
}

export const DEFAULT_MAX_ATTEMPTS = 5;

export function defaultBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 5 * 60_000);
}

/** setTimeout fires at once for delays past 2^31 - 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Pause before trying again after the database itself failed. */
const ERROR_RETRY_MS = 5_000;

function realTimer(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
}

function errorText(err: unknown): string {
  const e = dbCause(err);
  const text = e instanceof Error ? e.message || e.name : String(e);
  return text.slice(0, 2000);
}

export class Scheduler<H extends JobHandlers = JobHandlers> {
  private readonly kinds: string[];
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly leaseMs: number;
  private readonly maxSleepMs: number;
  private readonly onError: (err: unknown, job: JobContext | null) => void;

  private started = false;
  private stopped = false;
  private cancelTimer: (() => void) | null = null;
  private armedFor: number | null = null;
  private loop: Promise<void> | null = null;
  private wake = false;

  constructor(
    private readonly db: Db,
    private readonly handlers: H,
    opts: SchedulerOptions = {},
  ) {
    this.kinds = Object.keys(handlers);
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? realTimer;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = opts.backoffMs ?? defaultBackoffMs;
    this.leaseMs = opts.leaseMs ?? 5 * 60_000;
    this.maxSleepMs = opts.maxSleepMs ?? 60_000;
    this.onError = opts.onError ?? ((err, job) => console.error('scheduler', job?.kind ?? '', job?.id ?? '', dbCause(err)));
  }

  /**
   * Stores a job and returns its id. A dedupe key names one logical timer:
   * scheduling the same key again moves that job (new time and payload,
   * attempts reset) instead of adding another, even from inside its own run.
   */
  async schedule<K extends keyof H & string>(
    kind: K,
    runAt: Date | number,
    payload: PayloadOf<H[K]>,
    opts: { dedupeKey?: string } = {},
  ): Promise<string> {
    const at = new Date(runAt);
    if (Number.isNaN(at.getTime())) throw new Error('runAt is not a valid time');
    const fresh = {
      kind,
      runAt: at,
      payload: payload ?? null,
      status: 'pending' as const,
      attempts: 0,
      lastError: null,
      lockedUntil: null,
      lockedBy: null,
    };
    const [row] = await this.db
      .insert(jobs)
      .values({ id: newId(), ...fresh, dedupeKey: opts.dedupeKey ?? null, createdAt: new Date(this.now()) })
      .onConflictDoUpdate({ target: jobs.dedupeKey, set: fresh })
      .returning({ id: jobs.id });
    if (this.kinds.includes(kind)) this.arm(at.getTime());
    return row.id;
  }

  /**
   * Cancels a pending job by id or dedupe key. A job that is running right
   * now finishes its current run but will not be retried or marked done.
   */
  async cancel(idOrDedupeKey: string): Promise<boolean> {
    const rows = await this.db
      .update(jobs)
      .set({ status: 'cancelled', lockedUntil: null })
      .where(
        and(
          or(eq(jobs.id, idOrDedupeKey), eq(jobs.dedupeKey, idOrDedupeKey)),
          inArray(jobs.status, ['pending', 'running']),
        ),
      )
      .returning({ id: jobs.id });
    return rows.length > 0;
  }

  /**
   * Runs every job that came due while the server was down, then arms the
   * timer for the soonest pending one. Resolves once the missed jobs have run,
   * so call it when the handlers' dependencies are ready.
   */
  async start(): Promise<void> {
    this.started = true;
    this.stopped = false;
    await this.kick();
  }

  /** Disarms the timer and waits for a run in progress. Pending jobs stay in the table. */
  async stop(): Promise<void> {
    this.started = false;
    this.stopped = true;
    this.disarm();
    await this.idle();
  }

  /** Runs all due jobs now. The timer calls this; tests and admin tools may too. */
  runDue(): Promise<void> {
    return this.kick();
  }

  /** Resolves when no run is in progress. */
  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  /** When the armed timer fires (epoch ms), or null when none is armed. */
  get nextWakeAt(): number | null {
    return this.armedFor;
  }

  // ---------------------------------------------------------------- internals

  private kick(): Promise<void> {
    if (this.loop) {
      this.wake = true;
      return this.loop;
    }
    const loop = this.cycle().finally(() => {
      if (this.loop === loop) this.loop = null;
    });
    this.loop = loop;
    return loop;
  }

  private async cycle(): Promise<void> {
    try {
      for (;;) {
        this.wake = false;
        await this.drain();
        if (this.wake && !this.stopped) continue;
        await this.armForNext();
        if (!this.wake || this.stopped) return;
      }
    } catch (err) {
      this.onError(err, null);
      this.arm(this.now() + ERROR_RETRY_MS);
    }
  }

  private async drain(): Promise<void> {
    if (this.kinds.length === 0) return;
    while (!this.stopped) {
      const job = await this.claim();
      if (!job) return;
      await this.run(job);
    }
  }

  /** Atomically takes the most overdue job this process can handle, or returns null. */
  private async claim(): Promise<Job | null> {
    const now = new Date(this.now());
    const due = and(
      inArray(jobs.kind, this.kinds),
      or(
        and(eq(jobs.status, 'pending'), lte(jobs.runAt, now)),
        and(eq(jobs.status, 'running'), lte(jobs.lockedUntil, now)),
      ),
    );
    const next = this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(due)
      .orderBy(asc(jobs.runAt), asc(jobs.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    // A scalar subquery runs once; `id in (... limit 1 skip locked)` can be re-scanned and claim several rows.
    // `due` is repeated outside it so a row another process claimed meanwhile no longer matches.
    const [job] = await this.db
      .update(jobs)
      .set({
        status: 'running',
        lockedUntil: new Date(now.getTime() + this.leaseMs),
        lockedBy: newId(),
        attempts: sql`${jobs.attempts} + 1`,
      })
      .where(and(sql`${jobs.id} = (${next})`, due))
      .returning();
    return job ?? null;
  }

  private async run(job: Job): Promise<void> {
    const ctx: JobContext = {
      id: job.id,
      kind: job.kind,
      attempt: job.attempts,
      runAt: job.runAt,
      dedupeKey: job.dedupeKey,
    };
    // Only this claim may finish the job: not after a cancel, a re-schedule or a takeover.
    const mine = and(eq(jobs.id, job.id), eq(jobs.status, 'running'), eq(jobs.lockedBy, job.lockedBy ?? ''));

    if (job.attempts > this.maxAttempts) {
      // The previous holder's lease ran out on its last attempt (it crashed or hung).
      await this.db
        .update(jobs)
        .set({ status: 'failed', lockedUntil: null, lastError: job.lastError ?? 'lease expired on the last attempt' })
        .where(mine);
      return;
    }

    const handler = this.handlers[job.kind] as unknown as JobHandler;
    try {
      await handler(job.payload ?? null, ctx);
    } catch (err) {
      const lastError = errorText(err);
      const retry = job.attempts < this.maxAttempts;
      await this.db
        .update(jobs)
        .set(
          retry
            ? {
                status: 'pending',
                runAt: new Date(this.now() + this.backoffMs(job.attempts)),
                lastError,
                lockedUntil: null,
                lockedBy: null,
              }
            : { status: 'failed', lastError, lockedUntil: null },
        )
        .where(mine);
      this.onError(err, ctx);
      return;
    }
    await this.db.update(jobs).set({ status: 'done', lockedUntil: null }).where(mine);
  }

  private async armForNext(): Promise<void> {
    if (!this.started || this.kinds.length === 0) return;
    const [pending] = await this.db
      .select({ at: jobs.runAt })
      .from(jobs)
      .where(and(eq(jobs.status, 'pending'), inArray(jobs.kind, this.kinds)))
      .orderBy(asc(jobs.runAt))
      .limit(1);
    const [leased] = await this.db
      .select({ at: jobs.lockedUntil })
      .from(jobs)
      .where(and(eq(jobs.status, 'running'), inArray(jobs.kind, this.kinds)))
      .orderBy(asc(jobs.lockedUntil))
      .limit(1);
    const times = [pending?.at, leased?.at].filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
    this.arm(times.length > 0 ? Math.min(...times) : Infinity);
  }

  /** Keeps a single timer, armed for the soonest time asked for. */
  private arm(at: number): void {
    if (!this.started) return;
    const now = this.now();
    const target = Math.min(at, now + this.maxSleepMs);
    if (this.cancelTimer && this.armedFor !== null && this.armedFor <= target) return;
    this.disarm();
    const delay = Math.max(0, Math.min(target - now, MAX_TIMER_MS));
    this.armedFor = now + delay;
    this.cancelTimer = this.setTimer(() => {
      this.cancelTimer = null;
      this.armedFor = null;
      void this.kick();
    }, delay);
  }

  private disarm(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.armedFor = null;
  }
}

/** One job row, for admin views and tests. */
export async function getJob(db: Db, id: string): Promise<Job | null> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  return job ?? null;
}
