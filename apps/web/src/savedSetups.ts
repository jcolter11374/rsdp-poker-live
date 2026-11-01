import { useSyncExternalStore } from 'react';
import { SETUP_NAME_MAX, type SavedSetup, type SetupKind } from '@rsdp/engine/wire';
import { MAX_SAVED_STRUCTURE_LENGTH } from '@rsdp/tournament';
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
  /** False while a signed-in list is still coming from the server (so a name check can't be trusted yet). */
  ready(): boolean;
  /** Saves under the name, replacing one of the same name; resolves with the name as kept. */
  save(name: string, json: string): Promise<string>;
  rename(from: string, to: string): Promise<string>;
  remove(name: string): Promise<void>;
}

const NONE: SavedSetup[] = [];

/** Which kinds of setup this browser may still bring onto the account it signed in to. */
const BRING_KEY = 'rsdp.bringSetups';

/**
 * Called at sign-in (true when it's the player's own device, the "bring over"
 * box) and at sign-out (false). Only then does the next signed-in session move
 * the browser's setups onto the account; on a friend's phone they stay theirs.
 */
export function bringSetupsOver(yes: boolean) {
  try {
    if (yes) localStorage.setItem(BRING_KEY, JSON.stringify(['table', 'tournament']));
    else localStorage.removeItem(BRING_KEY);
  } catch {
    /* storage blocked: nothing to bring */
  }
}

function mayBring(kind: SetupKind): boolean {
  try {
    const kinds = JSON.parse(localStorage.getItem(BRING_KEY) ?? '[]');
    return Array.isArray(kinds) && kinds.includes(kind);
  } catch {
    return false;
  }
}

function broughtOver(kind: SetupKind) {
  try {
    const kinds = (JSON.parse(localStorage.getItem(BRING_KEY) ?? '[]') as unknown[]).filter((k) => k !== kind);
    if (kinds.length) localStorage.setItem(BRING_KEY, JSON.stringify(kinds));
    else localStorage.removeItem(BRING_KEY);
  } catch {
    /* storage blocked */
  }
}

/**
 * Most one message bringing setups over may weigh. The server drops the connection on a message over 1 MB
 * (its Socket.IO limit), so a big pile goes over in several. The biggest setup the account takes is well under this.
 */
const IMPORT_BATCH_BYTES = 512 * 1024;

/** The setups in turn, in groups that each fit in one message. */
function importBatches(setups: SavedSetup[]): SavedSetup[][] {
  const out: SavedSetup[][] = [];
  let batch: SavedSetup[] = [];
  let bytes = 0;
  for (const setup of setups) {
    const size = new TextEncoder().encode(JSON.stringify(setup)).length;
    if (batch.length && bytes + size > IMPORT_BATCH_BYTES) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(setup);
    bytes += size;
  }
  if (batch.length) out.push(batch);
  return out;
}

export const cleanSetupName = (name: string) => name.replace(/\s+/g, ' ').trim();

/**
 * `retitle` gives the setup under a new name (a table preset carries its name
 * inside its JSON) and throws for one that can't be saved.
 */
export function setupList(kind: SetupKind, storageKey: string, retitle: (setup: SavedSetup) => SavedSetup): SetupList {
  let local: SavedSetup[] = [];
  const readLocal = (): SavedSetup[] => {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      return Array.isArray(raw) ? raw.filter((p) => p && typeof p.name === 'string' && typeof p.json === 'string') : [];
    } catch {
      // Storage blocked: the list kept for this page.
      return local;
    }
  };
  local = readLocal();
  /** The account's list while signed in; null for a guest. */
  let remote: SavedSetup[] | null = null;
  let account = !!currentSession()?.account;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((l) => l());
  // The same empty list every time: a fresh [] each call would make React render forever.
  const list = () => (account ? (remote ?? NONE) : local);
  const sorted = (l: SavedSetup[]) => [...l].sort((a, b) => a.name.localeCompare(b.name));

  /** Changes the browser's list as stored now, so another tab's change isn't written over. */
  const updateLocal = (change: (current: SavedSetup[]) => SavedSetup[]) => {
    local = sorted(change(readLocal()));
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
      // What this browser saved as a guest moves onto the account once, when it's the player's own device.
      // Only what the account took leaves the browser; anything refused stays and shows again after sign-out.
      // One too big for the account to take isn't sent: it stays here.
      const mine = mayBring(kind) ? readLocal().filter((p) => p.json.length <= MAX_SAVED_STRUCTURE_LENGTH) : [];
      for (const batch of importBatches(mine)) {
        const { kept } = await call<{ kept: string[] }>('setups:import', { kind, setups: batch });
        updateLocal((cur) => cur.filter((p) => !(kept.includes(p.name) && batch.some((m) => m.name === p.name && m.json === p.json))));
      }
      if (mayBring(kind)) broughtOver(kind);
      const pushedBefore = pushes;
      const r = await call<{ setups: SavedSetup[] }>('setups:list', { kind });
      // A push from another tab that came in meanwhile is newer than this answer.
      if (run === syncing && pushes === pushedBefore) remote = r.setups;
    } catch {
      /* offline or refused: try again on the next session */
    }
    changed();
  };
  let pushes = 0;
  socket.on('setups', (m) => {
    if (m.kind !== kind || !account) return;
    pushes++;
    remote = m.setups;
    changed();
  });
  onSession((s) => void sync(s));
  // A guest tab sees what another tab saved.
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== storageKey) return;
    local = readLocal();
    changed();
  });
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
    ready: () => !account || remote !== null,
    async save(name, json) {
      const setup = tidy(name, json);
      if (account) return (await call<{ name: string }>('setups:save', { kind, ...setup })).name;
      updateLocal((cur) => [...cur.filter((p) => p.name !== setup.name), setup]);
      return setup.name;
    },
    async rename(from, to) {
      if (account) return (await call<{ name: string }>('setups:rename', { kind, from, to: cleanSetupName(to) })).name;
      const setup = local.find((p) => p.name === from);
      if (!setup) throw new Error('That one is gone');
      const next = tidy(to, setup.json);
      if (next.name !== from && local.some((p) => p.name === next.name)) throw new Error(`You already have one called “${next.name}”`);
      updateLocal((cur) => [...cur.filter((p) => p.name !== from), next]);
      return next.name;
    },
    async remove(name) {
      if (account) await call('setups:delete', { kind, name });
      else updateLocal((cur) => cur.filter((p) => p.name !== name));
    },
  };
}
