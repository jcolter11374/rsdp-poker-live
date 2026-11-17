import { describe, expect, it } from 'vitest';
import { handSizes, rowHand, splitsPot } from './handSizes';

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

describe('rowHand (#447: a hand that grows past four cards is a row over the nameplate from its first card)', () => {
  it('is true for stud, triple draw and five- and six-card Omaha, whose hands reach five cards or more', () => {
    for (const game of ['stud', 'razz', 'stud8', 'td27', 'plo5', 'plo6', 'plo5-8', 'plo6-8']) expect(rowHand(game)).toBe(true);
  });
  it('is false for the games that tuck their cards into the nameplate, and for no game', () => {
    for (const game of ['nlhe', 'plo4', 'plo8', 'badugi', '', 'not-a-game']) expect(rowHand(game)).toBe(false);
  });
});

describe('splitsPot (#427: a split pot names two hands at the showdown)', () => {
  it('is true only where a showdown has a high and a low hand', () => {
    for (const game of ['plo8', 'plo5-8', 'stud8']) expect(splitsPot(game)).toBe(true);
    for (const game of ['nlhe', 'plo4', 'plo5', 'stud', 'razz', 'td27', 'badugi', '', 'not-a-game']) expect(splitsPot(game)).toBe(false);
  });
});
