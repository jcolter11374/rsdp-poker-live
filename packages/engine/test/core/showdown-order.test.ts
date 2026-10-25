import { describe, expect, it } from 'vitest';
import { engine, type HandState } from '../../src/core';
import { eventsOf, holdemTop, start } from './harness';

const act = engine.act;

function checkDown(s: HandState) {
  for (let i = 0; i < 100 && s.phase === 'betting' && s.toAct !== null; i++) {
    const legal = engine.legalActions(s, s.toAct)!;
    act(s, s.toAct, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
}

const shows = (s: HandState) => eventsOf(s, 'show').map((e) => e.seat);
const mucks = (s: HandState) => eventsOf(s, 'muck').map((e) => e.seat);
const board = ['2c', '7d', '9h', 'Ts', '3c'] as const;

describe('showdown with mucking', () => {
  it('checked through: first after the button shows, a worse hand behind it mucks, a better one shows', () => {
    // Button 0. Seat 1 shows first (pair of nines), seat 2 (ace high) mucks, seat 0 (aces) shows.
    const top = holdemTop({ 0: ['As', 'Ah'], 1: ['9c', '4d'], 2: ['Ad', '5h'] }, [...board], 0);
    const s = start({ stacks: [100, 100, 100], button: 0, top, options: { showdown: 'muck-losers' } });
    checkDown(s);
    expect(shows(s)).toEqual([1, 0]);
    expect(mucks(s)).toEqual([2]);
    expect(s.awards.map((a) => a.seat)).toEqual([0]);
  });

  it('the last aggressor on the river shows first', () => {
    const top = holdemTop({ 0: ['As', 'Ah'], 1: ['Kc', 'Kd'], 2: ['8d', '5h'] }, [...board], 0);
    const r = start({ stacks: [100, 100, 100], button: 0, top, options: { showdown: 'muck-losers' } });
    while (r.street < 3) {
      const legal = engine.legalActions(r, r.toAct!)!;
      act(r, r.toAct!, legal.canCheck ? { type: 'check' } : { type: 'call' });
    }
    // River: seat 1 checks, seat 2 bets, seat 0 and seat 1 call.
    act(r, 1, { type: 'check' });
    act(r, 2, { type: 'bet', to: 10 });
    act(r, 0, { type: 'call' });
    act(r, 1, { type: 'call' });
    expect(shows(r)).toEqual([2, 0]);
    expect(mucks(r)).toEqual([1]);
  });

  it('ties show so they can claim their share', () => {
    const top = holdemTop({ 0: ['As', '4h'], 1: ['Ad', '4c'], 2: ['8d', '5h'] }, ['Ac', '7d', '9h', 'Ts', 'Kc'], 0);
    const s = start({ stacks: [100, 100, 100], button: 0, top, options: { showdown: 'muck-losers' } });
    checkDown(s);
    expect(shows(s).sort()).toEqual([0, 1]);
    expect(mucks(s)).toEqual([2]);
  });

  it('a side pot winner shows even when a shown hand beats it', () => {
    // Seat 1 is all in short with the best hand; seats 0 and 2 contest the side pot, seat 0 wins it.
    const top = holdemTop({ 0: ['Ks', 'Kh'], 1: ['As', 'Ah'], 2: ['Qd', 'Qc'] }, ['2c', '7d', '9h', 'Ts', '3c'], 0);
    const s = start({ stacks: [100, 20, 100], button: 0, top, options: { showdown: 'muck-losers' } });
    act(s, 0, { type: 'raise', to: 50 });
    act(s, 1, { type: 'call' });
    act(s, 2, { type: 'call' });
    checkDown(s);
    expect(new Set(s.awards.map((a) => a.seat))).toEqual(new Set([0, 1]));
    expect(shows(s)).toContain(0);
    expect(shows(s)).toContain(1);
  });

  it('show-all (and no option) turns every live hand up', () => {
    const top = holdemTop({ 0: ['As', 'Ah'], 1: ['9c', '4d'], 2: ['Ad', '5h'] }, [...board], 0);
    for (const options of [{ showdown: 'show-all' as const }, {}]) {
      const s = start({ stacks: [100, 100, 100], button: 0, top, options });
      checkDown(s);
      expect(shows(s).sort()).toEqual([0, 1, 2]);
      expect(mucks(s)).toEqual([]);
    }
  });
});
