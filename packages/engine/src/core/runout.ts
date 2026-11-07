import type { HandEvent } from './types';

/**
 * All-in runouts: the engine deals the rest of the hand at once, and tables
 * show it a street at a time (the turn, a pause, the river; the first run
 * before the second; in stud each street's cards for every seat together).
 * The server holds the next hand for as long as that takes.
 */
export const RUNOUT_STEP_MS = 2000;
/**
 * The last card of a single run waits longer than the streets before it, so
 * the table has a moment of build-up before the river (issue #308).
 */
export const RUNOUT_LAST_STEP_MS = 3000;
/**
 * Run it twice deals slower, about as PokerNow does (some 4 s a street), so
 * each card of both runs has its moment: a turn all-in is otherwise two
 * quick rivers.
 */
export const RUN_TWICE_STEP_MS = 3500;
/** A beat after the last card before the result shows, long enough to read the board first. */
export const RUNOUT_SETTLE_MS = 1200;

type BoardEvent = Extract<HandEvent, { t: 'board' }>;
type DealEvent = Extract<HandEvent, { t: 'deal' }>;
/** Cards dealt in a runout: to a board, or (stud) to a seat. */
export type RunoutEvent = BoardEvent | DealEvent;

/**
 * The cards dealt after the hand went all in, one group per street shown
 * together. Hold'em and Omaha: every board of a run gets its turn at once,
 * and a second run starts after the first has finished. Stud (issue #216):
 * each street's cards for every seat still in, or the one shared card a short
 * deck puts in the middle instead. Empty when there was no runout.
 */
export function runoutSteps(events: readonly HandEvent[]): RunoutEvent[][] {
  const start = events.findIndex((e) => e.t === 'run-it');
  if (start < 0) return [];
  const after = events.slice(start + 1);
  // Stud runs out street by street, each street's deal closed by its street event. Stud never runs it twice,
  // and hold'em and Omaha runouts deal boards only, with no street events.
  if (after.some((e) => e.t === 'street')) {
    const steps: RunoutEvent[][] = [];
    let step: RunoutEvent[] = [];
    for (const e of after) {
      if (e.t === 'deal' || e.t === 'board') step.push(e);
      else if (e.t === 'street' && step.length) {
        steps.push(step);
        step = [];
      }
    }
    return step.length ? [...steps, step] : steps;
  }
  const steps: RunoutEvent[][] = [];
  let last: BoardEvent | null = null;
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

/**
 * The pause before each step of this hand's runout (one per runoutSteps entry).
 * Run it twice deals every street at its slower pace; a single run waits
 * longer before its last card.
 */
export function runoutWaits(events: readonly HandEvent[]): number[] {
  const n = runoutSteps(events).length;
  if (events.some((e) => e.t === 'run-it' && e.times === 2)) return Array(n).fill(RUN_TWICE_STEP_MS);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? RUNOUT_LAST_STEP_MS : RUNOUT_STEP_MS));
}

/** How long a table takes to show this hand's runout, or 0 with none. */
export function runoutMs(events: readonly HandEvent[]): number {
  const waits = runoutWaits(events);
  return waits.length ? waits.reduce((a, b) => a + b, 0) + RUNOUT_SETTLE_MS : 0;
}
