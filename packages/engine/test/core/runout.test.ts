import { describe, expect, it } from 'vitest';
import { engine, RUN_TWICE_STEP_MS, RUNOUT_LAST_STEP_MS, RUNOUT_SETTLE_MS, RUNOUT_STEP_MS, runoutMs, runoutSteps, runoutWaits, type HandEvent, type HandState } from '../../src/core';
import { start } from './harness';

const { act } = engine;
const shape = (s: ReturnType<typeof start>) => runoutSteps(s.events).map((step) => step.map((e) => (e.t === 'board' ? `${e.run}.${e.board}:${e.cards.length}` : `deal ${e.seat}`)));

describe('runout steps', () => {
  it('splits an all-in before the flop into the flop, the turn and the river', () => {
    const s = start({ stacks: [100, 100] });
    act(s, 0, { type: 'raise', to: 100 });
    act(s, 1, { type: 'call' });
    expect(shape(s)).toEqual([['0.0:3'], ['0.0:1'], ['0.0:1']]);
    // The river waits longer than the flop and the turn: the build-up (#308).
    expect(runoutWaits(s.events)).toEqual([RUNOUT_STEP_MS, RUNOUT_STEP_MS, RUNOUT_LAST_STEP_MS]);
    expect(RUNOUT_LAST_STEP_MS).toBeGreaterThan(RUNOUT_STEP_MS);
    expect(runoutMs(s.events)).toBe(2 * RUNOUT_STEP_MS + RUNOUT_LAST_STEP_MS + RUNOUT_SETTLE_MS);
  });

  it('gives a flop all-in its build-up before the river too', () => {
    const s = start({ stacks: [100, 100] });
    // Check and call up to the flop, then all in.
    while (s.street < 1) act(s, s.toAct!, engine.legalActions(s, s.toAct!)!.canCheck ? { type: 'check' } : { type: 'call' });
    act(s, s.toAct!, { type: 'raise', to: engine.legalActions(s, s.toAct!)!.maxTo });
    act(s, s.toAct!, { type: 'call' });
    expect(shape(s)).toEqual([['0.0:1'], ['0.0:1']]);
    expect(runoutWaits(s.events)).toEqual([RUNOUT_STEP_MS, RUNOUT_LAST_STEP_MS]);
  });

  it('finishes the first run before the second', () => {
    const s = start({ stacks: [100, 100], options: { runItTwice: 'always' } });
    act(s, 0, { type: 'raise', to: 100 });
    act(s, 1, { type: 'call' });
    expect(shape(s)).toEqual([['0.0:3'], ['0.0:1'], ['0.0:1'], ['1.0:3'], ['1.0:1'], ['1.0:1']]);
    // Run it twice is dealt slower.
    expect(runoutWaits(s.events)).toEqual(Array(6).fill(RUN_TWICE_STEP_MS));
    expect(runoutMs(s.events)).toBe(6 * RUN_TWICE_STEP_MS + RUNOUT_SETTLE_MS);
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

describe('stud runout steps (#216)', () => {
  const STUD_STAKES = { ante: 1, anteType: 'per-player' as const, bringIn: 1, smallBet: 2, bigBet: 4 };
  /** Each step as its deals (`d<seat>:<cards>`, a down card as `v`, an up card as `^`) and shared cards (`b:<n>`). */
  const studShape = (events: readonly HandEvent[]) =>
    runoutSteps(events).map((step) => step.map((e) => (e.t === 'deal' ? `d${e.seat}:${e.cards.map((c) => (c.up ? '^' : 'v')).join('')}` : `b:${e.cards.length}`)));
  /** Everyone puts their chips in at the first chance (no limit, so one bet does it). */
  function shove(s: HandState) {
    for (let i = 0; i < 50 && s.phase === 'betting'; i++) {
      const legal = engine.legalActions(s, s.toAct!)!;
      act(s, s.toAct!, legal.canRaise && legal.maxTo > legal.callAmount ? { type: legal.raiseKind, to: legal.maxTo } : { type: 'call' });
    }
  }
  /** Checks and calls (bringing in on third street) until `street`. */
  function passiveTo(s: HandState, street: number) {
    for (let i = 0; i < 50 && s.phase === 'betting' && s.street < street; i++) {
      const legal = engine.legalActions(s, s.toAct!)!;
      act(s, s.toAct!, legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' });
    }
  }

  for (const game of ['stud', 'stud8', 'razz']) {
    it(`${game}: an all-in on third street shows fourth to seventh street, each street's cards for every seat together`, () => {
      const s = start({ game, betting: 'no-limit', stacks: [50, 50, 50], stakes: STUD_STAKES });
      shove(s);
      expect(s.phase).toBe('complete');
      const up = ['d2:^', 'd0:^', 'd1:^'];
      expect(studShape(s.events)).toEqual([up, up, up, ['d2:v', 'd0:v', 'd1:v']]);
      // The same pace as hold'em: a street every RUNOUT_STEP_MS, the build-up before the last, then the result.
      expect(runoutWaits(s.events)).toEqual([RUNOUT_STEP_MS, RUNOUT_STEP_MS, RUNOUT_STEP_MS, RUNOUT_LAST_STEP_MS]);
      expect(runoutMs(s.events)).toBe(3 * RUNOUT_STEP_MS + RUNOUT_LAST_STEP_MS + RUNOUT_SETTLE_MS);
    });
  }

  it('a later all-in shows only the streets still to come', () => {
    const s = start({ game: 'stud', betting: 'no-limit', stacks: [50, 50, 50], stakes: STUD_STAKES });
    passiveTo(s, 3);
    expect(s.input.game.streets[s.street].name).toBe('Sixth Street');
    shove(s);
    expect(s.phase).toBe('complete');
    expect(studShape(s.events)).toEqual([['d2:v', 'd0:v', 'd1:v']]);
    expect(runoutWaits(s.events)).toEqual([RUNOUT_LAST_STEP_MS]);
    expect(runoutMs(s.events)).toBe(RUNOUT_LAST_STEP_MS + RUNOUT_SETTLE_MS);
  });

  it('a folded seat gets no cards in the runout', () => {
    const s = start({ game: 'stud', betting: 'no-limit', stacks: [50, 50, 50], stakes: STUD_STAKES });
    // The low card brings in, the next player folds, and the other two put everything in.
    act(s, s.toAct!, { type: 'bring-in' });
    act(s, s.toAct!, { type: 'fold' });
    shove(s);
    expect(s.phase).toBe('complete');
    const steps = studShape(s.events);
    expect(steps).toHaveLength(4);
    for (const step of steps) expect(step).toHaveLength(2);
  });

  it('the shared card a short deck puts in the middle is the last street', () => {
    const s = start({ game: 'stud', betting: 'no-limit', stacks: Array(8).fill(50), stakes: STUD_STAKES });
    shove(s);
    expect(s.phase).toBe('complete');
    const steps = studShape(s.events);
    expect(steps.map((step) => step.length)).toEqual([8, 8, 8, 1]);
    expect(steps[3]).toEqual(['b:1']);
    expect(runoutWaits(s.events)).toEqual([RUNOUT_STEP_MS, RUNOUT_STEP_MS, RUNOUT_STEP_MS, RUNOUT_LAST_STEP_MS]);
  });

  it('a table sees the same steps and waits as the server, whatever cards it may see', () => {
    const s = start({ game: 'stud', betting: 'no-limit', stacks: [50, 50, 50], stakes: STUD_STAKES });
    shove(s);
    for (const viewer of [{ seat: 0, seeAll: false }, { seat: null, seeAll: false }, { seat: null, seeAll: true }]) {
      const seen = engine.visibleEvents(s, viewer);
      expect(studShape(seen)).toEqual(studShape(s.events));
      expect(runoutMs(seen)).toBe(runoutMs(s.events));
    }
    // A seat's hand comes to it in the order it was dealt, the runout's streets last.
    const dealt = (seat: number) => s.events.flatMap((e) => (e.t === 'deal' && e.seat === seat ? e.cards : []));
    for (const seat of [0, 1, 2]) expect(dealt(seat)).toEqual(s.seats.find((x) => x.seat === seat)!.cards);
  });

  it('stud runs once even where run it twice is always on', () => {
    const s = start({ game: 'stud', betting: 'no-limit', stacks: [50, 50], stakes: STUD_STAKES, options: { runItTwice: 'always' } });
    shove(s);
    expect(s.events.filter((e) => e.t === 'run-it')).toEqual([expect.objectContaining({ times: 1 })]);
    expect(runoutWaits(s.events)).toEqual([RUNOUT_STEP_MS, RUNOUT_STEP_MS, RUNOUT_STEP_MS, RUNOUT_LAST_STEP_MS]);
  });

  it('a stud hand played to the end has no runout', () => {
    const s = start({ game: 'stud', stacks: [50, 50, 50], stakes: STUD_STAKES });
    passiveTo(s, 99);
    expect(s.phase).toBe('complete');
    expect(runoutSteps(s.events)).toEqual([]);
    expect(runoutMs(s.events)).toBe(0);
  });
});
