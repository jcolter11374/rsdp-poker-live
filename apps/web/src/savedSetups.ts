import { useSyncExternalStore } from 'react';
import { SETUP_NAME_MAX, type SavedSetup, type SetupKind } from '@rsdp/engine/wire';
import { call, currentSession, onSession, socket, type Session } from './socket';

/**
 * Setups saved under a name (cash table presets, tournament structures). When
 * signed in they live on the account, so they follow you to every device;
 * a guest keeps them in this browser. Signing in brings the browser's ones
 * onto the account.
 */
export interface SetupList {
  /** The saved setups, by name. */
  use(): SavedSetup[];
  /** Whether they are kept on an account (else in this browser). */
  useOnAccount(): boolean;
  list(): SavedSetup[];
  /** Saves under the name, replacing one of the same name; resolves with the name as kept. */
  save(name: string, json: string): Promise<string>;
  rename(from: string, to: string): Promise<string>;
  remove(name: string): Promise<void>;
}

const NONE: SavedSetup[] = [];

export const cleanSetupName = (name: string) => name.replace(/\s+/g, ' ').trim();

/**
 * `retitle` gives the setup under a new name (a table preset carries its name
 * inside its JSON) and throws for one that can't be saved.
 */
export function setupList(kind: SetupKind, storageKey: string, retitle: (setup: SavedSetup) => SavedSetup): SetupList {
  const readLocal = (): SavedSetup[] => {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      return Array.isArray(raw) ? raw.filter((p) => p && typeof p.name === 'string' && typeof p.json === 'string') : [];
    } catch {
      return [];
    }
  };
  let local = readLocal();
  /** The account's list while signed in; null for a guest. */
  let remote: SavedSetup[] | null = null;
  let account = !!currentSession()?.account;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((l) => l());
  // The same empty list every time: a fresh [] each call would make React render forever.
  const list = () => (account ? (remote ?? NONE) : local);
  const sorted = (l: SavedSetup[]) => [...l].sort((a, b) => a.name.localeCompare(b.name));

  const storeLocal = (next: SavedSetup[]) => {
    local = sorted(next);
    try {
      if (local.length) localStorage.setItem(storageKey, JSON.stringify(local));
      else localStorage.removeItem(storageKey);
    } catch {
      /* storage blocked or full: they last for this page only */
    }
    changed();
  };

  const tidy = (name: string, json: string) => {
    const clean = cleanSetupName(name);
    if (!clean) throw new Error('Give it a name');
    if (Array.from(clean).length > SETUP_NAME_MAX) throw new Error(`Names can be up to ${SETUP_NAME_MAX} characters`);
    return retitle({ name: clean, json });
  };

  let syncing = 0;
  const sync = async (s: Session) => {
    account = !!s.account;
    if (!account) {
      remote = null;
      changed();
      return;
    }
    const run = ++syncing;
    try {
      // What this browser saved as a guest moves onto the account, once.
      const mine = readLocal();
      if (mine.length) {
        await call('setups:import', { kind, setups: mine });
        storeLocal(readLocal().filter((p) => !mine.some((m) => m.name === p.name && m.json === p.json)));
      }
      const r = await call<{ setups: SavedSetup[] }>('setups:list', { kind });
      if (run === syncing) remote = r.setups;
    } catch {
      /* offline or refused: try again on the next session */
    }
    changed();
  };
  socket.on('setups', (m) => {
    if (m.kind !== kind || !account) return;
    remote = m.setups;
    changed();
  });
  onSession((s) => void sync(s));
  const first = currentSession();
  if (first) void sync(first);

  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };

  return {
    use: () => useSyncExternalStore(subscribe, list),
    useOnAccount: () => useSyncExternalStore(subscribe, () => account),
    list,
    async save(name, json) {
      const setup = tidy(name, json);
      if (account) return (await call<{ name: string }>('setups:save', { kind, ...setup })).name;
      storeLocal([...local.filter((p) => p.name !== setup.name), setup]);
      return setup.name;
    },
    async rename(from, to) {
      if (account) return (await call<{ name: string }>('setups:rename', { kind, from, to: cleanSetupName(to) })).name;
      const setup = local.find((p) => p.name === from);
      if (!setup) throw new Error('That one is gone');
      const next = tidy(to, setup.json);
      if (next.name !== from && local.some((p) => p.name === next.name)) throw new Error(`You already have one called “${next.name}”`);
      storeLocal([...local.filter((p) => p.name !== from), next]);
      return next.name;
    },
    async remove(name) {
      if (account) await call('setups:delete', { kind, name });
      else storeLocal(local.filter((p) => p.name !== name));
    },
  };
}
