import type { CSSProperties } from 'react';

/** Casino colours, smallest first. Each chip is worth its multiple of the table's base chip. */
export const CHIP_SET = [
  { mult: 1, face: '#eef0f2', spot: '#3a6fd6' },
  { mult: 5, face: '#d23a31', spot: '#ffffff' },
  { mult: 25, face: '#1e9452', spot: '#ffffff' },
  { mult: 100, face: '#24272c', spot: '#ffffff' },
  { mult: 500, face: '#7a4bc6', spot: '#ffffff' },
  { mult: 1000, face: '#f0a12a', spot: '#2a2116' },
  { mult: 5000, face: '#8a5a38', spot: '#ffffff' },
  { mult: 25000, face: '#e46aa9', spot: '#ffffff' },
] as const;

/**
 * Cash games are played for money, so their chips are a casino's, one cent
 * each to start: pennies, nickels and quarters below the dollar chips.
 */
export const DOLLAR_CHIPS = [
  { mult: 1, face: '#c08a5b', spot: '#ffffff' },
  { mult: 5, face: '#9aa7b4', spot: '#ffffff' },
  { mult: 25, face: '#4fa3e0', spot: '#ffffff' },
  { mult: 100, face: '#eef0f2', spot: '#3a6fd6' },
  { mult: 500, face: '#d23a31', spot: '#ffffff' },
  { mult: 2500, face: '#1e9452', spot: '#ffffff' },
  { mult: 10000, face: '#24272c', spot: '#ffffff' },
  { mult: 50000, face: '#7a4bc6', spot: '#ffffff' },
  { mult: 100000, face: '#f0a12a', spot: '#2a2116' },
  { mult: 500000, face: '#8a5a38', spot: '#ffffff' },
  { mult: 2500000, face: '#e46aa9', spot: '#ffffff' },
] as const;

export type ChipSet = readonly { mult: number; face: string; spot: string }[];

/** The table's smallest chip: a power of ten no bigger than its smallest forced bet, so 1/2 plays with 1s and 25/50 with 10s. */
export function baseChip(smallest: number): number {
  return Math.pow(10, Math.floor(Math.log10(Math.max(1, smallest))));
}

/**
 * An amount broken into chips, biggest first, as [colour index, count] pairs.
 * Whatever is left below the base chip (odd cents) rounds into one more small chip.
 */
export function breakdown(amount: number, base: number, set: ChipSet = CHIP_SET): [number, number][] {
  const out: [number, number][] = [];
  let left = Math.max(0, Math.round(amount));
  for (let i = set.length - 1; i >= 0 && left > 0; i--) {
    const value = set[i].mult * base;
    const count = Math.floor(left / value);
    if (count > 0) {
      out.push([i, count]);
      left -= count * value;
    }
  }
  if (left > 0) {
    const last = out.at(-1);
    if (last && last[0] === 0) last[1] += 1;
    else out.push([0, 1]);
  }
  return out;
}

/** Up to three small stacks of chips, one per colour, for a bet or a pot. */
export function ChipStacks({ amount, base, set = CHIP_SET, max = 3 }: { amount: number; base: number; set?: ChipSet; max?: number }) {
  const stacks = breakdown(amount, base, set).slice(0, max);
  if (!stacks.length) return null;
  return (
    <span className="chip-stacks" aria-hidden="true">
      {stacks.map(([i, count]) => (
        <span className="chip-stack" key={i}>
          {Array.from({ length: Math.min(count, 5) }, (_, k) => (
            <span key={k} className="chip" style={{ '--chip': set[i].face, '--spot': set[i].spot, '--k': k } as CSSProperties} />
          ))}
        </span>
      ))}
    </span>
  );
}
