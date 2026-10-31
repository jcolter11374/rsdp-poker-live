import { describe, expect, it } from 'vitest';
import {
  apply,
  createTournament,
  defaultSettings,
  nextWakeAt,
  playerOptions,
  splitBounty,
  standings,
  summarize,
  tick,
  validateSettings,
  viewFor,
  type Command,
  type DirectorEvent,
  type StructureRow,
  type TournamentSettings,
  type TournamentState,
} from '../src';

const MIN = 60_000;
const T0 = Date.parse('2026-10-30T00:00:00Z');
const START = T0 + 120 * MIN;

const levels: StructureRow[] = [
  { kind: 'level', sb: 50, bb: 100, ante: 0, anteType: 'none', minutes: 10, rebuy: true },
  { kind: 'level', sb: 100, bb: 200, ante: 0, anteType: 'none', minutes: 10, rebuy: true },
  { kind: 'level', sb: 200, bb: 400, ante: 0, anteType: 'none', minutes: 10 },
];

class Sim {
  state: TournamentState;
  events: DirectorEvent[] = [];
  now = T0;
  constructor(overrides: Partial<TournamentSettings> = {}) {
    this.state = createTournament({
      id: 'T',
      hostId: 'host',
      settings: defaultSettings({ structure: levels, startingStack: 1000, lateRegistration: { enabled: false, throughLevel: null }, ...overrides }),
      now: this.now,
      seed: 7,
    });
  }
  do(cmd: Command) {
    const r = apply(this.state, cmd, this.now);
    this.state = r.state;
    this.events.push(...r.events);
    return r.events;
  }
  at(t: number) {
    this.now = t;
    const r = tick(this.state, t);
    this.state = r.state;
    this.events.push(...r.events);
    return r.events;
  }
  register(n: number, from = 0, code?: string) {
    for (let i = from; i < from + n; i++) this.do({ type: 'register', playerId: `p${i}`, displayName: `P${i}`, ...(code ? { code } : {}) });
  }
  of<K extends DirectorEvent['type']>(type: K) {
    return this.events.filter((e): e is Extract<DirectorEvent, { type: K }> => e.type === type);
  }
  entry(playerId: string) {
    return this.state.entries.filter((e) => e.playerId === playerId).at(-1)!;
  }
  /** Plays a hand: each busted player loses everything to their winners, split evenly. */
  hand(tableId: string, knockouts: Record<string, string[]>) {
    const t = this.state.tables.find((x) => x.id === tableId)!;
    const ids = t.seats.filter((x): x is string => !!x).map((id) => this.state.entries.find((e) => e.id === id)!);
    const start = Object.fromEntries(ids.map((e) => [e.playerId, e.stack]));
    const end = { ...start };
    for (const [b, winners] of Object.entries(knockouts)) {
      const each = Math.floor(end[b] / winners.length);
      winners.forEach((w, i) => (end[w] += i === 0 ? end[b] - each * (winners.length - 1) : each));
      end[b] = 0;
    }
    this.do({ type: 'handStarted', tableId, handNumber: t.lastHandNumber + 1 });
    return this.do({ type: 'handResult', result: { tableId, handNumber: t.lastHandNumber + 1, startStacks: start, endStacks: end, knockedOutBy: knockouts } });
  }
}

