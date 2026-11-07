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
