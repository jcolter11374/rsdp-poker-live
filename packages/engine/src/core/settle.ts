import type { Award, Card, Chips, GameSpec, Pot, SeatIndex, VariantRules } from './types';

export interface SettleArgs {
  pots: Pot[];
  /** runs[run][board] = community cards. Empty (stud, draw) means one run with one empty board. */
  runs: Card[][][];
  button: SeatIndex | null;
  maxSeats: number;
  holeBySeat: Record<SeatIndex, Card[]>;
  spec: GameSpec;
  rules: VariantRules;
  /** Chips taken from each pot before it is awarded (simulated rake). */
  fee?: (pot: Pot, index: number) => Chips;
}

function assertChips(value: Chips, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${what} must be a non-negative integer, got ${value}`);
}

/** Splits chips into `parts` near-equal shares; leftover chips go one each to the first shares. */
function split(amount: Chips, parts: number): Chips[] {
  const share = Math.floor(amount / parts);
  const odd = amount - share * parts;
  return Array.from({ length: parts }, (_, i) => share + (i < odd ? 1 : 0));
}

/**
 * Seats in odd-chip order: clockwise from the first seat after the button, so
 * a split pot's leftover chip goes to the worst position. With no button
 * (stud, or a dead button) seats run in order from seat 0.
 */
export function oddChipOrder(eligible: SeatIndex[], button: SeatIndex | null, maxSeats: number): SeatIndex[] {
  if (!Number.isSafeInteger(maxSeats) || maxSeats < 1) throw new Error(`bad maxSeats ${maxSeats}`);
  const inRange = (s: SeatIndex) => Number.isSafeInteger(s) && s >= 0 && s < maxSeats;
  if (button !== null && !inRange(button)) throw new Error(`button ${button} is not a seat`);
  for (const s of eligible) if (!inRange(s)) throw new Error(`seat ${s} is not below maxSeats ${maxSeats}`);
  const key = (s: SeatIndex) => (button === null ? s : (s - button - 1 + maxSeats) % maxSeats);
  return [...eligible].sort((a, b) => key(a) - key(b));
}

/**
 * Awards every pot, then every run, then every board, through
 * `rules.awardPortion`. A pot with one eligible seat goes to it whole without
 * looking at cards (everyone else folded, or an unmatched side pot). Odd chips
 * favour run 0 over later runs and board 0 over board 1, and within a portion
 * follow {@link oddChipOrder}. Throws if any portion's awards do not add up,
 * so a buggy variant can never create or destroy chips.
 */
export function settle(args: SettleArgs): Award[] {
  const { pots, button, maxSeats, holeBySeat, spec, rules, fee } = args;
  const runs = args.runs.length > 0 ? args.runs : [[[]]];
  runs.forEach((run, r) => {
    if (run.length === 0) throw new Error(`run ${r} has no boards`);
  });

  const awards: Award[] = [];
  let owed = 0;
  pots.forEach((pot, p) => {
    assertChips(pot.amount, `pot ${p}`);
    if (pot.eligible.length === 0) throw new Error(`pot ${p} has no eligible seat`);
    const taken = fee ? fee(pot, p) : 0;
    assertChips(taken, `fee for pot ${p}`);
    if (taken > pot.amount) throw new Error(`fee ${taken} is more than pot ${p} (${pot.amount})`);
    const amount = pot.amount - taken;
    owed += amount;
    if (amount === 0) return;

    if (pot.eligible.length === 1) {
      awards.push({ pot: p, run: 0, board: 0, seat: pot.eligible[0], amount, half: 'scoop' });
      return;
    }

    const order = rules.oddChipOrder ? rules.oddChipOrder(pot.eligible, holeBySeat) : oddChipOrder(pot.eligible, button, maxSeats);
    split(amount, runs.length).forEach((runShare, r) => {
      split(runShare, runs[r].length).forEach((portion, b) => {
        if (portion === 0) return;
        const got = rules.awardPortion(spec, portion, order, holeBySeat, runs[r][b]);
        let paid = 0;
        for (const a of got) {
          assertChips(a.amount, `award to seat ${a.seat}`);
          if (!pot.eligible.includes(a.seat)) throw new Error(`seat ${a.seat} is not eligible for pot ${p}`);
          paid += a.amount;
          awards.push({ ...a, pot: p, run: r, board: b });
        }
        if (paid !== portion) throw new Error(`pot ${p} run ${r} board ${b}: awarded ${paid} of ${portion}`);
      });
    });
  });

  const total = awards.reduce((sum, a) => sum + a.amount, 0);
  if (total !== owed) throw new Error(`awarded ${total} but pots minus fees are ${owed}`);
  return awards;
}
