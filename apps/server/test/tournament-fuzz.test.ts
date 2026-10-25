// Random tournaments with hosts and players doing everything at once, and a server event loop that
// sometimes runs late: after every step that leaves nothing pending, the director and its tables agree
// on who sits where, every stack, the chips in play, and which tables are playing a hand.
import { beforeAll, describe, expect, it } from 'vitest';
import { ActionError, engine, variants, type Action } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { addOnsOpen, defaultSettings, payoutPreset, tableAddress, type Command, type StructureRow } from '@rsdp/tournament';
import type { TableRuntime } from '../src/runtime/table';
import { seeded } from './fake-clock';
import { chipsInPlay, registerAll, setup, type Env } from './tournament-helpers';

beforeAll(() => registerAllVariants(variants));

type Internals = { live: Map<string, { deferred: unknown[]; reports: Map<unknown, unknown>; tables: Map<string, TableRuntime> }> };

/** Throws if the director and its tables disagree; false while something is still on its way. */
function check(env: Env, id: string, label: string) {
  const live = (env.manager as unknown as Internals).live.get(id)!;
  if (live.deferred.length || live.reports.size) return false;
  const s = env.manager.view(id)!.state;
  if (s.status !== 'running' && s.status !== 'paused') return false;
  const problems: string[] = [];
  for (const t of s.tables) {
    const rt = env.tables.get(tableAddress(t.id));
    if (!rt) { problems.push(`no runtime for ${t.id}`); continue; }
    if (t.inHand !== (rt.state.handStartedAt !== null)) problems.push(`${t.id} inHand director=${t.inHand} table=${rt.state.handStartedAt !== null}`);
  }
  for (const rt of env.tables.values()) {
    const tid = [...live.tables.entries()].find(([, r]) => r === rt)?.[0];
    if (!s.tables.some((t) => t.id === tid)) problems.push(`runtime ${rt.state.id} has no director table`);
  }
  const at = new Map<string, string[]>();
  for (const rt of env.tables.values()) for (const seat of rt.state.seats) if (seat) at.set(seat.playerId, [...(at.get(seat.playerId) ?? []), rt.state.id]);
  for (const e of s.entries) {
    const alive = e.status === 'seated' || e.status === 'rebuy-offer';
    if (!alive) {
      if (at.has(e.playerId) && !s.entries.some((x) => x.playerId === e.playerId && x !== e && (x.status === 'seated' || x.status === 'rebuy-offer')))
        problems.push(`${e.playerId} (${e.status}) still at ${at.get(e.playerId)}`);
      continue;
    }
    const where = at.get(e.playerId);
    if (!where || where.length !== 1 || where[0] !== tableAddress(e.tableId!)) { problems.push(`${e.playerId} director ${e.tableId} tables ${where}`); continue; }
    const rt = env.tables.get(where[0])!;
    const seat = rt.seatOf(e.playerId)!;
    if (seat.seat !== e.seat) problems.push(`${e.playerId} seat director ${e.seat} table ${seat.seat}`);
    const hand = rt.state.hand && rt.state.hand.phase !== 'complete' ? rt.state.hand : null;
    const hs = hand?.seats.find((x) => x.playerId === e.playerId);
    const tableStack = (hs ? hs.startStack : seat.stack) + seat.pendingChips;
    if (tableStack !== e.stack) problems.push(`${e.playerId} stack director ${e.stack} table ${tableStack} (inHand ${!!hs}, pending ${seat.pendingChips}, leave ${seat.leaveAfterHand})`);
  }
  const directorChips = s.entries.filter((e) => e.status === 'seated' || e.status === 'rebuy-offer').reduce((a, e) => a + e.stack, 0);
  if (directorChips !== chipsInPlay(env)) problems.push(`chips director ${directorChips} tables ${chipsInPlay(env)}`);
  if (problems.length) throw new Error(`${label}: ${problems.join('; ')}`);
  return true;
}

function actOnce(env: Env, rand: (n: number) => number, shove = 15) {
  const rts = [...env.tables.values()];
  for (const rt of rts.sort(() => rand(3) - 1)) {
    for (const seat of rt.state.seats) if (seat && !rt.isOnline(seat.playerId)) rt.connect(seat.playerId);
    const hand = rt.state.hand;
    if (!hand || hand.phase !== 'betting' || hand.toAct === null || rt.state.paused) continue;
    const seat = hand.seats.find((x) => x.seat === hand.toAct)!;
    const legal = engine.legalActions(hand, seat.seat)!;
    const r = rand(100);
    let action: Action;
    const big = legal.callAmount * 4 > seat.stack + seat.bet;
    if (legal.canRaise && r < shove) action = { type: legal.raiseKind, to: legal.maxTo };
    else if (!legal.canCheck && (r < shove + 13 || (big && r < 70))) action = { type: 'fold' };
    else action = legal.canCheck ? { type: 'check' } : { type: 'call' };
    rt.act(seat.playerId, action);
    return true;
  }
  return false;
}

