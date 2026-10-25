import { beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings, standings, type TournamentSettings } from '@rsdp/tournament';
import { players, playUntil, setup } from './tournament-helpers';

beforeAll(() => registerAllVariants(variants));

const MIN = 60_000;

const chipsInPlay = (env: ReturnType<typeof setup>) => {
  let total = 0;
  for (const rt of env.tables.values()) {
    for (const seat of rt.state.seats) if (seat) total += seat.pendingChips + (rt.state.hand?.seats.find((x) => x.playerId === seat.playerId) ? 0 : seat.stack);
    if (rt.state.hand) for (const x of rt.state.hand.seats) total += x.startStack;
  }
  return total;
};

describe('tournaments on the server', () => {
  it('starts a scheduled tournament on its own and plays it down to a winner', async () => {
    const env = setup();
    const startAt = env.clock.now() + 10 * MIN;
    const settings: TournamentSettings = defaultSettings({
      name: 'Friday',
      start: { kind: 'scheduled', startAt },
      startingStack: 1000,
      seatsPerTable: 6,
      lateRegistration: { enabled: false, throughLevel: null },
    });
    const id = await env.manager.create('host', settings);
    for (const p of players(14)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: 'spoofed', displayName: 'x' });
    const state = () => env.manager.view(id)!.state;
    expect(state().entries.map((e) => e.playerId)).toContain('p1');
    expect(state().entries.every((e) => e.playerId !== 'spoofed')).toBe(true);

    // A minute before the start the seats are drawn; nobody presses start.
    env.clock.advance(9 * MIN + 1000);
    expect(state().status).toBe('seating');
    expect(env.tables.size).toBe(3);
    expect([...env.tables.values()].every((rt) => !rt.state.hand)).toBe(true);
    // Each player is told where they sit.
    expect(env.moves.filter((m) => m.from === '').map((m) => m.playerId).sort()).toEqual(players(14).map((p) => p.id).sort());
    env.clock.advance(MIN);
    expect(state().status).toBe('running');
    expect([...env.tables.values()].every((rt) => rt.state.hand)).toBe(true);
    expect(chipsInPlay(env)).toBe(14 * 1000);

    playUntil(env, () => state().status === 'finished');
    expect(env.errors).toEqual([]);
    expect(state().status).toBe('finished');
    // Everyone has a place (players busted in the same hand with equal stacks share one) and one winner has every chip.
    const places = standings(state()).map((s) => s.place);
    expect(places.every((p) => p !== null && p >= 1 && p <= 14)).toBe(true);
    expect(places.filter((p) => p === 1)).toHaveLength(1);
    expect(standings(state())[0].stack).toBe(14 * 1000);
    // Tables broke as players busted, and players were moved to keep them balanced.
    expect(env.tables.size).toBe(1);
    expect(env.moves.filter((m) => m.from !== '').length).toBeGreaterThan(0);
  }, 60_000);

  it('plays a mixed-game tournament (Hold\'em, Omaha, Stud, Triple Draw, Badugi) to the end', async () => {
    const env = setup();
    const games = ['nlhe', 'plo4', 'stud', 'td27', 'badugi'];
    const id = await env.manager.create('host', defaultSettings({ name: 'Mixed', games, startingStack: 600, seatsPerTable: 6, lateRegistration: { enabled: false, throughLevel: null } }));
    for (const p of players(25)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const state = () => env.manager.view(id)!.state;
    const seen = new Set<string>();
    const watch = () => {
      for (const rt of env.tables.values()) if (rt.state.hand) seen.add(rt.state.hand.input.game.id);
      return state().status === 'finished';
    };
    playUntil(env, watch, { shove: 2, thinkMs: 4000 });
    const levels = state().clock.rowIndex;
    expect(env.errors).toEqual([]);
    expect(state().status).toBe('finished');
    expect(standings(state())[0].stack).toBe(25 * 600);
    expect([...seen].sort(), `levels reached: ${levels}`).toEqual([...games].sort());
  }, 120_000);

  it('only lets the host run the tournament, and never takes hand reports from browsers', async () => {
    const env = setup();
    const id = await env.manager.create('host', defaultSettings({ name: 'Locked' }));
    await env.manager.command(id, 'p1', 'Ann', { type: 'register', playerId: 'p1', displayName: 'Ann' });
    await env.manager.command(id, 'p2', 'Bob', { type: 'register', playerId: 'p2', displayName: 'Bob' });
    await expect(env.manager.command(id, 'p1', 'Ann', { type: 'startNow', by: 'host' })).rejects.toThrow(/host/);
    await expect(
      env.manager.command(id, 'p1', 'Ann', { type: 'handResult', result: { tableId: 'x', handNumber: 1, startStacks: {}, endStacks: {} } }),
    ).rejects.toThrow();
    await expect(env.manager.command(id, 'p3', '', { type: 'register', playerId: 'p3', displayName: '' })).rejects.toThrow(/name/);
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'someone-else' });
    expect(env.manager.view(id)!.state.status).toBe('running');
    expect(env.manager.view(id)!.state.rng).toBe(0);
  });

  it('deals the first hand to everyone at the table and gives players time to get there', async () => {
    const env = setup();
    const id = await env.manager.create('host', defaultSettings({ name: 'Arrivals', startingStack: 1000 }));
    for (const p of players(3)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const [rt] = env.tables.values();
    expect(rt.state.hand!.input.seats).toHaveLength(3);
    // Nobody has opened the table yet; the first player gets the offline grace, not an instant fold.
    const first = rt.state.hand!.toAct;
    env.clock.advance(10_000);
    expect(rt.state.hand!.toAct).toBe(first);
    env.clock.advance(6_000);
    expect(rt.state.hand!.phase === 'complete' || rt.state.hand!.toAct !== first).toBe(true);
    // The tournament runs its tables: not even its host pauses, stops or changes one directly.
    expect(() => rt.pause('host', true)).toThrow(/lobby/);
    expect(() => rt.updateSettings('host', {})).toThrow(/lobby/);
    expect(() => rt.stop('host')).toThrow(/tournament/);
    expect(() => rt.dealNext('host')).toThrow();
  });

  it('carries on after a restart: a scheduled start still happens and tables come back', async () => {
    const first = setup();
    const startAt = first.clock.now() + 5 * MIN;
    const id = await first.manager.create('host', defaultSettings({ name: 'Restart', start: { kind: 'scheduled', startAt }, startingStack: 500, seatsPerTable: 6 }));
    for (const p of players(4)) await first.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    first.clock.advance(300);
    await first.manager.flush();
    first.manager.dispose();

    // A new server process with the same storage and clock.
    const second = setup({ store: first.store, snapshots: first.snapshots, clock: first.clock });
    await second.manager.resumeAll();
    second.clock.advance(5 * MIN);
    const state = second.manager.view(id)!.state;
    expect(state.status).toBe('running');
    expect(second.tables.size).toBe(1);
    const [rt] = second.tables.values();
    expect(rt.state.hand).not.toBeNull();

    // Mid-hand restart: the table resumes from its snapshot with the same hand.
    const handId = rt.state.hand!.input.handId;
    second.clock.advance(300);
    await second.manager.flush();
    second.manager.dispose();
    for (const t of second.tables.values()) t.dispose();
    const third = setup({ store: first.store, snapshots: first.snapshots, clock: first.clock });
    await third.manager.resumeAll();
    const [again] = third.tables.values();
    expect(again.state.hand?.input.handId).toBe(handId);
    playUntil(third, () => third.manager.view(id)!.state.status === 'finished');
    expect(third.manager.view(id)!.state.status).toBe('finished');
    expect(third.errors).toEqual([]);
  }, 60_000);

  it('a busted player with a rebuy offer holds the table until they decide', async () => {
    const env = setup();
    const structure = defaultSettings({ startingStack: 100 }).structure.map((r, i) => (r.kind === 'level' && i < 3 ? { ...r, rebuy: true } : r));
    const id = await env.manager.create(
      'host',
      defaultSettings({ name: 'Rebuys', startingStack: 100, seatsPerTable: 6, structure, rebuy: { max: 2, chips: 100, approval: false, offerSeconds: 30 } }),
    );
    for (const p of players(3)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
    await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
    const state = () => env.manager.view(id)!.state;
    playUntil(env, () => state().entries.some((e) => e.status === 'rebuy-offer'));
    const offered = state().entries.find((e) => e.status === 'rebuy-offer')!;
    const [rt] = env.tables.values();
    env.clock.advance(5000);
    expect(rt.state.hand?.phase ?? 'complete').toBe('complete');
    await env.manager.command(id, offered.playerId, offered.displayName, { type: 'rebuy', playerId: offered.playerId });
    env.clock.advance(5000);
    expect(rt.state.seats.find((x) => x?.playerId === offered.playerId)?.stack).toBe(100);
    expect(rt.state.hand && rt.state.hand.phase !== 'complete').toBe(true);
  }, 30_000);
});