describe('bounties', () => {
  it('splits a bounty evenly, odd cents to the first winners, with a progressive share onto their heads', () => {
    expect(splitBounty(1000, 1, 0)).toEqual([{ cash: 1000, headAdded: 0 }]);
    expect(splitBounty(1000, 1, 50)).toEqual([{ cash: 500, headAdded: 500 }]);
    expect(splitBounty(1001, 2, 50)).toEqual([
      { cash: 251, headAdded: 250 },
      { cash: 250, headAdded: 250 },
    ]);
    expect(splitBounty(0, 2, 50)).toEqual([]);
  });

  it('pays a regular bounty to the player who busts someone, and the winner keeps their own', () => {
    const sim = new Sim({ bounty: { amount: 1000, progressivePercent: 0 } });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    expect(sim.entry('p0')).toMatchObject({ bounty: 1000, bountiesWon: 0, knockouts: 0 });
    sim.hand(t, { p1: ['p0'] });
    expect(sim.of('bountyWon')).toEqual([{ type: 'bountyWon', entryId: sim.entry('p0').id, playerId: 'p0', fromEntryId: sim.entry('p1').id, fromPlayerId: 'p1', cash: 1000, headAdded: 0 }]);
    expect(sim.entry('p0')).toMatchObject({ bounty: 1000, bountiesWon: 1000, knockouts: 1 });
    sim.hand(t, { p2: ['p0'] });
    expect(sim.state.status).toBe('finished');
    const st = Object.fromEntries(standings(sim.state).map((s) => [s.playerId, s]));
    // 2000 for two knockouts plus their own 1000.
    expect(st.p0).toMatchObject({ place: 1, bounties: 3000, knockouts: 2, bounty: 0 });
    expect(st.p1).toMatchObject({ bounties: 0, knockouts: 0, bounty: 0 });
  });

  it('progressive knockout: half goes onto the winner’s head and grows', () => {
    const sim = new Sim({ bounty: { amount: 1000, progressivePercent: 50 } });
    sim.register(4);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.hand(t, { p1: ['p0'] });
    expect(sim.entry('p0')).toMatchObject({ bounty: 1500, bountiesWon: 500 });
    sim.hand(t, { p0: ['p2'] });
    // p2 collects half of p0's 1500 head.
    expect(sim.entry('p2')).toMatchObject({ bounty: 1750, bountiesWon: 750, knockouts: 1 });
    expect(summarize(sim.state, sim.now).bountiesInPlay).toBe(1750 + 1000);
  });

  it('a split pot splits the bounty, and a rebuy buys a fresh one', () => {
    const sim = new Sim({ bounty: { amount: 1001, progressivePercent: 0 }, rebuy: { max: 1, chips: 1000, approval: false, offerSeconds: 15 } });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.hand(t, { p2: ['p0', 'p1'] });
    expect(sim.entry('p0')).toMatchObject({ bountiesWon: 501, knockouts: 1 });
    expect(sim.entry('p1')).toMatchObject({ bountiesWon: 500, knockouts: 1 });
    expect(sim.entry('p2')).toMatchObject({ status: 'rebuy-offer', bounty: 0 });
    sim.do({ type: 'rebuy', playerId: 'p2' });
    expect(sim.entry('p2')).toMatchObject({ status: 'seated', bounty: 1001 });
  });

  it('nobody else collects the bounty of a player who quits', () => {
    const sim = new Sim({ bounty: { amount: 500, progressivePercent: 0 }, allowQuit: true });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    sim.do({ type: 'quit', playerId: 'p1' });
    expect(sim.of('bountyWon')).toEqual([]);
    expect(standings(sim.state).find((s) => s.playerId === 'p1')!.bounties).toBe(500);
    expect(standings(sim.state).filter((s) => s.playerId !== 'p1').every((s) => s.bounties === 0)).toBe(true);
  });

  it('a player who quits keeps their own bounty; one who quits mid-hand and busts pays it to the winner', () => {
    const sim = new Sim({ bounty: { amount: 1000, progressivePercent: 50 }, allowQuit: true });
    sim.register(4);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.do({ type: 'quit', playerId: 'p3' });
    expect(sim.entry('p3')).toMatchObject({ status: 'quit', bounty: 0, bountiesWon: 1000 });
    const hand = sim.state.tables[0].lastHandNumber + 1;
    sim.do({ type: 'handStarted', tableId: t, handNumber: hand });
    sim.do({ type: 'quit', playerId: 'p0' });
    sim.do({
      type: 'handResult',
      result: { tableId: t, handNumber: hand, startStacks: { p0: 1000, p1: 1000, p2: 1000 }, endStacks: { p0: 0, p1: 2000, p2: 1000 }, knockedOutBy: { p0: ['p1'] } },
    });
    expect(sim.entry('p0').status).toBe('quit');
    expect(sim.entry('p1')).toMatchObject({ bountiesWon: 500, bounty: 1500, knockouts: 1 });
    sim.hand(t, { p2: ['p1'] });
    expect(sim.state.status).toBe('finished');
    // Every cent of the four bounties ends with someone.
    expect(standings(sim.state).reduce((a, s) => a + s.bounties, 0)).toBe(4000);
  });

  it('a player the host removes during a hand still collects the bounty of anyone they bust in it', () => {
    const sim = new Sim({ bounty: { amount: 500, progressivePercent: 0 } });
    sim.register(4);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    const hand = sim.state.tables[0].lastHandNumber + 1;
    sim.do({ type: 'handStarted', tableId: t, handNumber: hand });
    // p0 is already all in when the host removes them; they win and bust p1.
    sim.do({ type: 'remove', by: 'host', playerId: 'p0' });
    sim.do({
      type: 'handResult',
      result: {
        tableId: t,
        handNumber: hand,
        startStacks: { p0: 1000, p1: 1000, p2: 1000, p3: 1000 },
        endStacks: { p0: 2000, p1: 0, p2: 1000, p3: 1000 },
        knockedOutBy: { p1: ['p0'] },
      },
    });
    expect(sim.entry('p0').status).toBe('removed');
    expect(sim.of('bountyWon')).toEqual([{ type: 'bountyWon', entryId: sim.entry('p0').id, playerId: 'p0', fromEntryId: sim.entry('p1').id, fromPlayerId: 'p1', cash: 500, headAdded: 0 }]);
    const st = standings(sim.state);
    // p1's bounty and their own.
    expect(st.find((s) => s.playerId === 'p0')).toMatchObject({ bounties: 1000, knockouts: 1 });
    expect(st.reduce((a, s) => a + s.bounties + s.bounty, 0)).toBe(2000);
  });

  it('progressive knockout: a player who quits during a hand keeps both halves of a bounty they win in it', () => {
    const sim = new Sim({ bounty: { amount: 1000, progressivePercent: 50 }, allowQuit: true });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    const hand = sim.state.tables[0].lastHandNumber + 1;
    sim.do({ type: 'handStarted', tableId: t, handNumber: hand });
    sim.do({ type: 'quit', playerId: 'p0' });
    sim.do({
      type: 'handResult',
      result: { tableId: t, handNumber: hand, startStacks: { p0: 1000, p1: 1000, p2: 1000 }, endStacks: { p0: 2000, p1: 0, p2: 1000 }, knockedOutBy: { p1: ['p0'] } },
    });
    // Half of p1's head as cash, and the half added to p0's own head goes with p0 as they leave.
    expect(sim.of('bountyWon')).toMatchObject([{ playerId: 'p0', fromPlayerId: 'p1', cash: 500, headAdded: 500 }]);
    expect(sim.entry('p0')).toMatchObject({ status: 'quit', bounty: 0, bountiesWon: 2000, knockouts: 1 });
    expect(sim.state.status).toBe('finished');
    expect(standings(sim.state).reduce((a, s) => a + s.bounties + s.bounty, 0)).toBe(3000);
  });

  it('bounties won before a re-entry stay with the player', () => {
    const sim = new Sim({ bounty: { amount: 1000, progressivePercent: 0 }, reEntry: { enabled: true, throughLevel: null, max: null, approval: false } });
    sim.register(3);
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    sim.hand(t, { p1: ['p0'] });
    sim.hand(t, { p0: ['p2'] });
    sim.do({ type: 'reEnter', playerId: 'p0' });
    const p0 = standings(sim.state).find((s) => s.playerId === 'p0')!;
    expect(p0).toMatchObject({ bounties: 1000, knockouts: 1, bounty: 1000, entryNo: 2 });
  });

  it('validates the bounty settings', () => {
    const base = defaultSettings();
    expect(validateSettings({ ...base, bounty: { amount: 0, progressivePercent: 0 } })).toContain('The bounty must be a whole amount above 0');
    expect(validateSettings({ ...base, bounty: { amount: 100, progressivePercent: 101 } })).toContain('The progressive share must be 0-100%');
    expect(validateSettings({ ...base, bounty: { amount: 100, progressivePercent: 50 } })).toEqual([]);
  });
});

