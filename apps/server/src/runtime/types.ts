import type { BettingKind, HandState, PlayerId, Stakes } from '@rsdp/engine/core';
import type { SettingsChange, SettingsPatch, TableSettings } from '@rsdp/engine/settings';

/** Snapshot layout version for RuntimeState. Bump it when the shape changes. */
export const RUNTIME_VERSION = 1;

/** Time and timers, injected so tests can run a table on a fake clock. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface SeatState {
  seat: number;
  playerId: PlayerId;
  name: string;
  stack: number;
  /** Not dealt in (cash) or auto-folded (tournament). */
  sittingOut: boolean;
  sitOutReason: 'player' | 'timeouts' | 'busted' | 'host' | null;
  /** Joined since the last hand and has not posted yet. */
  isNew: boolean;
  missedSmallBlind: boolean;
  missedBigBlind: boolean;
  /** Player preference: wait for the big blind instead of posting to play. */
  waitForBigBlind: boolean;
  /** Player preference: straddle when under the gun (or on the button). */
  straddle: boolean;
  /** Player preference: take part in Nit game rounds (absent in older snapshots). */
  nitOptIn?: boolean;
  /** Emoji shown by the seat (absent in older snapshots). */
  mood?: string | null;
  /** Turns in a row the clock ran out. */
  timeouts: number;
  /** Seconds left in this player's time bank. */
  timeBank: number;
  handsSinceRefill: number;
  /** Stand up once the current hand ends. */
  leaveAfterHand: boolean;
  /** leaveAfterHand was set because the player was offline too long; coming back undoes it. */
  released?: boolean;
  /** Chips approved to add before the next hand (rebuys, host top-ups). */
  pendingChips: number;
  /** Host set the stack to this before the next hand. */
  pendingStack: number | null;
}

export interface SeatRequest {
  id: string;
  kind: 'seat' | 'rebuy';
  playerId: PlayerId;
  name: string;
  /** Seat asked for (seat requests). */
  seat: number | null;
  /** Buy-in or rebuy amount. */
  amount: number;
  at: number;
}

/** Someone queued for a seat at a full table. */
export interface WaitlistEntry {
  playerId: PlayerId;
  name: string;
  /** The buy-in they will sit with. */
  stack: number;
  at: number;
}

/** A free seat held for the next person on the waitlist until they take it or time runs out. */
export interface SeatOffer {
  seat: number;
  playerId: PlayerId;
  expiresAt: number;
}

export interface LedgerRow {
  playerId: PlayerId;
  name: string;
  /** Everything brought to the table: buy-ins, rebuys and host top-ups. */
  buyIn: number;
  /** Everything taken away when leaving. */
  cashOut: number;
}

export interface ChatMessage {
  at: number;
  playerId: PlayerId | null;
  name: string;
  text: string;
}

/** One line in the table's activity log (joins, settings changes, host actions). */
export interface TableLogEntry {
  at: number;
  text: string;
}

export interface SettingsLogEntry {
  at: number;
  by: PlayerId;
  /** Applied now, or waiting for the next hand. */
  when: 'now' | 'next-hand';
  changes: SettingsChange[];
}

/** What hand history keeps of a finished hand: enough to show it to each viewer, no deck. */
export interface PastHand {
  handNumber: number;
  startedAt: number;
  endedAt: number;
  gameName: string;
  betting: BettingKind;
  stakes: Stakes;
  button: number;
  seats: { seat: number; playerId: PlayerId; startStack: number }[];
  events: HandState['events'];
}

/** A finished hand kept in memory for the hand log and replayer; the server also stores it. */
export interface HandRecord {
  handNumber: number;
  startedAt: number;
  endedAt: number;
  hand: HandState;
}

export interface TurnClock {
  /** Hand number and event count when the turn started, so a stale timer never fires on a later turn. */
  key: string;
  seat: number;
  startedAt: number;
  deadline: number | null;
  /** True once the time bank is running. */
  usingBank: boolean;
  /** Deadline before the time bank kicked in. */
  bankFrom: number | null;
}

