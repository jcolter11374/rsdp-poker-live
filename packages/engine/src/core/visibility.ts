import type { Card } from '../cards';
import { HIDDEN_CARD, type HandEvent, type HandState, type SeatIndex, type Viewer } from './types';

/**
 * Events as one viewer may see them. A card is visible if it was dealt face
 * up, belongs to the viewer, has been shown, or the viewer sees everything.
 * Hidden cards become HIDDEN_CARD so card counts still line up.
 */
export function visibleEvents(state: HandState, viewer: Viewer, fromSeq = 0): HandEvent[] {
  const shown = new Map<SeatIndex, Set<Card>>();
  for (const e of state.events) {
    if (e.t !== 'show') continue;
    const set = shown.get(e.seat) ?? new Set<Card>();
    for (const c of e.cards) set.add(c);
    shown.set(e.seat, set);
  }
  const sees = (seat: SeatIndex, card: Card) => viewer.seeAll || viewer.seat === seat || !!shown.get(seat)?.has(card);

  const out: HandEvent[] = [];
  for (const e of state.events) {
    if (e.seq < fromSeq) continue;
    if (e.t === 'deal') {
      out.push({ ...e, cards: e.cards.map((c) => (c.up || sees(e.seat, c.card) ? c : { card: HIDDEN_CARD, up: false })) });
    } else if (e.t === 'draw') {
      out.push({ ...e, cards: e.cards.map((c) => (sees(e.seat, c) ? c : HIDDEN_CARD)) });
    } else {
      out.push(e);
    }
  }
  return out;
}
