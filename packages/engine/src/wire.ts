/**
 * The table protocol between server and web: the per-viewer view and the
 * socket events. `import type { TableView } from '@rsdp/engine/wire'`.
 */

import type {
  Action,
  Award,
  BettingKind,
  GameFamily,
  HandEvent,
  HandPhase,
  LegalActions,
  PlayerId,
  Stakes,
} from './core/types';
import type { SettingsChange, SettingsPatch, TableSettings } from './settings';

/** A card as one viewer sees it: '??' when hidden. */
export interface WireCard {
  card: string;
  up: boolean;
}

export interface SeatView {
  seat: number;
  playerId: PlayerId;
  name: string;
  /** Chips behind (during a hand: what is left after this hand's bets). */
  stack: number;
  sittingOut: boolean;
  sitOutReason: 'player' | 'timeouts' | 'busted' | 'host' | null;
  online: boolean;
  /** Dealt into the current hand. */
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  /** Chips in front of the player this betting round. */
  bet: number;
  cards: WireCard[];
  lastAction: string | null;
  /** Seconds left in the time bank. */
  timeBank: number;
  /** Will stand up when the hand ends. */
  leaving: boolean;
  /** Owes blinds (sat out while they went past). */
  owesBlinds: boolean;
  /** Waiting for the big blind or to post before being dealt in. */
  waiting: boolean;
  waitForBigBlind: boolean;
  straddle: boolean;
  /** Chips this seat won in the finished hand. */
  won: number;
  /** Best hand name at showdown. */
  handName: string | null;
}

export interface HandView {
  handNumber: number;
  gameId: string;
  gameName: string;
  shortName: string;
  family: GameFamily;
  betting: BettingKind;
  stakes: Stakes;
  phase: HandPhase;
  street: number;
  streetName: string;
  button: number;
  buttonDead: boolean;
  smallBlind: number | null;
  bigBlind: number | null;
  /** boards[run][board]: community cards. */
  boards: string[][][];
  /** Pots from chips already gathered (excludes this round's bets). */
  pots: { amount: number; eligible: number[] }[];
  /** Everything in the middle including this round's bets. */
  potTotal: number;
  toAct: number | null;
  currentBet: number;
  /** Draw games: most cards that may be swapped this draw. */
  drawMax: number | null;
  runItTwice: { offered: boolean; votes: Record<number, boolean | null>; deadline: number | null; times: 1 | 2 | null };
  showdown: boolean;
  /** Everyone posted and the first betting round was skipped. */
  bombPot: boolean;
  awards: Award[];
  /** Events this viewer may see, for the hand log and animations. */
  events: HandEvent[];
}

export interface RequestView {
  id: string;
  kind: 'seat' | 'rebuy';
  playerId: PlayerId;
  name: string;
  seat: number | null;
  amount: number;
  at: number;
}

export interface LedgerView {
  playerId: PlayerId;
  name: string;
  buyIn: number;
  cashOut: number;
  /** Current chips if still seated. */
  stack: number;
  net: number;
}

export interface ChatView {
  at: number;
  playerId: PlayerId | null;
  name: string;
  text: string;
}

export interface TableView {
  id: string;
  name: string;
  mode: 'cash' | 'tournament';
  /** Set on tournament tables. */
  tournamentId: string | null;
  hostId: PlayerId;
  isHost: boolean;
  me: { playerId: PlayerId; seat: number | null };
  settings: TableSettings;
  /** Host edits waiting for the next hand. */
  pendingSettings: SettingsPatch | null;
  started: boolean;
  paused: boolean;
  stopAfterHand: boolean;
  seats: (SeatView | null)[];
  hand: HandView | null;
  /** What I may do now (null when it is not my turn). */
  legal: LegalActions | null;
  canDraw: { max: number } | null;
  canVoteRunItTwice: boolean;
  /** My card indexes I may still show (after the hand). */
  canShow: number[];
  turn: { seat: number; startedAt: number; deadline: number | null; usingBank: boolean } | null;
  nextHandAt: number | null;
  /** Server clock when the view was built, to correct for skew. */
  serverNow: number;
  /**
   * Rabbit hunting after a hand that ended early: `available` when there are
   * undealt board cards to see; `cards` (one list per board) only for a viewer
   * who asked.
   */
  rabbit: { available: boolean; cards: string[][] | null };
  /** The host made the next hand a bomb pot. */
  bombPotNext: boolean;
  /** Game and stakes of the next hand when no hand is running (cash tables). */
  upcoming: { gameId: string; gameName: string; betting: BettingKind; stakes: Stakes } | null;
  /** Blind schedule: current level and when it ends. */
  level: { index: number; count: number; endsAt: number | null; handsLeft: number | null } | null;
  /** The host sees all requests; everyone else sees their own. */
  requests: RequestView[];
  ledger: LedgerView[];
  chat: ChatView[];
  log: { at: number; text: string }[];
  settingsLog: { at: number; by: string; when: 'now' | 'next-hand'; changes: SettingsChange[] }[];
  /** Finished hands available to replay, newest last. */
  history: { handNumber: number; endedAt: number; gameName: string }[];
  /** People with the table open who are not seated (spectators). */
  watchers: { playerId: PlayerId; name: string }[];
}

