/**
 * Engine core API (contract). The implementation lands in this folder on the
 * `foundation` branch; until then these signatures are what other workstreams
 * code against.
 */

import type {
  Action,
  Chips,
  GameSpec,
  HandEvent,
  HandInput,
  HandState,
  LegalActions,
  Modifier,
  PlannedPost,
  PlayerId,
  Pot,
  SeatIndex,
  Stakes,
  VariantRules,
  Viewer,
} from './types';

/**
 * Games register once at startup; the engine looks rules up by `input.game.id`,
 * so hand state stays plain JSON (no functions inside).
 */
export interface VariantRegistry {
  register(spec: GameSpec, rules: VariantRules): void;
  get(id: string): { spec: GameSpec; rules: VariantRules };
  list(): GameSpec[];
}

/** Modifiers register once at startup, like variants. */
export interface ModifierRegistry {
  register(modifier: Modifier): void;
  get(id: string): Modifier | undefined;
}

export interface EngineApi {
  /** Posts forced bets, deals the first street and finds the first player to act. Rules come from the registry. */
  startHand(input: HandInput): HandState;
  /** Null when it is not this seat's turn. */
  legalActions(state: HandState, seat: SeatIndex): LegalActions | null;
  /** Throws ActionError for anything illegal. `auto` marks actions taken for away or timed-out players. */
  act(state: HandState, seat: SeatIndex, action: Action, opts?: { auto?: boolean }): void;
  /** Draw games: discard the cards at these indexes and draw replacements. */
  draw(state: HandState, seat: SeatIndex, discard: number[]): void;
  /** Run it twice vote while phase is 'rit-vote'. Any "no" runs it once. */
  voteRunItTwice(state: HandState, seat: SeatIndex, yes: boolean): void;
  /** After the hand (or at showdown with show/muck): reveal some or all hole cards. */
  show(state: HandState, seat: SeatIndex, cardIndexes: number[]): void;
  /** Clock ran out: check if possible, otherwise fold. */
  timeout(state: HandState, seat: SeatIndex): void;
  /** Fold a player who left or was removed, whether or not it is their turn. */
  foldOutOfTurn(state: HandState, seat: SeatIndex): void;
  /** Main pot and side pots from everything put in so far. */
  pots(state: HandState): Pot[];
  /** Events this viewer may see (hole cards filtered), optionally from a sequence number on. */
  visibleEvents(state: HandState, viewer: Viewer, fromSeq?: number): HandEvent[];
}

/** Seat facts the runtime keeps between hands and feeds to the forced-bet planner. */
export interface PlannerSeat {
  seat: SeatIndex;
  playerId: PlayerId;
  stack: Chips;
  /** Joined since the last hand and has not posted yet. */
  isNew: boolean;
  /** Owes blinds from sitting out (cash games). */
  missedSmallBlind: boolean;
  missedBigBlind: boolean;
  /** Chooses to wait for the big blind instead of posting. */
  waitForBigBlind: boolean;
  /** Wants to straddle when under the gun (player preference). */
  straddle: boolean;
}

export interface ForcedBetPlan {
  /** Seats dealt in this hand. */
  dealtIn: SeatIndex[];
  button: SeatIndex;
  buttonDead: boolean;
  smallBlindSeat: SeatIndex | null;
  bigBlindSeat: SeatIndex | null;
  posts: PlannedPost[];
}

/**
 * Runtime-side helper (lives in the engine package so it is unit-testable):
 * moves the button with the dead-button rule, assigns blinds, collects
 * missed blinds, and plans antes, straddles, bomb-pot posts or the bring-in.
 */
export type PlanForcedBets = (args: {
  game: GameSpec;
  stakes: Stakes;
  maxSeats: number;
  seats: PlannerSeat[];
  /** Where the big blind was last hand, for the dead-button rule. */
  lastBigBlindSeat: SeatIndex | null;
  lastButton: SeatIndex | null;
  mode: 'cash' | 'tournament';
  straddles: 'off' | 'utg' | 'utg-and-button';
  bombPot: { amount: Chips } | null;
}) => ForcedBetPlan;
