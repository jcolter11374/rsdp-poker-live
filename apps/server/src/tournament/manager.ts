import { randomBytes } from 'node:crypto';
import { cryptoRng, type Rng } from '@rsdp/engine';
import { ActionError, variants, type PlayerId } from '@rsdp/engine/core';
import { applyAtNextHand, defaultSettings, parseSettings } from '@rsdp/engine/settings';
import {
  apply,
  createTournament,
  DirectorError,
  levelFor,
  nextWakeAt,
  tableAddress,
  tableGate,
  tick,
  type Command,
  type DirectorEvent,
  type Result,
  type SeatInfo,
  type TableId,
  type TournamentSettings,
  type TournamentState,
  type TournamentView,
} from '@rsdp/tournament';
import { cleanName as cleanDisplayName } from '../names';
import { TableRuntime } from '../runtime/table';
import type { Clock, RuntimeState, TournamentHooks } from '../runtime/types';

/** Where tournament director state is kept. */
export interface TournamentStore {
  save(state: TournamentState, nextId: string | null): Promise<void>;
  load(id: string): Promise<{ state: TournamentState; nextId: string | null } | null>;
  /** Tournaments that are not finished or cancelled, to resume after a restart. */
  listLive(): Promise<{ state: TournamentState; nextId: string | null }[]>;
}

/** The server side of the tables a tournament runs: storage, broadcasting and links. */
export interface TableHost {
  /** Saves a new table before anything else is saved for it. */
  createTable(state: RuntimeState): Promise<void>;
  loadTable(id: string): Promise<RuntimeState | null>;
  /** Starts sending views and saving snapshots for a table. */
  attach(rt: TableRuntime, tournamentId: string, created: Promise<void>): void;
  detach(rt: TableRuntime): void;
}

export interface ManagerDeps {
  clock: Clock;
  store: TournamentStore;
  tables: TableHost;
  /** Push a fresh view to everyone watching this tournament. */
  onState: (id: string) => void;
  /** A player was moved to another table (or seated late). `from` is '' when they had no table. */
  onMoved: (playerId: PlayerId, from: string, to: string) => void;
  log: (message: string, err?: unknown) => void;
  rng?: Rng;
}

interface Live {
  state: TournamentState;
  nextId: string | null;
  /** Runtimes by director table id. */
  tables: Map<TableId, TableRuntime>;
  timer: unknown;
  saveTimer: unknown;
  /** Director events are being applied to the tables: none may deal until they all have been. */
  applying: boolean;
  /** Events from a hand start, waiting for that table to finish its step. */
  deferred: DirectorEvent[];
}

/** Commands only the host may send; the director trusts the server to check. */
const HOST_COMMANDS = new Set<Command['type']>(['approve', 'reject', 'remove', 'pause', 'resume', 'startNow', 'editStructure', 'updateSettings', 'end']);
/** Commands that come from tables, never from a browser. */
const TABLE_COMMANDS = new Set<Command['type']>(['handStarted', 'handResult']);
const SAVE_DEBOUNCE_MS = 300;
/** Long sleeps are re-armed in steps, so a far-off scheduled start never overflows a timer. */
const MAX_SLEEP_MS = 60 * 60 * 1000;
const NAME_MAX = 20;

const newTournamentId = () => randomBytes(4).toString('hex');

/** Seconds between tournament hands; keeps director updates ahead of the next deal. */
const TOURNAMENT_NEXT_HAND_SECONDS = 2;

/**
 * Runs tournament directors on the server: applies commands, wakes the
 * director on its schedule (scheduled starts need nobody to press start),
 * and turns its events into table runtimes, seats, moves and eliminations.
 */
export class TournamentManager {
  private readonly live = new Map<string, Live>();
  /** Runtime table id -> tournament id. */
  private readonly tableOwners = new Map<string, string>();
  private readonly clock: Clock;

  constructor(private readonly deps: ManagerDeps) {
    this.clock = deps.clock;
  }

