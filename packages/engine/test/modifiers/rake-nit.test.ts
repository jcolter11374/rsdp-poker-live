import { describe, expect, it } from 'vitest';
import { engine, type HandState } from '../../src/core';
import { nitClears, rakeFor, rakeSchema, type RakeSettings } from '../../src/modifiers';
import { eventsOf, holdemTop, stacks, start } from '../core/harness';

function checkDown(s: HandState) {
  for (let i = 0; i < 100 && s.phase === 'betting' && s.toAct !== null; i++) {
    const legal = engine.legalActions(s, s.toAct)!;
    engine.act(s, s.toAct, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
}

const rake = (patch: Partial<RakeSettings> = {}) => ({ id: 'rake', settings: { ...rakeSchema.defaults(), enabled: true, ...patch } });

describe('simulated rake', () => {
  const top = holdemTop({ 0: ['As', 'Ah'], 1: ['Kd', 'Kc'], 2: ['9h', '8h'] }, ['2c', '7d', '3h', 'Ts', '4c'], 0);

  it('takes the percentage, rounded down, and caps it', () => {
    const s = start({ stacks: [100, 100, 100], button: 0, top, modifiers: [rake({ percent: 5 })] });
    engine.act(s, 0, { type: 'raise', to: 21 });
    engine.act(s, 1, { type: 'call' });
    engine.act(s, 2, { type: 'call' });
    checkDown(s);
    // Pot 63: 5% is 3.15, so 3.
    expect(eventsOf(s, 'transfer')).toMatchObject([{ kind: 'rake', amount: 3 }]);
    const capped = start({ stacks: [100, 100, 100], button: 0, top, modifiers: [rake({ percent: 10, cap: 4 })] });
    engine.act(capped, 0, { type: 'raise', to: 21 });
    engine.act(capped, 1, { type: 'call' });
    engine.act(capped, 2, { type: 'call' });
    checkDown(capped);
    // 10% of 63 is 6, capped at 4.
    expect(eventsOf(capped, 'transfer')).toMatchObject([{ kind: 'rake', amount: 4 }]);
  });

  it('no flop, no fee; minimum pot; short-handed rate', () => {
    const pre = start({ stacks: [100, 100, 100], button: 0, top, modifiers: [rake()] });
    for (let i = 0; i < 2; i++) engine.act(pre, pre.toAct!, { type: 'fold' });
    expect(eventsOf(pre, 'transfer')).toHaveLength(0);
    const pot = { amount: 200, eligible: [0, 1] };
    const flopped = start({ stacks: [100, 100, 100], button: 0, top });
    checkDown(flopped);
    const cfg = { ...rakeSchema.defaults(), enabled: true, percent: 5 };
    expect(rakeFor(pot, flopped, cfg)).toBe(10);
    expect(rakeFor(pot, flopped, { ...cfg, minPot: 1000 })).toBe(0);
    expect(rakeFor(pot, flopped, { ...cfg, shortHanded: { players: 3, percent: 2.5, cap: 0 } })).toBe(5);
    expect(rakeFor(pot, flopped, { ...cfg, shortHanded: { players: 2, percent: 2.5, cap: 0 } })).toBe(10);
    // A short-handed cap of 0 keeps the normal cap rather than removing it.
    expect(rakeFor(pot, flopped, { ...cfg, cap: 3, shortHanded: { players: 3, percent: 2.5, cap: 0 } })).toBe(3);
    expect(rakeFor(pot, flopped, { ...cfg, cap: 3, shortHanded: { players: 3, percent: 2.5, cap: 4 } })).toBe(4);
  });

  it('keeps chips balanced: stacks plus rake equal what came in', () => {
    const s = start({ stacks: [100, 100, 100], button: 0, top, modifiers: [rake({ percent: 10 })] });
    checkDown(s);
    const taken = eventsOf(s, 'transfer').reduce((n, e) => n + e.amount, 0);
    expect(Object.values(stacks(s)).reduce((a, b) => a + b, 0) + taken).toBe(300);
  });
});

describe('nit clearing', () => {
  it('an outright win clears; losers and folders do not', () => {
    const top = holdemTop({ 0: ['As', 'Ah'], 1: ['Kd', 'Kc'], 2: ['9h', '8h'] }, ['2c', '7d', '3h', 'Ts', '4c'], 0);
    const s = start({ stacks: [100, 100, 100], button: 0, top });
    engine.act(s, 0, { type: 'call' });
    engine.act(s, 1, { type: 'call' });
    engine.act(s, 2, { type: 'fold' });
    checkDown(s);
    expect(nitClears(s, [0, 1, 2])).toEqual([0]);
  });

  it('an uncontested win clears, a chop does not', () => {
    const top = holdemTop({ 0: ['As', '4h'], 1: ['Ad', '4c'], 2: ['8d', '5h'] }, ['Ac', '7d', '9h', 'Ts', 'Kc'], 0);
    const chop = start({ stacks: [100, 100, 100], button: 0, top });
    checkDown(chop);
    expect(nitClears(chop, [0, 1, 2])).toEqual([]);
    const fold = start({ stacks: [100, 100, 100], button: 0, top });
    engine.act(fold, 0, { type: 'raise', to: 10 });
    engine.act(fold, 1, { type: 'fold' });
    engine.act(fold, 2, { type: 'fold' });
    expect(nitClears(fold, [0, 1, 2])).toEqual([0]);
  });

  it('winning only the main pot while losing a side pot does not clear', () => {
    const top = holdemTop({ 0: ['Ks', 'Kh'], 1: ['As', 'Ah'], 2: ['Qd', 'Qc'] }, ['2c', '7d', '9h', 'Ts', '3c'], 0);
    const s = start({ stacks: [100, 20, 100], button: 0, top });
    engine.act(s, 0, { type: 'raise', to: 50 });
    engine.act(s, 1, { type: 'call' });
    engine.act(s, 2, { type: 'call' });
    checkDown(s);
    // Seat 1 wins the main pot only (it was in nothing else): clears. Seat 0 wins the side pot but lost the main: no.
    expect(nitClears(s, [0, 1, 2])).toEqual([1]);
  });
});
