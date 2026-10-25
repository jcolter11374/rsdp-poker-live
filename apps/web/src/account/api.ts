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
  account: { username: string; createdAt: string; devices: number } | null;
  tables: TableRow[];
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

export async function signUp(username: string, password: string) {
  const res = await request<{ session: string; username: string }>('POST', '/api/account/signup', { username, password });
  saveSessionToken(res.session);
  return res;
}

export async function signIn(username: string, password: string) {
  const res = await request<{ session: string; username: string; broughtOver: boolean }>('POST', '/api/account/signin', { username, password });
  saveSessionToken(res.session);
  return res;
}

export async function signOut() {
  // Even when the server can't be reached, this browser forgets the sign-in.
  await request('POST', '/api/account/signout').catch(() => {});
  startOverAsGuest();
}

export const changePassword = (current: string, password: string) => request('POST', '/api/account/password', { current, password });

export async function deleteAccount(password: string) {
  await request('POST', '/api/account/delete', { password });
  startOverAsGuest();
}

export const resetPassword = (username: string, code: string, password: string) => request('POST', '/api/account/reset', { username, code, password });

/** The admin's side of a reset: a one-time code to send to the player. */
export const issueResetCode = (adminKey: string, username: string) =>
  request<{ username: string; code: string; expiresAt: string }>('POST', '/api/admin/accounts/reset-code', { username }, { 'x-admin-key': adminKey });
