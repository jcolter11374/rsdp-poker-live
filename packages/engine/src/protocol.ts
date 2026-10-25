import type { Action } from './table';
import type { TableView } from './view';

/** Shared by server and client so both sides agree on the wire format. */

export interface CreateRoomInput {
  hostName: string;
  smallBlind: number;
  bigBlind: number;
  /** Seconds per decision before an automatic check or fold. 0 turns the clock off. */
  turnSeconds: number;
}

export interface SeatRequest {
  id: string;
  playerId: string;
  name: string;
  seat: number;
  stack: number;
}

export interface LedgerEntry {
  playerId: string;
  name: string;
  buyIn: number;
  /** Current stack if seated, otherwise what they left with. */
  stack: number;
  net: number;
}

export interface ChatMessage {
  at: number;
  name: string;
  text: string;
}

export interface RoomView extends TableView {
  roomId: string;
  hostId: string;
  isHost: boolean;
  running: boolean;
  paused: boolean;
  /** Host sees every request; everyone else sees only their own. */
  requests: SeatRequest[];
  ledger: LedgerEntry[];
  chat: ChatMessage[];
  /** Epoch ms when the current player's clock runs out, if the clock is on. */
  turnDeadline: number | null;
  /** When the current clock started, so clients can draw a shrinking bar. */
  turnStarted: number | null;
  turnSeconds: number;
  /** Seated players with no open connection. */
  away: string[];
}

export type Ack<T = object> = (res: ({ ok: true } & T) | { ok: false; error: string }) => void;

export interface ClientToServer {
  'room:create': (input: CreateRoomInput, ack: Ack<{ roomId: string }>) => void;
  'room:join': (input: { roomId: string }, ack: Ack) => void;
  'seat:request': (input: { seat: number; name: string; stack: number }, ack: Ack) => void;
  'seat:cancel': () => void;
  'player:action': (action: Action, ack: Ack) => void;
  'player:stand': () => void;
  'player:sitOut': (input: { value: boolean }) => void;
  'chat:send': (input: { text: string }) => void;
  'host:approve': (input: { requestId: string }, ack: Ack) => void;
  'host:reject': (input: { requestId: string }) => void;
  'host:start': (ack: Ack) => void;
  'host:pause': (input: { value: boolean }) => void;
  'host:settings': (input: { smallBlind: number; bigBlind: number; turnSeconds: number }, ack: Ack) => void;
  'host:setStack': (input: { playerId: string; stack: number }, ack: Ack) => void;
  'host:kick': (input: { playerId: string }) => void;
}

export interface ServerToClient {
  'room:state': (view: RoomView) => void;
}

export interface HandshakeAuth {
  /** Random secret kept in the browser. Never sent to other players. */
  token: string;
}
