import type { AnteType } from '../core/types';
import { VARIANT_LIST } from './specs';

/** Nice ante amounts, the ladder the tournament presets use: 1, 2, 3, 4, 5, 6, 8, 10, 20, 25, 30, 40, 50, 60, 80, 100, 200, 250, ... */
const ANTE_STEPS = [1, 2, 2.5, 3, 4, 5, 6, 8];

/** The nice ante amount nearest `v`, at least 1. Halfway goes to the smaller one. */
function nearestNiceAnte(v: number): number {
  let below = 1;
  for (let exp = 0; ; exp++) {
    for (const m of ANTE_STEPS) {
      const x = m * 10 ** exp;
      if (!Number.isInteger(x)) continue;
      if (x > v) return v - below <= x - v ? below : x;
      below = x;
    }
  }
}

/**
 * The ante each player pays in a stud game for a big-blind ante of `amount`.
 * Stud has no big blind to post it, so everyone antes about an eighth of it:
 * a full stud table is 8 players, so the pot gets about what the big-blind
 * ante would put in. Rounded to a nice amount (300 becomes 40), never below 1
 * and never above `amount`. No ante stays no ante.
 */
export function studAnteForBigBlindAnte(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.min(amount, nearestNiceAnte(amount / 8));
}

/** Round amounts for a bring-in: 1, 1.5, 2, 2.5, 3, 4, 5, 6 and 8 times a power of ten (the tournament blinds' steps). */
const BRING_IN_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];

/**
 * The stud bring-in worked out for a small bet of `smallBet`: a third of it,
 * rounded down to a round amount (1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a
 * power of ten), never below 1. Card rooms bring in for about a quarter to a
 * third of the small bet in chips that are in play, so 2,000 brings in 600
 * and 4,000 brings in 1,000 rather than 666 and 1,333 (#398).
 */
export function bringInFor(smallBet: number): number {
  const third = smallBet / 3;
  if (!Number.isFinite(third) || third < 1) return 1;
  let best = 1;
  for (let exp = 0; 10 ** exp <= third; exp++) {
    for (const m of BRING_IN_STEPS) {
      const x = m * 10 ** exp;
      if (Number.isInteger(x) && x <= third) best = x;
    }
  }
  return best;
}

/**
 * The ante a hand of `gameId` posts for an ante setting. In the stud games a
 * big-blind ante becomes everyone's smaller ante (studAnteForBigBlindAnte);
 * every other game, and a game this doesn't know, keeps it as it is.
 */
export function anteForGame(gameId: string, ante: number, anteType: AnteType): { ante: number; anteType: AnteType } {
  const stud = VARIANT_LIST.some((v) => v.id === gameId && v.forcedBets === 'ante-bring-in');
  if (!stud || anteType !== 'big-blind') return { ante, anteType };
  return { ante: studAnteForBigBlindAnte(ante), anteType: 'per-player' };
}
