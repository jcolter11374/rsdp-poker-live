// How tournament pages talk to the server. The socket implementation lives
// with the server runtime; LocalTournamentClient runs the same director in
// the browser so the pages work (and can be demoed) before that lands.

import {
  apply,
  createTournament,
  DirectorError,
  nextWakeAt,
  tableGate,
  tick,
  type Command,
  type TournamentSettings,
  type TournamentState,
} from '@rsdp/tournament';

export interface Session {
  playerId: string;
  displayName: string;
  /** Null for a guest; registering for a tournament needs an account. */
  account: { username: string } | null;
}

export interface TournamentView {
  state: TournamentState;
  /** Server clock when the view was sent, to correct for clock skew. */
  serverNow: number;
}

export interface TournamentClient {
  session(): Session | null;
  onSession(cb: (s: Session | null) => void): () => void;
  /** Calls onView with the current view and again on every change. */
  subscribe(id: string, onView: (v: TournamentView) => void, onError: (message: string) => void): () => void;
  /** Rejects with the server's message when the command is refused. */
  send(id: string, command: Command): Promise<void>;
  create(settings: TournamentSettings): Promise<string>;
}

// ---------------------------------------------------------------------------

const STORE_KEY = 'rsdp.localTournaments';
const GUEST_KEY = 'rsdp.guestId';

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function randomId(bytes = 8): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Runs @rsdp/tournament in this tab. Tournaments are saved to localStorage so
 * a refresh keeps them, and a 1 s timer calls tick whenever nextWakeAt passes.
 * Demo helpers add test players and play hands, since there are no tables yet.
 */
export class LocalTournamentClient implements TournamentClient {
  private states = new Map<string, TournamentState>();
  private listeners = new Map<string, Set<(v: TournamentView) => void>>();
  private sessionListeners = new Set<(s: Session | null) => void>();
  private me: Session;
  private rng = (Date.now() >>> 0) | 1;

  constructor() {
    const store = storage();
    try {
      const saved = JSON.parse(store?.getItem(STORE_KEY) ?? '{}') as Record<string, TournamentState>;
      for (const [id, s] of Object.entries(saved)) this.states.set(id, s);
    } catch {
      /* start empty */
    }
    let guest = store?.getItem(GUEST_KEY) ?? null;
    if (!guest) {
      guest = randomId();
      store?.setItem(GUEST_KEY, guest);
    }
    const name = store?.getItem('rsdp.name') || 'You';
    // Local mode pretends you are signed in so registration can be tried.
    this.me = { playerId: guest, displayName: name, account: { username: name } };
    setInterval(() => this.wake(), 1000);
  }

  session() {
    return this.me;
  }

  onSession(cb: (s: Session | null) => void) {
    this.sessionListeners.add(cb);
    return () => this.sessionListeners.delete(cb);
  }

  /** Demo: act as another player (or the host) in this tab. */
  actAs(playerId: string, displayName: string) {
    this.me = { playerId, displayName, account: { username: displayName } };
    this.sessionListeners.forEach((cb) => cb(this.me));
    this.states.forEach((_, id) => this.emit(id));
  }

  subscribe(id: string, onView: (v: TournamentView) => void, onError: (message: string) => void) {
    const set = this.listeners.get(id) ?? new Set();
    set.add(onView);
    this.listeners.set(id, set);
    const s = this.states.get(id);
    if (s) onView({ state: s, serverNow: Date.now() });
    else onError('Tournament not found');
    return () => set.delete(onView);
  }

  async send(id: string, command: Command) {
    const s = this.states.get(id);
    if (!s) throw new Error('Tournament not found');
    try {
      this.commit(id, apply(s, command, Date.now()).state);
    } catch (e) {
      throw new Error(e instanceof DirectorError ? e.message : String(e));
    }
  }

  async create(settings: TournamentSettings) {
    const id = randomId(4);
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    try {
      this.commit(id, createTournament({ id, hostId: this.me.playerId, settings, now: Date.now(), seed }));
    } catch (e) {
      throw new Error(e instanceof DirectorError ? e.message : String(e));
    }
    return id;
  }

