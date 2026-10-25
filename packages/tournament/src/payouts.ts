// Payouts (TRN-30, TRN-42): display-only prize pool, payout structures with
// player-count ranges, built-in presets, prize calculation, and final-table
// deals by chip chop or ICM. Money is whole units of the smallest currency
// unit (cents); nothing here moves real balances.

export interface PayoutRange {
  /** Inclusive entry-count range. */
  minEntries: number;
  maxEntries: number;
  /** Percent of the pool for 1st, 2nd, ... Up to two decimals; sums to 100. */
  percents: number[];
}

export interface PayoutStructure {
  name: string;
  ranges: PayoutRange[];
}

/** Optional display-only money values. All amounts in the smallest unit. */
export interface PrizeMoney {
  buyIn: number;
  rebuy?: number;
  addOn?: number;
  /** Percent of buy-ins, rebuys and add-ons kept back, 0-100. */
  feePercent?: number;
  /** Added money on top. */
  added?: number;
}

export interface PrizeCounts {
  entries: number;
  rebuys?: number;
  addOns?: number;
}

export function prizePool(money: PrizeMoney, counts: PrizeCounts): number {
  const gross = counts.entries * money.buyIn + (counts.rebuys ?? 0) * (money.rebuy ?? 0) + (counts.addOns ?? 0) * (money.addOn ?? 0);
  const fee = Math.min(100, Math.max(0, money.feePercent ?? 0));
  return Math.floor((gross * (100 - fee)) / 100) + (money.added ?? 0);
}

const cents = (n: number) => Math.round(n * 100);

/**
 * Checks a structure. Ranges must be in order with no gaps or overlaps and
 * cover 2 up to `maxEntries`; each range must pay no more places than its
 * smallest entry count, percents must not increase, and each range sums to 100.
 */
export function validatePayoutStructure(s: PayoutStructure, maxEntries: number): string[] {
  const errors: string[] = [];
  if (!Array.isArray(s?.ranges) || !s.ranges.length) return ['Add at least one range'];
  let expectedMin = 2;
  for (const [i, r] of s.ranges.entries()) {
    // Settings arrive from browsers, so a range may not be shaped like one.
    if (r === null || typeof r !== 'object' || !Array.isArray(r.percents) || !r.percents.every((p) => typeof p === 'number')) {
      errors.push(`Range ${i + 1} is not a payout range`);
      return errors;
    }
    const label = `Range ${r.minEntries}-${r.maxEntries}`;
    if (!Number.isInteger(r.minEntries) || !Number.isInteger(r.maxEntries) || r.maxEntries < r.minEntries)
      errors.push(`${label}: invalid entry counts`);
    if (r.minEntries !== expectedMin)
      errors.push(i === 0 ? 'The first range must start at 2 entries' : `${label}: must start at ${expectedMin} (no gaps or overlaps)`);
    expectedMin = r.maxEntries + 1;
    if (!r.percents.length) errors.push(`${label}: pays nobody`);
    if (r.percents.length > r.minEntries) errors.push(`${label}: pays more places than ${r.minEntries} entries`);
    if (r.percents.some((p) => !(p > 0) || Math.abs(p * 100 - cents(p)) > 1e-6))
      errors.push(`${label}: percents must be above 0 with at most two decimals`);
    if (r.percents.some((p, j) => j > 0 && p > r.percents[j - 1])) errors.push(`${label}: a lower place pays more than a higher one`);
    const sum = r.percents.reduce((a, p) => a + cents(p), 0);
    if (sum !== 10000) errors.push(`${label}: percents add up to ${sum / 100}, not 100`);
  }
  if (expectedMin - 1 < maxEntries) errors.push(`Ranges stop at ${expectedMin - 1} entries; they must reach ${maxEntries}`);
  return errors;
}

export function rangeFor(s: PayoutStructure, entries: number): PayoutRange | null {
  return s.ranges.find((r) => entries >= r.minEntries && entries <= r.maxEntries) ?? null;
}

/**
 * Prize for each place (index 0 = 1st). Each place is rounded down and the
 * remainder goes to 1st.
 */
export function placePrizes(pool: number, s: PayoutStructure, entries: number): number[] {
  const range = rangeFor(s, entries);
  if (!range || pool <= 0) return [];
  const prizes = range.percents.map((p) => Math.floor((pool * cents(p)) / 10000));
  prizes[0] += pool - prizes.reduce((a, b) => a + b, 0);
  return prizes;
}

/**
 * Prizes for finished places when players can tie (equal places). Tied
 * players split the prizes of every place they occupy; the odd unit goes to
 * the first listed. `places` maps an id to its place (1 = winner).
 */