describe('invite codes', () => {
  it('requires a code, counts uses, and frees a single-use code when its player unregisters', () => {
    const sim = new Sim({ invites: { required: true, autoApprove: false } });
    sim.do({ type: 'createInvites', by: 'host', count: 2, maxUses: 1 });
    const codes = sim.of('invitesCreated')[0].codes;
    expect(codes).toHaveLength(2);
    expect(codes[0]).toMatch(/^[A-Z2-9]{8}$/);
    expect(() => sim.register(1)).toThrow('You need an invite code to register');
    expect(() => sim.register(1, 0, 'NOPE1234')).toThrow('That invite code is not valid');
    sim.register(1, 0, codes[0].toLowerCase());
    expect(sim.state.invites![0].usedBy).toMatchObject([{ playerId: 'p0', displayName: 'P0' }]);
    expect(() => sim.register(1, 1, codes[0])).toThrow('That invite code is not valid');
    sim.do({ type: 'unregister', playerId: 'p0' });
    expect(sim.state.invites![0].usedBy).toEqual([]);
    sim.register(1, 1, codes[0]);
    sim.do({ type: 'cancelInvite', by: 'host', code: codes[1] });
    expect(() => sim.register(1, 2, codes[1])).toThrow('That invite code is not valid');
  });

  it('a shared code has no use limit, and a code skips approval when auto-approve is on', () => {
    const sim = new Sim({ registrationApproval: true, invites: { required: false, autoApprove: true } });
    sim.do({ type: 'createInvites', by: 'host', count: 1, maxUses: null });
    const [code] = sim.of('invitesCreated')[0].codes;
    sim.register(5, 0, code);
    expect(sim.state.entries).toHaveLength(5);
    expect(sim.state.invites![0].usedBy).toHaveLength(5);
    // Without a code the host still approves.
    sim.register(1, 5);
    expect(sim.state.requests).toHaveLength(1);
  });

  it('a code waiting on approval holds its use, and is recorded when the host approves', () => {
    const sim = new Sim({ registrationApproval: true, invites: { required: true, autoApprove: false } });
    sim.do({ type: 'createInvites', by: 'host', count: 1, maxUses: 1, codes: ['abcd2345'] });
    sim.register(1, 0, 'ABCD-2345');
    expect(() => sim.register(1, 1, 'ABCD2345')).toThrow('That invite code is not valid');
    sim.do({ type: 'approve', by: 'host', requestId: sim.state.requests[0].id });
    expect(sim.state.invites![0].usedBy.map((u) => u.playerId)).toEqual(['p0']);
  });

  it('hides codes from everyone but the host', () => {
    const sim = new Sim({ registrationApproval: true });
    sim.do({ type: 'createInvites', by: 'host', count: 1, maxUses: 1 });
    const [code] = sim.of('invitesCreated')[0].codes;
    sim.register(1, 0, code);
    expect(viewFor(sim.state, 'host').invites).toHaveLength(1);
    const player = viewFor(sim.state, 'p0');
    expect(player.invites).toBeUndefined();
    expect(player.requests[0].code).toBeUndefined();
    expect(JSON.stringify(player)).not.toContain(code);
  });

  it('refuses bad batches', () => {
    const sim = new Sim();
    expect(() => sim.do({ type: 'createInvites', by: 'host', count: 0, maxUses: 1 })).toThrow('Make 1-200 codes at a time');
    expect(() => sim.do({ type: 'createInvites', by: 'host', count: 1, maxUses: 0 })).toThrow();
    expect(() => sim.do({ type: 'createInvites', by: 'host', count: 2, maxUses: 1, codes: ['AAAA2222', 'AAAA2222'] })).toThrow('Those codes are not usable');
  });
});

