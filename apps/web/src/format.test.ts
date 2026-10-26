import { describe, expect, it } from 'vitest';
import { bbFormat, betFromInput, betToInput } from './format';

describe('bbFormat', () => {
  it('shows amounts in big blinds, to one decimal when it is not whole', () => {
    const fmt = bbFormat(20);
    expect(fmt(200)).toBe('10 BB');
    expect(fmt(250)).toBe('12.5 BB');
    expect(fmt(10)).toBe('0.5 BB');
    expect(fmt(7)).toBe('0.35 BB');
    expect(bbFormat(100)(1)).toBe('0.01 BB');
    expect(bbFormat(50)(25)).toBe('0.5 BB');
  });
});

describe('bet box units', () => {
  it('turns big blinds typed in the box into whole chips', () => {
    const unit = { bb: 50 };
    expect(betFromInput(unit, 3)).toBe(150);
    expect(betFromInput(unit, 2.5)).toBe(125);
    expect(betFromInput(unit, 0.01)).toBe(1);
    expect(betFromInput({ bb: 3 }, 2.5)).toBe(8); // 7.5 chips rounds to 8
    expect(betFromInput({ bb: 2 }, 0.1 + 0.2)).toBe(1);
    expect(betFromInput(unit, NaN)).toBe(0);
  });
  it('shows chips in the box as big blinds to two places', () => {
    expect(betToInput({ bb: 50 }, 125)).toBe(2.5);
    expect(betToInput({ bb: 150 }, 425)).toBe(2.83);
    expect(betToInput({ bb: 2 }, 6)).toBe(3);
  });
  it('round-trips amounts that are whole tenths of a big blind', () => {
    for (const bb of [2, 20, 50, 100, 150, 400]) {
      for (let tenths = 1; tenths <= 500; tenths++) {
        const chips = (tenths * bb) / 10;
        if (!Number.isInteger(chips)) continue;
        expect(betFromInput({ bb }, betToInput({ bb }, chips))).toBe(chips);
      }
    }
  });
  it('keeps chips and cents mode as before', () => {
    expect(betFromInput({ centsMode: false }, 40)).toBe(40);
    expect(betFromInput({ centsMode: true }, 1.25)).toBe(125);
    expect(betToInput({ centsMode: true }, 125)).toBe(1.25);
  });
  it('can show more places on the action buttons', () => {
    expect(bbFormat(150, 2)(425)).toBe('2.83 BB');
    expect(bbFormat(150)(425)).toBe('2.8 BB');
  });
});
