import { describe, expect, it } from 'vitest';
import { apply, createTournament, defaultSettings, standings, tick, type Command, type DirectorEvent, type StructureRow, type TournamentSettings, type TournamentState } from '../src';

const T0 = Date.parse('2026-10-30T00:00:00Z');
const levels: StructureRow[] = [
  { kind: 'level', sb: 50, bb: 100, ante: 0, anteType: 'none', minutes: 30, rebuy: true },
  { kind: 'level', sb: 100, bb: 200, ante: 0, anteType: 'none', minutes: 30 },
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
      seed: 42,
    });
  }
  do(cmd: Command) {
    const r = apply(this.state, cmd, this.now);
    this.state = r.state;
    this.events.push(...r.events);
  }
  at(t: number) {
    this.now = t;
    const r = tick(this.state, t);
    this.state = r.state;
    this.events.push(...r.events);
  }
  entry(playerId: string) {
    return this.state.entries.filter((e) => e.playerId === playerId).at(-1)!;
  }
  /** Plays a hand at a table; `stacks` sets start stacks, `bust` lose everything to `winner`. */
  hand(tableId: string, winner: string, bust: string[]) {
    const t = this.state.tables.find((x) => x.id === tableId)!;
    const ids = t.seats.filter((x): x is string => !!x).map((id) => this.state.entries.find((e) => e.id === id)!);
    const start = Object.fromEntries(ids.map((e) => [e.playerId, e.stack]));
    const end = { ...start };
    for (const b of bust) {
      end[winner] += end[b];
      end[b] = 0;
    }
    const handNumber = t.lastHandNumber + 1;
    this.do({ type: 'handStarted', tableId, handNumber });
    this.do({ type: 'handResult', result: { tableId, handNumber, startStacks: start, endStacks: end, knockedOutBy: Object.fromEntries(bust.map((b) => [b, [winner]])) } });
  }
  players(tableId: string) {
    const t = this.state.tables.find((x) => x.id === tableId)!;
    return t.seats.filter((x): x is string => !!x).map((id) => this.state.entries.find((e) => e.id === id)!.playerId);
  }
  places() {
    return Object.fromEntries(standings(this.state).map((s) => [s.playerId, s.place]));
  }
}

const rebuyOnce = { rebuy: { max: 1, chips: 1000, approval: false, offerSeconds: 15 } };

