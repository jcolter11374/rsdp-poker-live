import os from 'node:os';
import { parentPort, workerData } from 'node:worker_threads';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { workTip } from './coach';
import type { FromThread, ToThread } from './coachWorker';
import { coachTuning } from './strategy';

/**
 * The coach's own thread, started by coachWorker.ts (through coachThread.mjs).
 * It works out one tip at a time from the job it is sent and answers with the
 * tip and how long it took. It keeps nothing from one tip to the next.
 */

/** How far this thread stands back for the one running the tables (0 is the same, 19 is furthest). */
const NICE = 10;

const port = parentPort;
if (!port) throw new Error('coachThread runs only as the coach’s worker thread');
const send = (m: FromThread) => port.postMessage(m);

registerAllVariants(variants);
Object.assign(coachTuning, (workerData as { tuning?: Partial<typeof coachTuning> } | null)?.tuning ?? {});
// Linux keeps a priority for each thread, so on the live server this thread gives way to the tables whenever both have
// work. On macOS it would apply to the whole server, so a laptop leaves it alone.
if (process.platform === 'linux') {
  try {
    os.setPriority(NICE);
  } catch {
    // Not allowed here: tips still work, at the same priority as the tables.
  }
}

port.on('message', ({ id, job }: ToThread) => {
  const started = performance.now();
  try {
    send({ id, tip: workTip(job), ms: performance.now() - started });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    send({ id, error: { message: e.message, stack: e.stack } });
  }
});
send({ ready: true });
