import type { Card } from '../cards';
import type { GameSpec, SeatIndex } from '../core/types';
import { bestHigh, bestLowAceToFive } from './evaluators';
import { rankValue } from './evaluators/shape';
import { getVariant } from './specs';

/** Suits break ties: clubs lowest, then diamonds, hearts, spades. */
const SUIT_ORDER = 'cdhs';

/** Single-card strength, aces high or low, suit as the final tiebreak. */
const cardValue = (card: Card, aceLow: boolean) => rankValue(card, aceLow) * 4 + SUIT_ORDER.indexOf(card[1]);

function studSpec(game: GameSpec) {
  const spec = getVariant(game.id);
  if (spec.family !== 'stud') throw new Error(`${spec.id} is not a stud game`);
  return spec;
}

function seatsOf(upBySeat: Record<SeatIndex, Card[]>): SeatIndex[] {
  const seats = Object.keys(upBySeat).map(Number);
  if (seats.length === 0) throw new Error('no seats');
  return seats;
}

/**
 * Third street: the seat that must bring in. Stud and Stud Hi-Lo: the lowest up
 * card (aces high), lowest suit on a tie. Razz: the highest up card (aces low,
 * so a king is worst), highest suit on a tie. Uses each seat's first up card.
 */
export function bringInSeat(game: GameSpec, upBySeat: Record<SeatIndex, Card[]>): SeatIndex {
  const razz = studSpec(game).id === 'razz';
  const value = (seat: SeatIndex) => {
    const card = upBySeat[seat][0];
    if (!card) throw new Error(`seat ${seat} has no up card`);
    return razz ? cardValue(card, true) : -cardValue(card, false);
  };
  return seatsOf(upBySeat).reduce((a, b) => (value(b) > value(a) ? b : a));
}

/**
 * Fourth street on: the seat that acts first. Stud and Stud Hi-Lo: the best high
 * hand showing; Razz: the best low showing. Only pairs, trips and quads count
 * on the up cards. Exact ties go to the seat that comes first in `order`
 * (clockwise from the dealer's left); without it, the lowest seat number.
 */
export function firstToActSeat(game: GameSpec, upBySeat: Record<SeatIndex, Card[]>, order?: SeatIndex[]): SeatIndex {
  const razz = studSpec(game).id === 'razz';
  const seats = seatsOf(upBySeat);
  const position = (seat: SeatIndex) => {
    const i = order ? order.indexOf(seat) : seat;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const score = (seat: SeatIndex) => (razz ? bestLowAceToFive(upBySeat[seat]) : bestHigh(upBySeat[seat])).score;
  return seats.reduce((a, b) => {
    const diff = score(b) - score(a);
    return diff > 0 || (diff === 0 && position(b) < position(a)) ? b : a;
  });
}

/**
 * Stud has no button, so odd chips go by cards instead: seats sorted by their
 * single highest card (aces high, spades highest). Pass the result as
 * awardPortion's `eligible` for stud games.
 */
export function studOddChipOrder(eligible: SeatIndex[], holeBySeat: Record<SeatIndex, Card[]>): SeatIndex[] {
  const top = (seat: SeatIndex) => Math.max(...holeBySeat[seat].map((c) => cardValue(c, false)));
  return [...eligible].sort((a, b) => top(b) - top(a));
}
