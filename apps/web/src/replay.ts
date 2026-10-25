import type { Award, HandEvent } from '@rsdp/engine/core';
import { getVariant } from '@rsdp/engine/variants';
import type { HandRecordView, HandView, SeatView, TableView, WireCard } from '@rsdp/engine/wire';
import { defaultSettings } from '@rsdp/engine/settings';
import { eventLines, type Fmt } from './format';

/** One step of a replay: the table as it stood, and what just happened. */
export interface Frame {
  seats: Map<number, ReplaySeat>;
  boards: string[][][];
  /** Chips gathered into the middle (excludes bets in front of players). */
  pot: number;
  street: number;
  /** Seat about to act, for the highlight. */
  toAct: number | null;
  awards: Award[];
  done: boolean;
  caption: string;
}

interface ReplaySeat {
  name: string;
  playerId: string;
  stack: number;
  bet: number;
  folded: boolean;
  allIn: boolean;
  cards: { card: string; up: boolean; shown: boolean }[];
  action: string | null;
}

const POST_LABEL: Record<string, string> = {
  ante: 'Ante',
  'big-blind-ante': 'BB ante',
  'small-blind': 'Small blind',
  'big-blind': 'Big blind',
  'dead-small-blind': 'Dead blind',
  'missed-big-blind': 'Missed blind',
  straddle: 'Straddle',
  'bomb-pot': 'Bomb pot',
  'bring-in': 'Bring-in',
};
const ACTION_LABEL: Record<string, string> = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise', 'bring-in': 'Bring-in', complete: 'Complete' };

function clone(f: Frame): Frame {
  const seats = new Map<number, ReplaySeat>();
  for (const [k, s] of f.seats) seats.set(k, { ...s, cards: s.cards.map((c) => ({ ...c })) });
  return { ...f, seats, boards: f.boards.map((run) => run.map((b) => [...b])), awards: [...f.awards] };
}

/**
 * Plays a hand's events into frames. Other players' cards stay face down until
 * they are shown, as at the table; your own are face up from the deal.
 */
export function replayFrames(hand: HandRecordView, myId: string | null, fmt: Fmt): Frame[] {
  const names = new Map(hand.seats.map((s) => [s.seat, s.name]));
  const mySeat = hand.seats.find((s) => s.playerId === myId)?.seat ?? null;
  let f: Frame = {
    seats: new Map(
      hand.seats.map((s) => [s.seat, { name: s.name, playerId: s.playerId, stack: s.stack, bet: 0, folded: false, allIn: false, cards: [], action: null }]),
    ),
    boards: [[[]]],
    pot: 0,
    street: 0,
    toAct: null,
    awards: [],
    done: false,
    caption: '',
  };
  const lines = (upTo: number) => eventLines(hand.events.slice(0, upTo), (seat) => names.get(seat) ?? `Seat ${seat + 1}`, fmt, mySeat);
  const gather = () => {
    for (const s of f.seats.values()) {
      f.pot += s.bet;
      s.bet = 0;
    }
  };
  const frames: Frame[] = [];
  let lineCount = 0;
  hand.events.forEach((e, i) => {
    const prev = hand.events[i - 1];
    // Deals to every seat show as one step.
    const merge = e.t === 'deal' && prev?.t === 'deal' && frames.length > 0;
    f = merge ? f : clone(f);
    apply(f, e, gather, mySeat);
    const all = lines(i + 1);
    const fresh = all.slice(lineCount).map((l) => l.replace(/^--- /, ''));
    lineCount = all.length;
    const next = hand.events[i + 1];
    f.toAct = next?.t === 'action' || next?.t === 'draw' ? next.seat : null;
    if (merge) {
      f.caption = [f.caption, ...fresh].filter(Boolean).join(' · ');
      frames[frames.length - 1] = f;
    } else {
      f.caption = fresh.join(' · ');
      frames.push(f);
    }
  });
  // Nothing to see in a frame that changed nothing visible and says nothing.
  return frames.filter((fr, i) => i === 0 || fr.caption || fr.done);
}

