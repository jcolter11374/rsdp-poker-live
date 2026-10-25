import type { SeatView, TableView } from '@rsdp/engine/wire';
import { NoteBadge } from './Notes';
import './extras.css';

/*
 * Mount points on the table for features that live in their own components
 * (double board, bomb pot and 7-2 badges, rabbit hunt, nit marker, notes).
 * Add a line here rather than editing Table.tsx.
 */

/** Extra lines on a seat's nameplate. */
export function SeatExtras({ view, seat }: { view: TableView; seat: SeatView }) {
  return (
    <>
      {seat.nit === 'holder' && (
        <span className="tag nit-tag" title="Still holding the nit: win a pot outright to get off it">
          NIT
        </span>
      )}
      {seat.playerId !== view.me.playerId && <NoteBadge seat={seat} />}
    </>
  );
}

/** Extra things under the board and pots. */
export function BoardExtras(_props: { view: TableView }) {
  return null;
}
