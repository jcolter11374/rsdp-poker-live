import { io, type Socket } from 'socket.io-client';
import type { ClientToServer, ServerToClient } from '@rsdp/engine';

const TOKEN_KEY = 'rsdp.token';

/** A random secret that identifies this browser. Kept locally so a refresh keeps your seat. */
function token(): string {
  let t: string | null = null;
  try {
    t = localStorage.getItem(TOKEN_KEY);
  } catch {
    // Storage can be blocked; fall back to a per-tab identity.
  }
  if (!t) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    t = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* ignore */
    }
  }
  return t;
}

export type GameSocket = Socket<ServerToClient, ClientToServer>;

export const socket: GameSocket = io({ auth: { token: token() } });

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
