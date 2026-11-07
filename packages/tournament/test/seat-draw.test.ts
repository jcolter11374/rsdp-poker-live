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
import { legacySeatRng, nextRandom } from '../src/seating';

const T0 = Date.parse('2026-11-06T00:00:00Z');
const SEED = 'a1'.repeat(32);
const LEGACY = 0x9e3779b9;

const fresh = (seed = SEED, legacyRng = LEGACY) =>
  createTournament({ id: 'S', hostId: 'host', settings: defaultSettings({ name: 'Draw', seatsPerTable: 6 }), now: T0, seed, legacyRng });

function run(s: TournamentState, ...commands: Command[]): TournamentState {
  for (const c of commands) s = apply(s, c, T0).state;
  return s;
}

const register = (n: number): Command[] => Array.from({ length: n }, (_, i) => ({ type: 'register', playerId: `p${i}`, displayName: `P${i}` }));
const start: Command = { type: 'startNow', by: 'host' };
const seatsOf = (s: TournamentState) => s.tables.map((t) => t.seats);
const waitingIds = (s: TournamentState) => s.entries.filter((e) => e.status === 'registered').map((e) => e.id);

/** A state as a server saved it before rsdp-seats-v1: no seat-draw seed, a mulberry32 state in `rng`. */
function savedBeforeTheChange(s: TournamentState, rng: number): TournamentState {
  const { seatRng: _gone, ...old } = JSON.parse(JSON.stringify(s)) as TournamentState;
  return { ...old, rng };
}

describe('tournament seat draws', () => {
  it('start every new tournament on a 32-byte secret seed and a separate secret old-generator state, and refuse anything less', () => {
    const s = fresh();
    expect(s.seatRng).toEqual({ seed: SEED, at: 0 });
    // The old generator's state is the secret it was given, never the 0 browsers are sent (see the rollback tests below).
    expect(s.rng).toBe(LEGACY);
    for (const bad of [42, 'a1'.repeat(16), 'A1'.repeat(32), '', null]) expect(() => fresh(bad as string)).toThrow(/seed/);
    for (const bad of [0, -1, 1.5, 2 ** 32, NaN, '7', null]) expect(() => fresh(SEED, bad as number)).toThrow(/old-generator/);
    const settings = defaultSettings({ name: 'Draw' });
    expect(() => createTournament({ id: 'S', hostId: 'host', settings, now: T0, seed: SEED } as Parameters<typeof createTournament>[0])).toThrow(/old-generator/);
    expect(fresh(SEED, 1).rng).toBe(1);
    expect(fresh(SEED, 2 ** 32 - 1).rng).toBe(2 ** 32 - 1);
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

  it('leave a server rolled back to before rsdp-seats-v1 a secret to draw from that its viewers are never sent', () => {
    // That server ignores seatRng and draws with mulberry32 from `rng` alone, from the registered entries, which every
    // viewer is sent. It sends viewers every field but `rng` (as 0), `seatRng` included. So `rng` must be secret and
    // tell nothing that the seed does: with the same seed, it and the old draw follow only the separate secret.
    const oldDraw = (s: TournamentState) => {
      let state = s.rng;
      const rng = (n: number) => {
        const [r, next] = nextRandom(state);
        state = next;
        return Math.floor(r * n);
      };
      return drawSeats(waitingIds(s), 6, rng);
    };
    const a = run(fresh(), ...register(14));
    const b = run(fresh(SEED, 12345), ...register(14));
    expect(waitingIds(a)).toEqual(waitingIds(b));
    // Everything that server shows a viewer is the same for both...
    const shown = (s: TournamentState) => JSON.stringify({ ...s, rng: 0 });
    expect(shown(a)).toBe(shown(b));
    // ...yet it would draw different seats, and neither is the draw from the public 0.
    expect(a.rng).not.toBe(b.rng);
    expect(oldDraw(a)).not.toEqual(oldDraw(b));
    expect(oldDraw(a)).not.toEqual(oldDraw({ ...a, rng: 0 }));
    // And a different seed with the same secret leaves that server's draw as it was.
    expect(oldDraw(run(fresh('b2'.repeat(32)), ...register(14)))).toEqual(oldDraw(a));
    // The new code itself never reads it while the state has a seed.
    expect(seatsOf(run({ ...a, rng: 0 }, start))).toEqual(seatsOf(run(a, start)));
  });

  it('keep the seat seed through a save, and draw the same after it', () => {
    const registered = run(fresh(), ...register(8));
    const loaded = JSON.parse(JSON.stringify(registered)) as TournamentState;
    expect(seatsOf(run(loaded, start))).toEqual(seatsOf(run(registered, start)));
  });
});

describe('a fresh seed each time the server loads a tournament whose seats are still to draw', () => {
  it('replaces the seed and the old-generator state while seats are still to draw, and draws from the new ones', () => {
    const registered = run(fresh(), ...register(14));
    expect(needsSeatSeed(registered)).toBe(true);
    const seed = 'd4'.repeat(32);
    const reloaded = withSeatSeed(registered, seed, 4242);
    expect(reloaded.seatRng).toEqual({ seed, at: 0 });
    expect(reloaded.rng).toBe(4242);
    expect(seatsOf(run(reloaded, start))).toEqual(drawSeats(waitingIds(registered), 6, seatRng({ seed, at: 0 })));
    // A seed a rolled-back server showed is not the one drawn from after the reload.
    expect(seatsOf(run(reloaded, start))).not.toEqual(seatsOf(run(registered, start)));
    expect(() => withSeatSeed(registered, seed, 0)).toThrow(/old-generator/);
  });

  it('keeps the seed and its place once the seats are drawn, so the same moves follow from the same saved state', () => {
    const drawn = run(fresh(), ...register(14), start);
    expect(drawn.tables.length).toBeGreaterThan(0);
    expect(needsSeatSeed(drawn)).toBe(false);
    // Seats drawn early for a scheduled start: still registering, but no longer to draw.
    const early = { ...drawn, status: 'registering' as const };
    expect(needsSeatSeed(early)).toBe(false);
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
    const upgraded = withSeatSeed(old, seed, 777);
    expect(upgraded.seatRng).toEqual({ seed, at: 0 });
    expect(upgraded.rng).toBe(777);
    expect(seatsOf(run(upgraded, start))).toEqual(drawSeats(waitingIds(old), 6, seatRng({ seed, at: 0 })));
    expect(() => withSeatSeed(old, 'nope', 777)).toThrow(/seed/);
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
