import { describe, expect, it } from 'vitest';
import { engine, type HandState } from '../../src/core';
import {
  bombPotDue,
  bombPotSchema,
  bounty72Schema,
  doubleBoard,
  doubleBoardSchema,
  isSevenDeuce,
  type Bounty72Settings,
} from '../../src/modifiers';
import { defaultSettings, parseSettings } from '../../src/settings';
import { eventsOf, holdemTop, stacks, start, startTotal } from '../core/harness';

/** Checks or calls until the hand ends. */
function checkDown(s: HandState) {
  for (let i = 0; i < 200 && s.phase === 'betting' && s.toAct !== null; i++) {
    const legal = engine.legalActions(s, s.toAct)!;
    engine.act(s, s.toAct, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
}

function foldAround(s: HandState) {
  for (let i = 0; i < 20 && s.phase === 'betting' && s.toAct !== null; i++) engine.act(s, s.toAct, { type: 'fold' });
}

const bounty = (patch: Partial<Bounty72Settings> = {}) => ({ id: 'bounty-72', settings: { ...bounty72Schema.defaults(), enabled: true, amount: 10, autoShow: false, ...patch } });

describe('settings sections', () => {
  it('registers bomb pot, double board and 7-2 sections, off by default and cash only', () => {
    const cash = defaultSettings('cash');
    expect(bombPotSchema.get(cash)).toMatchObject({ enabled: false, chancePercent: 10, bigBlinds: 5, gameId: '' });
    expect(doubleBoardSchema.get(cash)).toEqual({ enabled: false, when: 'bomb-pots' });
    expect(bounty72Schema.get(cash)).toMatchObject({ enabled: false, suits: 'any' });
    const t = defaultSettings('tournament');
    t.modifiers['bounty-72'] = { ...bounty72Schema.defaults(), enabled: true };
    expect(() => parseSettings(t)).toThrow(/cash games only/);
  });
});

describe('bomb pot rule', () => {
  const cfg = { ...bombPotSchema.defaults(), enabled: true, chancePercent: 0 };
  const never = () => 99;
  it('the host button always wins, even with bomb pots off', () => {
    expect(bombPotDue({ ...cfg, enabled: false }, { handsSince: 0, requested: true, rng: never })).toBe(true);
    expect(bombPotDue({ ...cfg, enabled: false, chancePercent: 100 }, { handsSince: 0, requested: false, rng: () => 0 })).toBe(false);
  });
  it('every N hands counts from the last bomb pot', () => {
    const every = { ...cfg, everyHands: 3 };
    expect([0, 1, 2, 3].map((handsSince) => bombPotDue(every, { handsSince, requested: false, rng: never }))).toEqual([false, false, true, true]);
  });
  it('rolls the chance each hand', () => {
    const chance = { ...cfg, chancePercent: 25 };
    expect(bombPotDue(chance, { handsSince: 0, requested: false, rng: () => 24 })).toBe(true);
    expect(bombPotDue(chance, { handsSince: 0, requested: false, rng: () => 25 })).toBe(false);
  });
  it('a bomb pot hand skips preflop betting and starts after the button', () => {
    const s = start({ stacks: [100, 100, 100], button: 0, bombPot: 10 });
    expect(eventsOf(s, 'post').map((p) => [p.seat, p.kind, p.amount])).toEqual([
      [0, 'bomb-pot', 10],
      [1, 'bomb-pot', 10],
      [2, 'bomb-pot', 10],
    ]);
    expect(s.street).toBe(1);
    expect(s.runs[0][0]).toHaveLength(3);
    expect(s.toAct).toBe(1);
  });
});

describe('double board', () => {
  const run = (when: 'always' | 'bomb-pots', bombPot: boolean, game = 'nlhe', players = 3) => {
    const s = start({ game, stacks: Array(players).fill(100), bombPot: bombPot ? 4 : undefined });
    return doubleBoard.beforeHand!(s.input, { enabled: true, when }, () => 0).options.boards;
  };
  it('deals two boards always, or only in bomb pots', () => {
    expect(run('always', false)).toBe(2);
    expect(run('bomb-pots', false)).toBe(1);
    expect(run('bomb-pots', true)).toBe(2);
  });
  it('stays on one board when the deck is too small or there is no board', () => {
    expect(run('always', false, 'plo5', 9)).toBe(1);
    expect(run('always', false, 'stud', 3)).toBe(1);
  });
  it('splits each pot between the boards', () => {
    // Seat 1 has aces (wins board 1), seat 2 makes a flush on board 2.
    const top = [...holdemTop({ 0: ['3c', '4d'], 1: ['As', 'Ad'], 2: ['Kh', 'Qh'] }, [], 0), 'Ac', '7d', '9s', '2h', '5h', '8h', 'Tc', 'Jd', '3s', '4s'];
    const s = start({ stacks: [100, 100, 100], button: 0, top, options: { boards: 2 } });
    checkDown(s);
    expect(s.runs[0]).toHaveLength(2);
    const won = Object.fromEntries([1, 2].map((seat) => [seat, s.awards.filter((a) => a.seat === seat).map((a) => a.board)]));
    expect(won[1]).toContain(0);
    expect(Object.values(stacks(s)).reduce((a, b) => a + b, 0)).toBe(startTotal(s));
  });
});

describe('7-2 bounty', () => {
  it('recognises 7-2 hands with the suit rule', () => {
    expect(isSevenDeuce(['7c', '2d'], 'any')).toBe(true);
    expect(isSevenDeuce(['2d', '7d'], 'offsuit')).toBe(false);
    expect(isSevenDeuce(['2d', '7d'], 'suited')).toBe(true);
    expect(isSevenDeuce(['7c', '3d'], 'any')).toBe(false);
  });

  it('a 7-2 that wins at showdown collects from every other player dealt in', () => {
    const top = holdemTop({ 0: ['7c', '2d'], 1: ['Kd', 'Qc'], 2: ['9h', '8h'] }, ['7h', '7s', '2c', 'Js', '3d'], 2);
    const s = start({ stacks: [100, 100, 5], button: 2, top, modifiers: [bounty()] });
    checkDown(s);
    const t = eventsOf(s, 'transfer').map((e) => [e.from, e.to, e.amount]);
    // Seat 2 has 3 left after the blinds-and-calls, so pays what it has.
    expect(t).toEqual([
      [1, 0, 10],
      [2, 0, 3],
    ]);
    expect(Object.values(stacks(s)).reduce((a, b) => a + b, 0)).toBe(startTotal(s));
  });

  it('an uncontested 7-2 pays only once its cards are shown, and only once', () => {
    const top = holdemTop({ 0: ['7c', '2d'], 1: ['Kd', 'Qc'], 2: ['9h', '8h'] }, [], 2);
    const s = start({ stacks: [100, 100, 100], button: 2, top, modifiers: [bounty()] });
    // Seat 0 (small blind) raises, the big blind and button fold.
    engine.act(s, s.toAct!, { type: 'fold' }); // button
    engine.act(s, 0, { type: 'raise', to: 10 });
    engine.act(s, 1, { type: 'fold' });
    expect(s.phase).toBe('complete');
    expect(eventsOf(s, 'transfer')).toHaveLength(0);
    engine.show(s, 0, [0]);
    expect(eventsOf(s, 'transfer')).toHaveLength(0);
    engine.show(s, 0, [1]);
    expect(eventsOf(s, 'transfer').map((e) => [e.from, e.to, e.amount])).toEqual([
      [1, 0, 10],
      [2, 0, 10],
    ]);
    engine.show(s, 0, [0, 1]);
    expect(eventsOf(s, 'transfer')).toHaveLength(2);
    expect(stacks(s)).toEqual({ 0: 100 + 2 + 20, 1: 98 - 10, 2: 90 });
  });

  it('a losing 7-2 or a folded one earns nothing', () => {
    const top = holdemTop({ 0: ['7c', '2d'], 1: ['Ad', 'Ac'], 2: ['9h', '8h'] }, ['Kh', 'Qs', '4c', 'Js', '3d'], 2);
    const s = start({ stacks: [100, 100, 100], button: 2, top, modifiers: [bounty()] });
    checkDown(s);
    expect(eventsOf(s, 'transfer')).toHaveLength(0);
    const f = start({ stacks: [100, 100, 100], button: 2, top, modifiers: [bounty()] });
    foldAround(f);
    expect(eventsOf(f, 'transfer')).toHaveLength(0);
  });

  it('two 7-2 winners share each payer bounty', () => {
    const top = holdemTop({ 0: ['7c', '2d'], 1: ['7d', '2c'], 2: ['9h', '8h'] }, ['Ah', 'Ks', 'Qc', 'Js', 'Td'], 2);
    const s = start({ stacks: [100, 100, 100], button: 2, top, modifiers: [bounty({ amount: 5 })] });
    checkDown(s);
    // Broadway on the board: a three-way chop, and seat 2 pays both 7-2 holders.
    const t = eventsOf(s, 'transfer').map((e) => [e.from, e.to, e.amount]);
    expect(t).toEqual([
      [2, 0, 3],
      [2, 1, 2],
    ]);
  });
});
