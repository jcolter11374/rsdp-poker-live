import { describe, expect, it } from 'vitest';
import { apply, createTournament, defaultSettings, listedPublicly, sortListings, tournamentListing, type TournamentState } from '../src';

const MIN = 60_000;
const T0 = Date.parse('2026-10-30T00:00:00Z');

const make = (id: string, overrides: Parameters<typeof defaultSettings>[0] = {}) =>
  createTournament({ id, hostId: 'host', settings: defaultSettings({ name: id, ...overrides }), now: T0, seed: 1 });
const register = (s: TournamentState, ...ids: string[]) =>
  ids.reduce((st, p) => apply(st, { type: 'register', playerId: p, displayName: p.toUpperCase() }, T0).state, s);

describe('tournament listings', () => {
  it('says where the viewer stands', () => {
    const s = register(make('A', { start: { kind: 'scheduled', startAt: T0 + 30 * MIN } }), 'p1', 'p2');
    expect(tournamentListing(s, 'host', T0).me).toEqual({ hosting: true, registered: false, alive: false, place: null });
    expect(tournamentListing(s, 'p1', T0).me).toEqual({ hosting: false, registered: true, alive: true, place: null });
    expect(tournamentListing(s, null, T0).me.registered).toBe(false);
    const l = tournamentListing(s, 'p1', T0);
    expect(l).toMatchObject({ id: 'A', status: 'registering', start: 'scheduled', startAt: T0 + 30 * MIN, entrants: 2, levelNumber: null, winner: null });
  });

  it('counts a registration waiting for approval as registered', () => {
    const s = register(make('B', { registrationApproval: true }), 'p1');
    expect(tournamentListing(s, 'p1', T0).me).toMatchObject({ registered: true, alive: false });
  });

  it('shows the level and the winner', () => {
    let s = register(make('C', { lateRegistration: { enabled: false, throughLevel: null } }), 'p1', 'p2');
    s = apply(s, { type: 'startNow', by: 'host' }, T0).state;
    expect(tournamentListing(s, 'p1', T0 + 1000)).toMatchObject({ status: 'running', levelNumber: 1, playersLeft: 2 });
    s = apply(s, { type: 'pause', by: 'host' }, T0 + 2000).state;
    s = apply(s, { type: 'end', by: 'host' }, T0 + 3000).state;
    const done = tournamentListing(s, 'p2', T0 + 4000);
    expect(done.status).toBe('finished');
    expect(done.levelNumber).toBeNull();
    expect(done.winner).not.toBeNull();
    expect(done.me.place).not.toBeNull();
  });

  it('lists live events publicly, but not archived or invite-only ones', () => {
    const s = make('D');
    expect(listedPublicly(s)).toBe(true);
    expect(listedPublicly({ ...s, archivedAt: T0 } as TournamentState)).toBe(false);
    expect(listedPublicly({ ...s, settings: { ...s.settings, invites: { required: true } } } as TournamentState)).toBe(false);
    expect(listedPublicly({ ...s, status: 'finished' })).toBe(false);
  });

  it('puts running events first, then the soonest start, then finished ones newest first', () => {
    const at = (id: string, status: TournamentState['status'], startAt: number | null, finishedAt: number | null = null) =>
      ({ ...tournamentListing(make(id), null, T0), status, startAt, finishedAt });
    const sorted = sortListings([
      at('old', 'finished', T0 - 100 * MIN, T0 - 50 * MIN),
      at('manual', 'registering', null),
      at('later', 'registering', T0 + 60 * MIN),
      at('new', 'finished', T0 - 20 * MIN, T0 - 5 * MIN),
      at('soon', 'registering', T0 + 5 * MIN),
      at('live', 'running', T0 - 10 * MIN),
      at('drawn', 'seating', T0 + MIN),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(['live', 'drawn', 'soon', 'later', 'manual', 'new', 'old']);
  });
});
