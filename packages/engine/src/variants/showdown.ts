import type { Card } from '../cards';
import type { Chips, GameSpec, PortionAward, SeatIndex } from '../core/types';
import { HIGH_EVALUATORS, LOW_EVALUATORS, type HandRank } from './evaluators';
import { getVariant } from './specs';

interface Ranked {
  seat: SeatIndex;
  hand: HandRank;
}

/** Best hands among the seats, keeping the order of `eligible`. */
function winners(eligible: SeatIndex[], rank: (seat: SeatIndex) => HandRank | null): Ranked[] {
  const ranked = eligible.flatMap((seat) => {
    const hand = rank(seat);
    return hand ? [{ seat, hand }] : [];
  });
  const top = Math.max(...ranked.map((r) => r.hand.score));
  return ranked.filter((r) => r.hand.score === top);
}

/** Even shares; leftover chips one each to the earliest winners in odd-chip order. */
function share(amount: Chips, n: number): Chips[] {
  const base = Math.floor(amount / n);
  const extra = amount - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

function pay(amount: Chips, won: Ranked[], half: PortionAward['half']): PortionAward[] {
  return share(amount, won.length)
    .map((chips, i) => ({
      seat: won[i].seat,
      amount: chips,
      half,
      handName: won[i].hand.name,
      cards: won[i].hand.cards,
    }))
    .filter((a) => a.amount > 0);
}

/**
 * Awards one slice of one pot (one run, one board).
 *
 * `eligible` is in odd-chip order: the first seat gets the first leftover chip.
 * Hi-lo games split the amount into halves with the odd chip in the high half;
 * with no qualifying low the high hand takes everything. A seat that alone wins
 * the whole slice in a hi-lo game gets one "scoop" award.
 */
export function awardPortion(
  game: GameSpec,
  amount: Chips,
  eligible: SeatIndex[],
  holeBySeat: Record<SeatIndex, Card[]>,
  board: Card[],
): PortionAward[] {
  if (!Number.isInteger(amount) || amount < 0) throw new Error(`bad amount: ${amount}`);
  if (amount === 0 || eligible.length === 0) return [];
  const spec = getVariant(game.id);
  const hole = (seat: SeatIndex) => {
    const cards = holeBySeat[seat];
    if (!cards) throw new Error(`no cards for seat ${seat}`);
    return cards;
  };
  const { high, low } = spec.showdown;
  const highWin = high ? winners(eligible, (s) => HIGH_EVALUATORS[high](hole(s), board)) : [];
  const lowWin = low ? winners(eligible, (s) => LOW_EVALUATORS[low](hole(s), board)) : [];

  if (!low) return pay(amount, highWin, 'high');
  if (!high) return pay(amount, lowWin, 'low');

  if (lowWin.length === 0) {
    return highWin.length === 1 ? pay(amount, highWin, 'scoop') : pay(amount, highWin, 'high');
  }
  if (highWin.length === 1 && lowWin.length === 1 && highWin[0].seat === lowWin[0].seat) {
    const h = highWin[0].hand;
    const l = lowWin[0].hand;
    return [
      {
        seat: highWin[0].seat,
        amount,
        half: 'scoop',
        handName: `${h.name} and ${l.name}`,
        cards: [...new Set([...h.cards, ...l.cards])],
      },
    ];
  }
  const highHalf = Math.ceil(amount / 2);
  return [...pay(highHalf, highWin, 'high'), ...pay(amount - highHalf, lowWin, 'low')];
}
