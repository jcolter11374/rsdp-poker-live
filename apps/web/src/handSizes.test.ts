import { describe, expect, it } from 'vitest';
import { handSizes } from './handSizes';

describe('handSizes (#363: seats are spaced for the cards before they come)', () => {
  it('gives every size a hand reaches in each game', () => {
    expect(handSizes('nlhe')).toEqual([2]);
    expect(handSizes('plo4')).toEqual([4]);
    expect(handSizes('plo6')).toEqual([6]);
    expect(handSizes('stud')).toEqual([3, 4, 5, 6, 7]);
    expect(handSizes('razz')).toEqual(handSizes('stud'));
    expect(handSizes('td27')).toEqual([5]);
    expect(handSizes('badugi')).toEqual([4]);
  });
  it('gives nothing for an unknown game, or before one is chosen', () => {
    expect(handSizes('')).toEqual([]);
    expect(handSizes('not-a-game')).toEqual([]);
  });
});
