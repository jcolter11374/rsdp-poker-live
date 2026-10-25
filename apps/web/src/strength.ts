import { getVariant, HIGH_EVALUATORS, LOW_EVALUATORS } from '@rsdp/engine/variants';

/**
 * What your cards make right now, for the hint under the action buttons:
 * "Two Pair, Kings and Fives", "Eight-Six low", or both halves in hi-lo.
 * Null until there are enough cards to make a hand.
 */
export function handStrength(gameId: string, hole: string[], board: string[]): string | null {
  let spec;
  try {
    spec = getVariant(gameId);
  } catch {
    return null;
  }
  const mine = hole.filter((c) => c !== '??');
  if (mine.length !== hole.length || !mine.length) return null;
  const total = mine.length + board.length;
  const { high, low } = spec.showdown;
  const parts: string[] = [];
  try {
    if (high) {
      const enough = high === 'omaha' ? board.length >= 3 : total >= 5;
      const rank = enough ? HIGH_EVALUATORS[high](mine, board) : null;
      if (rank) parts.push(rank.name);
    }
    if (low) {
      const enough = low === 'badugi' ? total >= 4 : low === 'omaha-eight-or-better' ? board.length >= 3 : total >= 5;
      const rank = enough ? LOW_EVALUATORS[low](mine, board) : null;
      if (rank) parts.push(rank.name);
      else if (enough && high) parts.push('no low');
    }
  } catch {
    return null;
  }
  return parts.length ? parts.join(' · ') : null;
}
