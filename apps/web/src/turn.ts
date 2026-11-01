import type { TableView, TurnKey } from '@rsdp/engine/wire';

/**
 * The turn a move is for, as this view shows it: the hand's number and its
 * event count. Every move carries it, so the server refuses one that arrives
 * after its turn has passed (on a slow connection, usually the second of two
 * taps, the first having been played) instead of playing it on a later
 * street. Nothing without a hand.
 */
export function turnKey(view: Pick<TableView, 'hand'>): TurnKey {
  return view.hand ? { handNumber: view.hand.handNumber, at: view.hand.events.length } : {};
}
