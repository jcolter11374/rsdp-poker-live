import { useEffect, useState } from 'react';
import type { RoomView } from '@rsdp/engine';
import { PlayingCard } from './PlayingCard';

/** Seat positions around an oval, as percentages. Index 0 is the bottom centre. */
function position(i: number, n: number) {
  const angle = Math.PI / 2 + (i / n) * Math.PI * 2;
  return { left: `${50 + 46 * Math.cos(angle)}%`, top: `${50 + 42 * Math.sin(angle)}%` };
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function Table({ view, onPickSeat }: { view: RoomView; onPickSeat?: (seat: number) => void }) {
  const n = view.seats.length;
  // Rotate so your own seat is at the bottom.
  const offset = view.you.seat === -1 ? 0 : view.you.seat;
  const hand = view.hand;
  const now = useNow(view.turnDeadline !== null);
  const winners = new Map<number, number>();
  for (const pot of hand?.results ?? [])
    for (const w of pot.winners) winners.set(w.seat, (winners.get(w.seat) ?? 0) + w.amount);
  const totalPot = (hand?.pot ?? 0) + view.seats.reduce((s, x) => s + (x?.bet ?? 0), 0);

  return (
    <div className="felt">
      <div className="board">
        {hand && hand.board.length > 0 && (
          <div className="cards">
            {hand.board.map((c) => (
              <PlayingCard key={c} card={c} />
            ))}
          </div>
        )}
        {hand && totalPot > 0 && hand.street !== 'complete' && <div className="pot">Pot {totalPot}</div>}
        {hand?.street === 'complete' &&
          hand.results.map((r, i) => (
            <div className="pot" key={i}>
              {r.winners
                .map((w) => `${view.seats[w.seat]?.name ?? 'Player'} wins ${w.amount}${w.handName ? ` with ${w.handName}` : ''}`)
                .join(', ')}
            </div>
          ))}
      </div>

      {view.seats.map((s, seat) => {
        const pos = position((seat - offset + n) % n, n);
        if (!s) {
          return (
            <div className="seat empty" style={pos} key={seat}>
              {onPickSeat ? <button onClick={() => onPickSeat(seat)}>Sit here</button> : <span>Empty</span>}
            </div>
          );
        }
        const acting = hand?.toAct === seat;
        const secondsLeft = acting && view.turnDeadline ? Math.max(0, Math.ceil((view.turnDeadline - now) / 1000)) : null;
        const classes = [
          'seat',
          acting && 'acting',
          s.folded && 'folded',
          s.sittingOut && 'away',
          winners.has(seat) && 'winner',
          seat === view.you.seat && 'me',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div className={classes} style={pos} key={seat}>
            <div className="hole">
              {s.cards.map((c, i) => (
                <PlayingCard key={i} card={c} small />
              ))}
            </div>
            <div className="nameplate">
              <div className="name">
                {s.name}
                {s.playerId === view.hostId && <span className="tag">host</span>}
              </div>
              <div className="stack">{s.sittingOut ? 'away' : s.allIn ? 'ALL IN' : s.stack}</div>
              {secondsLeft !== null && <div className="clock">{secondsLeft}s</div>}
            </div>
            {view.button === seat && <div className="dealer">D</div>}
            {s.bet > 0 && <div className="bet">{s.bet}</div>}
          </div>
        );
      })}
    </div>
  );
}
