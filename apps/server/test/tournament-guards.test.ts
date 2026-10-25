import { beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings, type Command, type StructureRow, type TournamentSettings } from '@rsdp/tournament';
import { players, setup } from './tournament-helpers';

beforeAll(() => registerAllVariants(variants));

const MIN = 60_000;

type Env = ReturnType<typeof setup>;

async function registerAll(env: Env, id: string, n: number) {
  for (const p of players(n)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
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
});
