import { describe, expect, it } from 'vitest';
import type { TournamentListing } from '@rsdp/tournament';
import { START_LEAD_MS, startAlertsDue, startKey } from './startAlerts';

const NOW = 1_000_000_000;
const MIN = 60_000;
const listing = (over: Partial<TournamentListing> & { alive?: boolean } = {}): TournamentListing => ({
  id: 'x',
  name: 'Friday',
  status: 'registering',
  start: 'scheduled',
  startAt: NOW + 3 * MIN,
  finishedAt: null,
  games: ['nlhe'],
  startingStack: 1000,
  entrants: 4,
  maxEntrants: 600,
  playersLeft: 4,
  playersNeeded: null,
  levelNumber: null,
  winner: null,
  nextId: null,
  me: { hosting: false, registered: true, alive: over.alive ?? true, place: null },
  ...over,
});

describe('starting soon alerts', () => {
  it('fires within the lead time for events the player is in', () => {
    expect(startAlertsDue([listing()], NOW, new Set())).toHaveLength(1);
    expect(startAlertsDue([listing({ startAt: NOW + START_LEAD_MS + 1 })], NOW, new Set())).toHaveLength(0);
    expect(startAlertsDue([listing({ alive: false })], NOW, new Set())).toHaveLength(0);
    expect(startAlertsDue([listing({ startAt: NOW - 1 })], NOW, new Set())).toHaveLength(0);
    expect(startAlertsDue([listing({ status: 'running' })], NOW, new Set())).toHaveLength(0);
  });

  it('fires once per start time', () => {
    const t = listing();
    expect(startAlertsDue([t], NOW, new Set([startKey(t)]))).toHaveLength(0);
    const moved = listing({ startAt: NOW + 4 * MIN });
    expect(startAlertsDue([moved], NOW, new Set([startKey(t)]))).toHaveLength(1);
  });
});
