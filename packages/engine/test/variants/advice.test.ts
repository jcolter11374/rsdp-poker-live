import { describe, expect, it } from 'vitest';
import type { BettingKind } from '../../src/core/types';
import { bettingAdvice, VARIANT_LIST } from '../../src/variants';

const ALL: BettingKind[] = ['no-limit', 'pot-limit', 'fixed-limit'];

describe('bettingAdvice', () => {
  it("leaves Hold'em alone with any betting", () => {
    for (const b of ALL) expect(bettingAdvice('nlhe', b)).toBeNull();
  });

  it('gives Omaha a lighter note away from Pot Limit', () => {
    expect(bettingAdvice('plo4', 'pot-limit')).toBeNull();
    expect(bettingAdvice('plo5', 'no-limit')).toMatchObject({ level: 'uncommon', suggest: 'pot-limit' });
    expect(bettingAdvice('plo6', 'fixed-limit')).toMatchObject({ level: 'uncommon', suggest: 'pot-limit' });
  });

  it('accepts Omaha Hi-Lo at Pot Limit or Limit', () => {
    expect(bettingAdvice('plo8', 'pot-limit')).toBeNull();
    expect(bettingAdvice('plo8', 'fixed-limit')).toBeNull();
    expect(bettingAdvice('plo5-8', 'no-limit')).toMatchObject({ level: 'rare', suggest: 'pot-limit' });
  });

  it('expects Limit for stud and draw games', () => {
    for (const id of ['stud', 'razz', 'stud8', 'td27', 'badugi']) {
      expect(bettingAdvice(id, 'fixed-limit')).toBeNull();
      expect(bettingAdvice(id, 'no-limit')).toMatchObject({ level: 'rare', suggest: 'fixed-limit' });
      expect(bettingAdvice(id, 'pot-limit')).toMatchObject({ level: 'rare', suggest: 'fixed-limit' });
    }
    expect(bettingAdvice('stud', 'no-limit')?.message).toBe('No-Limit Seven Card Stud is rare. Most players expect Limit.');
  });

  it("never nudges a game's own default betting, and its suggestion is never nudged", () => {
    for (const v of VARIANT_LIST) {
      expect(bettingAdvice(v.id, v.defaultBetting)).toBeNull();
      for (const b of ALL) {
        const a = bettingAdvice(v.id, b);
        if (a) expect(bettingAdvice(v.id, a.suggest)).toBeNull();
      }
    }
  });

  it('ignores unknown games', () => {
    expect(bettingAdvice('nope', 'no-limit')).toBeNull();
  });
});
