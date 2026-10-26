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
import type { CoHost, HostPower } from './roles';

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
  /** Opted in to the Nit game. */
  nitOptIn: boolean;
  /** In the current Nit game round: still holding the nit, or off it. */
  nit: 'holder' | 'clear' | null;
  /** Chips this seat won in the finished hand. */
  won: number;
  /** Best hand name at showdown. */
  handName: string | null;
  /** The player's picture: 'lib:<id>' from AVATARS, 'up:<version>' for an upload served at /api/avatars/<playerId>, or null. */
  avatar: string | null;
  /** An emoji the player shows by their seat, or null. */
  mood: string | null;
  /** A practice bot: who added it, and its look (an index into BOT_LOOKS). Absent for people. */
  bot?: { ownerId: PlayerId; ownerName: string; look: number };
}

export interface HandView {
  handNumber: number;
  /**
   * Provably fair dealing: the commitment this hand was dealt from and the
   * players' seeds mixed in, so each browser can see its own seed was used.
   * Missing on hands dealt before it existed.
   */
  fair?: { commit: string; clientSeeds: { playerId: PlayerId; seed: string }[] };
  gameId: string;
  gameName: string;
  shortName: string;
  family: GameFamily;
  betting: BettingKind;
  stakes: Stakes;
  /** Seat → name of everyone dealt in, including players who have since left the seat. */
  names: Record<number, string>;
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
  /** A practice bot asking for a seat, and who added it (its owner sees the request too). */
  bot?: { ownerId: PlayerId; ownerName: string };
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
  /** A practice bot: its chips are play money, so nobody pays it or is paid by it. */
  bot?: true;
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
  /** I am the host (co-hosts are not). */
  isHost: boolean;
  /** Two or more people (not bots) have played a hand here, so the table can't be deleted by its host. */
  realGame: boolean;
  /** The host powers I hold: all of them for the host, the ones given for a co-host, none otherwise. */
  powers: HostPower[];
  /** Cash tables: the host's co-hosts and their powers. */
  coHosts: CoHost[];
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
  /** The Nit game round in progress. */
  nit: { prize: number; participants: number; holders: number } | null;
  /** Simulated rake collected so far, for whoever the host lets see it. */
  rakeTotal: number | null;
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
  /** Cash tables with a waitlist: who is queued for a seat, first in line first. */
  waitlist: { playerId: PlayerId; name: string }[];
  /** Free seats held for someone on the waitlist until `expiresAt`. */
  offers: { seat: number; playerId: PlayerId; name: string; expiresAt: number }[];
  /** People the host has muted in chat. */
  muted: PlayerId[];
  /**
   * How a spectator sees the table: `delaySeconds` behind the players (seats,
   * cards and bets as they were then), and with every hole card when
   * `seeAll`. Null for seated players and the host. `blocked` when the host
   * has turned watching off: the hand is hidden until you sit.
   */
  spectator: { delaySeconds: number; seeAll: boolean; blocked: boolean } | null;
  /**
   * Provably fair dealing (docs/FAIRNESS.md): the published commitment to the
   * next hand's server seed (seated browsers answer with fair:seed), and the
   * one the hand in progress was dealt from.
   */
  fair: { nextCommit: string; handCommit: string | null };
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
  /** `bot` marks a practice bot: whose it was and its look (BOT_LOOKS). */
  seats: { seat: number; playerId: PlayerId; name: string; stack: number; bot?: { ownerName: string; look: number } }[];
  events: HandEvent[];
  /** How the deck was made; null or missing for hands dealt (or shared) before provably fair dealing. */
  fair?: FairRecordView | null;
}

/**
 * A finished hand's fairness record. serverSeed and handSeed are null until the
 * hand is revealed (the host stopped the game, or at revealsAt): they give away
 * every card in the deck, folded hands included.
 */
export interface FairRecordView {
  version: string;
  handId: string;
  commit: string;
  clientSeeds: { playerId: PlayerId; name: string; seed: string }[];
  serverSeed: string | null;
  handSeed: string | null;
  revealsAt: number | null;
  /** Once revealed: every event with every card, so the checker can deal the hand again. */
  events: HandEvent[] | null;
}

/** A hand shared as a link: frozen as the sharer saw it (or with their own cards hidden). */
export interface SharedHandView {
  id: string;
  tableName: string;
  centsMode: boolean;
  seatCount: number;
  felt: string | null;
  sharedBy: string;
  createdAt: number;
  hand: HandRecordView;
}

export type Ack<T = object> = (res: ({ ok: true } & T) | { ok: false; error: string }) => void;

