/** Optional accounts: talks to /api/account with this browser's guest secret and sign-in token. */

import { guestToken, saveSessionToken, sessionToken, startOverAsGuest } from '../socket';

export interface TableRow {
  tableId: string;
  name: string;
  hands: number;
  lastPlayedAt: string;
  /** Chips won (above 0) or lost; null when the table's ledger is gone. */
  net: number | null;
  centsMode: boolean;
  practice: boolean;
}

export interface TournamentRow {
  id: string;
  name: string;
  status: string;
  at: string;
  entrants: number;
  place: number | null;
  prize: number;
  entered: boolean;
  hosted: boolean;
}

export interface Profile {
  playerId: string;
  displayName: string;
  account: { username: string; createdAt: string; devices: number; hasPassword: boolean; google: boolean } | null;
  tables: TableRow[];
  /** Tables I hid from my profile. */
  hiddenTables: TableRow[];
  tournaments: TournamentRow[];
}

/** A refused request, with the server's message. */
export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: object, extra: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-guest-token': guestToken(), ...extra };
  const session = sessionToken();
  if (session) headers['x-session-token'] = session;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body && JSON.stringify(body) }).catch(() => {
    throw new AccountError('Could not reach the server. Try again.', 0);
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new AccountError(data.error ?? 'Something went wrong. Try again.', res.status);
  return data;
}

/** Reloads into `to`, so every page connects again as the new player. */
export function reloadTo(to: string) {
  location.assign(to);
}

export const fetchProfile = () => request<Profile>('GET', '/api/account/me');

/** My result at one real cash game, in cents (a chip counts as 100). */
export interface ProfitSession {
  tableId: string;
  name: string;
  at: string;
  hands: number;
  net: number;
}

export const fetchGraph = () => request<{ sessions: ProfitSession[] }>('GET', '/api/account/graph');

/** One person on the leaderboard; amounts in cents (a chip counts as 100). */
export interface LeaderRow {
  key: string;
  name: string;
  profit: number;
  sessions: number;
  hands: number;
  biggestPot: number;
}

export type LeaderPeriod = 'month' | 'year' | 'all';

export const fetchLeaderboard = (period: LeaderPeriod) => request<{ period: LeaderPeriod; since: string | null; rows: LeaderRow[] }>('GET', `/api/leaderboard?period=${period}`);

/** One hand found by search, as I saw it. */
export interface FoundHand {
  handId: string;
  tableId: string;
  tableName: string;
  centsMode: boolean;
  seatCount: number;
  felt: string | null;
  myId: string;
  /** Chips in the pot (all pots together). */
  pot: number;
  hand: import('@rsdp/engine/wire').HandRecordView;
}

export interface HandQuery {
  player?: string;
  game?: string;
  cards?: string;
  minPot?: string;
  result?: '' | 'won' | 'lost';
}

export function searchHands(q: HandQuery, before?: string | null) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, String(v));
  if (before) params.set('before', before);
  return request<{ hands: FoundHand[]; next: string | null }>('GET', `/api/hands/search?${params}`);
}

export const fetchHandGames = () => request<{ games: { id: string; name: string; hands: number }[] }>('GET', '/api/hands/games');

/** A link anyone can open to watch one of my hands; `hideMine` keeps my cards face down unless shown. */
export const shareFoundHand = (handId: string, hideMine: boolean) => request<{ id: string }>('POST', '/api/hands/share', { handId, hideMine });

/** Hides a cash table from my profile (or shows it again). Nobody else's records change. */
export const hideTable = (tableId: string, hidden: boolean) => request('POST', '/api/account/tables/hide', { tableId, hidden });

/** What the admin sees about a table before deleting it. */
export interface AdminTable {
  id: string;
  name: string;
  mode: 'cash' | 'tournament';
  createdAt: string;
  hands: number;
  players: string[];
  realGame: boolean;
  live: boolean;
}

export const adminLookUpTable = (adminKey: string, id: string) => request<AdminTable>('GET', `/api/admin/tables/${encodeURIComponent(id)}`, undefined, { 'x-admin-key': adminKey });

export const adminDeleteTable = (adminKey: string, id: string) => request('POST', `/api/admin/tables/${encodeURIComponent(id)}/delete`, undefined, { 'x-admin-key': adminKey });

export async function signUp(username: string, password: string) {
  const res = await request<{ session: string; username: string }>('POST', '/api/account/signup', { username, password });
  saveSessionToken(res.session);
  return res;
}

/** `bringOver`: this is my own device, so what I did here as a guest joins my account. */
export async function signIn(username: string, password: string, bringOver: boolean) {
  const res = await request<{ session: string; username: string; broughtOver: boolean }>('POST', '/api/account/signin', { username, password, bringOver });
  saveSessionToken(res.session);
  return res;
}

export async function signOut() {
  // Even when the server can't be reached, this browser forgets the sign-in. Its guest starts over
  // only when that guest belonged to the account; a friend's device keeps its own guest.
  const res = await request<{ forgot: boolean }>('POST', '/api/account/signout').catch(() => ({ forgot: true }));
  if (res.forgot) startOverAsGuest();
  else saveSessionToken(null);
}

export const changePassword = (current: string, password: string) => request('POST', '/api/account/password', { current, password });

/** `password`, or for an account without one, its username typed to confirm. */
export async function deleteAccount(confirm: { password?: string; username?: string }) {
  await request('POST', '/api/account/delete', confirm);
  startOverAsGuest();
}

export const resetPassword = (username: string, code: string, password: string) => request('POST', '/api/account/reset', { username, code, password });

/** The admin's side of a reset: a one-time code to send to the player. */
export const issueResetCode = (adminKey: string, username: string) =>
  request<{ username: string; code: string; expiresAt: string }>('POST', '/api/admin/accounts/reset-code', { username }, { 'x-admin-key': adminKey });

/** Whether this server offers "Sign in with Google". */
export const fetchAuthConfig = () => request<{ google: boolean }>('GET', '/api/auth/config');

/** Off to Google; it sends the browser back to /auth/done. `link` adds Google to the signed-in account; `confirm` re-checks it's you. */
export async function startGoogle(mode: 'signin' | 'link' | 'confirm', bringOver = true, password?: string) {
  const { url } = await request<{ url: string }>('POST', '/api/auth/google/begin', { mode, bringOver, password });
  location.assign(url);
}

/** Back from Google: trades the one-time ticket (only this browser can) for the result. */
export const finishGoogle = (ticket: string) =>
  request<{ session?: string; welcome?: boolean; merged?: boolean; linked?: boolean; confirmed?: boolean }>('POST', '/api/auth/google/finish', { ticket });

export const unlinkGoogle = (password: string) => request('POST', '/api/account/google/unlink', { password });
