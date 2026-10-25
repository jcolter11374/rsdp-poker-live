import type { TableView } from '@rsdp/engine/wire';
import { call } from '../../socket';
import { useNow } from '../Table';
import './seating.css';

/**
 * Banners about getting a seat and watching: the waitlist (join, your place,
 * a seat held for you), what spectators can see, and a note for players when
 * spectators see every card.
 */
export function SeatingBanners({ view, skew, onTakeSeat, onJoinWaitlist }: { view: TableView; skew: number; onTakeSeat: (seat: number) => void; onJoinWaitlist: () => void }) {
  const me = view.me.playerId;
  const offer = view.offers.find((o) => o.playerId === me);
  const now = useNow(!!offer, 1000) + skew;
  const place = view.waitlist.findIndex((w) => w.playerId === me);
  const seated = view.me.seat !== null;
  const asking = view.requests.some((r) => r.playerId === me && r.kind === 'seat');
  const held = new Set([...view.offers.map((o) => o.seat), ...view.requests.filter((r) => r.kind === 'seat').map((r) => r.seat)]);
  const full = view.seats.every((s, i) => s !== null || held.has(i));
  const spectators = view.settings.spectators;
  const leave = () => call('waitlist:leave').catch(() => {});

  return (
    <>
      {offer ? (
        <div className="banner attention">
          Seat {offer.seat + 1} is yours if you want it ({Math.max(0, Math.ceil((offer.expiresAt - now) / 1000))} s).{' '}
          <button className="primary" onClick={() => onTakeSeat(offer.seat)}>
            Take it
          </button>{' '}
          <button onClick={leave}>No thanks</button>
        </div>
      ) : place >= 0 ? (
        <div className="banner">
          You're {place === 0 ? 'next' : `number ${place + 1}`} on the waitlist.{' '}
          <button onClick={leave}>Leave the waitlist</button>
        </div>
      ) : (
        view.mode === 'cash' &&
        view.settings.seating.waitlist &&
        !seated &&
        !asking &&
        full && (
          <div className="banner">
            The table is full{view.waitlist.length ? ` and ${view.waitlist.length} ${view.waitlist.length === 1 ? 'person is' : 'people are'} waiting` : ''}.{' '}
            <button className="primary" onClick={onJoinWaitlist}>
              Join the waitlist
            </button>
          </div>
        )
      )}
      {view.spectator?.blocked && <div className="banner">The host has turned watching off. Take a seat to see the game.</div>}
      {view.spectator && !view.spectator.blocked && (view.spectator.delaySeconds > 0 || view.spectator.seeAll) && (
        <div className="banner spectating">
          You're watching{view.spectator.seeAll ? ' with every card face up' : ''}
          {view.spectator.delaySeconds > 0 ? `, ${view.spectator.delaySeconds} seconds behind the table` : ''}.
        </div>
      )}
      {seated && spectators.allowed && spectators.seeAllCards && (
        <div className="banner spectating">
          Spectators can see every hole card{spectators.delaySeconds > 0 ? `, ${spectators.delaySeconds} seconds behind` : ', live'}.
        </div>
      )}
    </>
  );
}
