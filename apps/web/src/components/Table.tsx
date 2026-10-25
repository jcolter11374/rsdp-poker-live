import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { SeatView, TableView } from '@rsdp/engine/wire';
import { clock, type Fmt } from '../format';
import { handStrength } from '../strength';
import { PlayingCard } from './PlayingCard';
import { fromVars, lerp, px, seatFractions, stadiumPoint, type Point } from './geometry';
import { BoardExtras, FeltExtras, SeatExtras } from './table/slots';
import { feltStyle, usePrefs } from '../prefs';

/** What a player who showed down made, when every card of theirs is face up to us. */
const shownHand = (gameId: string, seat: SeatView, board: string[]) =>
  seat.cards.length && seat.cards.every((c) => c.card !== '??') ? handStrength(gameId, seat.cards.map((c) => c.card), board) : null;

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

/** The element's size, kept up to date as it changes. */
function useSize(ref: RefObject<HTMLElement>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** A short badge for a seat that is not playing, or null when it is. */
function seatBadge(s: SeatView): { text: string; kind: 'offline' | 'away' | 'info' } | null {
  if (!s.online) return { text: s.sittingOut ? 'Away · offline' : 'Offline', kind: 'offline' };
  if (s.sittingOut) {
    if (s.sitOutReason === 'busted') return { text: 'Busted', kind: 'away' };
    if (s.sitOutReason === 'host') return { text: 'Sat out by host', kind: 'away' };
    if (s.sitOutReason === 'timeouts') return { text: 'Away · timed out', kind: 'away' };
    return { text: 'Away', kind: 'away' };
  }
  if (s.leaving) return { text: 'Leaving', kind: 'info' };
  if (s.waiting && !s.inHand) return { text: s.waitForBigBlind ? 'Waits for big blind' : 'Plays next hand', kind: 'info' };
  return null;
}

export interface DiscardPick {
  selected: number[];
  toggle: (index: number) => void;
}

/** Chips flying across the felt: bets swept into the pot, the pot pushed to a winner. */
interface Flight {
  id: number;
  from: Point;
  to: Point;
  delay: number;
  kind: 'sweep' | 'award';
}

let flightId = 0;

export function Table({
  view,
  skew,
  fmt,
  compact = false,
  onPickSeat,
  onAddBot,
  onSeatClick,
  discard,
}: {
  view: TableView;
  /** Server clock minus ours. */
  skew: number;
  fmt: Fmt;
  /** Phone layout: a tall table and smaller seats. */
  compact?: boolean;
  onPickSeat?: (seat: number) => void;
  /** Put a practice bot in this empty seat. */
  onAddBot?: (seat: number) => void;
  onSeatClick?: (seat: SeatView) => void;
  discard?: DiscardPick | null;
}) {
  const felt = useRef<HTMLDivElement>(null);
  const prefs = usePrefs();
  const size = useSize(felt);
  const n = view.seats.length;
  // Rotate so your own seat is at the bottom.
  const offset = view.me.seat ?? 0;
  const hand = view.hand;
  const done = hand?.phase === 'complete';
  const live = !!hand && !done;
  const ticking = !!view.turn || view.nextHandAt !== null || !!hand?.runItTwice.deadline;
  const now = useNow(ticking) + skew;
  const myTurn = !!view.legal || !!view.canDraw || view.canVoteRunItTwice;

  // Geometry. Before the first measure, assume a typical box so nothing jumps far.
  const w = size.w || (compact ? 320 : 800);
  const h = size.h || (compact ? 520 : 500);
  const center: Point = { x: w / 2, y: h / 2 };
  // Empty seats keep about half a nameplate clear of players and a seat button's width from each other.
  const perimeter = 2 * Math.abs(w - h) + Math.PI * Math.min(w, h);
  const fractions = seatFractions(
    view.seats.map((s) => !!s),
    offset,
    { margin: (compact ? 62 : 90) / perimeter, minGap: (compact ? 58 : 64) / perimeter },
  );
  const seatPoint = (seat: number) => stadiumPoint(fractions[seat], w, h);
  // Your own bet sits further in, clear of your bigger cards.
  const betPoint = (seat: number) => lerp(seatPoint(seat), center, seat === view.me.seat ? (compact ? 0.48 : 0.56) : compact ? 0.36 : 0.4);
  const buttonPoint = (seat: number) => {
    const p = seatPoint(seat);
    // Beside the nameplate, square to the line to the middle: clear of the
    // cards above the plate and the bet in front of it. Downward when that
    // line is mostly sideways, since the cards sit above.
    const dx = center.x - p.x;
    const dy = center.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    let sx = -dy / len;
    let sy = dx / len;
    if (sy < 0) (sx = -sx), (sy = -sy);
    // Clear of the nameplate, which is wider now that it carries the picture.
    const reach = Math.abs(sx) * (compact ? 58 : 88) + Math.abs(sy) * (compact ? 36 : 44);
    const inward = compact ? 22 : 10;
    return { x: p.x + sx * reach + (dx / len) * inward, y: p.y + sy * reach + (dy / len) * inward };
  };

  // Winning cards, per board, and every card any winner used.
  const boardWinners = new Map<string, Set<string>>();
  const winningHole = new Set<string>();
  if (done)
    for (const a of hand!.awards) {
      const key = `${a.run}-${a.board}`;
      if (!boardWinners.has(key)) boardWinners.set(key, new Set());
      a.cards?.forEach((c) => {
        boardWinners.get(key)!.add(c);
        winningHole.add(c);
      });
    }
  const highlight = (card: string, set: Set<string> | undefined) => (!set || set.size === 0 || card === '??' ? '' : set.has(card) ? 'win' : 'dim');

  // One line per winner: total won and the best hand they won with.
  const results = new Map<number, { amount: number; handName?: string }>();
  if (done)
    for (const a of hand!.awards) {
      const prev = results.get(a.seat);
      results.set(a.seat, { amount: (prev?.amount ?? 0) + a.amount, handName: prev?.handName ?? a.handName });
    }

  // Chip flights: bets swept in when a betting round ends, the pot pushed to the winners.
  const [flights, setFlights] = useState<Flight[]>([]);
  const lastRound = useRef<{ key: string; hand: number } | null>(null);
  const lastBets = useRef<number[]>([]);
  const flightTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => flightTimers.current.forEach(clearTimeout), []);
  const geometry = useRef({ betPoint, seatPoint, center });
  geometry.current = { betPoint, seatPoint, center };
  const roundKey = hand ? `${hand.handNumber}:${hand.street}:${done ? 'done' : 'live'}` : '';
  // Runs before the effect below stores this view's bets, so lastBets holds the round that just ended.
  useEffect(() => {
    const before = lastRound.current;
    lastRound.current = hand ? { key: roundKey, hand: hand.handNumber } : null;
    if (!hand || !before || before.key === roundKey || before.hand !== hand.handNumber || document.hidden) return;
    const g = geometry.current;
    const next: Flight[] = [];
    lastBets.current.forEach((amount, seat) => {
      if (amount > 0) next.push({ id: ++flightId, from: g.betPoint(seat), to: g.center, delay: 0, kind: 'sweep' });
    });
    if (done) {
      const winners = [...new Set(hand.awards.map((a) => a.seat))];
      for (const seat of winners) next.push({ id: ++flightId, from: g.center, to: g.seatPoint(seat), delay: next.length ? 350 : 100, kind: 'award' });
    }
    if (!next.length) return;
    setFlights((f) => [...f, ...next]);
    const ids = new Set(next.map((f) => f.id));
    const t = setTimeout(() => {
      flightTimers.current.delete(t);
      setFlights((f) => f.filter((x) => !ids.has(x.id)));
    }, 1400);
    flightTimers.current.add(t);
  }, [roundKey]);
  useEffect(() => {
    lastBets.current = view.seats.map((s) => s?.bet ?? 0);
  }, [view]);

  const bets = view.seats.reduce((s, x) => s + (x?.bet ?? 0), 0);
  const runs = hand?.boards ?? [];
  const multiRun = runs.length > 1;
  const multiBoard = (runs[0]?.length ?? 0) > 1;
  const stud = hand?.family === 'stud';
  // Order of seats from the button, so the deal goes round the table.
  const dealOrder = (seat: number) => (hand ? (seat - hand.button - 1 + n) % n : 0);

  return (
    <div
      ref={felt}
      className={['felt', compact && 'compact', view.me.seat !== null && 'seated-view', myTurn && 'my-turn'].filter(Boolean).join(' ')}
      style={feltStyle(prefs, view.settings.table.felt)}
    >
      <div className="felt-brand">
        RSDP Poker <span>Live!</span>
      </div>
      <div className={`board${multiRun || multiBoard ? ' multi' : ''}`}>
        {runs.map((run, r) =>
          run.map(
            (cards, b) =>
              cards.length > 0 && (
                <div className="cards board-row" key={`${r}-${b}`}>
                  {(multiRun || multiBoard) && <span className="board-label">{multiRun ? `Run ${r + 1}` : `Board ${b + 1}`}</span>}
                  {cards.map((c, i) => (
                    <PlayingCard
                      key={`${hand!.handNumber}-${r}-${b}-${c}`}
                      card={c}
                      className={`deal-board ${highlight(c, boardWinners.get(`${r}-${b}`))}`}
                      style={{ animationDelay: `${cards.length <= 3 ? i * 110 : 0}ms` }}
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
              {view.hand?.names?.[seat] ?? view.seats[seat]?.name ?? 'Player'} wins {fmt(w.amount)}
              {w.handName ? ` · ${w.handName}` : ''}
            </div>
          ))}
        {!live && view.nextHandAt !== null && view.started && !view.paused && (
          <div className="next-hand">Next hand in {Math.max(0, Math.ceil((view.nextHandAt - now) / 1000))}</div>
        )}
        {view.paused && <div className="next-hand">Paused</div>}
        {!hand && view.upcoming && <div className="next-hand muted">{view.upcoming.gameName}</div>}
        <BoardExtras view={view} />
      </div>

      {view.seats.map((s, seat) => {
        const pos = seatPoint(seat);
        if (!s) {
          return (
            <div className="seat empty" style={px(pos)} key={seat}>
              {onPickSeat ? <button onClick={() => onPickSeat(seat)}>Sit</button> : !onAddBot && <span>{seat + 1}</span>}
              {onAddBot && (
                <button className="add-bot" onClick={() => onAddBot(seat)} title="Add a practice bot to this seat">
                  + Bot
                </button>
              )}
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
        const badge = seatBadge(s);
        const classes = [
          'seat',
          pos.x < w * 0.18 ? 'edge-left' : pos.x > w * 0.82 ? 'edge-right' : '',
          acting && 'acting',
          s.folded && 'folded',
          (s.sittingOut || !s.online) && 'away',
          won && 'winner',
          isMe && 'me',
          onSeatClick && 'host-click',
        ]
          .filter(Boolean)
          .join(' ');
        const pickable = isMe && !!discard;
        const shown = done && !won && s.inHand && !s.folded ? shownHand(hand!.gameId, s, hand!.boards[0]?.[0] ?? []) : null;
        const toMiddle = fromVars(center, pos);
        const muck = fromVars(lerp(pos, center, 0.5), pos);
        return (
          <div key={seat}>
            <div className={classes} style={px(pos)}>
              <div className={`hole n${s.cards.length} ${s.folded && !isMe ? 'mucked' : ''}`} style={muck}>
                {s.cards.map((c, i) => {
                  const face = c.card !== '??';
                  // Cards turned over at showdown flip; everything else is dealt in from the middle.
                  const flip = face && !isMe && !c.up;
                  return (
                    <PlayingCard
                      key={`${hand?.handNumber}-${i}-${isMe ? c.card : face ? 'f' : 'b'}`}
                      card={c.card}
                      small={!(compact && isMe)}
                      className={[
                        flip ? 'flip-in' : 'deal-hole',
                        highlight(c.card, winningHole),
                        stud && !c.up && 'facedown',
                        pickable && discard!.selected.includes(i) && 'discard',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{ ...toMiddle, animationDelay: flip ? `${i * 80}ms` : hand?.street === 0 ? `${(i * n + dealOrder(seat)) * 45}ms` : '0ms' }}
                      onClick={pickable ? () => discard!.toggle(i) : undefined}
                      title={pickable ? 'Tap to throw this card away' : undefined}
                    />
                  );
                })}
              </div>
              <div className="nameplate" onClick={onSeatClick ? () => onSeatClick(s) : undefined}>
                {badge && badge.kind !== 'info' && <div className={`pill ${badge.kind}`}>{badge.text}</div>}
                <div className="name">
                  {s.name}
                  {s.playerId === view.hostId && <span className="tag">host</span>}
                  {s.bot && (
                    <span className="tag bot" title={`A practice bot added by ${s.bot.ownerName}`}>
                      bot
                    </span>
                  )}
                </div>
                <div className="stack">{s.allIn ? 'ALL IN' : fmt(s.stack)}</div>
                {badge?.kind === 'info' && <div className="status">{badge.text}</div>}
                {s.lastAction && live && <div className={`last-action a-${s.lastAction.split(' ')[0].toLowerCase()}`}>{s.lastAction}</div>}
                {shown && <div className="status">{shown}</div>}
                {timeFraction !== null && (
                  <div className={`timer ${view.turn?.usingBank ? 'bank' : ''}`}>
                    <div className={`timer-fill ${secondsLeft! <= 5 ? 'low' : ''}`} style={{ width: `${timeFraction * 100}%` }} />
                  </div>
                )}
                {timeFraction !== null && (secondsLeft! <= 10 || view.turn?.usingBank) && (
                  <div className={`status ${view.turn?.usingBank ? 'bank-text' : 'low-text'}`}>
                    {view.turn?.usingBank ? 'time bank ' : ''}
                    {clock(secondsLeft! * 1000)}
                  </div>
                )}
                <SeatExtras view={view} seat={s} />
              </div>
              {won && <div className="win-float">+{fmt(won.amount)}</div>}
            </div>
            {s.bet > 0 && (
              <div className="bet" style={{ ...px(betPoint(seat)), ...fromVars(pos, betPoint(seat)) }}>
                <span className="chip" />
                {fmt(s.bet)}
              </div>
            )}
          </div>
        );
      })}

      {hand && !stud && <div className={`dealer ${hand.buttonDead ? 'dead' : ''}`} style={px(buttonPoint(hand.button))}>D</div>}

      <FeltExtras view={view} seatPoint={seatPoint} railPoint={{ x: w / 2, y: h }} />

      {flights.map((f) => (
        <div key={f.id} className={`chip-flight ${f.kind}`} style={{ ...px(f.to), ...fromVars(f.from, f.to), animationDelay: `${f.delay}ms` }}>
          <span className="chip" />
          <span className="chip" />
          <span className="chip" />
        </div>
      ))}
    </div>
  );
}
