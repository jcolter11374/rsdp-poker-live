/**
 * Engine core contracts.
 *
 * The engine plays ONE hand at a time. Everything that spans hands (seats, the
 * button, missed blinds, rebuys, tournaments) lives in the server's table
 * runtime, which builds a {@link HandInput} for each hand and reads back
 * {@link HandEvent}s and the final {@link HandState}.
 *
 * All state here is plain JSON: no classes, no functions, no Dates. A hand can
 * be snapshotted to the database after any call and restored after a restart.
 *
 * Chips are always whole numbers of the table's smallest unit. "Cents mode" is
 * display only.
 */

import type { Card } from '../cards';

export type { Card };

/** Whole chips in the table's smallest unit. Never fractional. */
export type Chips = number;

/** Seat index, 0-based, below the table's maxSeats (2-10). */
export type SeatIndex = number;

/** Opaque, stable player id (persistent guest id or account id). */
export type PlayerId = string;

/** Returns a uniformly random integer in [0, n). Inject a seeded one in tests. */
export type Rng = (n: number) => number;

// ---------------------------------------------------------------- games

export type GameFamily = 'flop' | 'stud' | 'draw';
export type BettingKind = 'no-limit' | 'pot-limit' | 'fixed-limit';
export type SplitKind = 'high' | 'low' | 'hi-lo';
export type ForcedBetStyle = 'blinds' | 'ante-bring-in';

/** One betting round, and what is dealt (or drawn) before it. */
export interface StreetSpec {
  name: string;
  /** Private cards dealt to each player before this round. */
  dealDown: number;
  /** Face-up cards dealt to each player (stud). */
  dealUp: number;
  /** Community cards added to each board before this round. */
  dealBoard: number;
  /** Draw games: a draw round with up to this many discards precedes the betting. */
  drawMaxDiscard?: number;
  /** Fixed-limit size for this round. */
  betSize: 'small' | 'big';
}

/**
 * What the engine needs to know about a game. The variants package
 * (src/variants) owns the full VariantSpec; it is structurally compatible with
 * this interface.
 */
export interface GameSpec {
  id: string;
  name: string;
  family: GameFamily;
  streets: StreetSpec[];
  /** Most players the deck can serve (e.g. PLO5 = 9, stud = 8). */
  maxPlayers: number;
  defaultBetting: BettingKind;
  split: SplitKind;
  forcedBets: ForcedBetStyle;
}

/** Awards for one slice of one pot (one run, one board). Supplied by the variants package. */
export interface PortionAward {
  seat: SeatIndex;
  amount: Chips;
  half: 'high' | 'low' | 'scoop';
  handName?: string;
  /** The cards that made the hand, for highlighting. */
  cards?: Card[];
}

/**
 * Splits `amount` among the best hands of `eligible` seats on one board.
 * `eligible` is in odd-chip order (first seat clockwise from the button first).
 * Stud and draw games pass an empty board.
 */
export type AwardPortion = (
  spec: GameSpec,
  amount: Chips,
  eligible: SeatIndex[],
  holeBySeat: Record<SeatIndex, Card[]>,
  board: Card[],
) => PortionAward[];

/**
 * Game-specific rules the engine calls into. Supplied by the variants package
 * (src/variants); NLH needs only awardPortion.
 */
export interface VariantRules {
  awardPortion: AwardPortion;
  /** Stud: seat that must bring in, from each live seat's up cards. */
  bringInSeat?(spec: GameSpec, upBySeat: Record<SeatIndex, Card[]>): SeatIndex;
  /** Stud: seat that acts first on later streets, from up cards. */
  firstToActSeat?(spec: GameSpec, upBySeat: Record<SeatIndex, Card[]>): SeatIndex;
}

// ---------------------------------------------------------------- stakes and forced bets

export type AnteType = 'none' | 'per-player' | 'big-blind';

export interface Stakes {
  smallBlind: Chips;
  bigBlind: Chips;
  ante: Chips;
  anteType: AnteType;
  /** Stud bring-in. */
  bringIn: Chips;
  /** Fixed-limit bet sizes. Defaults: small = big blind, big = 2 x big blind. */
  smallBet: Chips;
  bigBet: Chips;
}

export type PostKind =
  | 'ante'
  | 'big-blind-ante'
  | 'small-blind'
  | 'big-blind'
  /** Missed small blind: dead money, not counted toward calling. */
  | 'dead-small-blind'
  /** Missed big blind posted on return: live. */
  | 'missed-big-blind'
  | 'straddle'
  | 'bomb-pot'
  | 'bring-in';

