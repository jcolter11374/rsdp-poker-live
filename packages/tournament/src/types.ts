// Tournament director contracts. State is plain JSON and is snapshotted by the
// server; bump STATE_VERSION when its shape changes.

import type { PayoutStructure, PrizeMoney } from './payouts';
import type { Schedule } from './recurrence';
import type { AnteType, StructureRow } from './structure';

export const STATE_VERSION = 1;

/** Opaque account or guest id from the server. */
export type PlayerId = string;
/** Minted by the director: `${tournamentId}:e${n}`. One player can hold several entries (re-entry). */
export type EntryId = string;
/** Minted by the director: `${tournamentId}:t${n}`. */
export type TableId = string;

export type StartRule =
  /** The host starts with startNow. */
  | { kind: 'manual' }
  /** Starts by itself at startAt. `schedule` makes it one occurrence of a series. */
  | { kind: 'scheduled'; startAt: number; schedule?: Schedule }
  /** Seats as soon as playersNeeded register, deals after startDelaySeconds. */
  | { kind: 'sng'; playersNeeded: number; startDelaySeconds: number; autoSpawn: boolean };

export interface TournamentSettings {
  name: string;
  start: StartRule;
  /** Games in rotation, one per level; one entry for a single game. */
  games: string[];
  /** Stop rotating from this level on and stay on that level's game. */
  stopRotationAtLevel?: number;
  structure: StructureRow[];
  startingStack: number;
  /** 2-10. */
  seatsPerTable: number;
  /** 2-600. */
  maxEntrants: number;
  /** Scheduled start: tables are created and seated this long before startAt. Default 60 s. */
  seatLeadSeconds: number;
  /** Scheduled start with fewer than 2 entrants: keep registration open this long, then cancel. Default 15. */
  graceMinutes: number;
  /** Host must approve registrations (including late ones). */
  registrationApproval: boolean;
  /** Closes at the end of throughLevel; null keeps it open while the event has room. */
  lateRegistration: { enabled: boolean; throughLevel: number | null };
  reEntry: { enabled: boolean; throughLevel: number | null; /** Re-entries per player; null = unlimited. */ max: number | null; approval: boolean };
  /** Rebuys are allowed during levels marked `rebuy` in the structure. max 0 = off. */
  rebuy: { max: number; chips: number; approval: boolean; offerSeconds: number };
  /** Add-ons are allowed during breaks marked `addOn`. max 0 = off. */
  addOn: { max: number; chips: number; approval: boolean };
  /** Players may leave for good before busting. */
  allowQuit: boolean;
  /** Display-only prize pool and payouts. */
  payouts?: { structure: PayoutStructure; money: PrizeMoney };
  /** Play hand-for-hand on the bubble when payouts are set. */
  handForHand: boolean;
}

export type TournamentStatus = 'registering' | 'seating' | 'running' | 'paused' | 'finished' | 'cancelled';

export type EntryStatus =
  /** Registered, not seated yet. */
  | 'registered'
  | 'seated'
  /** Busted with a rebuy offer open. Keeps the seat; the table holds. */
  | 'rebuy-offer'
  | 'busted'
  | 'quit'
  | 'removed';

export interface Entry {
  id: EntryId;
  playerId: PlayerId;
  displayName: string;
  /** 1 for the first entry, 2 for the first re-entry, ... */
  entryNo: number;
  status: EntryStatus;
  stack: number;
  tableId: TableId | null;
  seat: number | null;
  rebuys: number;
  addOns: number;
  registeredAt: number;
  /** Set when a re-entry replaced this busted entry; it then takes no finishing place. */
  supersededBy?: EntryId;
  rebuyOfferExpiresAt?: number;
  /** Quit or host removal waiting for the current hand to end. */
  leaveRequested?: 'quit' | 'removed';
  bust?: { at: number; startStack: number; tableId: TableId | null; by: PlayerId[] };
}

export interface TableState {
  id: TableId;
  /** Entry id per seat. */
  seats: (EntryId | null)[];
  inHand: boolean;
  lastHandNumber: number;
  /** Button seat of the last hand, if the runtime reported it. */
  button: number | null;
  /** Hand-for-hand round this table last dealt in. */
  hfhPlayed: number;
  /** Hand-for-hand round of the hand in progress, or null when it is a normal hand. */
  hfhHand: number | null;
}

export type RequestKind = 'register' | 're-entry' | 'rebuy' | 'add-on';

export interface PendingRequest {
  id: string;
  kind: RequestKind;
  playerId: PlayerId;
  displayName: string;
  /** For rebuy, add-on and re-entry: the entry it applies to. */
  entryId?: EntryId;
  at: number;
}

export interface EliminationGroup {
  /** Entries knocked out together, with what decides their order. */
  members: { entryId: EntryId; startStack: number; tableId: TableId | null }[];
  at: number;
  /** Set for hand-for-hand busts. */
  hfhRound?: number;
}

export interface TournamentState {
  version: typeof STATE_VERSION;
  id: string;
  hostId: PlayerId;
  settings: TournamentSettings;
  status: TournamentStatus;
  createdAt: number;
  /** Deal time once known (scheduled start, or SNG seat time + delay). */
  startAt: number | null;
  /** Scheduled start with fewer than 2 entrants: when to give up. */
  graceUntil: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  clock: {
    /** Running time banked before runningSince. */
    elapsedMs: number;
    /** Wall time the clock last started, or null while stopped. */
    runningSince: number | null;
    /** Row of the structure that tick last moved to. */
    rowIndex: number;
  };
  entries: Entry[];
  tables: TableState[];
  requests: PendingRequest[];
  eliminations: EliminationGroup[];
  handForHand: { active: boolean; round: number };
  counters: { entry: number; table: number; request: number };
  /** mulberry32 state for seating draws. */
  rng: number;
}

