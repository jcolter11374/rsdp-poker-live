import { io, type Socket } from 'socket.io-client';
import type { ClientToServer, ServerToClient } from '@rsdp/engine/wire';
import type { TournamentClientToServer, TournamentServerToClient } from '@rsdp/tournament';

const TOKEN_KEY = 'rsdp.guestId';
/** Where the first version kept the secret; read once so old browsers keep their seat. */
const OLD_TOKEN_KEY = 'rsdp.token';

/** A random secret that identifies this browser. Kept locally so a refresh keeps your seat. */
export function guestToken(): string {
  let t: string | null = null;
  try {
    t = localStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(OLD_TOKEN_KEY);
  } catch {
    // Storage can be blocked; fall back to a per-tab identity.
  }
  if (!t || t.length < 16) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    t = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* ignore */
  }
  return t;
}

type C2S = ClientToServer & TournamentClientToServer;
type S2C = ServerToClient & TournamentServerToClient;
export type GameSocket = Socket<S2C, C2S>;

const SESSION_KEY = 'rsdp.session';

/** The sign-in token when this browser is signed in to an account, else ''. */
export function sessionToken(): string {
  try {
    return localStorage.getItem(SESSION_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Keeps (or with null, forgets) the sign-in token. The page reloads afterwards to connect as the new player. */
export function saveSessionToken(value: string | null) {
  try {
    if (value) localStorage.setItem(SESSION_KEY, value);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** After signing out or deleting the account: this browser starts over as a brand new guest. */
export function startOverAsGuest() {
  saveSessionToken(null);
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(OLD_TOKEN_KEY);
    localStorage.removeItem(NAME_KEY);
  } catch {
    /* ignore */
  }
}

const signedInWith = sessionToken();
export const socket: GameSocket = io({ auth: { token: guestToken(), ...(signedInWith ? { session: signedInWith } : {}) } });

export type Session = Parameters<ServerToClient['session']>[0];

// The server sends the session as soon as the socket connects, so listen
// before any page mounts.
let session: Session | null = null;
const sessionListeners = new Set<(s: Session) => void>();
socket.on('session', (s) => {
  session = s;
  // The sign-in ran out or was ended on another device: forget it, and play on as this browser's guest.
  if (!s.account && signedInWith) saveSessionToken(null);
  sessionListeners.forEach((cb) => cb(s));
});
export const currentSession = () => session;
export function onSession(cb: (s: Session) => void): () => void {
  sessionListeners.add(cb);
  return () => sessionListeners.delete(cb);
}

type AckResult = { ok: true } | { ok: false; error: string };

/**
 * Emits an event that takes an ack and resolves with the reply; rejects with
 * the server's message when it refuses. Events without a payload pass none.
 */
export function call<T extends object = object>(event: keyof C2S, ...payload: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    (socket.emit as (e: string, ...a: unknown[]) => void)(event, ...payload, (res: AckResult & T) =>
      res.ok ? resolve(res) : reject(new Error(res.error)),
    );
  });
}

const NAME_KEY = 'rsdp.name';
export function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
export function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

/** Sets the name other players see, on every table and tournament. */
export async function setName(name: string) {
  await call('session:name', { name });
  saveName(name.trim());
}