function apply(f: Frame, e: HandEvent, gather: () => void, mySeat: number | null) {
  const seat = 'seat' in e && typeof e.seat === 'number' ? f.seats.get(e.seat) : undefined;
  switch (e.t) {
    case 'hand-start':
      f.boards = Array.from({ length: 1 }, () => Array.from({ length: e.boards }, () => []));
      break;
    case 'post':
      if (!seat) break;
      seat.stack -= e.amount;
      if (e.live) seat.bet += e.amount;
      else f.pot += e.amount;
      seat.allIn = e.allIn;
      seat.action = POST_LABEL[e.kind] ?? null;
      break;
    case 'deal':
      if (!seat) break;
      for (const c of e.cards) seat.cards.push({ card: c.card, up: c.up, shown: c.up || e.seat === mySeat });
      break;
    case 'street':
      gather();
      f.street = e.street;
      for (const s of f.seats.values()) if (!s.folded) s.action = null;
      break;
    case 'board': {
      gather();
      while (f.boards.length <= e.run) f.boards.push(f.boards[0].map(() => []));
      // A second run starts from the cards the boards had in common.
      f.boards[e.run][e.board].push(...e.cards);
      break;
    }
    case 'action':
      if (!seat) break;
      seat.stack -= e.amount;
      if (e.action !== 'check' && e.action !== 'fold') seat.bet = e.to;
      if (e.action === 'fold') seat.folded = true;
      seat.allIn = e.allIn;
      seat.action = e.allIn ? 'All in' : ACTION_LABEL[e.action];
      break;
    case 'draw':
      if (!seat) break;
      if (e.positions) for (const p of e.positions) seat.cards.splice(p, 1);
      else seat.cards.splice(seat.cards.length - e.discarded, e.discarded);
      for (const c of e.cards) seat.cards.push({ card: c, up: false, shown: e.seat === mySeat });
      seat.action = e.discarded ? `Draw ${e.discarded}` : 'Stand pat';
      break;
    case 'uncalled':
      if (!seat) break;
      if (seat.bet >= e.amount) seat.bet -= e.amount;
      else f.pot -= e.amount;
      seat.stack += e.amount;
      break;
    case 'show':
      if (!seat) break;
      for (const c of seat.cards) if (e.cards.includes(c.card)) c.shown = true;
      break;
    case 'muck':
      if (seat) seat.action = 'Muck';
      break;
    case 'award':
      gather();
      if (seat) seat.stack += e.amount;
      f.pot -= e.amount;
      f.awards.push({ seat: e.seat, amount: e.amount, pot: e.pot, run: e.run, board: e.board, half: e.half, handName: e.handName, cards: e.cards } as Award);
      break;
    case 'transfer': {
      const from = e.from === 'house' ? undefined : f.seats.get(e.from);
      const to = e.to === 'house' ? undefined : f.seats.get(e.to);
      if (from) from.stack -= e.amount;
      if (to) to.stack += e.amount;
      break;
    }
    case 'hand-end':
      gather();
      for (const [k, v] of Object.entries(e.stacks)) {
        const s = f.seats.get(Number(k));
        if (s) s.stack = v;
      }
      f.pot = 0;
      f.done = true;
      break;
    default:
      break;
  }
}