/** A forced bet the runtime plans before the deal. The engine posts these in order. */
export interface PlannedPost {
  seat: SeatIndex;
  kind: PostKind;
  amount: Chips;
  /** Live money counts toward the player's bet this round; dead money only goes in the pot. */
  live: boolean;
}

// ---------------------------------------------------------------- hand input

export interface HandSeatInput {
  seat: SeatIndex;
  playerId: PlayerId;
  stack: Chips;
  /** Away but dealt in (tournaments, "deal to away" setting): auto check/fold on their turn. */
  away: boolean;
}

export interface HandOptions {
  /** 1 normally, 2 for double board. */
  boards: 1 | 2;
  /** Bomb pot: forced posts replace blinds and the first betting round is skipped. */
  bombPot: boolean;
  /** Offer run it twice when all-in before the river (cash games only; runtime decides). */
  runItTwice: 'off' | 'ask' | 'always';
  /** Fixed-limit raise cap per round (bet + N raises). Default 4 total bets. */
  fixedLimitCap: number;
  /** No cap heads-up in fixed limit. */
  uncappedHeadsUp: boolean;
}

export interface HandInput {
  handId: string;
  handNumber: number;
  game: GameSpec;
  betting: BettingKind;
  stakes: Stakes;
  maxSeats: number;
  /** Players dealt in, in seat order. */
  seats: HandSeatInput[];
  /** Button position. It may sit on an empty seat (dead button); see buttonDead. */
  button: SeatIndex;
  /** True when the button is on a seat with nobody dealt in (dead-button rule). */
  buttonDead: boolean;
  /** Forced bets in posting order (from the runtime's forced-bet planner). */
  posts: PlannedPost[];
  /** Full deck order, already shuffled with a CSPRNG by the runtime. Cards are dealt from index 0. */
  deck: Card[];
  /** Seed for reshuffling the muck when a draw game runs out of cards (keeps the engine deterministic). */
  reshuffleSeed: number;
  options: HandOptions;
  /** Modifiers active this hand with their settings; the engine calls their potFee and afterSettle. */
  modifiers: { id: string; settings: unknown }[];
}

// ---------------------------------------------------------------- actions

export type Action =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  /** Open the betting (or complete a stud bring-in) to `to` total chips this round. */
  | { type: 'bet'; to: Chips }
  /** Raise to `to` total chips this round. */
  | { type: 'raise'; to: Chips }
  /** Stud: post the bring-in instead of completing. */
  | { type: 'bring-in' };

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  /** Chips needed to call (capped at stack). 0 when checking is possible. */
  callAmount: Chips;
  /** Bet or raise allowed (false after an incomplete raise, or at the fixed-limit cap). */
  canRaise: boolean;
  /** "bet" when nobody has bet this round, otherwise "raise". */
  raiseKind: 'bet' | 'raise';
  /** Smallest legal total for this round (an all-in below it is still legal). */
  minTo: Chips;
  /** Largest legal total for this round (stack, pot limit or fixed size). */
  maxTo: Chips;
  /** Stud: the bring-in seat's choice between bring-in and completing. */
  canBringIn: boolean;
}

// ---------------------------------------------------------------- state

export type HandPhase =
  | 'betting'
  /** Draw games: players choose discards in turn. */
  | 'drawing'
  /** All-in before the river with run it twice set to "ask": waiting on votes. */
  | 'rit-vote'
  /** The hand is over; pots are awarded. Optional post-hand shows still allowed. */
  | 'complete';

export interface DealtCard {
  card: Card;
  /** Face up to everyone (stud up cards). */
  up: boolean;
}

export interface HandSeat {
  seat: SeatIndex;
  playerId: PlayerId;
  startStack: Chips;
  stack: Chips;
  cards: DealtCard[];
  away: boolean;
  folded: boolean;
  allIn: boolean;
  /** Live chips this betting round (what calls are measured against). */
  bet: Chips;
  /** All chips put in this hand, live and dead. */
  total: Chips;
  hasActed: boolean;
  /** False after an incomplete all-in raise that does not reopen betting for this seat. */
  canRaise: boolean;
  /** Short label of the latest action this round, for display. */
  lastAction: string | null;
  /** Cards this seat chose to show after the hand (indexes into `cards`). */
  shown: number[];
  /** Run-it-twice vote while the phase is 'rit-vote'. */
  ritVote: boolean | null;
}

export interface Pot {
  amount: Chips;
  /** Seats that can win this pot, in seat order. */
  eligible: SeatIndex[];
}

