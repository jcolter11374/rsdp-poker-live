import type { HandEvent } from './types';

/**
 * All-in runouts: the engine deals the rest of the board at once, and tables
 * show it a street at a time (the turn, a pause, the river; the first run
 * before the second). The server holds the next hand for as long as that takes.
 */
export const RUNOUT_STEP_MS = 1300;
/** A beat after the last card before the result shows. */
export const RUNOUT_SETTLE_MS = 700;

type BoardEvent = Extract<HandEvent, { t: 'board' }>;

/**
 * The board cards dealt after the hand went all in, one group per street
 * shown together: every board of a run gets its turn at once, and a second
 * run starts after the first has finished. Empty when there was no runout.
 */
export function runoutSteps(events: readonly HandEvent[]): BoardEvent[][] {
  const start = events.findIndex((e) => e.t === 'run-it');
  if (start < 0) return [];
  const steps: BoardEvent[][] = [];
  let last: BoardEvent | null = null;
  const after = events.slice(start + 1);
  // Stud deals each street to the seats (hold'em and Omaha deal to seats only before the first street),
  // and its runouts aren't paced, even when a short deck makes the last card a shared one.
  const firstStreet = events.findIndex((e) => e.t === 'street');
  if (firstStreet >= 0 && events.slice(firstStreet).some((e) => e.t === 'deal')) return [];
  for (const e of after) {
    if (e.t !== 'board') continue;
    // The engine deals run by run, street by street, board by board: a new street starts
    // when the run changes or the board index goes back to the first.
    if (!last || e.run !== last.run || e.board <= last.board) steps.push([]);
    steps[steps.length - 1].push(e);
    last = e;
  }
  return steps;
}

/** How long a table takes to show this hand's runout, or 0 with none. */
export function runoutMs(events: readonly HandEvent[]): number {
  const n = runoutSteps(events).length;
  return n ? n * RUNOUT_STEP_MS + RUNOUT_SETTLE_MS : 0;
}
