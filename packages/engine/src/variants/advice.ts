import type { BettingKind } from '../core/types';
import { gameTitle, getVariant } from './specs';

const BETTING_NAME: Record<BettingKind, string> = { 'no-limit': 'No Limit', 'pot-limit': 'Pot Limit', 'fixed-limit': 'Limit' };

/** A gentle note for a game played with unusual betting. Every pairing is still allowed. */
export interface BettingAdvice {
  /** 'rare' players will likely not expect; 'uncommon' is played but less often. */
  level: 'rare' | 'uncommon';
  /** The betting most players expect for this game. */
  suggest: BettingKind;
  message: string;
}

/**
 * The betting each game is usually played with. Hold'em is fine any way; Omaha is
 * Pot Limit (No Limit and Limit get a lighter note); Omaha Hi-Lo is Pot Limit or
 * Limit; stud and draw games are Limit games.
 */
function usual(gameId: string): { standard: BettingKind[]; uncommon: BettingKind[]; suggest: BettingKind } {
  const spec = getVariant(gameId);
  if (spec.family !== 'flop') return { standard: ['fixed-limit'], uncommon: [], suggest: 'fixed-limit' };
  if (gameId === 'nlhe') return { standard: ['no-limit', 'pot-limit', 'fixed-limit'], uncommon: [], suggest: 'no-limit' };
  if (spec.split === 'hi-lo') return { standard: ['pot-limit', 'fixed-limit'], uncommon: [], suggest: 'pot-limit' };
  return { standard: ['pot-limit'], uncommon: ['no-limit', 'fixed-limit'], suggest: 'pot-limit' };
}

/** Null when the pairing is a usual one, or the game is unknown. */
export function bettingAdvice(gameId: string, betting: BettingKind): BettingAdvice | null {
  let u: ReturnType<typeof usual>;
  try {
    u = usual(gameId);
  } catch {
    return null;
  }
  if (u.standard.includes(betting)) return null;
  const expected = BETTING_NAME[u.suggest];
  const name = getVariant(gameId).name;
  if (u.uncommon.includes(betting)) {
    return { level: 'uncommon', suggest: u.suggest, message: `Most ${name} games are ${expected}. ${BETTING_NAME[betting]} works, but some players may not expect it.` };
  }
  return { level: 'rare', suggest: u.suggest, message: `${gameTitle(gameId, betting)} is rare. Most players expect ${expected}.` };
}
