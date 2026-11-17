import { describe, expect, it } from 'vitest';
import { getVariant } from '@rsdp/engine/variants';
import { handKind, handStrength } from './strength';

describe('handKind: a shown hand on a phone tab (#455)', () => {
  it('keeps what the hand made, a low in figures, and both halves of hi-lo on one line', () => {
    expect(handKind('Full House, Sevens full of Queens')).toBe('Full House');
    expect(handKind('Two Pair, Kings and Fives')).toBe('Two Pair');
    expect(handKind('Pair of Queens')).toBe('Pair of Queens');
    expect(handKind('Straight, Jack high')).toBe('Straight');
    expect(handKind('Eight-Six low')).toBe('8-6 low');
    expect(handKind('Two Pair, Jacks and Tens · Eight-Seven low')).toBe('Two Pair · 8-7');
    expect(handKind('Flush, Ace high · no low')).toBe('Flush');
    expect(handKind('Badugi, King high')).toBe('Badugi');
  });

  // 24,000 hands: about 4s on its own, longer on a busy machine.
  it('gives every hand the evaluators can name a short tab, in every game', { timeout: 30_000 }, () => {
    const ranks = '23456789TJQKA';
    const deck = [...ranks].flatMap((r) => [...'cdhs'].map((s) => r + s));
    // A small seeded generator, so a failure can be run again.
    let seed = 455;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const games = ['nlhe', 'plo4', 'plo8', 'plo5', 'plo5-8', 'plo6', 'plo6-8', 'stud', 'stud8', 'razz', 'td27', 'badugi'];
    let named = 0;
    for (const game of games) {
      const spec = getVariant(game);
      const board = spec.family === 'flop' ? 5 : 0;
      const hole = spec.family === 'flop' ? spec.cardsPerPlayer : spec.family === 'stud' ? 7 : spec.cardsPerPlayer;
      const hiLo = !!spec.showdown.high && !!spec.showdown.low;
      for (let i = 0; i < 2000; i++) {
        const cards = [...deck];
        for (let j = cards.length - 1; j > 0; j--) {
          const k = Math.floor(next() * (j + 1));
          [cards[j], cards[k]] = [cards[k], cards[j]];
        }
        const name = handStrength(game, cards.slice(0, hole), cards.slice(hole, hole + board));
        expect(name, `${game}: ${cards.slice(0, hole + board).join(' ')}`).toBeTruthy();
        const kind = handKind(name!);
        expect(kind, `${game}: ${name}`).toMatch(/^[A-Za-z0-9 -]+( · [A-Za-z0-9 -]+)?$/);
        expect(kind.length, `${game}: ${name} -> ${kind}`).toBeLessThanOrEqual(hiLo ? 21 : 15);
        named++;
      }
    }
    expect(named).toBe(games.length * 2000);
  });
});
