import { useEffect, useState } from 'react';
import type { SeatView, TableView } from '@rsdp/engine/wire';
import { clock, type Fmt } from '../format';
import { handStrength } from '../strength';
import { PlayingCard } from './PlayingCard';

/** What a player who showed down made, when every card of theirs is face up to us. */
const shownHand = (gameId: string, seat: SeatView, board: string[]) =>
  seat.cards.length && seat.cards.every((c) => c.card !== '??') ? handStrength(gameId, seat.cards.map((c) => c.card), board) : null;

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

/** Re-renders on an interval while something on screen is counting down. */
export function useNow(active: boolean, ms = 200) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

const SIT_OUT_TEXT: Record<NonNullable<SeatView['sitOutReason']>, string> = {
  player: 'sitting out',
  timeouts: 'away',
  busted: 'busted',
  host: 'sat out by host',
};

export interface DiscardPick {
  selected: number[];
  toggle: (index: number) => void;
}

export function Table({
  view,
  skew,
  fmt,
  onPickSeat,
  onSeatClick,
  discard,
}: {
  view: TableView;
  /** Server clock minus ours. */
  skew: number;
  fmt: Fmt;
  onPickSeat?: (seat: number) => void;
  onSeatClick?: (seat: SeatView) => void;
  discard?: DiscardPick | null;
}) {
  const n = view.seats.length;
  // Rotate so your own seat is at the bottom.
  const offset = view.me.seat ?? 0;
  const hand = view.hand;
  const done = hand?.phase === 'complete';
  const live = !!hand && !done;
  const ticking = !!view.turn || view.nextHandAt !== null || !!hand?.runItTwice.deadline;
  const now = useNow(ticking) + skew;

  const winningCards = new Set<string>();
  if (done) for (const a of hand!.awards) if (a.run === 0 && a.board === 0) a.cards?.forEach((c) => winningCards.add(c));
  const highlight = (card: string) => (winningCards.size === 0 || card === '??' ? '' : winningCards.has(card) ? 'win' : 'dim');

  // One line per winner: total won and the best hand they won with.
  const results = new Map<number, { amount: number; handName?: string }>();
  if (done)
    for (const a of hand!.awards) {
      const prev = results.get(a.seat);
      results.set(a.seat, { amount: (prev?.amount ?? 0) + a.amount, handName: prev?.handName ?? a.handName });
    }

  const bets = view.seats.reduce((s, x) => s + (x?.bet ?? 0), 0);
  const runs = hand?.boards ?? [];
  const multiRun = runs.length > 1;
  const multiBoard = (runs[0]?.length ?? 0) > 1;
  const stud = hand?.family === 'stud';

  return (
    <div className={`felt ${view.me.seat !== null ? 'seated-view' : ''}`}>
      <div className="felt-brand">
        RSDP Poker <span>Live!</span>
      </div>
      <div className="board">
        {runs.map((run, r) =>
          run.map(
            (cards, b) =>
              cards.length > 0 && (
                <div className="cards board-row" key={`${r}-${b}`}>
                  {(multiRun || multiBoard) && (
                    <span className="board-label">{multiRun ? `Run ${r + 1}` : `Board ${b + 1}`}</span>
                  )}
                  {cards.map((c, i) => (
                    <PlayingCard
                      key={`${hand!.handNumber}-${r}-${b}-${c}`}
                      card={c}
                      className={`deal-board ${highlight(c)}`}
                      style={{ animationDelay: `${cards.length <= 3 ? i * 90 : 0}ms` }}
                    />
                  ))}
                </div>
              ),
          ),
        )}
        {live && (
          <div className="pots">
            {hand!.pots.map((p, i) => (
              <div className="pot" key={i}>
                {i === 0 ? 'Pot' : `Side pot ${i}`} {fmt(p.amount)}
              </div>
            ))}
            {bets > 0 && hand!.potTotal > 0 && <div className="pot total">Total {fmt(hand!.potTotal)}</div>}
          </div>
        )}
        {done &&
          [...results.entries()].map(([seat, w]) => (
            <div className="pot result" key={seat}>
              {view.seats[seat]?.name ?? 'Player'} wins {fmt(w.amount)}
              {w.handName ? ` · ${w.handName}` : ''}
            </div>
          ))}
        {!live && view.nextHandAt !== null && view.started && !view.paused && (
          <div className="next-hand">Next hand in {Math.max(0, Math.ceil((view.nextHandAt - now) / 1000))}</div>
        )}
        {view.paused && <div className="next-hand">Paused</div>}
        {!hand && view.upcoming && <div className="next-hand muted">{view.upcoming.gameName}</div>}
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
        const isMe = seat === view.me.seat;
        const acting = live && hand!.toAct === seat;
        const won = results.get(seat);
        let timeFraction: number | null = null;
        let secondsLeft: number | null = null;
        if (acting && view.turn?.seat === seat && view.turn.deadline) {
          const total = view.turn.deadline - view.turn.startedAt;
          timeFraction = Math.max(0, Math.min(1, (view.turn.deadline - now) / total));
          secondsLeft = Math.max(0, Math.ceil((view.turn.deadline - now) / 1000));
        }
        const classes = [
          'seat',
          acting && 'acting',
          s.folded && 'folded',
          (s.sittingOut || !s.online) && 'away',
          won && 'winner',
          isMe && 'me',
          onSeatClick && 'host-click',
        ]
          .filter(Boolean)
          .join(' ');
        const status = !s.online
          ? 'offline'
          : s.sittingOut
            ? SIT_OUT_TEXT[s.sitOutReason ?? 'player']
            : s.leaving
              ? 'leaving'
              : s.waiting && !s.inHand
                ? s.waitForBigBlind
                  ? 'waiting for big blind'
                  : 'next hand'
                : null;
        const pickable = isMe && !!discard;
        return (
          <div key={seat}>
            <div className={classes} style={pos}>
              <div className={`hole n${s.cards.length}`}>
                {s.cards.map((c, i) => (
                  <PlayingCard
                    key={`${hand?.handNumber}-${i}-${c.card}`}
                    card={c.card}
                    small
                    className={[
                      'deal-hole',
                      highlight(c.card),
                      stud && !c.up && 'facedown',
                      pickable && discard!.selected.includes(i) && 'discard',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={{ animationDelay: `${i * 90}ms` }}
                    onClick={pickable ? () => discard!.toggle(i) : undefined}
                    title={pickable ? 'Click to throw this card away' : undefined}
                  />
                ))}
              </div>
              <div className="nameplate" onClick={onSeatClick ? () => onSeatClick(s) : undefined}>
                <div className="name">
                  {s.name}
                  {s.playerId === view.hostId && <span className="tag">host</span>}
                </div>
                <div className="stack">{s.allIn ? 'ALL IN' : fmt(s.stack)}</div>
                {status && <div className="status">{status}</div>}
                {s.lastAction && live && <div className={`last-action a-${s.lastAction.split(' ')[0].toLowerCase()}`}>{s.lastAction}</div>}
                {done && !won && s.inHand && !s.folded && shownHand(hand!.gameId, s, hand!.boards[0]?.[0] ?? []) && (
                  <div className="status">{shownHand(hand!.gameId, s, hand!.boards[0]?.[0] ?? [])}</div>
                )}
                {timeFraction !== null && (
                  <div className={`timer ${view.turn?.usingBank ? 'bank' : ''}`}>
                    <div className={`timer-fill ${secondsLeft! <= 5 ? 'low' : ''}`} style={{ width: `${timeFraction * 100}%` }} />
                  </div>
                )}
                {timeFraction !== null && view.turn?.usingBank && <div className="status bank-text">time bank {clock(secondsLeft! * 1000)}</div>}
              </div>
              {hand && !stud && hand.button === seat && <div className={`dealer ${hand.buttonDead ? 'dead' : ''}`}>D</div>}
              {won && <div className="win-float">+{fmt(won.amount)}</div>}
            </div>
            {s.bet > 0 && (
              <div className="bet" style={betPosition(idx, n)}>
                <span className="chip" />
                {fmt(s.bet)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
