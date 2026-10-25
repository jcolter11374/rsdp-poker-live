import { useEffect, useState } from 'react';
import type { RoomView } from '@rsdp/engine';
import { PlayingCard } from './PlayingCard';

/** Seat positions around an oval, as percentages. Index 0 is the bottom centre. */
function position(i: number, n: number) {
  const angle = Math.PI / 2 + (i / n) * Math.PI * 2;
  return { left: `${50 + 46 * Math.cos(angle)}%`, top: `${50 + 42 * Math.sin(angle)}%` };
}

/** Where a seat's bet sits: part of the way from the seat towards the middle. */
function betPosition(i: number, n: number) {
  const angle = Math.PI / 2 + (i / n) * Math.PI * 2;
  return { left: `${50 + 30 * Math.cos(angle)}%`, top: `${50 + 25 * Math.sin(angle)}%` };
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 200);
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
  const done = hand?.street === 'complete';

  const winnings = new Map<number, number>();
  const winningCards = new Set<string>();
  for (const pot of done ? hand!.results : [])
    for (const w of pot.winners) {
      winnings.set(w.seat, (winnings.get(w.seat) ?? 0) + w.amount);
      // Highlight the hand that won the main pot.
      if (pot === hand!.results[0]) w.bestCards?.forEach((c) => winningCards.add(c));
    }
  const highlight = (card: string | null) =>
    winningCards.size === 0 || !card ? '' : winningCards.has(card) ? 'win' : 'dim';

  const totalPot = (hand?.pot ?? 0) + view.seats.reduce((s, x) => s + (x?.bet ?? 0), 0);
  const winnerText = done
    ? hand!.results
        .flatMap((r) => r.winners)
        .reduce<Map<number, { amount: number; handName?: string }>>((m, w) => {
          const prev = m.get(w.seat);
          m.set(w.seat, { amount: (prev?.amount ?? 0) + w.amount, handName: w.handName });
          return m;
        }, new Map())
    : null;

  return (
    <div className={`felt ${view.you.seat !== -1 ? 'seated-view' : ''}`}>
      <div className="felt-brand">
        RSDP Poker <span>Live!</span>
      </div>
      <div className="board">
        {hand && hand.board.length > 0 && (
          <div className="cards">
            {hand.board.map((c, i) => (
              <PlayingCard
                key={`${hand.number}-${c}`}
                card={c}
                className={`deal-board ${highlight(c)}`}
                style={{ animationDelay: `${hand.board.length <= 3 ? i * 90 : 0}ms` }}
              />
            ))}
          </div>
        )}
        {hand && !done && totalPot > 0 && <div className="pot">Pot {totalPot}</div>}
        {winnerText &&
          [...winnerText.entries()].map(([seat, w]) => (
            <div className="pot result" key={seat}>
              {view.seats[seat]?.name ?? 'Player'} wins {w.amount}
              {w.handName ? ` · ${w.handName}` : ''}
            </div>
          ))}
      </div>

      {view.seats.map((s, seat) => {
        const idx = (seat - offset + n) % n;
        const pos = position(idx, n);
        if (!s) {
          return (
            <div className="seat empty" style={pos} key={seat}>
              {onPickSeat ? <button onClick={() => onPickSeat(seat)}>Sit</button> : <span>{seat + 1}</span>}
            </div>
          );
        }
        const acting = hand?.toAct === seat;
        const away = view.away.includes(s.playerId);
        let timeFraction: number | null = null;
        let secondsLeft: number | null = null;
        if (acting && view.turnDeadline && view.turnStarted) {
          const total = view.turnDeadline - view.turnStarted;
          timeFraction = Math.max(0, Math.min(1, (view.turnDeadline - now) / total));
          secondsLeft = Math.max(0, Math.ceil((view.turnDeadline - now) / 1000));
        }
        const classes = [
          'seat',
          acting && 'acting',
          s.folded && 'folded',
          (s.sittingOut || away) && 'away',
          winnings.has(seat) && 'winner',
          seat === view.you.seat && 'me',
        ]
          .filter(Boolean)
          .join(' ');
        const status = away ? 'offline' : s.sittingOut ? 'sitting out' : null;
        return (
          <div key={seat}>
            <div className={classes} style={pos}>
              <div className="hole">
                {s.cards.map((c, i) => (
                  <PlayingCard
                    key={`${hand?.number}-${i}-${c ?? 'x'}`}
                    card={c}
                    small
                    className={`deal-hole ${highlight(c)}`}
                    style={{ animationDelay: `${i * 120}ms` }}
                  />
                ))}
              </div>
              <div className="nameplate">
                <div className="name">
                  {s.name}
                  {s.playerId === view.hostId && <span className="tag">host</span>}
                </div>
                <div className="stack">{s.allIn ? 'ALL IN' : s.stack}</div>
                {status && <div className="status">{status}</div>}
                {s.lastAction && !done && <div className={`last-action a-${s.lastAction.replace(' ', '-').toLowerCase()}`}>{s.lastAction}</div>}
                {timeFraction !== null && (
                  <div className="timer">
                    <div
                      className={`timer-fill ${secondsLeft! <= 5 ? 'low' : ''}`}
                      style={{ width: `${timeFraction * 100}%` }}
                    />
                  </div>
                )}
              </div>
              {view.button === seat && <div className="dealer">D</div>}
              {winnings.has(seat) && <div className="win-float">+{winnings.get(seat)}</div>}
            </div>
            {s.bet > 0 && (
              <div className="bet" style={betPosition(idx, n)}>
                <span className="chip" />
                {s.bet}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