export interface CreateTableInput {
  /** Any subset of the settings; the rest come from the defaults. */
  settings: SettingsPatch;
  /** A practice table: seat me with this name and deal straight away against this many bots (1-9). */
  practice?: { name: string; bots: number };
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
  /** The whole table log and chat (the view carries only the latest lines) and every finished hand, for the full log download. */
  'table:fullLog': (ack: Ack<{ log: { at: number; text: string }[]; chat: ChatView[]; hands: HandRecordView[] }>) => void;
  /** Freeze a finished hand as I saw it behind a link anyone can open; hideMine leaves out my cards unless I showed them. */
  'hand:share': (input: { handNumber: number; hideMine?: boolean }, ack: Ack<{ id: string }>) => void;
  /** Stop a link I made from working. */
  'hand:unshare': (input: { id: string }, ack: Ack) => void;
  'seat:request': (input: { seat: number; name: string; stack: number }, ack: Ack) => void;
  'seat:cancel': () => void;
  'seat:stand': (input: { afterHand?: boolean }) => void;
  'seat:sitOut': (input: { value: boolean }, ack: Ack) => void;
  'seat:prefs': (input: { waitForBigBlind?: boolean; straddle?: boolean; nitGame?: boolean; mood?: string | null }, ack: Ack) => void;
  'seat:rebuy': (input: { amount: number }, ack: Ack) => void;
  /** Queue for a seat at a full table, with the stack to sit with. */
  'waitlist:join': (input: { name: string; stack: number }, ack: Ack) => void;
  /** Leave the waitlist (also turns down a seat being held for you). */
  'waitlist:leave': (ack: Ack) => void;
  'hand:act': (action: Action, ack: Ack) => void;
  'hand:draw': (input: { discard: number[] }, ack: Ack) => void;
  'hand:runItTwice': (input: { yes: boolean }, ack: Ack) => void;
  'hand:show': (input: { cards: number[] }, ack: Ack) => void;
  /** Add my time bank to my clock now. */
  'hand:timeBank': (ack: Ack) => void;
  /** See the cards that would have come (only I see them). */
  'hand:rabbit': (ack: Ack) => void;
  /** Add my browser's randomness to the next hand, answering the commitment I was shown (seated players). */
  'fair:seed': (input: { commit: string; seed: string }, ack: Ack) => void;
  'chat:send': (input: { text: string }, ack?: Ack) => void;
  /** Throw a gesture at a player at my table. */
  'table:gesture': (input: { to: PlayerId; kind: GestureKind }, ack: Ack) => void;
  /** My picture everywhere: one from the library, an uploaded image (a small data: URL), or none. */
  'avatar:set': (input: { library?: string; image?: string } | null, ack: Ack<{ avatar: string | null }>) => void;
  /** My private notes on other players. */
  'notes:list': (ack: Ack<{ notes: PlayerNote[] }>) => void;
  /** Saves (or, with no text and no colour, deletes) my note on a player. */
  'notes:set': (input: PlayerNote, ack: Ack<{ note: PlayerNote | null }>) => void;
  /** Approve a request; `seat` puts a seat request's player in another open seat. */
  'host:approve': (input: { requestId: string; seat?: number }, ack: Ack) => void;
  'host:reject': (input: { requestId: string }) => void;
  'host:start': (ack: Ack) => void;
  'host:stop': (ack: Ack) => void;
  /** Host only: delete a cash table nobody has played a real game at, for good (a test or a mistake). */
  'host:deleteTable': (ack: Ack) => void;
  'host:deal': (ack: Ack) => void;
  'host:pause': (input: { value: boolean }, ack: Ack) => void;
  /** Make the next hand a bomb pot (value false takes it back). */
  'host:bombPot': (input: { value: boolean }, ack: Ack) => void;
  'host:settings': (input: { patch: SettingsPatch }, ack: Ack) => void;
  'host:setStack': (input: { playerId: string; stack: number }, ack: Ack) => void;
  'host:kick': (input: { playerId: string }, ack: Ack) => void;
  'host:sitOut': (input: { playerId: string }, ack: Ack) => void;
  'host:transfer': (input: { playerId: string }, ack: Ack) => void;
  /** Between hands: reseat everyone at random and draw the button again. */
  'host:shuffle': (ack: Ack) => void;
  /** Move a player who is not in the hand to an empty seat. */
  'host:move': (input: { playerId: string; seat: number }, ack: Ack) => void;
  /** Host only: make someone a co-host, or change a co-host's powers. */
  'host:coHost': (input: { playerId: string; powers: HostPower[] }, ack: Ack) => void;
  /** Host: remove a co-host. A co-host may remove themselves (step down). */
  'host:removeCoHost': (input: { playerId: string }, ack: Ack) => void;
  /** Mute (or unmute) someone's chat for everyone. */
  'host:mute': (input: { playerId: string; value: boolean }, ack: Ack) => void;
  /** Add a practice bot of mine (it gets its own short name and robot), in this seat or the first free one. */
  'bot:add': (input: { seat?: number }, ack: Ack<{ playerId: string }>) => void;
  /** Take away a bot I added (the host can take away any). */
  'bot:remove': (input: { playerId: string }, ack: Ack) => void;
}

