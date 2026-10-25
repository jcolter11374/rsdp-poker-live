// The tournament socket protocol between server and web.

import type { TournamentListing } from './listing';
import type { SeasonBoard } from './season';
import type { Command, TournamentSettings, TournamentState } from './types';

type Ack<T = object> = (res: ({ ok: true } & T) | { ok: false; error: string }) => void;

export interface TournamentView {
  state: TournamentState;
  /** Server clock when the view was sent, to correct for clock skew. */
  serverNow: number;
  /** The next event in a series or the next Sit & Go, once the server has made it. */
  nextId?: string | null;
}

export interface TournamentClientToServer {
  'tournament:create': (input: { settings: TournamentSettings }, ack: Ack<{ id: string }>) => void;
  /** Sends the current view at once, then again on every change. */
  'tournament:subscribe': (input: { id: string }, ack: Ack) => void;
  'tournament:unsubscribe': (input: { id: string }) => void;
  /** Player and host commands. The server fills in who is acting from the connection. */
  'tournament:command': (input: { id: string; command: Command }, ack: Ack) => void;
  /** Home page: every upcoming and running event, plus the viewer's own (hosted or played) from the last 30 days. */
  'tournament:list': (ack: Ack<{ tournaments: TournamentListing[]; serverNow: number }>) => void;
  /** A season's leaderboard; anyone with the link may look. */
  'season:get': (input: { id: string }, ack: Ack<{ board: SeasonBoard }>) => void;
  /** Seasons this player hosts, newest first, to add a new event to. */
  'season:mine': (input: object, ack: Ack<{ seasons: { id: string; name: string; events: number }[] }>) => void;
}

export interface TournamentServerToClient {
  'tournament:state': (input: { id: string; view: TournamentView }) => void;
}

/** A director table id (`abc:t3`) as the table's address in links (`abc-t3`). */
export const tableAddress = (tableId: string) => tableId.replace(/:/g, '-');
