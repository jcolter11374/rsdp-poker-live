import { beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { defaultSettings, standings } from '@rsdp/tournament';
import { playUntil, registerAll, setup } from './tournament-helpers';

beforeAll(() => registerAllVariants(variants));

describe('tournament formats on the server', () => {
  it('makes invite codes itself, ignores codes from the browser, and shows them only to the host', async () => {
    const env = setup();
    const id = await env.manager.create('host', defaultSettings({ name: 'Invites', invites: { required: true, autoApprove: false } }));
    await expect(env.manager.command(id, 'p1', 'P1', { type: 'createInvites', by: 'p1', count: 1, maxUses: 1 })).rejects.toThrow(/only the host/);
    await env.manager.command(id, 'host', 'Host', { type: 'createInvites', by: 'host', count: 3, maxUses: 1, codes: ['AAAA2222', 'BBBB2222', 'CCCC2222'] });
    const codes = env.manager.view(id, 'host')!.state.invites!.map((c) => c.code);
    expect(codes).toHaveLength(3);
    expect(codes).not.toContain('AAAA2222');
    expect(env.manager.view(id, 'p1')!.state.invites).toBeUndefined();

    await expect(env.manager.command(id, 'p1', 'P1', { type: 'register', playerId: 'p1', displayName: 'P1' })).rejects.toThrow(/invite code/);
    await env.manager.command(id, 'p1', 'P1', { type: 'register', playerId: 'p1', displayName: 'P1', code: codes[0] });
    expect(env.manager.view(id, 'host')!.state.invites![0].usedBy.map((u) => u.playerId)).toEqual(['p1']);
  });

  it('players check in themselves; the host opens check-in', async () => {
    const env = setup();
    const id = await env.manager.create('host', defaultSettings({ name: 'Check-in', checkIn: { groups: [{ firstN: null, waitMinutes: 10 }], opensMinutesBefore: 30 } }));
    await registerAll(env, id, 3);
    await expect(env.manager.command(id, 'p1', 'Player 1', { type: 'openCheckIn', by: 'p1' })).rejects.toThrow(/only the host/);
    await env.manager.command(id, 'host', 'Host', { type: 'openCheckIn', by: 'host' });
    await env.manager.command(id, 'p1', 'Player 1', { type: 'checkIn', playerId: 'someone-else' });
    await env.manager.command(id, 'p2', 'Player 2', { type: 'checkIn', playerId: 'p2' });
    await env.manager.command(id, 'host', 'Host', { type: 'startNow', by: 'host' });
    expect(env.manager.view(id)!.state.entries.map((e) => e.playerId)).toEqual(['p1', 'p2']);
  });

  it('a progressive knockout plays to the end with every bounty accounted for', async () => {
    const env = setup();
    const amount = 1000;
    const id = await env.manager.create('host', defaultSettings({ name: 'PKO', startingStack: 1000, seatsPerTable: 6, bounty: { amount, progressivePercent: 50 } }));
    await registerAll(env, id, 9);
    await env.manager.command(id, 'host', 'Host', { type: 'startNow', by: 'host' });
    const state = () => env.manager.view(id)!.state;
    playUntil(env, () => state().status === 'finished', { shove: 40 });
    expect(state().status).toBe('finished');
    const st = standings(state());
    // Every head's money ends with someone: split pots and progressive shares lose no cents.
    expect(st.reduce((a, s) => a + s.bounties, 0)).toBe(9 * amount);
    expect(st.find((s) => s.place === 1)!.knockouts).toBeGreaterThan(0);
    expect(st.reduce((a, s) => a + s.knockouts, 0)).toBeGreaterThanOrEqual(8);
  });
});