export interface ServerToClient {
  session: (session: { playerId: string; displayName: string; account: { username: string } | null; avatar?: string | null }) => void;
  'table:state': (view: TableView) => void;
  /** A tournament moved you to another table (balancing or a broken table). */
  'table:moved': (input: { from: string; to: string }) => void;
  /** The table I had open was deleted for good. */
  'table:deleted': (input: { id: string }) => void;
  /** Someone at the table threw a gesture. */
  'table:gesture': (input: { from: PlayerId; to: PlayerId; kind: GestureKind; at: number }) => void;
  /** All my notes again, after one changed in any of my tabs. */
  notes: (notes: PlayerNote[]) => void;
}

/** Gestures a player can throw at another. The pictures and sounds are drawn by the web client. */
export const GESTURES = ['heart', 'clap', 'cheers', 'fire', 'laugh', 'cry', 'money', 'fish', 'shark', 'clown', 'tomato', 'rose'] as const;
export type GestureKind = (typeof GESTURES)[number];

/**
 * Practice bots' names and pictures. Each bot at a table takes the first one no
 * other bot there has, so bots are easy to tell apart at a glance. The order
 * puts the most different colours first. Names stay at five letters or fewer
 * so they fit a phone nameplate. The web client draws the robot from `color`
 * and `face` (0-3).
 */
export const BOT_LOOKS: readonly { name: string; color: string; face: number }[] = [
  { name: 'Ace', color: '#e5484d', face: 0 },
  { name: 'Chip', color: '#2f8ee8', face: 1 },
  { name: 'Lucky', color: '#2f9e5b', face: 2 },
  { name: 'Ducky', color: '#f2b705', face: 3 },
  { name: 'Slick', color: '#9b4dca', face: 1 },
  { name: 'Rocky', color: '#f76b15', face: 2 },
  { name: 'Deuce', color: '#0f9f95', face: 0 },
  { name: 'Hooks', color: '#e0457b', face: 3 },
  { name: 'Quads', color: '#9a6a3c', face: 2 },
  { name: 'Shark', color: '#5b5bd6', face: 0 },
  { name: 'Spike', color: '#7cab1f', face: 1 },
  { name: 'Trips', color: '#7d8a99', face: 3 },
];

/** The built-in avatar library: id → emoji and background colour. All our own picks, free for everyone. */
export const AVATARS: Record<string, { emoji: string; bg: string }> = {
  fox: { emoji: '🦊', bg: '#f2994a' },
  owl: { emoji: '🦉', bg: '#8d6e63' },
  cat: { emoji: '🐱', bg: '#f6c344' },
  bear: { emoji: '🐻', bg: '#a1887f' },
  frog: { emoji: '🐸', bg: '#66bb6a' },
  octopus: { emoji: '🐙', bg: '#ec6fa8' },
  tiger: { emoji: '🐯', bg: '#ffa726' },
  panda: { emoji: '🐼', bg: '#cfd8dc' },
  unicorn: { emoji: '🦄', bg: '#b39ddb' },
  robot: { emoji: '🤖', bg: '#90a4ae' },
  alien: { emoji: '👽', bg: '#7cb342' },
  ghost: { emoji: '👻', bg: '#9fa8da' },
  cowboy: { emoji: '🤠', bg: '#d4a373' },
  shark: { emoji: '🦈', bg: '#4fc3f7' },
  dragon: { emoji: '🐲', bg: '#43a047' },
  penguin: { emoji: '🐧', bg: '#4dd0e1' },
  koala: { emoji: '🐨', bg: '#b0bec5' },
  lion: { emoji: '🦁', bg: '#fbc02d' },
  monkey: { emoji: '🐵', bg: '#bcaaa4' },
  wolf: { emoji: '🐺', bg: '#78909c' },
  crown: { emoji: '👑', bg: '#7e57c2' },
  rocket: { emoji: '🚀', bg: '#5c6bc0' },
  cactus: { emoji: '🌵', bg: '#9ccc65' },
  pizza: { emoji: '🍕', bg: '#ef5350' },
  sunglasses: { emoji: '😎', bg: '#26a69a' },
  wizard: { emoji: '🧙', bg: '#5e35b1' },
  ninja: { emoji: '🥷', bg: '#455a64' },
  diamond: { emoji: '💎', bg: '#29b6f6' },
};
/** Largest uploaded avatar accepted, as a data: URL (the web client shrinks pictures well under this). */
export const AVATAR_MAX_CHARS = 60_000;

export const NOTE_COLORS = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];
export const NOTE_MAX = 500;

/** A private note one player keeps on another. Only its owner ever receives it. */
export interface PlayerNote {
  targetPlayerId: string;
  text: string;
  color: NoteColor;
}

export interface HandshakeAuth {
  /** Random secret kept in the browser (localStorage rsdp.guestId). Never shown to other players. */
  token: string;
}