/** Side-game progress kept between hands (cash tables). */
export interface SideGameState {
  /** Hands dealt since the last bomb pot. */
  handsSinceBombPot: number;
  /** The host asked for a bomb pot next hand. */
  bombPotNext: boolean;
  /** Simulated rake taken so far. */
  rakeTotal?: number;
  /** The Nit game round in progress. */
  nit?: NitRound | null;
}

export interface NitRound {
  /** Who started the round; they share the prize. */
  participants: PlayerId[];
  /** Participants who have not won a pot outright yet. */
  holders: PlayerId[];
  /** Chips the last holder pays each other participant. */
  prize: number;
}

/** Everything about one table. Plain JSON, so it can be snapshotted and restored. */
export interface RuntimeState {
  version: typeof RUNTIME_VERSION;
  id: string;
  hostId: PlayerId;
  createdAt: number;
  settings: TableSettings;
  /** Host edits waiting for the next hand. */
  pendingSettings: SettingsPatch | null;
  settingsLog: SettingsLogEntry[];
  seats: (SeatState | null)[];
  requests: SeatRequest[];
  ledger: Record<PlayerId, LedgerRow>;
  /** Players who left, for the rathole rule. */
  departures: Record<PlayerId, { stack: number; at: number }>;
  /** The name of everyone dealt a hand here, so logs and history keep it after they leave. Missing in older snapshots. */
  handNames?: Record<PlayerId, string>;
  /** The host started the game; hands deal automatically while this is true. */
  started: boolean;
  /** Stop after the current hand. */
  stopAfterHand: boolean;
  paused: boolean;
  /** While paused: how long was left on each clock. */
  pausedLeft: { turn: number | null; nextHand: number | null; rit: number | null } | null;
  handNumber: number;
  hand: HandState | null;
  handStartedAt: number | null;
  /** Blind positions of the last hand, for the dead-button rule. */
  positions: { button: number; smallBlind: number | null; bigBlind: number | null } | null;
  turn: TurnClock | null;
  nextHandAt: number | null;
  ritDeadline: number | null;
  /** Cash blind schedule progress. */
  level: { index: number; elapsedMs: number; runningSince: number | null; hands: number };
  /** Mixed-game rotation progress. */
  rotation: { step: number; hands: number; orbits: number; anchor: number | null };
  chat: ChatMessage[];
  log: TableLogEntry[];
  history: HandRecord[];
  /** Added after version 1 snapshots; absent means fresh counters. */
  sideGames?: SideGameState;
  /** Who rabbit hunted the last hand (they alone see its undealt cards). */
  rabbit?: { handNumber: number; playerIds: PlayerId[] };
  /** Players queued for a seat, first come first served. Absent in older snapshots. */
  waitlist?: WaitlistEntry[];
  /** Free seats held for waitlisted players. */
  offers?: SeatOffer[];
  /** Players the host has muted in chat. */
  muted?: PlayerId[];
  /** Practice bots at this table (seated or asking for a seat), by their player id. */
  bots?: Record<PlayerId, BotInfo>;
}

/** A practice bot: who added it, and what it buys in (and rebuys) for. */
export interface BotInfo {
  ownerId: PlayerId;
  ownerName: string;
  buyIn: number;
}

/** What a tournament table needs from the tournament runtime. Cash tables have none. */
export interface TournamentHooks {
  /**
   * The director is still delivering a batch of events to its tables. Until it pokes, this table runs
   * nothing on its own (turn clocks, deals), so no hand ends before chips or seats on their way arrive.
   */
  busy(): boolean;
  gate(now: number): 'deal' | 'hold';
  level(): { gameId: string; betting?: BettingKind; stakes: Stakes };
  handStarted(handNumber: number): void;
  handEnded(result: {
    handNumber: number;
    startStacks: Record<PlayerId, number>;
    endStacks: Record<PlayerId, number>;
    knockedOutBy: Record<PlayerId, PlayerId[]>;
    button: number;
  }): void;
}
