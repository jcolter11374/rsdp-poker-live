import { io, type Socket } from 'socket.io-client';
import type { ClientToServer, ServerToClient } from '@rsdp/engine/wire';

const TOKEN_KEY = 'rsdp.guestId';
/** Where the first version kept the secret; read once so old browsers keep their seat. */
const OLD_TOKEN_KEY = 'rsdp.token';

/** A random secret that identifies this browser. Kept locally so a refresh keeps your seat. */
function token(): string {
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

export type GameSocket = Socket<ServerToClient, ClientToServer>;

export const socket: GameSocket = io({ auth: { token: token() } });

type AckResult = { ok: true } | { ok: false; error: string };

/**
 * Emits an event that takes an ack and resolves with the reply; rejects with
 * the server's message when it refuses. Events without a payload pass none.
 */
export function call<T extends object = object>(event: keyof ClientToServer, ...payload: unknown[]): Promise<T> {
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
