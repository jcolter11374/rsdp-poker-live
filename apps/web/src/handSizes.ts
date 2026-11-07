import { getVariant } from '@rsdp/engine/variants';

/** How many cards a player holds at each point of a hand of this game: [2] in Hold'em, [3, 4, 5, 6, 7] in stud. */
export function handSizes(gameId: string): number[] {
  let streets: readonly { dealDown: number; dealUp: number }[];
  try {
    streets = getVariant(gameId).streets;
  } catch {
    return [];
  }
  const sizes: number[] = [];
  let held = 0;
  for (const s of streets) {
    held += s.dealDown + s.dealUp;
    if (held > 0 && sizes.at(-1) !== held) sizes.push(held);
  }
  return sizes;
}

/**
 * Whether a hand of this game is ever more than four cards: stud, triple draw, five- and six-card Omaha. On a computer such
 * a hand is a row of cards over the nameplate from its first card (#447), so a stud hand doesn't move from beside the
 * nameplate to above it at fifth street. Up to four cards tuck into the nameplate.
 */
export function rowHand(gameId: string): boolean {
  return handSizes(gameId).some((n) => n > 4);
}

/**
 * The shapes a hand reaches in any of these games on a computer, smallest first: each size tucked into the nameplate, then
 * the longest row over it (a shorter row reaches less far). The seats are spaced for these before the cards come (#363),
 * and a mixed table for all of its games (#409).
 */
export function dealtShapes(games: readonly string[]): number[] {
  const tucked = games.filter((g) => !rowHand(g)).flatMap(handSizes);
  const rows = games.filter(rowHand).flatMap(handSizes);
  return [...new Set([...tucked, ...(rows.length ? [Math.max(...rows)] : [])])].sort((a, b) => a - b);
}

/** Whether a showdown in this game names two hands, a high and a low ("Two Pair, Kings and Fives · Eight-Six low"). */
export function splitsPot(gameId: string): boolean {
  try {
    const { high, low } = getVariant(gameId).showdown;
    return !!high && !!low;
  } catch {
    return false;
  }
}
