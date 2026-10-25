import { beforeAll, describe, expect, it } from 'vitest';
import { ActionError, engine, variants, type Action } from '@rsdp/engine/core';
import { defaultSettings, SettingsError, type SettingsPatch } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import '@rsdp/engine/modifiers';
import { TableRuntime } from '../src/runtime/table';
import type { RuntimeState } from '../src/runtime/types';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

/**
 * A cash table played the way a rowdy home game plays it: random actions,
 * people leaving mid-hand, rebuys, host stack edits, kicks, sitting out,
 * dropped connections, settings changed mid-hand and server restarts. After
 * every step the chips must still add up: everything bought in is on a seat,
 * cashed out, or raked, and nothing is negative.
 */
const PLAYERS = ['host', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
const GAMES = ['nlhe', 'plo4', 'plo5', 'plo6', 'plo8', 'plo5-8', 'plo6-8', 'stud', 'razz', 'stud8', 'td27', 'badugi'];

function run(seed: number, steps: number) {
  const rng = seeded(seed);
  const pick = <T>(xs: readonly T[]) => xs[rng(xs.length)];
  const chance = (pct: number) => rng(100) < pct;
  const clock = new FakeClock();
  const settings = defaultSettings('cash');
  settings.table.maxSeats = 8;
  const deps = { clock, rng: seeded(seed * 31 + 1), log: (m: string, e?: unknown) => { throw new Error(`${m}: ${String(e)}`); } };
  let rt = TableRuntime.create({ id: 'fz', hostId: 'host', settings }, deps);
  const online = new Set<string>();
  const connect = (id: string) => {
    if (online.has(id)) return;
    online.add(id);
    rt.connect(id);
  };
  for (const id of PLAYERS) connect(id);
  rt.updateSettings('host', { seating: { requireApproval: false, rebuyRequiresApproval: false } });
  for (const [i, id] of PLAYERS.slice(0, 4).entries()) rt.requestSeat(id, { seat: i, name: id, stack: 100 + rng(400) });
  rt.start('host');
  const trace: string[] = [];

  const check = (where: string) => {
    const s = rt.state;
    const live = !!s.hand && s.hand.phase !== 'complete';
    const ids = s.seats.filter(Boolean).map((x) => x!.playerId);
    expect(new Set(ids).size, `${where}: a player in two seats`).toBe(ids.length);
    s.seats.forEach((x, i) => {
      if (!x) return;
      expect(x.seat, `${where}: seat index`).toBe(i);
      expect(Number.isInteger(x.stack) && x.stack >= 0, `${where}: stack ${x.stack}`).toBe(true);
    });
    if (live) return;
    const ledger = Object.values(s.ledger);
    const buyIn = ledger.reduce((n, r) => n + r.buyIn, 0);
    const out = ledger.reduce((n, r) => n + r.cashOut, 0);
    const onTable = s.seats.reduce((n, x) => n + (x ? x.stack + x.pendingChips : 0), 0);
    const rake = s.sideGames?.rakeTotal ?? 0;
    expect(onTable + out + rake, `${where}: chips don't add up (buy-ins ${buyIn})\n${trace.slice(-25).join('\n')}`).toBe(buyIn);
    for (const x of s.seats) if (x) expect(s.ledger[x.playerId], `${where}: seated without a ledger row`).toBeTruthy();
  };

  // Someone at the table, or an empty seat's would-be player when nobody is (the runtime must refuse them cleanly).
  const seated = () => {
    const ids = rt.state.seats.filter(Boolean).map((x) => x!.playerId);
    return ids.length ? ids : ['nobody'];
  };
  const host = () => rt.state.hostId;

  const randomAction = (seatNo: number): Action => {
    const hand = rt.state.hand!;
    const legal = engine.legalActions(hand, seatNo);
    if (!legal) return { type: 'check' };
    const r = rng(100);
    if (legal.canBringIn && r < 50) return { type: 'bring-in' };
    if (legal.canRaise && r < 30) {
      const to = r < 8 ? legal.maxTo : legal.minTo + rng(Math.max(1, legal.maxTo - legal.minTo + 1));
      return { type: legal.raiseKind, to };
    }
    if (legal.canCheck) return { type: 'check' };
    if (r < 75) return { type: 'call' };
    return { type: 'fold' };
  };

  const ops: [number, () => void][] = [
    [40, () => {
      const hand = rt.state.hand;
      if (!hand || hand.phase === 'complete') return void clock.advance(1000 + rng(8000));
      if (hand.phase === 'rit-vote') {
        const voters = hand.seats.filter((x) => !x.folded && x.ritVote === null);
        if (!voters.length) return void clock.advance(1000);
        const v = pick(voters);
        trace.push(`vote ${v.playerId}`);
        return rt.voteRunItTwice(v.playerId, chance(60));
      }
      if (hand.toAct === null) return void clock.advance(500);
      const id = rt.state.seats[hand.toAct]?.playerId;
      if (!id) return void clock.advance(500);
      if (hand.phase === 'drawing') {
        trace.push(`draw ${id}`);
        return rt.draw(id, [0, 1, 2, 3, 4].filter(() => chance(40)));
      }
      const a = randomAction(hand.toAct);
      trace.push(`act ${id} ${JSON.stringify(a)}`);
      rt.act(id, a);
    }],
    [6, () => { trace.push('clock 31s'); clock.advance(31_000); }],
    [4, () => { trace.push('clock 2m'); clock.advance(120_000); }],
    [12, () => {
      const id = pick(PLAYERS.filter((p) => !seated().includes(p)));
      if (!id) return;
      const free = rt.state.seats.flatMap((x, i) => (x ? [] : [i]));
      if (!free.length) return;
      trace.push(`sit ${id}`);
      rt.requestSeat(id, { seat: pick(free), name: id, stack: 50 + rng(500) });
    }],
    [2, () => { const id = pick(seated()); trace.push(`stand ${id}`); rt.stand(id, { afterHand: chance(50) }); }],
    [5, () => { const id = pick(seated()); trace.push(`rebuy ${id}`); rt.rebuy(id, 1 + rng(300)); }],
    [3, () => { const id = pick(seated()); trace.push(`setStack ${id}`); rt.setStack(host(), id, rng(600)); }],
    [1, () => { const id = pick(seated()); trace.push(`kick ${id}`); rt.kick(host(), id); }],
    [5, () => { const id = pick(seated()); trace.push(`sitOut ${id}`); rt.sitOut(id, chance(25)); }],
    [1, () => { const id = pick(seated()); trace.push(`hostSitOut ${id}`); rt.hostSitOut(host(), id); }],
    [3, () => { const id = pick(seated()); trace.push(`prefs ${id}`); rt.setPreferences(id, { straddle: chance(50), waitForBigBlind: chance(30), nitGame: chance(50) }); }],
    [6, () => {
      const id = pick(PLAYERS);
      if (online.has(id)) {
        trace.push(`drop ${id}`);
        online.delete(id);
        rt.disconnect(id);
      } else {
        trace.push(`back ${id}`);
        connect(id);
      }
    }],
    [5, () => {
      const patches: SettingsPatch[] = [
        { game: { gameId: pick(GAMES), betting: pick(['no-limit', 'pot-limit', 'fixed-limit'] as const) } },
        { table: { maxSeats: 6 + rng(3) } },
        { play: { runItTwice: pick(['off', 'ask', 'always'] as const), straddle: pick(['off', 'utg', 'utg-and-button'] as const) } },
        { modifiers: { 'bomb-pot': { enabled: chance(60), chancePercent: 30 } } },
        { modifiers: { 'bounty-72': { enabled: chance(60) } } },
        { modifiers: { 'double-board': { enabled: chance(60), when: pick(['always', 'bomb-pots'] as const) } } },
        { modifiers: { nit: { enabled: chance(50), minPlayers: 3 } } },
        { modifiers: { rake: { enabled: chance(50), percent: 5 } } },
        { stakes: { ante: rng(3), anteType: pick(['none', 'per-player', 'big-blind'] as const) } },
        { seating: { maxBuyIn: chance(50) ? 0 : 400, ratholeMinutes: chance(50) ? 0 : 30 } },
        { play: { revealAllAtShowdown: chance(50), trimExcessBets: chance(50) } },
        { timing: { decisionSeconds: 5 + rng(30), timeBankSeconds: rng(30) } },
      ];
      const patch = pick(patches);
      trace.push(`settings ${JSON.stringify(patch)}`);
      rt.updateSettings(host(), patch);
    }],
    [2, () => { trace.push('bomb next'); rt.requestBombPot(host(), true); }],
    [2, () => { trace.push('pause'); rt.pause(host(), !rt.state.paused); }],
    [4, () => { trace.push('resume'); rt.pause(host(), false); }],
    [6, () => { trace.push('start'); rt.start(host()); }],
    [1, () => { trace.push('stop'); rt.stop(host()); }],
    [1, () => { trace.push('shuffle'); rt.shuffleSeats(host()); }],
    [2, () => {
      const id = pick(seated());
      const free = rt.state.seats.flatMap((x, i) => (x ? [] : [i]));
      if (!free.length) return;
      trace.push(`move ${id}`);
      rt.moveSeat(host(), id, pick(free));
    }],
    [1, () => {
      const to = pick(PLAYERS.filter((p) => online.has(p)));
      if (!to) return;
      trace.push(`host -> ${to}`);
      rt.transferHost(host(), to);
    }],
    [3, () => { const id = pick(seated()); trace.push(`show ${id}`); rt.show(id, [0, 1]); }],
    [2, () => { const id = pick(seated()); trace.push(`timebank ${id}`); rt.useTimeBank(id); }],
    [2, () => {
      // Server restart: save the state as JSON and bring it back up, with nobody connected.
      trace.push('restart');
      const saved = JSON.parse(JSON.stringify(rt.state)) as RuntimeState;
      rt.dispose();
      rt = new TableRuntime(saved, deps);
      rt.resume();
      const was = [...online];
      online.clear();
      for (const id of was) if (chance(80)) connect(id);
    }],
  ];
  const totalWeight = ops.reduce((n, [w]) => n + w, 0);

  for (let i = 0; i < steps; i++) {
    let r = rng(totalWeight);
    const op = ops.find(([w]) => (r -= w) < 0)![1];
    try {
      op();
    } catch (e) {
      if (!(e instanceof ActionError) && !(e instanceof SettingsError)) {
        throw new Error(`seed ${seed} step ${i}: ${(e as Error).stack}\n${trace.slice(-25).join('\n')}`);
      }
    }
    check(`seed ${seed} step ${i}`);
  }
  return rt.state.handNumber;
}

describe('cash table fuzz', () => {
  const seeds = Number(process.env.SEEDS ?? 12);
  for (let seed = 1; seed <= seeds; seed++) {
    it(`seed ${seed}: chips always add up`, () => {
      expect(run(seed, 1500)).toBeGreaterThan(5);
    });
  }
});