/** `hfh`: with payouts, so the bubble brings on hand-for-hand play. */
async function fuzz(seed: number, opts: { lag: boolean; hfh: boolean }) {
  const env = setup();
  const level = (sb: number, minutes: number, rebuy = false): StructureRow => ({ kind: 'level', sb, bb: sb * 2, ante: 0, anteType: 'none', minutes, ...(rebuy ? { rebuy: true } : {}) });
  const structure: StructureRow[] = [level(10, 3, true), level(20, 3, true), { kind: 'break', minutes: 1, addOn: true }, level(40, 3), level(80, 3), level(160, 3), level(320, 3), level(640, 60)];
  const settings = defaultSettings({
    name: 'Fuzz',
    startingStack: 1000,
    seatsPerTable: 4,
    structure,
    rebuy: { max: 1, chips: 1000, approval: false, offerSeconds: 5 },
    addOn: { max: 1, chips: 1500, approval: false },
    allowQuit: true,
    lateRegistration: { enabled: true, throughLevel: 2 },
    handForHand: true,
    ...(opts.hfh ? { payouts: { structure: payoutPreset('standard', 600), money: { buyIn: 100, rebuy: 100, addOn: 100 } } } : {}),
  });
  const id = await env.manager.create('host', settings);
  await registerAll(env, id, 13);
  await env.manager.command(id, 'host', '', { type: 'startNow', by: 'host' });
  const state = () => env.manager.view(id)!.state;
  const rand = seeded(seed);
  let late = 13;
  const cmd = async (who: string, c: Command) => {
    try {
      await env.manager.command(id, who, '', c);
    } catch (e) {
      if (!(e instanceof ActionError)) throw e;
    }
  };
  let checks = 0;
  const log: string[] = [];
  for (let i = 0; i < 30000 && (state().status === 'running' || state().status === 'paused'); i++) {
    const r = rand(1000);
    const alive = state().entries.filter((e) => e.status === 'seated' || e.status === 'rebuy-offer');
    if (opts.lag && r < 40) {
      // The event loop is late: time passes but no timer has run yet.
      env.clock.t += rand(40_000);
    }
    const r2 = rand(1000);
    if (r2 < 6 && alive.length > 2) {
      const e = alive[rand(alive.length)];
      log.push(`${i} remove ${e.playerId}`);
      await cmd('host', { type: 'remove', by: 'host', playerId: e.playerId });
    } else if (r2 < 12 && alive.length > 2) {
      const e = alive[rand(alive.length)];
      log.push(`${i} quit ${e.playerId}`);
      await cmd(e.playerId, { type: 'quit', playerId: e.playerId });
    } else if (r2 < 40) {
      for (const e of state().entries.filter((x) => x.status === 'rebuy-offer')) {
        const r3 = rand(10);
        if (r3 < 3) { log.push(`${i} rebuy ${e.playerId}`); await cmd(e.playerId, { type: 'rebuy', playerId: e.playerId }); }
        else if (r3 < 4) { log.push(`${i} decline ${e.playerId}`); await cmd(e.playerId, { type: 'declineRebuy', playerId: e.playerId }); }
      }
    } else if (r2 < 70 && addOnsOpen(state())) {
      const e = alive[rand(alive.length)];
      if (e) { log.push(`${i} addOn ${e.playerId}`); await cmd(e.playerId, { type: 'addOn', playerId: e.playerId }); }
    } else if (r2 < 75 && late < 20) {
      const p = `p${++late}`;
      log.push(`${i} register ${p}`);
      await cmd(p, { type: 'register', playerId: p, displayName: `Player ${late}` });
    } else if (r2 < 78) {
      log.push(`${i} pause`);
      await cmd('host', { type: 'pause', by: 'host' });
    } else if (r2 < 95 && state().status === 'paused') {
      log.push(`${i} resume`);
      await cmd('host', { type: 'resume', by: 'host' });
    }
    if (!actOnce(env, rand)) env.clock.advance(rand(3) === 0 ? 0 : 1 + rand(2500));
    else if (rand(4) === 0) env.clock.advance(rand(300));
    try {
      if (check(env, id, `seed ${seed} step ${i}`)) checks++;
    } catch (e) {
      throw new Error(`${(e as Error).message}\nlast: ${log.slice(-12).join(' | ')}\nerrors: ${JSON.stringify(env.errors.map((x) => (x as [string])[0]))}`);
    }
  }
  return { env, checks };
}

// SEEDS=32 npm test runs more of them.
const SEEDS = Number(process.env.SEEDS ?? 4);

describe('tournament fuzz', () => {
  for (const lag of [false, true]) {
    for (const hfh of [true, false]) {
      for (let seed = 1; seed <= SEEDS; seed++) {
        it(`seed ${seed}${lag ? ', late event loop' : ''}${hfh ? ', hand-for-hand' : ''}`, async () => {
          const { env, checks } = await fuzz(seed, { lag, hfh });
          expect(env.errors).toEqual([]);
          expect(checks).toBeGreaterThan(10);
        }, 120_000);
      }
    }
  }
});
