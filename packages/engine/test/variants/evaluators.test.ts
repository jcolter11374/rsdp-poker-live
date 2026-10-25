import { describe, expect, it } from 'vitest';
import {
  bestBadugi,
  bestHigh,
  bestLowAceToFive,
  bestLowDeuceToSeven,
  bestLowEight,
  evaluateOmahaHigh,
  evaluateOmahaLowEight,
  type HandRank,
} from '../../src/variants';

const c = (s: string) => s.split(' ');
const better = (a: HandRank | null, b: HandRank | null) => (a?.score ?? -1) > (b?.score ?? -1);

describe('high hands', () => {
  it('names every category', () => {
    expect(bestHigh(c('As Ks Qs Js Ts 2c 3d')).name).toBe('Royal Flush');
    expect(bestHigh(c('9s 8s 7s 6s 5s 2c 3d')).name).toBe('Straight Flush, Nine high');
    expect(bestHigh(c('9c 9d 9h 9s 2c')).name).toBe('Four of a Kind, Nines');
    expect(bestHigh(c('Kc Kd Kh 5s 5c 3d 4h')).name).toBe('Full House, Kings full of Fives');
    expect(bestHigh(c('Ah 9h 7h 4h 2h Kc Qd')).name).toBe('Flush, Ace high');
    expect(bestHigh(c('5c 4d 3h 2s Ac Kd Qh')).name).toBe('Straight, Five high');
    expect(bestHigh(c('7c 7d 7h Ks 2c')).name).toBe('Three of a Kind, Sevens');
    expect(bestHigh(c('7c 7d Kh Ks 2c')).name).toBe('Two Pair, Kings and Sevens');
    expect(bestHigh(c('6c 6d Kh Qs 2c')).name).toBe('Pair of Sixes');
    expect(bestHigh(c('Ac Jd 9h 6s 2c')).name).toBe('Ace high');
  });

  it('shows the wheel as 5-4-3-2-A', () => {
    expect(bestHigh(c('Ac 2d 3h 4s 5c')).cards).toEqual(c('5c 4s 3h 2d Ac'));
  });

  it('ranks partial stud hands by pairs and kickers only', () => {
    expect(bestHigh(c('Kc Kd')).name).toBe('Pair of Kings');
    expect(better(bestHigh(c('2c 2d')), bestHigh(c('As Ks')))).toBe(true);
    expect(better(bestHigh(c('9c 9d Ah')), bestHigh(c('9h 9s Kc')))).toBe(true);
    // Four suited cards are not a flush yet.
    expect(bestHigh(c('2s 5s 9s Js')).name).toBe('Jack high');
  });
});

describe('Omaha high', () => {
  it('uses exactly two hole cards', () => {
    // Four spades on board and one in hand: no flush.
    expect(evaluateOmahaHigh(c('As Kd Qc Jh'), c('2s 5s 8s 9s Td')).name).not.toMatch(/Flush/);
    // One heart in hand does not complete the royal flush on board.
    expect(evaluateOmahaHigh(c('Th 3c 4d 5s'), c('Ah Kh Qh Jh 2c')).name).toBe('Ace high');
    expect(evaluateOmahaHigh(c('As Ks Qd Jd'), c('2s 5s 8s 9h Td')).name).toBe('Flush, Ace high');
  });

  it('handles 5 and 6 hole cards', () => {
    expect(evaluateOmahaHigh(c('Ah Kh 2c 3d 4s'), c('Qh Jh Th 8c 7d')).name).toBe('Royal Flush');
    expect(evaluateOmahaHigh(c('2c 3d 4s 5h 9h 9s'), c('9d 9c Kh 8c 7d')).name).toBe('Four of a Kind, Nines');
  });
});

