import { describe, expect, it } from 'vitest';
import { apply, createTournament, defaultSettings, logEvent, namesIn, type DirectorEvent, type TournamentState } from '../src';

const T0 = Date.parse('2026-10-30T00:00:00Z');

describe('the public lobby log', () => {
  it('names players instead of showing their ids, including one who just unregistered', () => {
    let s: TournamentState = createTournament({ id: 'L', hostId: 'host', settings: defaultSettings(), now: T0, seed: 1 });
    s = apply(s, { type: 'register', playerId: 'p1', displayName: 'Ana' }, T0).state;
    const before = s;
    const r = apply(s, { type: 'unregister', playerId: 'p1' }, T0);
    const out = r.events.map((e) => logEvent(e, namesIn(r.state, before)));
    expect(out).toEqual([{ type: 'unregistered', name: 'Ana' }]);
  });

  it('leaves out requests and seat moves', () => {
    const name = () => 'X';
    const request = { id: 'r', kind: 'register', playerId: 'p', displayName: 'P', at: 0 } as const;
    const quiet: DirectorEvent[] = [
      { type: 'requestPending', request },
      { type: 'requestRejected', request },
      { type: 'moveSeat', entryId: 'e', playerId: 'p', from: { tableId: 't1', seat: 0 }, to: { tableId: 't2', seat: 1 }, stack: 5 },
      { type: 'scheduleNext', startAt: 0 },
    ];
    expect(quiet.map((e) => logEvent(e, name))).toEqual([null, null, null, null]);
    expect(logEvent({ type: 'eliminated', entryId: 'e', playerId: 'p', place: 3, by: ['q'], tableId: null, seat: null, reason: 'busted' }, (id) => (id === 'p' ? 'Ana' : 'Bo'))).toEqual({
      type: 'eliminated',
      name: 'Ana',
      place: 3,
      by: ['Bo'],
      reason: 'busted',
    });
  });
});
