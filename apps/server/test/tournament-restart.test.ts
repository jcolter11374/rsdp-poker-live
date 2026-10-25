import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings, standings, tableAddress, type TournamentSettings, type TournamentState } from '@rsdp/tournament';
import { createApp, memoryStore } from '../src/app';
import type { TableRuntime } from '../src/runtime/table';
import { memoryTournamentStore } from '../src/tournament/store';
import { FakeClock, seeded } from './fake-clock';
import { chipsInPlay, players, playUntil, registerAll, seatsAgree, setup, type Env } from './tournament-helpers';

beforeAll(() => registerAllVariants(variants));

const MIN = 60_000;

/** A new server process after a crash: the stores as the old one left them, and a clock of its own, so nothing the old process armed ever fires. */
async function restart(store: Env['store'], snapshots: Map<string, string>, now: number) {
  const clock = new FakeClock();
  clock.t = now;
  const env = setup({ store, snapshots, clock });
  await env.manager.resumeAll();
  return env;
}

/** A store holding just this director state, as the last save left it. */
async function savedAs(state: TournamentState) {
  const store = memoryTournamentStore();
  await store.save(state, null);
  return store;
}

async function started(n: number, overrides: Partial<TournamentSettings> = {}) {
  const env = setup();
  const settings = defaultSettings({ name: 'Restart', startingStack: 1000, seatsPerTable: 6, lateRegistration: { enabled: false, throughLevel: null }, ...overrides });
  const id = await env.manager.create('host', settings);
  await registerAll(env, id, n);
  await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
  return { env, id, state: () => env.manager.view(id)!.state };
}

