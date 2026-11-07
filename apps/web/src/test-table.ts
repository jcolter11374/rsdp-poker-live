// Tables for tests (never loaded by the site): Ann (seat 0), Bo and Cy at 10/20 no-limit hold'em, as Ann sees it.
import type { LegalActions, Stakes } from '@rsdp/engine/core';
import { defaultSettings } from '@rsdp/engine/settings';
import type { HandView, SeatView, TableView } from '@rsdp/engine/wire';

export const STAKES: Stakes = { smallBlind: 10, bigBlind: 20, ante: 0, anteType: 'none', bringIn: 5, smallBet: 20, bigBet: 40 };
const NAMES = ['Ann', 'Bo', 'Cy'];

export function seatView(seat: number, over: Partial<SeatView> = {}): SeatView {
  return {
    seat,
    playerId: `p${seat}`,
    name: NAMES[seat] ?? `Player ${seat}`,
    stack: 1000,
    sittingOut: false,
    sitOutReason: null,
    online: true,
    inHand: true,
    folded: false,
    allIn: false,
    bet: 0,
    cards: [
      { card: '??', up: false },
      { card: '??', up: false },
    ],
    lastAction: null,
    timeBank: 30,
    leaving: false,
    owesBlinds: false,
    waiting: false,
    waitForBigBlind: false,
    straddle: false,
    nitOptIn: false,
    nit: null,
    won: 0,
    handName: null,
    avatar: null,
    mood: null,
    ...over,
  };
}

/** Hand 7, on the flop with 200 in the middle and no events yet. Ann has the button, so Bo acts first. */
export function handView(over: Partial<HandView> = {}): HandView {
  return {
    handNumber: 7,
    gameId: 'nlhe',
    gameName: "No Limit Hold'em",
    shortName: 'NLH',
    family: 'flop',
    betting: 'no-limit',
    stakes: STAKES,
    names: { 0: 'Ann', 1: 'Bo', 2: 'Cy' },
    phase: 'betting',
    street: 1,
    streetName: 'Flop',
    button: 0,
    buttonDead: false,
    smallBlind: 1,
    bigBlind: 2,
    boards: [[['2c', '7d', 'Jh']]],
    pots: [{ amount: 200, eligible: [0, 1, 2] }],
    potTotal: 200,
    toAct: 1,
    currentBet: 0,
    drawMax: null,
    runItTwice: { offered: false, votes: {}, deadline: null, times: null },
    showdown: false,
    bombPot: false,
    awards: [],
    events: [],
    ...over,
  };
}

/** Ann's moves when the action is checked to her on the flop. */
export const CHECKED_TO_ME: LegalActions = { canFold: true, canCheck: true, callAmount: 0, canRaise: true, raiseKind: 'bet', minTo: 20, maxTo: 1000, canBringIn: false };

export function tableView({ hand = {}, legal = null, seats, view }: { hand?: Partial<HandView> | null; legal?: LegalActions | null; seats?: (SeatView | null)[]; view?: Partial<TableView> } = {}): TableView {
  const settings = defaultSettings('cash');
  settings.stakes = { ...STAKES, centsMode: false };
  return {
    id: 't1',
    name: 'Poker night',
    mode: 'cash',
    tournamentId: null,
    hostId: 'p1',
    isHost: false,
    realGame: true,
    powers: [],
    coHosts: [],
    me: { playerId: 'p0', seat: 0 },
    settings,
    pendingSettings: null,
    started: true,
    paused: false,
    stopAfterHand: false,
    recordsLocked: true,
    seats: seats ?? [seatView(0, { cards: [{ card: 'As', up: false }, { card: 'Kh', up: false }] }), seatView(1), seatView(2)],
    hand: hand && handView(hand),
    legal,
    canDraw: null,
    canVoteRunItTwice: false,
    canShow: [],
    turn: null,
    nextHandAt: null,
    serverNow: 0,
    rabbit: { available: false, cards: null },
    nit: null,
    rakeTotal: null,
    bombPotNext: false,
    upcoming: null,
    level: null,
    requests: [],
    ledger: [],
    chat: [],
    log: [],
    settingsLog: [],
    history: [],
    watchers: [],
    waitlist: [],
    offers: [],
    muted: [],
    spectator: null,
    cardsWatched: null,
    fair: { nextCommit: '', handCommit: null, openThrough: 0 },
    ...view,
  };
}
