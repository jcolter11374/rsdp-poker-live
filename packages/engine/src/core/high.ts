import { evaluate } from '../evaluator';
import type { AwardPortion, PortionAward, VariantRules } from './types';

/**
 * Default high-hand award (hold'em style): best five of hole plus board wins,
 * ties split evenly, and odd chips go one at a time in `eligible` order, which
 * the caller has already put in odd-chip order. Stud passes an empty board and
 * seven hole cards, which this handles too. Seats whose share rounds to zero
 * get no award entry.
 */
export const highAwardPortion: AwardPortion = (_spec, amount, eligible, holeBySeat, board) => {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`portion must be a non-negative integer, got ${amount}`);
  if (amount === 0) return [];
  if (eligible.length === 0) throw new Error('no eligible seat for a non-empty portion');

  const hands = eligible.map((seat) => {
    const hole = holeBySeat[seat];
    if (!hole) throw new Error(`no hole cards for seat ${seat}`);
    return { seat, value: evaluate([...hole, ...board]) };
  });
  const best = Math.max(...hands.map((h) => h.value.score));
  const winners = hands.filter((h) => h.value.score === best);

  const share = Math.floor(amount / winners.length);
  const odd = amount - share * winners.length;
  const awards: PortionAward[] = [];
  for (const [i, { seat, value }] of winners.entries()) {
    const won = share + (i < odd ? 1 : 0);
    if (won > 0) awards.push({ seat, amount: won, half: 'scoop', handName: value.description, cards: value.cards });
  }
  return awards;
};

/** Rules for games that need nothing beyond a high-hand showdown (NLH). */
export const highRules: VariantRules = { awardPortion: highAwardPortion };
