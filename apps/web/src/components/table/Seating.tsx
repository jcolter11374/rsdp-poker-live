import { useState } from 'react';
import { delayText } from '@rsdp/engine/settings';
import type { TableView } from '@rsdp/engine/wire';
import { call } from '../../socket';
import { useNow } from '../Table';
import './seating.css';

/**
 * Banners about getting a seat and watching: the waitlist (join, your place,
 * a seat held for you), what spectators can see, and a warning for players
 * when spectators see every card.
 */
export function SeatingBanners({
  view,
  skew,
  onTakeSeat,
  onJoinWaitlist,
  onPeople,
}: {
  view: TableView;
  skew: number;
  onTakeSeat: (seat: number) => void;
  onJoinWaitlist: () => void;
  onPeople: () => void;
}) {
  const me = view.me.playerId;
  const offer = view.offers.find((o) => o.playerId === me);
  const now = useNow(!!offer, 1000) + skew;
  const place = view.waitlist.findIndex((w) => w.playerId === me);
  const seated = view.me.seat !== null;
  const asking = view.requests.some((r) => r.playerId === me && r.kind === 'seat');
  const held = new Set([...view.offers.map((o) => o.seat), ...view.requests.filter((r) => r.kind === 'seat').map((r) => r.seat)]);
  const full = view.seats.every((s, i) => s !== null || held.has(i));
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
          {view.spectator.delaySeconds > 0 ? `, ${delayText(view.spectator.delaySeconds)} behind the table` : ''}.
        </div>
      )}
      {!view.spectator && <CardsWatched view={view} onPeople={onPeople} />}
    </>
  );
}

const ackKey = (tableId: string) => `rsdp.cardsWatchedSeen.${tableId}`;

function seenAt(tableId: string): number {
  try {
    return Number(localStorage.getItem(ackKey(tableId))) || 0;
  } catch {
    return 0;
  }
}

/** Remembers that this browser has been told spectators see every card (agreeing to it when sitting counts). */
export function markCardsWatchedSeen(tableId: string, at: number) {
  try {
    localStorage.setItem(ackKey(tableId), String(at));
  } catch {
    // Private mode: the warning just shows again.
  }
}

/**
 * For players and staff while spectators see every hole card: a warning to
 * acknowledge when the host turns it on, then a line that stays as long as
 * it's on, with how far behind they are and how many are watching.
 */
function CardsWatched({ view, onPeople }: { view: TableView; onPeople: () => void }) {
  const watched = view.cardsWatched;
  const [seen, setSeen] = useState(() => seenAt(view.id));
  if (!watched) return null;
  const behind = watched.delaySeconds > 0 ? `${delayText(watched.delaySeconds)} behind the table` : 'live, with no delay';
  const count = `${watched.watchers} ${watched.watchers === 1 ? 'spectator' : 'spectators'} watching`;
  // Whoever can change the settings turned it on themselves (or could have), so the warning is for everyone else.
  const fresh = watched.at > 0 && watched.at > seen && view.me.seat !== null && !view.powers.includes('settings');
  if (fresh) {
    return (
      <div className="banner watched alert" role="alert">
        <strong>👁 Spectators can now see every player's hole cards</strong>, {behind}. Someone watching could pass them on to a player. If you're not OK with that, say so in chat or
        leave the table.{' '}
        <button
          className="primary"
          onClick={() => {
            markCardsWatchedSeen(view.id, watched.at);
            setSeen(watched.at);
          }}
        >
          Got it
        </button>
      </div>
    );
  }
  return (
    <div className="banner watched">
      👁 Spectators see every hole card, {behind}.{' '}
      <button className="link" onClick={onPeople}>
        {count}
      </button>
    </div>
  );
}
