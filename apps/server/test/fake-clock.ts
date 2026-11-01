import type { Clock } from '../src/runtime/types';

/** A clock tests move by hand; timers fire in time order as it advances. */
export class FakeClock implements Clock {
  t = 1_000_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers.delete(id as number);
  };
  advance(ms: number) {
    const end = this.t + ms;
    // A timer that keeps re-arming itself for a time already past would spin a real server.
    let fired = 0;
    for (;;) {
      if (++fired > 10_000) throw new Error(`timers keep firing at ${this.t}`);
      const due = [...this.timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
    }
    this.t = end;
  }
}

/**
 * Seeded RNG so deals are repeatable: mulberry32, a whole 0..n-1 from the top
 * bits. (The old `a * 1103515245` lost its low bits past 2^53, so it came round
 * every 10,466 draws and an even n always gave an even number.)
 */
export function seeded(seed = 7) {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}
