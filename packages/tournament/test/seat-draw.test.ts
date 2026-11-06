import { describe, expect, it } from 'vitest';
import {
  apply,
  createTournament,
  defaultSettings,
  drawCodes,
  drawSeats,
  needsSeatSeed,
  seatRng,
  withSeatSeed,
  type Command,
  type TournamentState,
} from '../src';
import { legacySeatRng } from '../src/seating';

const T0 = Date.parse('2026-11-06T00:00:00Z');
const SEED = 'a1'.repeat(32);

const fresh = (seed = SEED) => createTournament({ id: 'S', hostId: 'host', settings: defaultSettings({ name: 'Draw', seatsPerTable: 6 }), now: T0, seed });

function run(s: TournamentState, ...commands: Command[]): TournamentState {
  for (const c of commands) s = apply(s, c, T0).state;
  return s;
}

const register = (n: number): Command[] => Array.from({ length: n }, (_, i) => ({ type: 'register', playerId: `p${i}`, displayName: `P${i}` }));
const start: Command = { type: 'startNow', by: 'host' };
const seatsOf = (s: TournamentState) => s.tables.map((t) => t.seats);
const waitingIds = (s: TournamentState) => s.entries.filter((e) => e.status === 'registered').map((e) => e.id);

/** A state as a server saved it before 2026-11-06: no seat-draw seed, a mulberry32 state in `rng`. */
function savedBeforeTheChange(s: TournamentState, rng: number): TournamentState {
  const { seatRng: _gone, ...old } = JSON.parse(JSON.stringify(s)) as TournamentState;
  return { ...old, rng };
}

describe('tournament seat draws', () => {
  it('start every new tournament on a 32-byte secret seed, and refuse anything less', () => {
    const s = fresh();
    expect(s.seatRng).toEqual({ seed: SEED, at: 0 });
    expect(s.rng).toBe(0);
    expect(needsSeatSeed(s)).toBe(false);
    for (const bad of [42, 'a1'.repeat(16), 'A1'.repeat(32), '', null]) expect(() => fresh(bad as string)).toThrow(/seed/);
  });

  it('draw from the secure stream, and the same seed gives the same seats', () => {
    const registered = run(fresh(), ...register(14));
    const ids = waitingIds(registered);
    const drawn = run(registered, start);
    expect(seatsOf(drawn)).toEqual(drawSeats(ids, 6, seatRng({ seed: SEED, at: 0 })));
    expect(drawn.seatRng!.at).toBeGreaterThan(0);
    // The same tournament run again draws the same seats; another seed draws others.
    expect(seatsOf(run(fresh(), ...register(14), start))).toEqual(seatsOf(drawn));
    expect(seatsOf(run(fresh('b2'.repeat(32)), ...register(14), start))).not.toEqual(seatsOf(drawn));
  });

  it('carry on from where the stream stopped: codes the director makes come first, then the draw', () => {
    const s = run(fresh(), { type: 'createInvites', by: 'host', count: 3, maxUses: null });
    const codes = s.invites!.map((c) => c.code);
    expect(codes).toEqual(drawCodes(seatRng({ seed: SEED, at: 0 }), 3, new Set()));
    const afterCodes = s.seatRng!.at;
    expect(afterCodes).toBeGreaterThan(0);
    const registered = run(s, ...register(9));
    const drawn = run(registered, start);
    expect(seatsOf(drawn)).toEqual(drawSeats(waitingIds(registered), 6, seatRng({ seed: SEED, at: afterCodes })));
    expect(drawn.seatRng!.at).toBeGreaterThan(afterCodes);
    // Codes passed in (as the server always does) leave the stream where it was.
    const passed = run(fresh(), { type: 'createInvites', by: 'host', count: 1, maxUses: 1, codes: ['ABCD2345'] });
    expect(passed.seatRng).toEqual({ seed: SEED, at: 0 });
  });

  it('keep the seat seed through a save, and draw the same after it', () => {
    const registered = run(fresh(), ...register(8));
    const loaded = JSON.parse(JSON.stringify(registered)) as TournamentState;
    expect(seatsOf(run(loaded, start))).toEqual(seatsOf(run(registered, start)));
  });
});

describe('tournaments saved before seat draws used a 32-byte seed', () => {
  it('still load and draw, exactly as the old generator would have, when nobody gave them a new seed', () => {
    const old = savedBeforeTheChange(run(fresh(), ...register(14)), 12345);
    expect(needsSeatSeed(old)).toBe(true);
    const drawn = run(old, start);
    const holder = { rng: 12345 };
    expect(seatsOf(drawn)).toEqual(drawSeats(waitingIds(old), 6, legacySeatRng(holder)));
    expect(drawn.rng).toBe(holder.rng);
    expect(drawn.seatRng).toBeUndefined();
    expect(drawn.status).toBe('running');
  });

  it('draw from a fresh secure seed once the server gives them one', () => {
    const old = savedBeforeTheChange(run(fresh(), ...register(14)), 12345);
    const seed = 'c3'.repeat(32);
    const upgraded = withSeatSeed(old, seed);
    expect(upgraded.seatRng).toEqual({ seed, at: 0 });
    expect(needsSeatSeed(upgraded)).toBe(false);
    expect(seatsOf(run(upgraded, start))).toEqual(drawSeats(waitingIds(old), 6, seatRng({ seed, at: 0 })));
    expect(() => withSeatSeed(old, 'nope')).toThrow(/seed/);
  });

  it('need no new seed once their seats are drawn: nothing later is random', () => {
    const running = savedBeforeTheChange(run(fresh(), ...register(14), start), 99);
    expect(running.status).not.toBe('registering');
    expect(needsSeatSeed(running)).toBe(false);
    // Late registration and play carry on without one.
    const later = run(running, { type: 'register', playerId: 'late', displayName: 'Late' });
    expect(later.entries.find((e) => e.playerId === 'late')!.status).toBe('seated');
    expect(later.rng).toBe(99);
  });
});
