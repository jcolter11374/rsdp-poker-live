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

/** Every size a hand reaches in any of these games, smallest first: a mixed table is laid out for all of them (#409). */
export function dealtSizes(games: readonly string[]): number[] {
  return [...new Set(games.flatMap(handSizes))].sort((a, b) => a - b);
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