/** The first player to act moves all in and everyone calls (or checks) it down. */
function allIn(rt: TableRuntime) {
  while (rt.state.hand?.phase === 'betting' && rt.state.hand.toAct !== null) {
    const hand = rt.state.hand;
    const seat = hand.seats.find((x) => x.seat === hand.toAct)!;
    const legal = engine.legalActions(hand, seat.seat)!;
    rt.act(seat.playerId, legal.canRaise ? { type: legal.raiseKind, to: legal.maxTo } : legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
}

describe('shutting down', () => {
  it('a hand that ends as the server stops is saved by both the director and its table', async () => {
    const clock = new FakeClock();
    const tables = memoryStore();
    const tournaments = memoryTournamentStore();
    const errors: unknown[] = [];
    const server = createApp({ clock, rng: seeded(3), store: tables, tournaments, log: (m, e) => errors.push([m, e]) });
    const id = await server.tournaments.create('host', defaultSettings({ name: 'Shutdown', startingStack: 1500 }));
    for (const p of players(2)) await server.tournaments.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    await server.tournaments.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const [rt] = server.tables.values();
    // The hand is over and the table has reported it, but the director acts on that a moment later.
    allIn(rt);
    expect(rt.state.handStartedAt).toBeNull();
    await server.close();

    const director = (await tournaments.load(id))!.state;
    const table = (await tables.loadTable(rt.state.id))!;
    expect(director.tables[0]).toMatchObject({ inHand: false, lastHandNumber: table.handNumber });
    for (const e of director.entries) expect(table.seats.find((x) => x?.playerId === e.playerId)?.stack ?? 0, e.playerId).toBe(e.stack);
    // Nothing moves once the server has stopped.
    clock.advance(10 * MIN);
    expect(rt.state).toEqual(table);
    expect(errors).toEqual([]);
  });
});

describe('tournaments after a crash', () => {
  it.each(['during', 'before'] as const)('a bust the director never saved is replayed from the table (director saved %s the hand)', async (when) => {
    const { env, id, state } = await started(4);
    const [rt] = env.tables.values();
    // The director as it stood between hands, and at a hand that has just knocked somebody out but not been reported yet.
    let between = state();
    playUntil(env, () => {
      const t = state().tables[0];
      if (rt.state.handStartedAt === null && !t.inHand && t.lastHandNumber === rt.state.handNumber) between = state();
      const unreported = rt.state.handStartedAt === null && t.inHand && rt.state.seats.some((x) => x?.stack === 0);
      // Before: the director must have been between hands since the last one (not so for a bust in the first hand).
      return unreported && (when === 'during' || (!between.tables[0].inHand && between.tables[0].lastHandNumber === rt.state.handNumber - 1));
    });
    const saved = when === 'during' ? state() : between;
    expect(saved.tables[0].lastHandNumber).toBe(when === 'during' ? rt.state.handNumber : rt.state.handNumber - 1);
    const busted = rt.state.seats.flatMap((x) => (x?.stack === 0 ? [x.playerId] : [])).sort();

    const after = await restart(await savedAs(saved), env.snapshots, env.clock.t);
    const now = () => after.manager.view(id)!.state;
    expect(now().entries.filter((e) => e.status === 'busted').map((e) => e.playerId).sort()).toEqual(busted);
    expect(now().tables[0]).toMatchObject({ inHand: false, lastHandNumber: rt.state.handNumber });
    seatsAgree(after, id);
    expect(chipsInPlay(after)).toBe(4000);
    playUntil(after, () => now().status === 'finished');
    expect(after.errors).toEqual([]);
    expect(standings(now())[0].stack).toBe(4000);
  }, 60_000);

  it('a table break the director never saved is replayed, and its players reach the table they moved to', async () => {
    const { env, id, state } = await started(4, { seatsPerTable: 3 });
    expect(state().tables).toHaveLength(2);
    const unreported = () =>
      state().tables.some((t) => {
        const rt = env.tables.get(tableAddress(t.id))!;
        return t.inHand && rt.state.handStartedAt === null && rt.state.seats.some((x) => x?.stack === 0);
      });
    playUntil(env, unreported);
    const saved = state();
    const before = new Map(env.snapshots);
    // The report lands: somebody is out, a table breaks and its players move.
    env.clock.advance(0);
    expect(state().tables).toHaveLength(1);
    // The broken table was saved at once; the one its players moved to had not been saved since.
    const snapshots = new Map(before);
    for (const [address, json] of env.snapshots) if (!env.tables.has(address)) snapshots.set(address, json);

    const after = await restart(await savedAs(saved), snapshots, env.clock.t);
    const now = () => after.manager.view(id)!.state;
    expect(now().tables).toHaveLength(1);
    expect(now().entries.filter((e) => e.status === 'busted')).toHaveLength(1);
    seatsAgree(after, id);
    expect(chipsInPlay(after)).toBe(4000);
    playUntil(after, () => now().status === 'finished');
    expect(after.errors).toEqual([]);
    expect(standings(now())[0].stack).toBe(4000);
  }, 60_000);

  it('seats players where the director has them when their tables were saved before a move', async () => {
    const env = setup();
    const startAt = env.clock.now() + 5 * MIN;
    const settings = defaultSettings({ name: 'Moves', start: { kind: 'scheduled', startAt }, startingStack: 1000, seatsPerTable: 6, lateRegistration: { enabled: false, throughLevel: null } });
    const id = await env.manager.create('host', settings);
    await registerAll(env, id, 10);
    env.clock.advance(4 * MIN + 1000);
    const state = () => env.manager.view(id)!.state;
    expect(state().status).toBe('seating');
    const lagging = new Map(env.snapshots);
    // Two players leave one table, so a player moves over from the other.
    const [a] = state().tables;
    for (const e of state().entries.filter((x) => x.tableId === a.id).slice(0, 2)) await env.manager.command(id, 'host', '', { type: 'remove', by: 'host', playerId: e.playerId });
    expect(env.moves.filter((m) => m.from !== '')).toHaveLength(1);
    // The director was saved after all that, the tables before it.
    await env.manager.flush();

    const after = await restart(env.store, lagging, env.clock.t);
    const now = () => after.manager.view(id)!.state;
    seatsAgree(after, id);
    expect(chipsInPlay(after)).toBe(8000);
    after.clock.advance(MIN);
    expect(now().status).toBe('running');
    playUntil(after, () => now().status === 'finished');
    expect(after.errors).toEqual([]);
    expect(standings(now())[0].stack).toBe(8000);
  }, 60_000);
});