export interface Award extends PortionAward {
  pot: number;
  run: number;
  board: number;
}

export interface HandState {
  input: HandInput;
  phase: HandPhase;
  /** Index into input.game.streets. */
  street: number;
  seats: HandSeat[];
  /** Next undealt card in input.deck. */
  deckPos: number;
  /** boards[run][board] = community cards. One run unless run it twice happened. */
  runs: Card[][][];
  /** Draw games: discarded cards, reshuffled when the deck runs short. */
  muck: Card[];
  toAct: SeatIndex | null;
  /** Highest live bet this round. */
  currentBet: Chips;
  /** Size of the last full bet or raise this round (minimum raise increment). */
  lastFullRaise: Chips;
  /** Bets and raises made this round (fixed-limit cap). */
  raisesThisRound: number;
  /** Set once every live player is all in, or one player remains with chips. */
  runout: boolean;
  /** True when live hands were compared at showdown. */
  showdown: boolean;
  awards: Award[];
  /** Ordered event log for this hand. */
  events: HandEvent[];
}

// ---------------------------------------------------------------- events

/** Everything that happens in a hand, in order. Logs, the replayer, downloads, sounds and animations are built from these. */
export type HandEvent = { seq: number } & (
  | {
      t: 'hand-start';
      handId: string;
      handNumber: number;
      gameId: string;
      betting: BettingKind;
      stakes: Stakes;
      button: SeatIndex;
      buttonDead: boolean;
      seats: { seat: SeatIndex; playerId: PlayerId; stack: Chips }[];
      boards: 1 | 2;
      bombPot: boolean;
    }
  | { t: 'post'; seat: SeatIndex; kind: PostKind; amount: Chips; live: boolean; allIn: boolean }
  /** Private unless every card is up. Filter with visibleEvents(). */
  | { t: 'deal'; seat: SeatIndex; cards: DealtCard[] }
  | { t: 'board'; run: number; board: number; cards: Card[] }
  | { t: 'street'; street: number; name: string }
  | {
      t: 'action';
      seat: SeatIndex;
      action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'bring-in' | 'complete';
      /** Chips added by this action. */
      amount: Chips;
      /** Seat's live total this round after the action. */
      to: Chips;
      allIn: boolean;
      /** Engine acted for an away or timed-out player. */
      auto: boolean;
    }
  /** Draw games. `cards` (the replacements) are private. */
  | { t: 'draw'; seat: SeatIndex; discarded: number; cards: Card[] }
  | { t: 'uncalled'; seat: SeatIndex; amount: Chips }
  | { t: 'rit-offer'; seats: SeatIndex[] }
  | { t: 'rit-vote'; seat: SeatIndex; yes: boolean }
  | { t: 'run-it'; times: 1 | 2 }
  | { t: 'show'; seat: SeatIndex; cards: Card[]; handName?: string }
  | { t: 'muck'; seat: SeatIndex }
  | { t: 'award'; pot: number; run: number; board: number; half: Award['half']; seat: SeatIndex; amount: Chips; handName?: string; cards?: Card[] }
  /** Side-game and fee transfers settled after the pot (7-2 bounty, nit game, simulated rake). */
  | { t: 'transfer'; kind: 'bounty-72' | 'nit' | 'nit-escrow' | 'rake'; from: SeatIndex | 'house'; to: SeatIndex | 'house'; amount: Chips }
  | { t: 'hand-end'; stacks: Record<SeatIndex, Chips> }
);

/** Stands in for a card the viewer may not see. */
export const HIDDEN_CARD = '??';

/** Who is looking. Spectators may be granted all cards (with a delay) by the host. */
export interface Viewer {
  seat: SeatIndex | null;
  /** See every hole card (spectator mode, replayer for a finished hand you may see). */
  seeAll: boolean;
}

// ---------------------------------------------------------------- modifiers

/**
 * Optional table features plug in here instead of editing the engine core.
 * The runtime calls these around each hand; they never touch sockets or storage.
 */
export interface Modifier<Settings = unknown> {
  id: string;
  /** Adjust the hand before it starts (e.g. bomb pot decides, double board sets boards = 2). */
  beforeHand?(input: HandInput, settings: Settings, rng: Rng): HandInput;
  /** Fee taken from each pot before it is awarded (simulated rake). */
  potFee?(pot: Pot, state: HandState, settings: Settings): Chips;
  /** Side transfers after the pots are awarded (7-2 bounty, nit game). */
  afterSettle?(state: HandState, settings: Settings): Extract<HandEvent, { t: 'transfer' }>[];
}

export class ActionError extends Error {}
