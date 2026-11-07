import type { HandRecordView, LedgerView, TableView } from '@rsdp/engine/wire';
import type { Fmt } from './format';
import { settleUp } from './records';

/*
 * The recap a player pastes into the group chat after a cash game: the table
 * and the date, the games, how many hands in how long, everyone's result and
 * the biggest pot. It is built only from what this viewer already sees: the
 * ledger (the same rows settle-up pays from) and the finished hands their
 * Hands tab shows. No link (a table's link is its invite) and no cards.
 */

/** A break longer than this between two hands (the next night, say) isn't counted in how long the game ran. */
export const BREAK_MS = 60 * 60 * 1000;
/** Games named before the rest are only counted ("and 2 more"), so a dealer's choice night still fits a phone. One more is named rather than counted. */
const GAMES_NAMED = 3;

export type RecapHand = Pick<HandRecordView, 'handNumber' | 'startedAt' | 'endedAt' | 'gameName' | 'seats' | 'events'>;

export interface RecapInput {
  tableName: string;
  /** The ledger as this viewer sees it (view.ledger). */
  ledger: Pick<LedgerView, 'playerId' | 'name' | 'net' | 'bot'>[];
  /** The finished hands this viewer can see; null when they couldn't be loaded, which leaves out what comes from them. */
  hands: RecapHand[] | null;
  /** The game is still running: the results are so far, with chips on the table counted as if cashed out now. */
  running: boolean;
  /** Dollars and cents (cash tables since D15), or plain chips at older tables. */
  centsMode: boolean;
  /** Amounts as the ledger shows them (chipFormat). */
  fmt: Fmt;
  /** The date to show when there are no hands to date it by. */
  now: number;
  /** Where the dates are read: the browser's own unless given (tests give them). */
  locale?: string;
  timeZone?: string;
}

/** The recap's lines, joined with newlines, ready to paste. */
export function cashRecap(input: RecapInput): string {
  const { fmt, centsMode } = input;
  const hands = input.hands && [...input.hands].sort((a, b) => a.handNumber - b.handNumber);
  const amount = (n: number) => `${centsMode ? '$' : ''}${fmt(Math.abs(n))}`;
  const signed = (n: number) => (n === 0 ? 'even' : `${n > 0 ? '+' : '-'}${amount(n)}`);
  const day = new Intl.DateTimeFormat(input.locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: input.timeZone });

  const first = hands?.[0];
  const last = hands?.at(-1);
  const from = day.format(first?.startedAt ?? input.now);
  const to = last ? day.format(last.endedAt) : from;
  const lines = [`${input.tableName} · ${from === to ? from : `${from} to ${to}`}${input.running ? ' (still playing)' : ''}`];

  if (hands) {
    if (!hands.length) lines.push('No hands played yet.');
    else {
      lines.push(gamesLine(hands));
      lines.push(`${hands.length} ${hands.length === 1 ? 'hand' : 'hands'} in ${duration(playTime(hands))}`);
    }
  }

  // Practice bots play for nothing: settle-up pays only between people, so they get one line of their own.
  const people = input.ledger.filter((r) => !r.bot);
  const order = [...people].sort((a, b) => b.net - a.net || a.name.localeCompare(b.name) || a.playerId.localeCompare(b.playerId));
  lines.push('', ...order.map((r) => `${r.name} ${signed(r.net)}`));
  const { bots } = settleUp(input.ledger);
  if (bots !== 0) lines.push(`Practice bots ${bots > 0 ? 'won' : 'lost'} ${amount(bots)} (play money, so nobody pays it)`);

  const pot = hands && biggestPot(hands);
  if (pot) {
    const who = pot.winners.length === 1 ? `to ${pot.winners[0]}` : `split by ${andList(pot.winners)}`;
    lines.push('', `Biggest pot: ${amount(pot.amount)} ${who} (hand ${pot.handNumber})`);
  }
  return lines.join('\n');
}

/** The games played, in the order they were first dealt. */
function gamesLine(hands: RecapHand[]): string {
  const games = [...new Set(hands.map((h) => h.gameName))];
  if (games.length <= GAMES_NAMED + 1) return andList(games);
  return `${games.slice(0, GAMES_NAMED).join(', ')} and ${games.length - GAMES_NAMED} more`;
}

/** How long the game ran: from the first hand to the last, leaving out any break over BREAK_MS. */
export function playTime(hands: Pick<RecapHand, 'startedAt' | 'endedAt'>[]): number {
  let total = 0;
  let lastEnd: number | null = null;
  for (const h of hands) {
    const end = Math.max(h.endedAt, h.startedAt);
    if (lastEnd !== null && h.startedAt > lastEnd && h.startedAt - lastEnd <= BREAK_MS) total += h.startedAt - lastEnd;
    total += end - h.startedAt;
    lastEnd = Math.max(lastEnd ?? end, end);
  }
  return total;
}

/** "2h 35m", "45m", "3h". */
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

/**
 * The hand whose pots paid out the most (the earlier one on a tie), and who won it, biggest share first. Awards
 * are shown to everyone at the table, so this needs no cards.
 */
export function biggestPot(hands: RecapHand[]): { handNumber: number; amount: number; winners: string[] } | null {
  let best: { handNumber: number; amount: number; winners: string[] } | null = null;
  for (const h of hands) {
    const won = new Map<number, number>();
    for (const e of h.events) if (e.t === 'award') won.set(e.seat, (won.get(e.seat) ?? 0) + e.amount);
    const amount = [...won.values()].reduce((a, b) => a + b, 0);
    if (amount <= 0 || (best && amount <= best.amount)) continue;
    const name = (seat: number) => {
      const s = h.seats.find((x) => x.seat === seat);
      return s ? `${s.name}${s.bot ? ' (bot)' : ''}` : `Seat ${seat + 1}`;
    };
    const winners = [...won].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([seat]) => name(seat));
    best = { handNumber: h.handNumber, amount, winners };
  }
  return best;
}

/** "Ann", "Ann and Bo", "Ann, Bo and Cy". */
function andList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * Whether this viewer is offered the recap: on cash tables where people have played each other, never a practice
 * table (realGame), once anyone has bought in. Everyone who sees the ledger then gets it, spectators included.
 * realGame turns on as the first hand between two people is dealt, which a spectator on a delay hasn't seen yet, so
 * for them the button waits out the delay after this browser first saw it on (`realSeenAt`, by the same clock as `now`).
 */
export function recapOffered(view: Pick<TableView, 'mode' | 'realGame' | 'ledger' | 'spectator'>, realSeenAt: number | undefined, now: number): boolean {
  if (view.mode !== 'cash' || !view.realGame || !view.ledger.length) return false;
  const delay = (view.spectator?.delaySeconds ?? 0) * 1000;
  return delay <= 0 || (realSeenAt !== undefined && now - realSeenAt >= delay);
}
