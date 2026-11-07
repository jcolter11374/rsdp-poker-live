import type { DelayedPart } from './view';

/** One moment of a table as spectators on a delay will see it. */
export interface Moment {
  /** When it was the table (server time): the snapshot's serverNow. */
  at: number;
  /** When spectators may see it. */
  showAt: number;
  /** The table's delay when it was taken: the delay of the hand it shows. */
  delayMs: number;
  part: DelayedPart;
  /** The same moment without the hole cards spectators seeing every card were shown, for when the host turns that off. */
  plain?: DelayedPart;
  /** The table's latest hand then, and how many events it had: cards shown after it ends add more (#435). */
  lastHand?: { handNumber: number; events: number };
}

/**
 * Spectators on a delay (#432, #435): what a table looked like to them, oldest first, and when each moment may be
 * shown. A moment is shown once it is old enough under the delay it was taken under, and never before the one before
 * it. A change to the delay applies at the live deal, so with this spectators stay on the old delay until their view
 * reaches the first hand dealt under the new one: a longer delay holds the view on the gap between hands for the
 * difference, a shorter one skips ahead within the new hand, and the end of the hand before is never hidden, skipped
 * or shown early. Turned off, the delay runs out the same way before spectators see the table live.
 */
export class SpectatorFeed {
  private moments: Moment[] = [];
  /** The latest time the feed has been asked to show: it never goes back from there (a timer can fire early). */
  private through = -Infinity;

  /**
   * When a moment taken at `at`, under a delay of `delayMs`, may be shown: once it is that old, never before the moment
   * before it, and the first one under a shorter delay only once it is as old as the delay before: the view reaches
   * the first hand dealt under the new delay (or the moment the host changed it between hands) on the old one,
   * showing the end of the hand before and the gap after it in full, and only then skips ahead.
   */
  showAtFor(at: number, delayMs: number): number {
    const last = this.moments.at(-1);
    if (!last) return at + Math.max(0, delayMs);
    return Math.max(at + Math.max(0, delayMs, last.delayMs), last.showAt);
  }

  add(at: number, delayMs: number, part: DelayedPart, plain?: DelayedPart, lastHand?: Moment['lastHand']): Moment {
    const moment: Moment = { at, showAt: this.showAtFor(at, delayMs), delayMs, part, ...(plain ? { plain } : {}), ...(lastHand ? { lastHand } : {}) };
    this.moments.push(moment);
    return moment;
  }

  /**
   * The newest moment spectators may see at `now`, or null when none is old enough yet. Unless `keep`, the moments
   * before it are dropped: nobody is shown them again.
   */
  shown(now: number, keep = false): Moment | null {
    // A view sent for a moment that came due must not be followed by an older one, whatever time the next ask has.
    this.through = Math.max(this.through, now);
    now = this.through;
    let i = -1;
    while (i + 1 < this.moments.length && this.moments[i + 1].showAt <= now) i++;
    if (i > 0 && !keep) this.moments.splice(0, i);
    return i < 0 ? null : this.moments[keep ? i : 0];
  }

  /** The oldest moment kept: the one shown, or while none is old enough, the one shown next. */
  oldest(): Moment | null {
    return this.moments[0] ?? null;
  }

  /** Every moment taken has been shown by `now`. */
  caughtUp(now: number): boolean {
    const last = this.moments.at(-1);
    return !last || last.showAt <= Math.max(now, this.through);
  }

  /**
   * The host stopped spectators seeing every card: the moments still to come play on without the cards (it works at
   * once, even in the middle of a hand, and the view neither jumps nor stops).
   */
  hideCards() {
    // Every moment that showed cards has its twin without them; one that somehow doesn't is never played out.
    this.moments = this.moments.filter((m) => m.plain || !m.part.spectator?.seeAll);
    for (const m of this.moments) {
      if (!m.plain) continue;
      m.part = m.plain;
      delete m.plain;
    }
  }

  get size() {
    return this.moments.length;
  }
}
