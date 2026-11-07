import { Worker } from 'node:worker_threads';
import { ActionError } from '@rsdp/engine/core';
import type { CoachTip } from '@rsdp/engine/wire';
import { workTip, type TipJob } from './coach';
import type { coachTuning } from './strategy';

/**
 * Coach tips are worked out on a thread of their own (Node's worker_threads),
 * never on the event loop that runs every table, so a burst of tips can't hold
 * up anyone's turn. One thread is enough for a server with one CPU, and a few
 * tips may wait in line for it. A full line, or a tip that has waited too long,
 * is told the coach is busy. A tip that runs too long, or a thread that fails,
 * stops that thread: its tip is told the coach is busy too, and a fresh thread
 * starts. Only a TipJob crosses to the thread: the hand as the one player sees
 * it, and a few numbers.
 */

/** What the player is told whenever the coach can't answer now. */
export const COACH_BUSY = 'the coach is busy, try again in a moment';

/** Works out coach tips. */
export interface TipWorker {
  work(job: TipJob): Promise<CoachTip>;
}

/** Works a tip out on the caller's own thread: for tests of one table, where there is nothing else to hold up. */
export const inThreadTips: TipWorker = { work: async (job) => workTip(job) };

export interface CoachWorkerOptions {
  /** Threads working out tips at once. */
  threads?: number;
  /** Tips that may wait for a thread; one more is told the coach is busy. */
  queue?: number;
  /** A tip still waiting for a thread after this long is told the coach is busy. */
  waitMs?: number;
  /** A tip still being worked out after this long stops its thread. */
  runMs?: number;
  /** A thread that hasn't started after this long is stopped. */
  startMs?: number;
  /** A tip slower than this is logged, once, since it means the server is struggling. */
  slowMs?: number;
  /** Changes to coachTuning on the thread (tests turn the deals down, as they do on the main thread). */
  tuning?: Partial<typeof coachTuning>;
  /** The script the thread runs (tests swap in one that fails). */
  entry?: URL;
  log?: (message: string, err?: unknown) => void;
}

/** What the thread is sent: one tip to work out. */
export interface ToThread {
  id: number;
  job: TipJob;
}

/** What the thread sends back: that it has started, a tip and how long it took, or why a tip failed. */
export type FromThread = { ready: true } | { id: number; tip: CoachTip; ms: number } | { id: number; error: { message: string; stack?: string } };

/** The plain JavaScript a thread starts from: it loads TypeScript itself (see the file). */
const ENTRY = new URL('./coachThread.mjs', import.meta.url);
/** The most memory a thread may use; past it the thread fails and a fresh one starts. A tip needs a few megabytes. */
const HEAP_MB = 128;

