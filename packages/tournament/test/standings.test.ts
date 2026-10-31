import { describe, expect, it } from 'vitest';
import { apply, createTournament, currentPrizePool, defaultSettings, payoutPreset, standings, type Command, type StructureRow, type TournamentState } from '../src';

const T0 = Date.parse('2026-10-30T00:00:00Z');
const levels: StructureRow[] = [
  { kind: 'level', sb: 50, bb: 100, ante: 0, anteType: 'none', minutes: 10, rebuy: true },
  { kind: 'level', sb: 100, bb: 200, ante: 0, anteType: 'none', minutes: 10, rebuy: true },
  { kind: 'break', minutes: 5, addOn: true },
  { kind: 'level', sb: 200, bb: 400, ante: 0, anteType: 'none', minutes: 10 },
];

describe('standings after a re-entry', () => {
  it('count the rebuys of every entry the player paid for (lobby tags, results CSV)', () => {
    let s: TournamentState = createTournament({
      id: 'T',
      hostId: 'host',
      settings: defaultSettings({
        structure: levels,
        startingStack: 1000,
        lateRegistration: { enabled: false, throughLevel: null },
        rebuy: { max: 1, chips: 1000, approval: false, offerSeconds: 15 },
        reEntry: { enabled: true, throughLevel: 2, max: 1, approval: false },
        payouts: { structure: payoutPreset('standard', 600), money: { buyIn: 2000, rebuy: 2000 } },
      }),
      now: T0,
      seed: 42,
    });
    const run = (cmd: Command) => (s = apply(s, cmd, T0).state);
    for (const p of ['p0', 'p1', 'p2']) run({ type: 'register', playerId: p, displayName: p.toUpperCase() });
    run({ type: 'startNow', by: 'host' });
    const t = s.tables[0];
    const bust = (loser: string) => {
      const ids = t.seats.length ? s.tables[0].seats.filter((x): x is string => !!x).map((id) => s.entries.find((e) => e.id === id)!) : [];
      const start = Object.fromEntries(ids.map((e) => [e.playerId, e.stack]));
      const end = { ...start, p0: start.p0 + start[loser], [loser]: 0 };
      const n = s.tables[0].lastHandNumber + 1;
      run({ type: 'handStarted', tableId: t.id, handNumber: n });
      run({ type: 'handResult', result: { tableId: t.id, handNumber: n, startStacks: start, endStacks: end, knockedOutBy: { [loser]: ['p0'] } } });
    };
    bust('p1'); // rebuy offer
    run({ type: 'rebuy', playerId: 'p1' }); // pays a $20 rebuy
    bust('p1'); // no rebuys left: busted
    run({ type: 'reEnter', playerId: 'p1' }); // pays a $20 re-entry
    // Money in: 3 buy-ins + p1's re-entry + p1's rebuy = 5 x $20 (the pool knows it).
    expect(currentPrizePool(s)).toBe(5 * 2000);
    const p1 = standings(s).find((r) => r.playerId === 'p1')!;
    expect(p1.entryNo).toBe(2);
    // p1 paid for one rebuy; the results row (lobby "R1" tag, CSV "Rebuys" column, what the host settles from) should say so.
    expect(p1.rebuys).toBe(1);
  });
});