describe('check-in groups', () => {
  const checkIn = { groups: [{ firstN: 2, waitMinutes: 10 }, { firstN: null, waitMinutes: 10 }], opensMinutesBefore: 30 };

  it('opens groups in order before a scheduled start and drops anyone who did not check in', () => {
    const sim = new Sim({ start: { kind: 'scheduled', startAt: START }, maxEntrants: 3, checkIn });
    sim.register(5);
    // The list may run past max entrants.
    expect(sim.state.entries).toHaveLength(5);
    expect(nextWakeAt(sim.state)).toBe(START - 30 * MIN);
    expect(playerOptions(sim.state, 'p0').canCheckIn).toBe(false);
    expect(() => sim.do({ type: 'checkIn', playerId: 'p0' })).toThrow("Your check-in group isn't open yet");

    sim.at(START - 30 * MIN);
    expect(sim.of('checkInOpened')).toEqual([{ type: 'checkInOpened', group: 1, playerIds: ['p0', 'p1'] }]);
    expect(playerOptions(sim.state, 'p0').canCheckIn).toBe(true);
    expect(playerOptions(sim.state, 'p3')).toMatchObject({ canCheckIn: false, checkInOpensAt: START - 20 * MIN });
    sim.do({ type: 'checkIn', playerId: 'p0' });
    expect(summarize(sim.state, sim.now).checkIn).toMatchObject({ checkedIn: 1, notCheckedIn: 4, groupsOpen: 1, groups: 2, msToNextGroup: 10 * MIN });

    expect(nextWakeAt(sim.state)).toBe(START - 20 * MIN);
    sim.at(START - 20 * MIN);
    expect(sim.of('checkInOpened')[1]).toEqual({ type: 'checkInOpened', group: 2, playerIds: ['p2', 'p3', 'p4'] });
    sim.do({ type: 'checkIn', playerId: 'p4' });
    sim.do({ type: 'checkIn', playerId: 'p2' });
    // Three seats, three checked in: the rest wait in vain.
    expect(playerOptions(sim.state, 'p1').canCheckIn).toBe(false);
    expect(() => sim.do({ type: 'checkIn', playerId: 'p1' })).toThrow('Every seat is taken');

    sim.at(START - 60_000);
    expect(sim.of('unregistered').map((e) => [e.playerId, e.reason])).toEqual([
      ['p1', 'not-checked-in'],
      ['p3', 'not-checked-in'],
    ]);
    expect(sim.state.entries.map((e) => [e.playerId, e.status])).toEqual([
      ['p0', 'seated'],
      ['p2', 'seated'],
      ['p4', 'seated'],
    ]);
  });

  it('a scheduled start with fewer than 2 checked in waits for check-ins', () => {
    const sim = new Sim({ start: { kind: 'scheduled', startAt: START }, checkIn: { groups: [{ firstN: null, waitMinutes: 5 }], opensMinutesBefore: 15 } });
    sim.register(3);
    sim.at(START - 15 * MIN);
    sim.do({ type: 'checkIn', playerId: 'p0' });
    sim.at(START);
    expect(sim.state.status).toBe('registering');
    expect(sim.of('startDelayed')).toHaveLength(1);
    sim.do({ type: 'checkIn', playerId: 'p1' });
    expect(sim.state.status).toBe('running');
    expect(sim.state.entries.map((e) => e.playerId)).toEqual(['p0', 'p1']);
  });

  it('the host opens check-in for an event they start themselves', () => {
    const sim = new Sim({ checkIn: { groups: [{ firstN: null, waitMinutes: 5 }], opensMinutesBefore: 15 } });
    sim.register(3);
    expect(() => sim.do({ type: 'startNow', by: 'host' })).toThrow('Need at least 2 checked-in players');
    sim.do({ type: 'openCheckIn', by: 'host' });
    expect(sim.of('checkInOpened')[0].playerIds).toEqual(['p0', 'p1', 'p2']);
    sim.do({ type: 'checkIn', playerId: 'p0' });
    sim.do({ type: 'checkIn', playerId: 'p2' });
    sim.do({ type: 'startNow', by: 'host' });
    expect(sim.state.entries.map((e) => e.playerId)).toEqual(['p0', 'p2']);
    // Late registration after the draw needs no check-in.
    expect(playerOptions(sim.state, 'p1').canCheckIn).toBe(false);
  });

  it('validates check-in settings', () => {
    const base = defaultSettings({ start: { kind: 'scheduled', startAt: START } });
    expect(validateSettings({ ...base, checkIn: { groups: [], opensMinutesBefore: 30 } })).toContain('Check-in needs 1-15 groups');
    expect(validateSettings({ ...base, checkIn: { groups: [{ firstN: null, waitMinutes: 0 }], opensMinutesBefore: 30 } })).toContain(
      'The wait before the next check-in group must be 1-599 minutes',
    );
    expect(validateSettings({ ...base, seatLeadSeconds: 600, checkIn: { groups: [{ firstN: null, waitMinutes: 5 }], opensMinutesBefore: 10 } })).toContain(
      'Check-in must open before the seats are drawn',
    );
    expect(
      validateSettings({ ...base, start: { kind: 'sng', playersNeeded: 2, startDelaySeconds: 0, autoSpawn: false }, checkIn: { groups: [{ firstN: null, waitMinutes: 5 }], opensMinutesBefore: 10 } }),
    ).toContain('Sit & Go events have no check-in');
    expect(validateSettings({ ...base, checkIn: { groups: [{ firstN: 5, waitMinutes: 30 }, { firstN: null, waitMinutes: 5 }], opensMinutesBefore: 30 } })).toContain(
      'Every check-in group must open before the seats are drawn',
    );
    expect(validateSettings({ ...base, checkIn })).toEqual([]);
  });
});