interface Waiting {
  id: number;
  job: TipJob;
  resolve: (tip: CoachTip) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface Thread {
  worker: Worker;
  /** It has loaded and can take a tip. */
  ready: boolean;
  /** The tip it is working out now. */
  job: Waiting | null;
  /** Stops it if it doesn't start, or doesn't finish its tip, in time. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * The coach's threads, started when the first tip is asked for. Idle threads
 * never keep the process running; close() stops them, and tells any tip still
 * waiting that the coach is busy.
 */
export function coachWorker(opts: CoachWorkerOptions = {}): TipWorker & { close(): Promise<void> } {
  const { threads = 1, queue = 8, waitMs = 4_000, runMs = 3_000, startMs = 30_000, slowMs = 1_000, tuning = {}, entry = ENTRY, log = () => {} } = opts;
  const line: Waiting[] = [];
  const live: Thread[] = [];
  let ids = 0;
  let closed = false;
  let slowLogged = false;
  const busy = () => new ActionError(COACH_BUSY);

  function start() {
    const worker = new Worker(entry, {
      // The thread loads tsx itself, the same way however the server was started (tsx, tsx watch or vitest).
      execArgv: [],
      workerData: { tuning },
      resourceLimits: { maxOldGenerationSizeMb: HEAP_MB },
    });
    worker.unref();
    const t: Thread = { worker, ready: false, job: null };
    t.timer = setTimeout(() => lose(t, `the coach's thread did not start within ${startMs} ms`), startMs);
    t.timer.unref();
    worker.on('message', (m: FromThread) => answer(t, m));
    worker.on('error', (err) => lose(t, "the coach's thread failed", err));
    worker.on('exit', (code) => lose(t, `the coach's thread stopped (exit code ${code})`));
    live.push(t);
  }

  function answer(t: Thread, m: FromThread) {
    if (!live.includes(t)) return;
    if ('ready' in m) {
      t.ready = true;
      clearTimeout(t.timer);
      return next();
    }
    const w = t.job;
    if (!w || w.id !== m.id) return;
    clearTimeout(t.timer);
    t.job = null;
    if ('tip' in m) {
      if (m.ms > slowMs && !slowLogged) {
        slowLogged = true;
        log(`a coach tip took ${Math.round(m.ms)} ms`);
      }
      w.resolve(m.tip);
    } else {
      // A tip that throws is a bug, the same wherever it runs: it fails as it did before tips had a thread.
      const err = new Error(m.error.message);
      if (m.error.stack) err.stack = m.error.stack;
      w.reject(err);
    }
    next();
  }

  /** A thread that failed, hung or would not start: it is stopped, its tip is told the coach is busy, and a fresh thread takes over. */
  function lose(t: Thread, why: string, err?: unknown) {
    const at = live.indexOf(t);
    if (at < 0) return;
    live.splice(at, 1);
    clearTimeout(t.timer);
    void t.worker.terminate();
    const job = t.job;
    t.job = null;
    job?.reject(busy());
    if (t.ready && job) {
      // It failed on a tip, so a fresh one starts now and the next tip needn't wait for it to load.
      log(`${why}; a fresh thread is starting`, err);
      start();
      next();
      return;
    }
    // It never started (or failed with nothing to do), so it isn't started over and over: unless another thread is
    // working, everyone waiting is told, and the next tip asked for starts a fresh one.
    log(`${why}; the next tip starts a fresh thread`, err);
    if (live.some((x) => x.ready)) return;
    for (const w of line.splice(0)) {
      clearTimeout(w.timer);
      w.reject(busy());
    }
  }

  /** Hands waiting tips to free threads, starting one if there is room for it. */
  function next() {
    while (!closed && line.length) {
      const t = live.find((x) => x.ready && !x.job);
      if (!t) {
        if (live.length < threads) start();
        return;
      }
      const w = line.shift()!;
      clearTimeout(w.timer);
      t.job = w;
      // This timer, like each waiting tip's, keeps the process running until the tip is answered.
      t.timer = setTimeout(() => lose(t, `a coach tip ran past ${runMs} ms`), runMs);
      try {
        t.worker.postMessage({ id: w.id, job: w.job } satisfies ToThread);
      } catch (err) {
        // Something in the job can't be copied to the thread, which is a bug; the thread itself is fine.
        clearTimeout(t.timer);
        t.job = null;
        w.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  return {
    work(job) {
      if (closed) return Promise.reject(busy());
      if (!live.some((t) => t.ready && !t.job) && line.length >= queue) return Promise.reject(busy());
      return new Promise<CoachTip>((resolve, reject) => {
        const w: Waiting = { id: ++ids, job, resolve, reject };
        w.timer = setTimeout(() => {
          const at = line.indexOf(w);
          if (at < 0) return;
          line.splice(at, 1);
          reject(busy());
        }, waitMs);
        line.push(w);
        next();
      });
    },
    async close() {
      closed = true;
      for (const w of line.splice(0)) {
        clearTimeout(w.timer);
        w.reject(busy());
      }
      const all = live.splice(0);
      for (const t of all) {
        clearTimeout(t.timer);
        t.job?.reject(busy());
        t.job = null;
      }
      await Promise.all(all.map((t) => t.worker.terminate()));
    },
  };
}