// ---------------------------------------------------------------------------
// Inputs

/** What the runtime reports after each hand on a tournament table. */
export interface HandResult {
  tableId: TableId;
  handNumber: number;
  startStacks: Record<PlayerId, number>;
  endStacks: Record<PlayerId, number>;
  /** Who won chips from each busted player (several when the busting pot was split). */
  knockedOutBy?: Record<PlayerId, PlayerId[]>;
  /** Button seat of this hand; used to pick who moves when balancing. */
  button?: number;
}

export type Command =
  | { type: 'register'; playerId: PlayerId; displayName: string }
  | { type: 'unregister'; playerId: PlayerId }
  | { type: 'rebuy'; playerId: PlayerId }
  | { type: 'declineRebuy'; playerId: PlayerId }
  | { type: 'addOn'; playerId: PlayerId }
  | { type: 'reEnter'; playerId: PlayerId }
  | { type: 'quit'; playerId: PlayerId }
  | { type: 'approve'; by: PlayerId; requestId: string }
  | { type: 'reject'; by: PlayerId; requestId: string }
  | { type: 'remove'; by: PlayerId; playerId: PlayerId }
  | { type: 'pause'; by: PlayerId }
  | { type: 'resume'; by: PlayerId }
  | { type: 'startNow'; by: PlayerId }
  | { type: 'editStructure'; by: PlayerId; structure: StructureRow[] }
  | { type: 'updateSettings'; by: PlayerId; settings: Partial<TournamentSettings> }
  /** Before the start: cancel. Paused with no hand running: end and rank the rest by chips. */
  | { type: 'end'; by: PlayerId }
  | { type: 'handStarted'; tableId: TableId; handNumber: number }
  | { type: 'handResult'; result: HandResult };

// ---------------------------------------------------------------------------
// Outputs

export interface SeatInfo {
  tableId: TableId;
  seat: number;
  entryId: EntryId;
  playerId: PlayerId;
  displayName: string;
  stack: number;
}

export type DirectorEvent =
  | { type: 'registered'; entryId: EntryId; playerId: PlayerId; displayName: string; late: boolean; entryNo: number }
  | { type: 'unregistered'; playerId: PlayerId }
  | { type: 'requestPending'; request: PendingRequest }
  | { type: 'requestRejected'; request: PendingRequest }
  | { type: 'tablesCreated'; tables: { tableId: TableId; seats: SeatInfo[] }[] }
  /** Open a new table (late registration overflow). */
  | { type: 'tableOpened'; tableId: TableId }
  | { type: 'startDelayed'; reason: 'not-enough-players'; graceUntil: number }
  | { type: 'started'; at: number }
  | { type: 'levelUp'; levelNumber: number; sb: number; bb: number; ante: number; anteType: AnteType; gameId: string }
  | { type: 'breakStarted'; minutes: number; endsAt: number; addOn: boolean }
  | { type: 'breakEnded' }
  | { type: 'lateRegistrationClosed' }
  | { type: 'rebuysClosed' }
  | { type: 'reEntryClosed' }
  /** Seat a player at a table before its next hand. */
  | { type: 'seatPlayer'; seat: SeatInfo; reason: 'late-registration' | 're-entry' }
  /** Move between hands of the source table; the player is dealt in at the destination's next hand. */
  | { type: 'moveSeat'; entryId: EntryId; playerId: PlayerId; from: { tableId: TableId; seat: number }; to: { tableId: TableId; seat: number }; stack: number }
  | { type: 'tableBroken'; tableId: TableId }
  | { type: 'rebuyOffered'; entryId: EntryId; playerId: PlayerId; expiresAt: number; chips: number }
  /** Add chips to a seated player's stack before their next hand. */
  | { type: 'stackAdded'; entryId: EntryId; playerId: PlayerId; tableId: TableId | null; seat: number | null; chips: number; reason: 'rebuy' | 'add-on' }
  /** Leaves the table for good. */
  | { type: 'eliminated'; entryId: EntryId; playerId: PlayerId; place: number; by: PlayerId[]; tableId: TableId | null; seat: number | null; reason: 'busted' | 'quit' | 'removed' }
  | { type: 'handForHand'; active: boolean }
  | { type: 'paused' }
  | { type: 'resumed' }
  | { type: 'structureEdited' }
  | { type: 'settingsUpdated' }
  | { type: 'finished'; standings: Standing[] }
  | { type: 'cancelled'; reason: 'not-enough-players' | 'host' }
  /** A recurring series: the server should create the next occurrence at this time with the same settings. */
  | { type: 'scheduleNext'; startAt: number }
  /** A Sit & Go with auto-spawn: the server should open a fresh copy with the same settings. */
  | { type: 'spawnNext' };

export interface Standing {
  entryId: EntryId;
  playerId: PlayerId;
  displayName: string;
  entryNo: number;
  /** Finishing place; null while still playing. Tied players share a place. */
  place: number | null;
  stack: number;
  rebuys: number;
  addOns: number;
  /** Display-only prize for a finished place (0 when out of the money or no payouts set). */
  prize: number;
  eliminatedBy: PlayerId[];
}

export interface Result {
  state: TournamentState;
  events: DirectorEvent[];
}

export type Gate = 'deal' | 'hold';

export interface LevelStakes {
  levelNumber: number;
  gameId: string;
  sb: number;
  bb: number;
  ante: number;
  anteType: AnteType;
  bringIn: number;
  smallBet: number;
  bigBet: number;
}
