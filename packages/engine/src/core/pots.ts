import type { Chips, Pot, SeatIndex } from './types';

/** What pot building needs from each seat dealt into the hand. */
export interface PotSeat {
  seat: SeatIndex;
  /** All chips put in this hand, live and dead. */
  total: Chips;
  folded: boolean;
  /**
   * Part of `total` paid for the whole table rather than to play (a dead small
   * blind, a big blind ante). It goes to the main pot and does not raise this
   * seat's side-pot level. Per-player antes are not included: everyone pays
   * them, so they level like any bet.
   */
  dead?: Chips;
}

/** What uncalled-bet detection needs from each seat this round. */
export interface BetSeat {
  seat: SeatIndex;
  /** Live chips this betting round. */
  bet: Chips;
}

function assertChips(value: Chips, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${what} must be a non-negative integer, got ${value}`);
}

const sameSeats = (a: SeatIndex[], b: SeatIndex[]) => a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * Main pot and side pots, one level per distinct total among seats still in
 * the hand. Folded seats and dead money only fund the levels they reach, so a
 * short all-in can never win more from anyone than it put in. Chips above the
 * top live level (a folded overbet) go to the last pot rather than vanish.
 * Throws if chips are in but every seat has folded, since nobody could win them.
 */
export function computePots(seats: PotSeat[]): Pot[] {
  for (const s of seats) assertChips(s.total, `total for seat ${s.seat}`);
  const ordered = [...seats].sort((a, b) => a.seat - b.seat);
  ordered.forEach((s, i) => {
    if (i > 0 && ordered[i - 1].seat === s.seat) throw new Error(`seat ${s.seat} listed twice`);
  });
  const live = ordered.filter((s) => !s.folded);
  const all = ordered.reduce((sum, s) => sum + s.total, 0);
  if (live.length === 0) {
    if (all > 0) throw new Error('chips in the pot but no seat left to win them');
    return [];
  }

  for (const s of ordered) {
    assertChips(s.dead ?? 0, `dead money for seat ${s.seat}`);
    if ((s.dead ?? 0) > s.total) throw new Error(`seat ${s.seat} has more dead money than chips in`);
  }
  const claim = (s: PotSeat) => s.total - (s.dead ?? 0);
  const levels = [...new Set(live.map(claim))].sort((a, b) => a - b);
  const raw: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const s of ordered) amount += Math.max(0, Math.min(claim(s), level) - prev);
    raw.push({ amount, eligible: live.filter((s) => claim(s) >= level).map((s) => s.seat) });
    prev = level;
  }
  raw[0].amount += ordered.reduce((sum, s) => sum + (s.dead ?? 0), 0);
  raw[raw.length - 1].amount += all - raw.reduce((sum, p) => sum + p.amount, 0);

  const pots: Pot[] = [];
  for (const pot of raw) {
    if (pot.amount === 0) continue;
    const last = pots[pots.length - 1];
    if (last && sameSeats(last.eligible, pot.eligible)) last.amount += pot.amount;
    else pots.push(pot);
  }
  return pots;
}

/**
 * The part of the round's single highest bet that nobody matched, measured
 * against the second-highest bet (folded seats count: their chips matched
 * what they put in). It goes back to the bettor before pots are built.
 * Null when the top bet is tied or there are no bets.
 */
export function uncalledBet(seats: BetSeat[]): { seat: SeatIndex; amount: Chips } | null {
  for (const s of seats) assertChips(s.bet, `bet for seat ${s.seat}`);
  if (seats.length === 0) return null;
  const sorted = [...seats].sort((a, b) => b.bet - a.bet);
  const amount = sorted[0].bet - (sorted[1]?.bet ?? 0);
  return amount > 0 ? { seat: sorted[0].seat, amount } : null;
}