export function prizesForPlaces(places: Record<string, number>, prizes: number[]): Record<string, number> {
  const byPlace = new Map<number, string[]>();
  for (const [id, place] of Object.entries(places)) byPlace.set(place, [...(byPlace.get(place) ?? []), id]);
  const out: Record<string, number> = {};
  for (const [place, ids] of byPlace) {
    let total = 0;
    for (let k = 0; k < ids.length; k++) total += prizes[place - 1 + k] ?? 0;
    const share = Math.floor(total / ids.length);
    ids.forEach((id, k) => (out[id] = share + (k === 0 ? total - share * ids.length : 0)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presets

/** Percents for `paid` places with weights 1 / place^exponent, rounded to 0.01, remainder to 1st. */
export function curvePercents(paid: number, exponent: number): number[] {
  const weights = Array.from({ length: paid }, (_, i) => 1 / (i + 1) ** exponent);
  const total = weights.reduce((a, b) => a + b, 0);
  const c = weights.map((w) => Math.floor((w / total) * 10000));
  c[0] += 10000 - c.reduce((a, b) => a + b, 0);
  return c.map((x) => x / 100);
}

function fromPaidCounts(name: string, maxEntries: number, paidFor: (entries: number) => number, exponent: number): PayoutStructure {
  const ranges: PayoutRange[] = [];
  for (let n = 2; n <= maxEntries; n++) {
    const paid = Math.min(n, paidFor(n));
    const last = ranges[ranges.length - 1];
    if (last && last.percents.length === paid) last.maxEntries = n;
    else ranges.push({ minEntries: n, maxEntries: n, percents: curvePercents(paid, exponent) });
  }
  return { name, ranges };
}

export type PayoutPresetName = 'winner-take-all' | 'top-two' | 'top-three' | 'standard' | 'flat';

/** Standard paid places: 1 up to 4 entries, 2 up to 7, 3 up to 10, then about 15% of the field. */
function standardPaid(n: number): number {
  if (n <= 4) return 1;
  if (n <= 7) return 2;
  if (n <= 10) return 3;
  return Math.max(4, Math.round(n * 0.15));
}

export function payoutPreset(name: PayoutPresetName, maxEntries = 600): PayoutStructure {
  switch (name) {
    case 'winner-take-all':
      return { name, ranges: [{ minEntries: 2, maxEntries, percents: [100] }] };
    case 'top-two':
      return fromPaidCounts(name, maxEntries, (n) => (n < 4 ? 1 : 2), 0.9);
    case 'top-three':
      return fromPaidCounts(name, maxEntries, (n) => (n < 4 ? 1 : n < 6 ? 2 : 3), 0.9);
    case 'standard':
      return fromPaidCounts(name, maxEntries, standardPaid, 0.9);
    case 'flat':
      // About 20% paid, flatter curve.
      return fromPaidCounts(name, maxEntries, (n) => (n <= 4 ? 1 : n <= 6 ? 2 : Math.max(3, Math.round(n * 0.2))), 0.6);
  }
}

// ---------------------------------------------------------------------------
// Final-table deals (TRN-42 improvement)

/** Splits `total` by `weights` into integers that add up exactly (largest remainder). */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out;
}

/**
 * Chip chop: each remaining player is guaranteed the lowest remaining prize,
 * and the rest is split by chip count. `prizes` are the prizes still to be
 * paid, best first, one per remaining player.
 */
export function chipChop(stacks: number[], prizes: number[]): number[] {
  const n = stacks.length;
  const remaining = prizes.slice(0, n);
  while (remaining.length < n) remaining.push(0);
  const floor = remaining[n - 1];
  const total = remaining.reduce((a, b) => a + b, 0);
  return apportion(total - floor * n, stacks).map((x) => x + floor);
}

export const MAX_ICM_PLAYERS = 12;

/**
 * Independent Chip Model (Malmuth-Harville) equity per player. Exact, so it
 * is limited to MAX_ICM_PLAYERS (a final table). Results add up to the sum of
 * the prizes paid to the remaining places.
 */
export function icm(stacks: number[], prizes: number[]): number[] {
  const n = stacks.length;
  if (n > MAX_ICM_PLAYERS) throw new Error(`ICM supports at most ${MAX_ICM_PLAYERS} players`);
  const paid = prizes.slice(0, n);
  const equity = new Array<number>(n).fill(0);
  const reach = new Float64Array(1 << n);
  reach[0] = 1;
  for (let mask = 0; mask < 1 << n; mask++) {
    const p = reach[mask];
    if (!p) continue;
    let place = 0;
    let left = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) place++;
      else left += stacks[i];
    }
    if (place >= n) continue;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) continue;
      // Players with no chips can only finish behind everyone with chips.
      const q = left > 0 ? stacks[i] / left : 1 / (n - place);
      if (!q) continue;
      equity[i] += p * q * (paid[place] ?? 0);
      reach[mask | (1 << i)] += p * q;
    }
  }
  return apportion(Math.round(equity.reduce((a, b) => a + b, 0)), equity);
}