  /** Demo: register `count` test players. */
  async addTestPlayers(id: string, count: number) {
    const s = this.states.get(id)!;
    const n = s.entries.length + s.requests.length;
    for (let i = 0; i < count; i++) {
      const k = n + i + 1;
      await this.send(id, { type: 'register', playerId: `test-${k}`, displayName: `Player ${k}` }).catch(() => {});
    }
  }

  /** Demo: play one hand on every table that may deal; some players bust. */
  playHands(id: string) {
    let s = this.states.get(id)!;
    for (const t of s.tables) {
      if (tableGate(s, t.id, Date.now()) !== 'deal') continue;
      const players = t.seats.filter((x): x is string => !!x).map((eid) => s.entries.find((e) => e.id === eid)!);
      const startStacks = Object.fromEntries(players.map((e) => [e.playerId, e.stack]));
      const endStacks = { ...startStacks };
      const winner = players[Math.floor(this.random() * players.length)];
      const knockedOutBy: Record<string, string[]> = {};
      for (const p of players) {
        if (p === winner) continue;
        const r = this.random();
        // Everyone else pays a little; about one in eight goes all in and loses.
        const loss = r < 0.12 ? endStacks[p.playerId] : Math.min(endStacks[p.playerId], Math.floor(endStacks[p.playerId] * r * 0.15));
        endStacks[p.playerId] -= loss;
        endStacks[winner.playerId] += loss;
        if (endStacks[p.playerId] === 0) knockedOutBy[p.playerId] = [winner.playerId];
      }
      const handNumber = t.lastHandNumber + 1;
      const button = t.seats.findIndex((x, i) => x && i > (t.button ?? -1));
      s = apply(s, { type: 'handStarted', tableId: t.id, handNumber }, Date.now()).state;
      s = apply(s, { type: 'handResult', result: { tableId: t.id, handNumber, startStacks, endStacks, knockedOutBy, button: button >= 0 ? button : t.seats.findIndex(Boolean) } }, Date.now()).state;
    }
    this.commit(id, s);
  }

  /** Demo: move the tournament clock forward, as if `ms` had passed. */
  skipAhead(id: string, ms: number) {
    const s = structuredClone(this.states.get(id)!);
    if (s.startAt !== null && (s.status === 'registering' || s.status === 'seating')) s.startAt -= ms;
    if (s.graceUntil !== null) s.graceUntil -= ms;
    if (s.clock.runningSince !== null) s.clock.runningSince -= ms;
    for (const e of s.entries) if (e.rebuyOfferExpiresAt !== undefined) e.rebuyOfferExpiresAt -= ms;
    this.commit(id, tick(s, Date.now()).state);
  }

  remove(id: string) {
    this.states.delete(id);
    this.save();
  }

  list(): TournamentState[] {
    return [...this.states.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  private random() {
    // xorshift; demo only.
    this.rng ^= this.rng << 13;
    this.rng ^= this.rng >>> 17;
    this.rng ^= this.rng << 5;
    return (this.rng >>> 0) / 4294967296;
  }

  private wake() {
    const now = Date.now();
    for (const [id, s] of this.states) {
      const at = nextWakeAt(s);
      if (at !== null && at <= now) this.commit(id, tick(s, now).state);
    }
  }

  private commit(id: string, s: TournamentState) {
    this.states.set(id, s);
    this.save();
    this.emit(id);
  }

  private emit(id: string) {
    const s = this.states.get(id);
    if (s) this.listeners.get(id)?.forEach((cb) => cb({ state: s, serverNow: Date.now() }));
  }

  private save() {
    try {
      storage()?.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(this.states)));
    } catch {
      /* storage full or blocked */
    }
  }
}

let client: TournamentClient | null = null;

/** The client the pages use. Swap in the socket client once the server adapter is on develop. */
export function tournamentClient(): TournamentClient {
  client ??= new LocalTournamentClient();
  return client;
}
