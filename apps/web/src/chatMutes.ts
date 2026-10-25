import { useSyncExternalStore } from 'react';

/** People this browser has muted in chat. Only you stop seeing them; they are never told. */
const KEY = 'rsdp.chatMuted';

function load(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

let current = load();
const listeners = new Set<() => void>();

export function useChatMutes(): string[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export function setChatMuted(playerId: string, muted: boolean) {
  current = muted ? [...new Set([...current, playerId])] : current.filter((id) => id !== playerId);
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage blocked: the mute lasts for this page */
  }
  listeners.forEach((l) => l());
}
