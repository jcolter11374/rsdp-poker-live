import { describe, expect, it } from 'vitest';
import { engine, RUNOUT_SETTLE_MS, RUNOUT_STEP_MS, runoutMs, runoutSteps } from '../../src/core';
import { start } from './harness';

const { act } = engine;
const shape = (s: ReturnType<typeof start>) => runoutSteps(s.events).map((step) => step.map((e) => `${e.run}.${e.board}:${e.cards.length}`));

describe('runout steps', () => {
  it('splits an all-in before the flop into the flop, the turn and the river', () => {
    const s = start({ stacks: [100, 100] });
    act(s, 0, { type: 'raise', to: 100 });
    act(s, 1, { type: 'call' });
    expect(shape(s)).toEqual([['0.0:3'], ['0.0:1'], ['0.0:1']]);
    expect(runoutMs(s.events)).toBe(3 * RUNOUT_STEP_MS + RUNOUT_SETTLE_MS);
  });

  it('finishes the first run before the second', () => {
    const s = start({ stacks: [100, 100], options: { runItTwice: 'always' } });
    act(s, 0, { type: 'raise', to: 100 });
    act(s, 1, { type: 'call' });
    expect(shape(s)).toEqual([['0.0:3'], ['0.0:1'], ['0.0:1'], ['1.0:3'], ['1.0:1'], ['1.0:1']]);
  });

  it('deals every board of a double board together, street by street', () => {
    const s = start({ stacks: [100, 100], options: { boards: 2 } });
    act(s, 0, { type: 'raise', to: 100 });
    act(s, 1, { type: 'call' });
    expect(shape(s)).toEqual([
      ['0.0:3', '0.1:3'],
      ['0.0:1', '0.1:1'],
      ['0.0:1', '0.1:1'],
    ]);
  });

  it('is empty when the hand was played out', () => {
    const s = start({ stacks: [100, 100] });
    act(s, 0, { type: 'fold' });
    expect(runoutSteps(s.events)).toEqual([]);
    expect(runoutMs(s.events)).toBe(0);
  });
});