/** A TableView for one frame, so the replay is drawn by the same table as live play. */
export function frameView(tableName: string, seatCount: number, hand: HandRecordView, frame: Frame, myId: string | null): TableView {
  const n = Math.max(seatCount, ...hand.seats.map((s) => s.seat + 1));
  const mySeat = hand.seats.find((s) => s.playerId === myId)?.seat ?? null;
  const start = hand.events.find((e): e is Extract<HandEvent, { t: 'hand-start' }> => e.t === 'hand-start');
  const gameId = start?.gameId ?? 'nlhe';
  let family: HandView['family'] = 'flop';
  try {
    family = getVariant(gameId).family;
  } catch {
    /* unknown game */
  }
  const seats: (SeatView | null)[] = Array.from({ length: n }, () => null);
  for (const [i, s] of frame.seats) {
    const cards: WireCard[] = s.cards.map((c) => ({ card: c.shown || c.up ? c.card : '??', up: c.up }));
    seats[i] = {
      seat: i,
      playerId: s.playerId,
      name: s.name,
      stack: s.stack,
      sittingOut: false,
      sitOutReason: null,
      online: true,
      inHand: true,
      folded: s.folded,
      allIn: s.allIn && !frame.done,
      bet: s.bet,
      cards,
      lastAction: s.action,
      timeBank: 0,
      leaving: false,
      owesBlinds: false,
      waiting: false,
      waitForBigBlind: false,
      straddle: false,
      won: 0,
      handName: null,
    };
  }
  const potTotal = frame.pot + [...frame.seats.values()].reduce((a, s) => a + s.bet, 0);
  const settings = defaultSettings('cash');
  return {
    id: 'replay',
    name: tableName,
    mode: 'cash',
    tournamentId: null,
    isHost: false,
    settings,
    pendingSettings: null,
    serverNow: Date.now(),
    ledger: [],
    chat: [],
    log: [],
    settingsLog: [],
    history: [],
    watchers: [],
    bombPotNext: false,
    rabbit: { available: false, cards: null },
    me: { playerId: myId ?? '', seat: mySeat },
    hostId: '',
    seats,
    started: true,
    paused: false,
    stopAfterHand: false,
    legal: null,
    canDraw: null,
    canVoteRunItTwice: false,
    canShow: [],
    turn: null,
    nextHandAt: null,
    upcoming: null,
    level: null,
    requests: [],
    hand: {
      handNumber: hand.handNumber,
      gameId,
      gameName: hand.gameName,
      shortName: hand.gameName,
      family,
      betting: hand.betting,
      stakes: hand.stakes,
      phase: frame.done ? 'complete' : 'betting',
      street: frame.street,
      streetName: '',
      button: hand.button,
      buttonDead: false,
      smallBlind: null,
      bigBlind: null,
      boards: frame.boards,
      pots: frame.pot > 0 ? [{ amount: frame.pot, eligible: [] }] : [],
      potTotal,
      toAct: frame.toAct,
      currentBet: 0,
      drawMax: null,
      runItTwice: { offered: false, votes: {}, deadline: null, times: null },
      showdown: frame.done,
      awards: frame.done ? frame.awards : [],
      events: [],
      bombPot: !!start?.bombPot,
    },
  } satisfies TableView;
}

export interface PlayerStats {
  playerId: string;
  name: string;
  hands: number;
  /** Put money in voluntarily on the first betting round. */
  vpip: number;
  /** Raised (or bet, or completed) on the first betting round. */
  pfr: number;
  won: number;
  net: number;
  biggestPot: number;
}

/** Per-player numbers over a set of hands: hands dealt, VPIP, PFR, pots won, net. */
export function playerStats(hands: HandRecordView[]): PlayerStats[] {
  const by = new Map<string, PlayerStats>();
  for (const h of hands) {
    const start = new Map(h.seats.map((s) => [s.seat, s.stack]));
    const voluntary = new Set<number>();
    const raised = new Set<number>();
    const winners = new Map<number, number>();
    let street = 0;
    let end: Record<number, number> | null = null;
    for (const e of h.events) {
      if (e.t === 'street') street = e.street;
      if (e.t === 'action' && street === 0) {
        if (e.action === 'call' || e.action === 'bet' || e.action === 'raise' || e.action === 'complete') voluntary.add(e.seat);
        if (e.action === 'bet' || e.action === 'raise' || e.action === 'complete') raised.add(e.seat);
      }
      if (e.t === 'award') winners.set(e.seat, (winners.get(e.seat) ?? 0) + e.amount);
      if (e.t === 'hand-end') end = e.stacks;
    }
    for (const s of h.seats) {
      const row = by.get(s.playerId) ?? { playerId: s.playerId, name: s.name, hands: 0, vpip: 0, pfr: 0, won: 0, net: 0, biggestPot: 0 };
      row.name = s.name;
      row.hands++;
      if (voluntary.has(s.seat)) row.vpip++;
      if (raised.has(s.seat)) row.pfr++;
      const w = winners.get(s.seat) ?? 0;
      if (w > 0) {
        row.won++;
        row.biggestPot = Math.max(row.biggestPot, w);
      }
      if (end && end[s.seat] !== undefined) row.net += end[s.seat] - (start.get(s.seat) ?? 0);
      by.set(s.playerId, row);
    }
  }
  return [...by.values()].sort((a, b) => b.net - a.net);
}
