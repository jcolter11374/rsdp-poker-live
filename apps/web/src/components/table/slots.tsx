import type { SeatView, TableView } from '@rsdp/engine/wire';

/*
 * Mount points on the table for features that live in their own components
 * (double board, bomb pot and 7-2 badges, rabbit hunt, nit marker, notes).
 * Add a line here rather than editing Table.tsx.
 */

/** Extra lines on a seat's nameplate. */
export function SeatExtras({ seat }: { view: TableView; seat: SeatView }) {
  if (seat.nit !== 'holder') return null;
  return (
    <span className="tag nit-tag" title="Still holding the nit: win a pot outright to get off it">
      NIT
    </span>
  );
}

/** Extra things under the board and pots. */
export function BoardExtras(_props: { view: TableView }) {
  return null;
}