  /** Loads every unfinished tournament and its tables, and re-arms their clocks. */
  async resumeAll() {
    for (const saved of await this.deps.store.listLive()) {
      if (this.live.has(saved.state.id)) continue;
      try {
        await this.adopt(saved.state, saved.nextId);
      } catch (e) {
        this.deps.log(`resuming tournament ${saved.state.id} failed`, e);
      }
    }
  }

  async create(hostId: PlayerId, settings: TournamentSettings): Promise<string> {
    checkGames(settings);
    const id = newTournamentId();
    const state = this.guard(() =>
      createTournament({ id, hostId, settings, now: this.clock.now(), seed: randomBytes(4).readUInt32LE(0) }),
    );
    await this.deps.store.save(state, null);
    await this.adopt(state, null);
    return id;
  }

  /** The tournament, loading it from storage if this server has not got it yet. */
  async get(id: string): Promise<Live | null> {
    const live = this.live.get(id);
    if (live) return live;
    const saved = await this.deps.store.load(id);
    if (!saved) return null;
    return this.live.get(id) ?? this.adopt(saved.state, saved.nextId);
  }

  /** What a browser is sent. The seating seed stays on the server. */
  view(id: string): TournamentView | null {
    const live = this.live.get(id);
    if (!live) return null;
    return { state: { ...live.state, rng: 0 }, serverNow: this.clock.now(), nextId: live.nextId };
  }

  /** A browser's command, with who is acting filled in from the connection. */
  async command(id: string, me: PlayerId, myName: string, raw: Command) {
    const live = await this.get(id);
    if (!live) throw new ActionError('tournament not found');
    const command = this.fromBrowser(live, me, myName, raw);
    this.dispatch(live, (s, now) => apply(s, command, now));
  }

  /** The tournament a runtime table belongs to (by its runtime id), if any. */
  tournamentOf(tableId: string) {
    return this.tableOwners.get(tableId) ?? null;
  }

  /** Runtime table ids look like `<tournament>-t<n>`; loads the tournament that owns one. */
  async loadTableOwner(tableId: string) {
    const m = /^([0-9a-f]+)-t\d+$/.exec(tableId);
    if (!m) return null;
    await this.get(m[1]);
    return this.tableOwners.get(tableId) ?? null;
  }

  dispose() {
    for (const live of this.live.values()) {
      this.clock.clearTimeout(live.timer);
      this.clock.clearTimeout(live.saveTimer);
    }
  }

  /** Saves every tournament now (shutdown). */
  async flush() {
    await Promise.all([...this.live.values()].map((l) => this.deps.store.save(l.state, l.nextId).catch(() => {})));
  }

  // ---------------------------------------------------------------- internals