/** A finished hand for the log and replayer, filtered for the viewer. */
export interface HandRecordView {
  handNumber: number;
  startedAt: number;
  endedAt: number;
  gameName: string;
  betting: BettingKind;
  stakes: Stakes;
  button: number;
  seats: { seat: number; playerId: PlayerId; name: string; stack: number }[];
  events: HandEvent[];
}

export type Ack<T = object> = (res: ({ ok: true } & T) | { ok: false; error: string }) => void;

export interface CreateTableInput {
  /** Any subset of the settings; the rest come from the defaults. */
  settings: SettingsPatch;
}

export interface ClientToServer {
  /** The name other players see; also used to register for tournaments. */
  'session:name': (input: { name: string }, ack: Ack) => void;
  'table:create': (input: CreateTableInput, ack: Ack<{ tableId: string }>) => void;
  'table:join': (input: { tableId: string }, ack: Ack) => void;
  'table:leave': () => void;
  'table:history': (input: { handNumber: number }, ack: Ack<{ hand: HandRecordView }>) => void;
  /** Every finished hand at the table as you may see it, oldest first, for downloads and the replayer. */
  'table:export': (ack: Ack<{ hands: HandRecordView[] }>) => void;
  'seat:request': (input: { seat: number; name: string; stack: number }, ack: Ack) => void;
  'seat:cancel': () => void;
  'seat:stand': (input: { afterHand?: boolean }) => void;
  'seat:sitOut': (input: { value: boolean }, ack: Ack) => void;
  'seat:prefs': (input: { waitForBigBlind?: boolean; straddle?: boolean }, ack: Ack) => void;
  'seat:rebuy': (input: { amount: number }, ack: Ack) => void;
  'hand:act': (action: Action, ack: Ack) => void;
  'hand:draw': (input: { discard: number[] }, ack: Ack) => void;
  'hand:runItTwice': (input: { yes: boolean }, ack: Ack) => void;
  'hand:show': (input: { cards: number[] }, ack: Ack) => void;
  /** Add my time bank to my clock now. */
  'hand:timeBank': (ack: Ack) => void;
  /** See the cards that would have come (only I see them). */
  'hand:rabbit': (ack: Ack) => void;
  'chat:send': (input: { text: string }) => void;
  'host:approve': (input: { requestId: string }, ack: Ack) => void;
  'host:reject': (input: { requestId: string }) => void;
  'host:start': (ack: Ack) => void;
  'host:stop': (ack: Ack) => void;
  'host:deal': (ack: Ack) => void;
  'host:pause': (input: { value: boolean }, ack: Ack) => void;
  /** Make the next hand a bomb pot (value false takes it back). */
  'host:bombPot': (input: { value: boolean }, ack: Ack) => void;
  'host:settings': (input: { patch: SettingsPatch }, ack: Ack) => void;
  'host:setStack': (input: { playerId: string; stack: number }, ack: Ack) => void;
  'host:kick': (input: { playerId: string }, ack: Ack) => void;
  'host:sitOut': (input: { playerId: string }, ack: Ack) => void;
  'host:transfer': (input: { playerId: string }, ack: Ack) => void;
}

export interface ServerToClient {
  session: (session: { playerId: string; displayName: string; account: { username: string } | null }) => void;
  'table:state': (view: TableView) => void;
  /** A tournament moved you to another table (balancing or a broken table). */
  'table:moved': (input: { from: string; to: string }) => void;
}

export interface HandshakeAuth {
  /** Random secret kept in the browser (localStorage rsdp.guestId). Never shown to other players. */
  token: string;
}