describe('places after a rebuy offer', () => {
  /** Two tables; the first player busted at one, then (still offered a rebuy) a player out of rebuys busts at the other. */
  function twoTables() {
    const sim = new Sim({ ...rebuyOnce, seatsPerTable: 3 });
    for (let i = 0; i < 6; i++) sim.do({ type: 'register', playerId: `p${i}`, displayName: `P${i}` });
    sim.do({ type: 'startNow', by: 'host' });
    const [a, b] = sim.state.tables.map((t) => t.id);
    return { sim, a, b };
  }

  it('a player who lets the offer run out ranks by when they busted, below someone who busted after them', () => {
    const { sim, a, b } = twoTables();
    const [aWin, early] = sim.players(a);
    const [bWin, late] = sim.players(b);
    // `late` has used up their rebuy: they go out at once when they bust.
    sim.state.entries.find((e) => e.playerId === late)!.rebuys = 1;
    sim.hand(a, aWin, [early]);
    expect(sim.entry(early).status).toBe('rebuy-offer');
    sim.now += 5_000;
    sim.hand(b, bWin, [late]);
    expect(sim.entry(late).status).toBe('busted');
    sim.at(T0 + 15_000);
    expect(sim.entry(early).status).toBe('busted');
    expect({ early: sim.places()[early], late: sim.places()[late] }).toEqual({ early: 6, late: 5 });
  });

  it('the same when they decline the offer', () => {
    const { sim, a, b } = twoTables();
    const [aWin, early] = sim.players(a);
    const [bWin, late] = sim.players(b);
    sim.state.entries.find((e) => e.playerId === late)!.rebuys = 1;
    sim.hand(a, aWin, [early]);
    sim.now += 5_000;
    sim.hand(b, bWin, [late]);
    sim.now += 2_000;
    sim.do({ type: 'declineRebuy', playerId: early });
    expect({ early: sim.places()[early], late: sim.places()[late] }).toEqual({ early: 6, late: 5 });
  });

  it('busted in the same hand as someone out of rebuys: the bigger starting stack still places higher', () => {
    const sim = new Sim(rebuyOnce);
    for (let i = 0; i < 4; i++) sim.do({ type: 'register', playerId: `p${i}`, displayName: `P${i}` });
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    const [win, small, big] = sim.players(t);
    sim.state.entries.find((e) => e.playerId === small)!.stack = 400;
    sim.state.entries.find((e) => e.playerId === win)!.stack = 1600;
    // `big` has used their rebuy, so goes out at once; `small` is offered one and lets it run out.
    sim.state.entries.find((e) => e.playerId === big)!.rebuys = 1;
    sim.hand(t, win, [small, big]);
    expect(sim.entry(small).status).toBe('rebuy-offer');
    expect(sim.entry(big).status).toBe('busted');
    sim.at(T0 + 15_000);
    expect(sim.places()).toMatchObject({ [small]: 4, [big]: 3 });
  });

  it('two busted in the same hand with equal stacks tie, however their offers end', () => {
    const sim = new Sim(rebuyOnce);
    for (let i = 0; i < 4; i++) sim.do({ type: 'register', playerId: `p${i}`, displayName: `P${i}` });
    sim.do({ type: 'startNow', by: 'host' });
    const t = sim.state.tables[0].id;
    const [win, x, y] = sim.players(t);
    sim.hand(t, win, [x, y]);
    sim.now += 3_000;
    sim.do({ type: 'declineRebuy', playerId: x });
    sim.at(T0 + 15_000);
    expect(sim.places()).toMatchObject({ [x]: 3, [y]: 3 });
  });

  it('offers that run out together at different tables, from different hands, keep their bust order', () => {
    const { sim, a, b } = twoTables();
    const [aWin, early] = sim.players(a);
    const [bWin, late] = sim.players(b);
    sim.hand(a, aWin, [early]);
    sim.now += 5_000;
    sim.hand(b, bWin, [late]);
    // A late tick (say after a restart) ends both offers at once.
    sim.at(T0 + 60_000);
    expect({ early: sim.places()[early], late: sim.places()[late] }).toEqual({ early: 6, late: 5 });
  });

  it('a rebuy taken still leaves the others in bust order', () => {
    const { sim, a, b } = twoTables();
    const [aWin, early] = sim.players(a);
    const [bWin, late] = sim.players(b);
    sim.state.entries.find((e) => e.playerId === late)!.rebuys = 1;
    sim.hand(a, aWin, [early]);
    sim.now += 5_000;
    sim.hand(b, bWin, [late]);
    sim.do({ type: 'rebuy', playerId: early });
    expect(sim.entry(early).status).toBe('seated');
    expect(sim.places()[late]).toBe(6);
  });

  it('hand-for-hand: a player whose offer runs out ties with someone busted at another table in the same round', () => {
    const sim = new Sim({
      seatsPerTable: 2,
      rebuy: { max: 1, chips: 1000, approval: false, offerSeconds: 300 },
      payouts: { structure: { name: 'custom', ranges: [{ minEntries: 2, maxEntries: 3, percents: [70, 30] }, { minEntries: 4, maxEntries: 600, percents: [50, 30, 20] }] }, money: { buyIn: 100 } },
    });
    for (let i = 0; i < 4; i++) sim.do({ type: 'register', playerId: `p${i}`, displayName: `P${i}` });
    sim.do({ type: 'startNow', by: 'host' });
    expect(sim.state.handForHand.active).toBe(true);
    const [a, b] = sim.state.tables.map((t) => t.id);
    const [aWin, offered] = sim.players(a);
    const [bWin, out] = sim.players(b);
    sim.state.entries.find((e) => e.playerId === out)!.rebuys = 1;
    sim.hand(a, aWin, [offered]);
    sim.now += 5_000;
    sim.hand(b, bWin, [out]);
    expect(sim.entry(out).status).toBe('busted');
    sim.at(sim.now + 301_000);
    expect(sim.entry(offered).status).toBe('busted');
    expect({ offered: sim.places()[offered], out: sim.places()[out] }).toEqual({ offered: 3, out: 3 });
  });
});