  private fromBrowser(live: Live, me: PlayerId, myName: string, cmd: Command): Command {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') throw new ActionError('unknown command');
    if (TABLE_COMMANDS.has(cmd.type)) throw new ActionError('unknown command');
    if (HOST_COMMANDS.has(cmd.type)) {
      if (me !== live.state.hostId) throw new ActionError('only the host can do that');
      // The director checks the shape; the games must also be ones this server can deal.
      if (cmd.type === 'editStructure') checkGames({ ...live.state.settings, structure: cmd.structure });
      if (cmd.type === 'updateSettings') checkGames({ ...live.state.settings, ...cmd.settings });
      return { ...cmd, by: me } as Command;
    }
    switch (cmd.type) {
      case 'register': {
        const displayName = cleanName(myName || ('displayName' in cmd ? String(cmd.displayName ?? '') : ''));
        if (!displayName) throw new ActionError('pick a name first');
        return { type: 'register', playerId: me, displayName };
      }
      case 'unregister':
      case 'rebuy':
      case 'declineRebuy':
      case 'addOn':
      case 'reEnter':
      case 'quit':
        return { type: cmd.type, playerId: me };
      default:
        throw new ActionError('unknown command');
    }
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof DirectorError) throw new ActionError(e.message);
      if (e instanceof ActionError) throw e;
      if (e instanceof TypeError) throw new ActionError('those tournament settings are incomplete');
      throw e;
    }
  }

  /** Runs one director step, then acts on its events. Throws ActionError when the director refuses. */
  private dispatch(live: Live, step: (s: TournamentState, now: number) => Result) {
    const result = this.guard(() => step(live.state, this.clock.now()));
    live.state = result.state;
    this.handle(live, result.events);
    this.changed(live);
  }

  /** For calls from tables and timers, where there is nobody to tell about a refusal. */
  private dispatchQuietly(live: Live, step: (s: TournamentState, now: number) => Result, what: string) {
    try {
      this.dispatch(live, step);
    } catch (e) {
      this.deps.log(`tournament ${live.state.id}: ${what} failed`, e);
    }
  }

  private changed(live: Live) {
    this.arm(live);
    this.scheduleSave(live);
    this.deps.onState(live.state.id);
  }

  private scheduleSave(live: Live) {
    if (live.saveTimer) return;
    live.saveTimer = this.clock.setTimeout(() => {
      live.saveTimer = null;
      this.deps.store.save(live.state, live.nextId).catch((e) => this.deps.log(`saving tournament ${live.state.id} failed`, e));
    }, SAVE_DEBOUNCE_MS);
  }

  /** Wakes the director when it next needs to act: start, seating, level changes, offer expiries. */
  private arm(live: Live) {
    this.clock.clearTimeout(live.timer);
    live.timer = null;
    const at = nextWakeAt(live.state);
    if (at === null) return;
    // A setting that is not a number would make a timer that fires at once and re-arms forever.
    if (!Number.isFinite(at)) {
      this.deps.log(`tournament ${live.state.id}: next wake time is ${at}, so its clock is not armed`);
      return;
    }
    const wait = Math.min(Math.max(0, at - this.clock.now()), MAX_SLEEP_MS);
    live.timer = this.clock.setTimeout(() => {
      live.timer = null;
      if (this.clock.now() >= at) this.dispatchQuietly(live, (s, now) => tick(s, now), 'tick');
      else this.arm(live);
    }, wait);
  }

  /** Takes a tournament into memory: its tables come back from their snapshots. */
  private async adopt(state: TournamentState, nextId: string | null): Promise<Live> {
    // Every snapshot loads before anything is mounted, so a failed load leaves nothing half-built to be found later.
    const snapshots = await Promise.all(state.tables.map((t) => this.deps.tables.loadTable(tableAddress(t.id))));
    const already = this.live.get(state.id);
    if (already) return already;
    const live: Live = { state, nextId, tables: new Map(), timer: null, saveTimer: null, applying: false, deferred: [] };
    try {
      state.tables.forEach((t, i) => {
        const saved = snapshots[i];
        if (saved) this.mount(live, t.id, new TableRuntime(saved, this.runtimeDeps(live, t.id)), Promise.resolve());
        else {
          // No snapshot yet (the server stopped right after seating): rebuild the seats from the director.
          const seats = t.seats.flatMap((entryId, seat) => {
            const e = entryId ? state.entries.find((x) => x.id === entryId) : undefined;
            return e ? [{ tableId: t.id, seat, entryId: e.id, playerId: e.playerId, displayName: e.displayName, stack: e.stack }] : [];
          });
          this.openTable(live, t.id, seats);
        }
      });
    } catch (e) {
      for (const rt of live.tables.values()) this.unmount(rt);
      throw e;
    }
    this.live.set(state.id, live);
    for (const [tableId, rt] of live.tables) {
      try {
        rt.resume();
      } catch (e) {
        this.deps.log(`tournament ${state.id}: resuming table ${tableId} failed`, e);
      }
    }
    // Catch up on anything that came due while the server was down.
    const at = nextWakeAt(live.state);
    if (at !== null && at <= this.clock.now()) this.dispatchQuietly(live, (s, now) => tick(s, now), 'catch-up tick');
    else this.arm(live);
    return live;
  }

  private runtimeDeps(live: Live, tableId: TableId) {
    return { clock: this.clock, rng: this.deps.rng ?? cryptoRng, tournament: this.hooks(live, tableId) };
  }

  /** What a tournament table asks of the director. Acting on its reports waits for a 0 ms timer, so the table finishes its own step first. */
  private hooks(live: Live, tableId: TableId): TournamentHooks {
    const later = (what: string, step: (s: TournamentState, now: number) => Result) =>
      this.clock.setTimeout(() => this.dispatchQuietly(live, step, what), 0);
    return {
      // Tables hold while the director's events are still reaching them, so nobody is dealt in at a seat they are leaving.
      gate: (now) => (live.applying || live.deferred.length ? 'hold' : tableGate(live.state, tableId, now)),
      level: () => {
        const l = levelFor(live.state, tableId);
        return {
          gameId: l.gameId,
          stakes: { smallBlind: l.sb, bigBlind: l.bb, ante: l.ante, anteType: l.anteType, bringIn: l.bringIn, smallBet: l.smallBet, bigBet: l.bigBet },
        };
      },
      handStarted: (handNumber) => {
        // The director hears of the deal at once, so no command in the meantime moves a player out of this hand.
        try {
          const result = this.guard(() => apply(live.state, { type: 'handStarted', tableId, handNumber }, this.clock.now()));
          live.state = result.state;
          live.deferred.push(...result.events);
        } catch (e) {
          this.deps.log(`tournament ${live.state.id}: hand start failed`, e);
        }
        this.clock.setTimeout(() => {
          this.handle(live, []);
          this.changed(live);
        }, 0);
      },
      handEnded: (r) => later('hand result', (s, now) => apply(s, { type: 'handResult', result: { ...r, tableId } }, now)),
    };
  }

  private mount(live: Live, tableId: TableId, rt: TableRuntime, created: Promise<void>) {
    live.tables.set(tableId, rt);
    this.tableOwners.set(rt.state.id, live.state.id);
    this.deps.tables.attach(rt, live.state.id, created);
  }

  private unmount(rt: TableRuntime) {
    this.tableOwners.delete(rt.state.id);
    this.deps.tables.detach(rt);
    rt.dispose();
  }

  private openTable(live: Live, tableId: TableId, seats: SeatInfo[]) {
    const s = live.state;
    const number = s.tables.findIndex((t) => t.id === tableId) + 1;
    const base = defaultSettings('tournament');
    const settings = parseSettings(
      applyAtNextHand(base, {
        table: { name: `${s.settings.name.slice(0, 28)} · Table ${number}`, maxSeats: s.settings.seatsPerTable },
        timing: { nextHandDelaySeconds: Math.max(base.timing.nextHandDelaySeconds, TOURNAMENT_NEXT_HAND_SECONDS) },
      }).settings,
    );
    const rt = TableRuntime.create({ id: tableAddress(tableId), hostId: s.hostId, settings }, this.runtimeDeps(live, tableId));
    // Seat everyone before the table may deal, so the first hand has them all.
    for (const seat of seats) rt.placePlayer({ seat: seat.seat, playerId: seat.playerId, name: seat.displayName, stack: seat.stack });
    rt.state.started = true;
    const created = this.deps.tables.createTable(rt.state).catch((e) => this.deps.log(`creating table ${rt.state.id} failed`, e));
    this.mount(live, tableId, rt, created);
    return rt;
  }

  private table(live: Live, tableId: TableId | null) {
    return tableId ? live.tables.get(tableId) : undefined;
  }

  private handle(live: Live, events: DirectorEvent[]) {
    // Events a hand start left waiting came from an earlier state, so they go first.
    const all = [...live.deferred.splice(0), ...events];
    live.applying = true;
    try {
      for (const e of all) {
        try {
          this.handleOne(live, e);
        } catch (err) {
          this.deps.log(`tournament ${live.state.id}: handling ${e.type} failed`, err);
        }
      }
    } finally {
      live.applying = false;
    }
    // Starts, levels, breaks, rebuys and moves all change which tables may deal.
    for (const [tableId, rt] of live.tables) {
      try {
        rt.poke();
      } catch (err) {
        this.deps.log(`tournament ${live.state.id}: dealing at table ${tableId} failed`, err);
      }
    }
  }

  private handleOne(live: Live, e: DirectorEvent) {
    const name = (playerId: PlayerId) => live.state.entries.find((x) => x.playerId === playerId)?.displayName ?? 'Player';
    switch (e.type) {
      case 'tablesCreated':
        for (const t of e.tables) {
          const rt = this.openTable(live, t.tableId, t.seats);
          // The draw: send everyone to their table.
          for (const seat of t.seats) this.deps.onMoved(seat.playerId, '', rt.state.id);
        }
        break;
      case 'tableOpened':
        if (!live.tables.has(e.tableId)) this.openTable(live, e.tableId, []);
        break;
      case 'seatPlayer': {
        const rt = this.table(live, e.seat.tableId) ?? this.openTable(live, e.seat.tableId, []);
        rt.placePlayer({ seat: e.seat.seat, playerId: e.seat.playerId, name: e.seat.displayName, stack: e.seat.stack });
        this.deps.onMoved(e.seat.playerId, '', rt.state.id);
        break;
      }
      case 'moveSeat': {
        const from = this.table(live, e.from.tableId);
        const to = this.table(live, e.to.tableId) ?? this.openTable(live, e.to.tableId, []);
        from?.unseatPlayer(e.playerId);
        to.placePlayer({ seat: e.to.seat, playerId: e.playerId, name: name(e.playerId), stack: e.stack });
        this.deps.onMoved(e.playerId, tableAddress(e.from.tableId), to.state.id);
        break;
      }
      case 'tableBroken': {
        const rt = this.table(live, e.tableId);
        if (rt) {
          live.tables.delete(e.tableId);
          this.deps.tables.detach(rt);
          rt.dispose();
        }
        break;
      }
      case 'stackAdded':
        this.table(live, e.tableId)?.tournamentChips(e.playerId, e.chips);
        break;
      case 'eliminated':
        this.table(live, e.tableId)?.unseatPlayer(e.playerId);
        break;
      case 'scheduleNext':
        this.spawn(live, { ...live.state.settings, start: { ...live.state.settings.start, startAt: e.startAt } as TournamentSettings['start'] });
        break;
      case 'spawnNext':
        this.spawn(live, live.state.settings);
        break;
      default:
        break;
    }
  }

  /** The next event of a series, or a fresh Sit & Go. */
  private spawn(live: Live, settings: TournamentSettings) {
    const hostId = live.state.hostId;
    this.create(hostId, settings)
      .then((id) => {
        live.nextId = id;
        this.changed(live);
      })
      .catch((e) => this.deps.log(`tournament ${live.state.id}: creating the next one failed`, e));
  }
}

/** Every game must exist and seat a full table. */
function checkGames(settings: TournamentSettings) {
  if (!settings || !Array.isArray(settings.games) || !Array.isArray(settings.structure)) throw new ActionError('those tournament settings are incomplete');
  // Any other value would pick a rotation game that is not in the list.
  const stop = settings.stopRotationAtLevel;
  if (stop != null && !(Number.isInteger(stop) && stop >= 1)) throw new ActionError('the rotation must stop at a whole level number');
  // A level's game is only skipped when it is left out: an empty one is still a game nobody can deal.
  const ids = new Set([...settings.games, ...settings.structure.flatMap((r) => (r?.kind === 'level' && r.gameId !== undefined ? [r.gameId] : []))]);
  for (const id of ids) {
    let spec;
    try {
      spec = variants.get(id).spec;
    } catch {
      throw new ActionError(`unknown game ${id}`);
    }
    if (settings.seatsPerTable > spec.maxPlayers) throw new ActionError(`${spec.name} seats at most ${spec.maxPlayers} per table`);
  }
}

function cleanName(name: string) {
  return cleanDisplayName(name, NAME_MAX);
}
