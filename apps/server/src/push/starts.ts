// "Starting soon" phone alerts: five minutes before a scheduled tournament
// deals, each player still in it is told once. A timer per event waits for
// that moment; anyone who registers inside the five minutes is told when they
// do. Who was told is kept in memory only, so a restart in those five minutes
// can tell someone twice.

import type { PlayerId } from '@rsdp/engine/core';
import { aliveEntries, isArchived, type TournamentState } from '@rsdp/tournament';
import type { Clock } from '../runtime/types';

/** As long before the start as the page's own alert (apps/web/src/tournament/startAlerts.ts). */
export const START_LEAD_MS = 5 * 60_000;
/** Long waits are taken in steps, so a start weeks away never overflows a timer. */
const MAX_WAIT_MS = 60 * 60_000;

export class StartAlerts {
  private readonly timers = new Map<string, { at: number; handle: unknown }>();
  /** `start:<id>:<startAt>` → when it starts and who has been told. */
  private readonly told = new Map<string, { startAt: number; players: Set<PlayerId> }>();

  constructor(
    private readonly deps: {
      clock: Clock;
      /** The event as it is now, or null when it isn't held. */
      state: (id: string) => TournamentState | null;
      send: (playerId: PlayerId, state: TournamentState, startAt: number, now: number) => void;
    },
  ) {}

  /** Looks at an event after it changed (or after a restart): waits for its moment, or tells anyone due now. */
  check(id: string) {
    const now = this.deps.clock.now();
    for (const [key, t] of this.told) if (t.startAt <= now) this.told.delete(key);
    const s = this.deps.state(id);
    const startAt = s && !isArchived(s) && (s.status === 'registering' || s.status === 'seating') ? s.startAt : null;
    if (!s || startAt === null || startAt <= now) return this.disarm(id);
    const due = startAt - START_LEAD_MS;
    if (now < due) return this.arm(id, Math.min(due, now + MAX_WAIT_MS));
    this.disarm(id);
    const key = `start:${id}:${startAt}`;
    const told = this.told.get(key) ?? { startAt, players: new Set<PlayerId>() };
    this.told.set(key, told);
    for (const e of aliveEntries(s)) {
      if (told.players.has(e.playerId)) continue;
      told.players.add(e.playerId);
      this.deps.send(e.playerId, s, startAt, now);
    }
  }

  dispose() {
    for (const t of this.timers.values()) this.deps.clock.clearTimeout(t.handle);
    this.timers.clear();
  }

  private arm(id: string, at: number) {
    if (this.timers.get(id)?.at === at) return;
    this.disarm(id);
    const handle = this.deps.clock.setTimeout(() => {
      this.timers.delete(id);
      this.check(id);
    }, at - this.deps.clock.now());
    this.timers.set(id, { at, handle });
  }

  private disarm(id: string) {
    const t = this.timers.get(id);
    if (!t) return;
    this.deps.clock.clearTimeout(t.handle);
    this.timers.delete(id);
  }
}
