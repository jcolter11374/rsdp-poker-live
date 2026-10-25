import { beforeAll, describe, expect, it } from 'vitest';
import { engine, variants, type Action, type PlayerId } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings, standings, tableAddress, type Command, type StructureRow, type TournamentSettings } from '@rsdp/tournament';
import type { TableRuntime } from '../src/runtime/table';
import { players, playUntil, setup } from './tournament-helpers';

beforeAll(() => registerAllVariants(variants));

const MIN = 60_000;

type Env = ReturnType<typeof setup>;

async function registerAll(env: Env, id: string, n: number) {
  for (const p of players(n)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
}

/** Chips at every table; a live hand counts what its players started it with. */
function chipsInPlay(env: Env) {
  let total = 0;
  for (const rt of env.tables.values()) {
    const hand = rt.state.hand?.phase === 'complete' ? null : rt.state.hand;
    for (const seat of rt.state.seats) if (seat) total += seat.pendingChips + (hand?.seats.some((x) => x.playerId === seat.playerId) ? 0 : seat.stack);
    for (const x of hand?.seats ?? []) total += x.startStack;
  }
  return total;
}

/** Every player sits at one table at most, and where the director says they sit. */
function seatsAgree(env: Env, id: string) {
  const at = new Map<PlayerId, string[]>();
  for (const rt of env.tables.values()) {
    for (const seat of rt.state.seats) if (seat) at.set(seat.playerId, [...(at.get(seat.playerId) ?? []), rt.state.id]);
  }
  const state = env.manager.view(id)!.state;
  for (const e of state.entries) {
    if (e.status !== 'seated' && e.status !== 'rebuy-offer') continue;
    expect(at.get(e.playerId), e.playerId).toEqual([tableAddress(e.tableId!)]);
  }
  for (const [playerId, tables] of at) expect(tables, playerId).toHaveLength(1);
}

/** Plays one hand at a table: the first player to act shoves, the next one calls, everyone else folds. */
function shoveAndCall(rt: TableRuntime) {
  let caller = false;
  for (let shoved = false; rt.state.hand?.phase === 'betting' && rt.state.hand.toAct !== null; ) {
    const hand = rt.state.hand;
    const seat = hand.seats.find((x) => x.seat === hand.toAct)!;
    const legal = engine.legalActions(hand, seat.seat)!;
    let action: Action;
    if (!shoved && legal.canRaise) action = { type: legal.raiseKind, to: legal.maxTo };
    else if (shoved && !caller && !legal.canCheck) action = { type: 'call' };
    else action = legal.canCheck ? { type: 'check' } : { type: 'fold' };
    if (action.type === 'call') caller = true;
    shoved ||= action.type === legal.raiseKind;
    rt.act(seat.playerId, action);
  }
}

/** A scheduled event with its seats drawn at two tables, saved and stopped as a server would on shutdown. */
async function seatedThenStopped() {
  const first = setup();
  const startAt = first.clock.now() + 5 * MIN;
  const id = await first.manager.create('host', defaultSettings({ name: 'Reload', start: { kind: 'scheduled', startAt }, startingStack: 1000, seatsPerTable: 6 }));
  await registerAll(first, id, 8);
  first.clock.advance(4 * MIN + 1000);
  const state = first.manager.view(id)!.state;
  expect(state.status).toBe('seating');
  expect(first.tables.size).toBe(2);
  await first.manager.flush();
  first.manager.dispose();
  for (const rt of first.tables.values()) rt.dispose();
  return { first, id, addresses: state.tables.map((t) => tableAddress(t.id)) };
}

describe('tournament manager guards', () => {
  it('refuses host edits naming a game it cannot deal at this table size', async () => {
    const env = setup();
    const id = await env.manager.create('host', defaultSettings({ name: 'Edits', startingStack: 1000, seatsPerTable: 9 }));
    await registerAll(env, id, 3);
    const host = (command: Command) => env.manager.command(id, 'host', '', command);
    const update = (settings: Partial<TournamentSettings>) => host({ type: 'updateSettings', by: 'host', settings });

    // Before the tables exist the games can still change, but only to ones a table can deal.
    await expect(update({ games: ['no-such-game'] })).rejects.toThrow(/unknown game/);
    await expect(update({ games: ['nlhe', 'badugi'] })).rejects.toThrow(/Badugi seats at most 6/);
    await expect(update({ games: ['nlhe', 'plo4'], stopRotationAtLevel: 1.5 })).rejects.toThrow(/rotation/);
    await update({ games: ['nlhe', 'plo4'] });

    await host({ type: 'startNow', by: 'host' });
    const state = () => env.manager.view(id)!.state;
    const structure = state().settings.structure;
    const later = structure.findIndex((r, i) => i > 1 && r.kind === 'level');
    const withGame = (gameId: string): StructureRow[] => structure.map((r, i) => (i === later ? { ...r, gameId } : r));
    await expect(host({ type: 'editStructure', by: 'host', structure: withGame('no-such-game') })).rejects.toThrow(/unknown game/);
    await expect(host({ type: 'editStructure', by: 'host', structure: withGame('') })).rejects.toThrow(/unknown game/);
    await expect(host({ type: 'editStructure', by: 'host', structure: withGame('badugi') })).rejects.toThrow(/Badugi seats at most 6/);
    expect(state().settings.structure).toEqual(structure);
    await host({ type: 'editStructure', by: 'host', structure: withGame('plo4') });
    expect(state().settings.structure[later]).toMatchObject({ gameId: 'plo4' });
    expect(env.errors).toEqual([]);
  });

  it('a table that fails to deal is logged, and the tournament is still saved and timed', async () => {
    const first = setup();
    const id = await first.manager.create('host', defaultSettings({ name: 'Broken', startingStack: 1000 }));
    await registerAll(first, id, 3);
    await first.manager.flush();
    first.manager.dispose();
    // A saved event whose game this server does not have (an older build, or a removed variant).
    const saved = (await first.store.load(id))!;
    await first.store.save({ ...saved.state, settings: { ...saved.state.settings, games: ['no-such-game'] } }, saved.nextId);

    const env = setup({ store: first.store, snapshots: first.snapshots, clock: first.clock });
    await env.manager.resumeAll();
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    expect(env.errors.map((x) => (x as [string])[0])).toEqual([expect.stringMatching(/deal/)]);
    env.clock.advance(1000);
    expect((await env.store.load(id))!.state.status).toBe('running');
    // The clock still runs: the first level ends on time.
    env.clock.advance(env.manager.view(id)!.state.settings.structure[0].minutes * MIN);
    expect(env.manager.view(id)!.state.clock.rowIndex).toBe(1);
  });

  it('a rebuy that frees a held table for a balance move deals after the move, so no chips appear', async () => {
    const env = setup();
    const structure = defaultSettings({ startingStack: 1000 }).structure.map((r, i) => (r.kind === 'level' && i < 3 ? { ...r, rebuy: true } : r));
    const id = await env.manager.create(
      'host',
      defaultSettings({
        name: 'Rebalance',
        startingStack: 1000,
        seatsPerTable: 6,
        structure,
        rebuy: { max: 1, chips: 1000, approval: false, offerSeconds: 300 },
        lateRegistration: { enabled: false, throughLevel: null },
      }),
    );
    await registerAll(env, id, 10);
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const state = () => env.manager.view(id)!.state;
    const [held, other] = state().tables.map((t) => t.id);
    const rt = env.tables.get(tableAddress(held))!;
    const count = (tableId: string) => state().tables.find((t) => t.id === tableId)!.seats.filter(Boolean).length;
    expect([count(held), count(other)]).toEqual([5, 5]);
    // The held table's players are at their browsers, so its hands wait for them.
    for (const seat of rt.state.seats) if (seat) rt.connect(seat.playerId);

    // Heads-up all-ins at one table until somebody busts there and is offered a rebuy.
    for (let i = 0; i < 50 && !state().entries.some((e) => e.status === 'rebuy-offer'); i++) {
      shoveAndCall(rt);
      env.clock.advance(10_000);
    }
    const offered = state().entries.find((e) => e.status === 'rebuy-offer')!;
    expect(offered.tableId).toBe(held);

    // Thin the other table: the held table now has to give up a player, which waits for the offer.
    const removed = state().entries.filter((e) => e.tableId === other && e.status === 'seated').slice(0, 2);
    for (const e of removed) await env.manager.command(id, 'host', '', { type: 'remove', by: 'host', playerId: e.playerId });
    const otherRt = env.tables.get(tableAddress(other))!;
    const between = (x: TableRuntime) => (x.state.hand?.phase ?? 'complete') === 'complete';
    for (let i = 0; i < 300 && (count(other) > 3 || !between(otherRt)); i++) env.clock.advance(1000);
    expect([count(held), count(other)]).toEqual([5, 3]);
    // The held table already tried to deal and is waiting on the director.
    expect(rt.state.nextHandAt).toBeNull();
    expect(between(rt)).toBe(true);
    const before = chipsInPlay(env);
    expect(state().entries.reduce((a, e) => a + e.stack, 0)).toBe(before);

    const moves = env.moves.length;
    await env.manager.command(id, offered.playerId, offered.displayName, { type: 'rebuy', playerId: offered.playerId });
    // The rebuy and the move it allows land together; the held table deals only once the moved player has gone.
    expect(env.moves.slice(moves).map((m) => m.from)).toEqual([tableAddress(held)]);
    expect(rt.state.hand && rt.state.hand.phase !== 'complete').toBe(true);
    seatsAgree(env, id);
    expect(chipsInPlay(env)).toBe(before + 1000);

    playUntil(env, () => state().status === 'finished');
    expect(env.errors).toEqual([]);
    expect(standings(state())[0].stack).toBe(before + 1000);
  }, 60_000);

  it('the director hears of a deal at once, so a command in the same moment cannot move a player out of the hand', async () => {
    const env = setup();
    const settings = defaultSettings({ name: 'Same moment', startingStack: 1000, seatsPerTable: 3, lateRegistration: { enabled: true, throughLevel: 4 } });
    const id = await env.manager.create('host', settings);
    await registerAll(env, id, 6);
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const state = () => env.manager.view(id)!.state;
    expect(state().tables.map((t) => t.inHand)).toEqual([true, true]);
    // A late registration handled before any timer runs opens a third table that needs players.
    await env.manager.command(id, 'p7', 'Player 7', { type: 'register', playerId: 'p7', displayName: 'Player 7' });
    expect(state().tables).toHaveLength(3);
    seatsAgree(env, id);
    expect(chipsInPlay(env)).toBe(7000);

    playUntil(env, () => state().status === 'finished');
    expect(env.errors).toEqual([]);
    expect(standings(state())[0].stack).toBe(7000);
  }, 60_000);

  it('a restart that fails to load a table leaves nothing half-loaded, and the next visit loads it whole', async () => {
    const { first, id, addresses } = await seatedThenStopped();
    // The second table's snapshot fails to load once (the database was briefly unreachable).
    const snapshots = new Map(first.snapshots);
    const get = snapshots.get.bind(snapshots);
    let failures = 1;
    snapshots.get = (key: string) => {
      if (key === addresses[1] && failures-- > 0) throw new Error('storage is down');
      return get(key);
    };
    const second = setup({ store: first.store, snapshots, clock: first.clock });
    await second.manager.resumeAll();
    expect(second.errors).toHaveLength(1);
    expect(second.manager.view(id)).toBeNull();
    expect(second.tables.size).toBe(0);
    expect(second.manager.tournamentOf(addresses[0])).toBeNull();

    expect(await second.manager.loadTableOwner(addresses[1])).toBe(id);
    expect([...second.tables.keys()].sort()).toEqual([...addresses].sort());
    second.clock.advance(MIN);
    expect(second.manager.view(id)!.state.status).toBe('running');
    expect([...second.tables.values()].every((rt) => rt.state.hand)).toBe(true);
    expect(chipsInPlay(second)).toBe(8000);
  });

  it('a table that fails to resume does not stop the others or the tournament clock', async () => {
    const { first, id, addresses } = await seatedThenStopped();
    // The first table's first save after the restart fails, so its resume throws.
    const snapshots = new Map(first.snapshots);
    const set = snapshots.set.bind(snapshots);
    let failures = 1;
    snapshots.set = (key: string, value: string) => {
      if (key === addresses[0] && failures-- > 0) throw new Error('disk full');
      return set(key, value);
    };
    const second = setup({ store: first.store, snapshots, clock: first.clock });
    await second.manager.resumeAll();
    expect(second.errors.map((x) => (x as [string])[0])).toEqual([expect.stringMatching(/resum/)]);
    expect(second.tables.size).toBe(2);
    second.clock.advance(MIN);
    expect(second.manager.view(id)!.state.status).toBe('running');
    expect([...second.tables.values()].every((rt) => rt.state.hand)).toBe(true);
  });

  it('never arms a timer for a wake time that is not a number', async () => {
    const first = setup();
    const id = await first.manager.create('host', defaultSettings({ name: 'Wake', start: { kind: 'scheduled', startAt: first.clock.now() + 10 * MIN } }));
    await registerAll(first, id, 2);
    await first.manager.flush();
    first.manager.dispose();
    // A saved setting the director cannot do arithmetic with.
    const saved = (await first.store.load(id))!;
    await first.store.save({ ...saved.state, settings: { ...saved.state.settings, seatLeadSeconds: 'soon' as unknown as number } }, saved.nextId);

    const second = setup({ store: first.store, snapshots: first.snapshots, clock: first.clock });
    const delays: number[] = [];
    const arm = second.clock.setTimeout;
    second.clock.setTimeout = (fn, ms) => {
      delays.push(ms);
      return arm(fn, ms);
    };
    await second.manager.resumeAll();
    expect(delays.filter((ms) => !Number.isFinite(ms))).toEqual([]);
    expect(second.errors.map((x) => (x as [string])[0])).toEqual([expect.stringMatching(/wake/)]);
    expect(second.manager.view(id)!.state.status).toBe('registering');
  });
});
