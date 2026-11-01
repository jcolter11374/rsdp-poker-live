import { describe, expect, it } from 'vitest';
import type { HandView } from '@rsdp/engine/wire';
import { turnKey } from './turn';

describe('the turn a move is for', () => {
  it("is the hand's number and its event count, as the coach tip asks for", () => {
    const hand = { handNumber: 12, events: [{ t: 'street', street: 0, name: 'Preflop' }, { t: 'street', street: 1, name: 'Flop' }] } as unknown as HandView;
    expect(turnKey({ hand })).toEqual({ handNumber: 12, at: 2 });
  });

  it('is left out without a hand, so the server checks nothing', () => {
    expect(turnKey({ hand: null })).toEqual({});
  });
});