describe('ace-to-five low', () => {
  it('names lows highest card first', () => {
    const r = bestLowAceToFive(c('8c 6d 4h 2s Ac Kd Kh'));
    expect(r.name).toBe('Eight-Six low');
    expect(r.detail).toBe('8-6-4-2-A');
    expect(bestLowAceToFive(c('5c 4d 3h 2s Ac')).name).toBe('Five-Four low');
  });

  it('ignores straights and flushes', () => {
    expect(better(bestLowAceToFive(c('5s 4s 3s 2s As')), bestLowAceToFive(c('6c 4d 3h 2s Ac')))).toBe(true);
  });

  it('plays pairs in Razz, worse than any unpaired hand', () => {
    expect(bestLowAceToFive(c('Kc Kd Kh Ks Qc Qd 2c')).name).toBe('Two Pair, Kings and Queens');
    expect(better(bestLowAceToFive(c('Kc Qd Jh Ts 9c')), bestLowAceToFive(c('Ac Ad 2h 3s 4c')))).toBe(true);
    expect(better(bestLowAceToFive(c('2c 2d 3h 4s 5c')), bestLowAceToFive(c('3c 3d 2h 4s 5c')))).toBe(true);
  });

  it('compares from the top card down', () => {
    expect(better(bestLowAceToFive(c('7c 6d 4h 3s 2c')), bestLowAceToFive(c('7c 6d 5h 2s Ac')))).toBe(true);
  });
});

describe('eight-or-better', () => {
  it('needs five different ranks of 8 or lower', () => {
    expect(bestLowEight(c('9c 7d 6h 5s 4c Kd Qh'))).toBeNull();
    expect(bestLowEight(c('8c 7d 7h 5s 4c Kd 4h'))).toBeNull();
    expect(bestLowEight(c('8c 7d 6h 5s 4c Kd Ah'))!.name).toBe('Seven-Six low');
  });

  it('Omaha low uses exactly two hole cards', () => {
    // Board has five low cards, but a player needs two low hole cards of new ranks.
    expect(evaluateOmahaLowEight(c('Ks Kd Qc Jh'), c('As 2s 3d 4h 5c'))).toBeNull();
    expect(evaluateOmahaLowEight(c('Ah 6c Kc Jh'), c('As 2s 3d 4h Kd'))!.detail).toBe('6-4-3-2-A');
    expect(evaluateOmahaLowEight(c('Ah 2c Kc Jh'), c('3s 7s 8d Kh Qc'))!.detail).toBe('8-7-3-2-A');
  });
});

describe('deuce-to-seven', () => {
  it('7-5-4-3-2 is best and aces are high', () => {
    expect(bestLowDeuceToSeven(c('7c 5d 4h 3s 2c')).name).toBe('Seven-Five low');
    expect(better(bestLowDeuceToSeven(c('8c 6d 4h 3s 2c')), bestLowDeuceToSeven(c('Ac 5d 4h 3s 2c')))).toBe(true);
    expect(bestLowDeuceToSeven(c('Ac 5d 4h 3s 2c')).name).toBe('Ace-Five low');
  });

  it('straights and flushes count against you', () => {
    expect(bestLowDeuceToSeven(c('6c 5d 4h 3s 2c')).name).toBe('Straight, Six high');
    expect(bestLowDeuceToSeven(c('7c 5c 4c 3c 2c')).name).toBe('Flush, Seven high');
    expect(better(bestLowDeuceToSeven(c('Kc Qd Jh 9s 8c')), bestLowDeuceToSeven(c('6c 5d 4h 3s 2c')))).toBe(true);
    expect(better(bestLowDeuceToSeven(c('2c 2d 3h 4s 5c')), bestLowDeuceToSeven(c('7c 5c 4c 3c 2c')))).toBe(true);
  });
});

describe('badugi', () => {
  it('ranks by size, then from the top card', () => {
    const best = bestBadugi(c('4c 3d 2h As'));
    expect(best.name).toBe('Badugi, Four high');
    expect(best.detail).toBe('4-3-2-A');
    expect(better(bestBadugi(c('Kc Qd Jh Ts')), bestBadugi(c('Ac 2c 3d 4h')))).toBe(true);
    expect(better(bestBadugi(c('8c 5d 3h 2s')), bestBadugi(c('8c 6d 2h As')))).toBe(true);
  });

  it('drops repeated suits and ranks', () => {
    expect(bestBadugi(c('Ac 2c 3d 4h')).name).toBe('Three-card, Four high');
    expect(bestBadugi(c('Ac 2c 3d 4h')).detail).toBe('4-3-A');
    expect(bestBadugi(c('5c 5d 5h 5s')).name).toBe('One-card, Five high');
    expect(bestBadugi(c('Kc 2c 2d 3d')).detail).toBe('3-2');
  });
});
