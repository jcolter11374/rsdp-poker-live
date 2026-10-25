import type { SeatView, TableView } from '@rsdp/engine/wire';

/*
 * Mount points on the table for features that live in their own components
 * (double board, bomb pot and 7-2 badges, rabbit hunt, nit marker, notes).
 * Add a line here rather than editing Table.tsx.
 */

/** Extra lines on a seat's nameplate. */
export function SeatExtras(_props: { view: TableView; seat: SeatView }) {
  return null;
}

/** Extra things under the board and pots. */
export function BoardExtras(_props: { view: TableView }) {
  return null;
}
