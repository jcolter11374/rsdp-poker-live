import { describe, expect, it } from 'vitest';
import type { TournamentListing } from '@rsdp/tournament';
import { eventOnPage, ON_SCREEN_FOR_MS, onScreenNow, START_LEAD_MS, startAlertsDue, startKey } from './startAlerts';

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

  it('waits while its lobby or one of its tables is on screen in some tab, and still comes once the player looks away', () => {
    const t = listing();
    expect(startAlertsDue([t], NOW, new Set(), new Set(['x']))).toHaveLength(0);
    expect(startAlertsDue([t], NOW, new Set(), new Set(['other']))).toHaveLength(1);
    expect(startAlertsDue([t], NOW + 15_000, new Set(), new Set())).toHaveLength(1);
    // Which event a page shows: its lobby, or a table of it (the lobby moves the player there at the seat draw).
    const of = (table: string) => (table.startsWith('x-') ? 'x' : null);
    expect(eventOnPage('/tn/x', of)).toBe('x');
    expect(eventOnPage('/t/x-t1', of)).toBe('x');
    expect(eventOnPage('/t/cash1', of)).toBeNull();
    expect(eventOnPage('/tn/new', of)).toBeNull();
    expect(eventOnPage('/', of)).toBeNull();
    // Another tab's note counts for two checks, then lapses once that tab is no longer showing it. A tab's own notes
    // don't count for it: it knows whether it's on screen.
    expect([...onScreenNow({ 'a|x': NOW - 20_000, 'a|y': NOW - ON_SCREEN_FOR_MS, 'me|z': NOW }, NOW, 'me')]).toEqual(['x']);
  });
});
