import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { Server, type Socket } from 'socket.io';
import type { Rng } from '@rsdp/engine';
import { ActionError, type PlayerId } from '@rsdp/engine/core';
import { applyAtNextHand, defaultSettings, mergePatches, parseSettings, SettingsError } from '@rsdp/engine/settings';
import type { Ack, ClientToServer, ServerToClient } from '@rsdp/engine/wire';
import type { TournamentClientToServer, TournamentServerToClient } from '@rsdp/tournament';
import { IdentityError } from './identity';
import { TableRuntime } from './runtime/table';
import { systemClock, type Clock, type HandRecord, type PastHand, type RuntimeState } from './runtime/types';
import { cleanName } from './names';
import { avatarImage, avatarToken, cleanAvatar, memoryAvatars, type AvatarStore } from './avatars';
import { GESTURES, type GestureKind } from '@rsdp/engine/wire';
import { cleanNote, memoryNotes, type NotesStore } from './notes';
import { handRecordView, pastHand, tableView } from './runtime/view';
import { TournamentManager, type TournamentStore } from './tournament/manager';
import { memoryTournamentStore } from './tournament/store';

export interface Session {
  playerId: PlayerId;
  displayName: string;
  account: { username: string } | null;
  /** The player's picture as tables show it (see SeatView.avatar). */
  avatar?: string | null;
}

/** Who a browser is. The default derives a player id from the browser secret; the database version adds names and accounts. */
export interface IdentityService {
  resolve(token: string): Promise<Session>;
  rename(playerId: PlayerId, name: string): Promise<void>;
}

/** Where tables and finished hands are kept. The default keeps them in memory. */
export interface TableStore {
  /** A new table, before anything else is saved for it. */
  createTable(state: RuntimeState): Promise<void>;
  saveTable(state: RuntimeState): Promise<void>;
  loadTable(id: string): Promise<RuntimeState | null>;
  saveHand(tableId: string, record: HandRecord): Promise<void>;
  /** Every finished hand saved for a table, oldest first. */
  loadHands(tableId: string): Promise<PastHand[]>;
}

export function memoryIdentity(): IdentityService {
  const names = new Map<PlayerId, string>();
  return {
    async resolve(token) {
      const playerId = createHash('sha256').update(token).digest('base64url').slice(0, 16);
      return { playerId, displayName: names.get(playerId) ?? '', account: null };
    },
    async rename(playerId, name) {
      names.set(playerId, name);
    },
  };
}

export function memoryStore(): TableStore {
  const tables = new Map<string, string>();
  const hands = new Map<string, PastHand[]>();
  const save = async (state: RuntimeState) => {
    tables.set(state.id, JSON.stringify(state));
  };
  return {
    createTable: save,
    saveTable: save,
    async loadTable(id) {
      const json = tables.get(id);
      return json ? (JSON.parse(json) as RuntimeState) : null;
    },
    async saveHand(tableId, record) {
      const list = hands.get(tableId) ?? [];
      hands.set(tableId, [...list.filter((h) => h.handNumber !== record.handNumber), pastHand(record)]);
    },
    async loadHands(tableId) {
      return [...(hands.get(tableId) ?? [])].sort((a, b) => a.handNumber - b.handNumber);
    },
  };
}

export interface AppDeps {
  clock?: Clock;
  identity?: IdentityService;
  store?: TableStore;
  tournaments?: TournamentStore;
  notes?: NotesStore;
  avatars?: AvatarStore;
  /** Deck shuffles; tests pass a seeded one. */
  rng?: Rng;
  /** Built web client to serve (production). */
  webDist?: string | null;
  log?: (message: string, err?: unknown) => void;
}

type C2S = ClientToServer & TournamentClientToServer;
type S2C = ServerToClient & TournamentServerToClient;
type Sock = Socket<C2S, S2C, object, { playerId: PlayerId; session: Session; tableId?: string; tournaments: Set<string>; lastExport?: number }>;

/** Least time between two hand downloads from one browser tab. */
const EXPORT_GAP_MS = 5_000;

const SAVE_DEBOUNCE_MS = 500;
/** Gestures one player may throw per window (across all their tabs), so nobody floods the table. */
const GESTURE_BURST = 4;
const GESTURE_WINDOW_MS = 10_000;
/** Picture changes one player may make per window. */
const AVATAR_BURST = 4;
const AVATAR_WINDOW_MS = 30_000;
const NAME_MAX = 20;

/** Runs a handler and acks the result; expected failures become an error ack, not a crash. */
async function guarded<T extends object>(ack: Ack<T> | undefined, fn: () => T | void | Promise<T | void>, log: AppDeps['log']) {
  try {
    const result = await fn();
    if (typeof ack === 'function') ack({ ok: true, ...(result ?? {}) } as never);
  } catch (err) {
    const expected = err instanceof ActionError || err instanceof SettingsError || err instanceof IdentityError;
    if (!expected) log?.('handler failed', err);
    if (typeof ack === 'function') ack({ ok: false, error: expected && err instanceof Error ? err.message : 'something went wrong' });
  }
}

export function createApp(deps: AppDeps = {}) {
  const clock = deps.clock ?? systemClock;
  const identity = deps.identity ?? memoryIdentity();
  const store = deps.store ?? memoryStore();
  const notes = deps.notes ?? memoryNotes();
  const avatarStore = deps.avatars ?? memoryAvatars();
  const log = deps.log ?? ((m, e) => console.error(m, e ?? ''));

  const app = express();
  const http = createServer(app);
  const io = new Server<C2S, S2C>(http, {
    cors: process.env.NODE_ENV === 'production' ? undefined : { origin: true },
  });

  const tables = new Map<string, TableRuntime>();
  const watchers = new Map<string, Set<Sock>>();
  const tournamentWatchers = new Map<string, Set<Sock>>();
  const playerSockets = new Map<PlayerId, Set<Sock>>();
  const pendingBroadcast = new Set<string>();
  const saveTimers = new Map<string, NodeJS.Timeout>();
  /** Saves wait for the table's row to exist. */
  const created = new Map<string, Promise<void>>();
  /** Pictures of players seen since the server started, as tables show them. */
  const avatars = new Map<PlayerId, string | null>();
  const avatarOf = (playerId: PlayerId) => avatars.get(playerId) ?? null;
  const gestureTimes = new Map<PlayerId, number[]>();
  const avatarChanges = new Map<PlayerId, number[]>();
  /** Loads the pictures of seated players the server has not seen yet (after a restart), then shows them. */
  function loadAvatars(rt: TableRuntime) {
    const missing = rt.state.seats.filter((x) => x && !avatars.has(x.playerId)).map((x) => x!.playerId);
    if (!missing.length) return;
    for (const id of missing) avatars.set(id, null);
    // A failed lookup is forgotten, so the next view tries again.
    Promise.all(missing.map((id) => avatarStore.get(id).then((a) => avatars.set(id, avatarToken(a)), (e) => (avatars.delete(id), Promise.reject(e)))))
      .then(() => broadcast(rt))
      .catch((e) => log('loading avatars failed', e));
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, tables: tables.size });
  });
  // Uploaded pictures. Tables name them with a version, so a new upload is a new URL and old ones can be cached for good.
  app.get('/api/avatars/:playerId', (req, res) => {
    avatarStore
      .get(String(req.params.playerId))
      .then((a) => {
        const img = avatarImage(a);
        if (!img) return void res.status(404).end();
        res.set({ 'Content-Type': img.type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
        res.send(img.data);
      })
      .catch((e) => {
        log('loading an avatar failed', e);
        res.status(500).end();
      });
  });
  if (deps.webDist && existsSync(deps.webDist)) {
    const dist = deps.webDist;
    app.use(express.static(dist));
    // Client-side routes (/t/:id, /tn/:id, ...) all load the app.
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  function broadcast(rt: TableRuntime) {
    const id = rt.state.id;
    if (pendingBroadcast.has(id)) return;
    pendingBroadcast.add(id);
    queueMicrotask(() => {
      pendingBroadcast.delete(id);
      const now = clock.now();
      const tournamentId = tournaments.tournamentOf(id);
      const people = audience(id);
      loadAvatars(rt);
      for (const s of watchers.get(id) ?? []) s.emit('table:state', tableView(rt, s.data.playerId, now, tournamentId, people, avatarOf));
    });
  }

  /** Everyone with a table open, once each, by the name they go by. */
  function audience(id: string) {
    const seen = new Map<PlayerId, string>();
    for (const s of watchers.get(id) ?? []) if (!seen.has(s.data.playerId)) seen.set(s.data.playerId, s.data.session.displayName || 'Guest');
    return [...seen].map(([playerId, name]) => ({ playerId, name }));
  }

  function scheduleSave(rt: TableRuntime) {
    const id = rt.state.id;
    if (saveTimers.has(id)) return;
    saveTimers.set(
      id,
      setTimeout(() => {
        saveTimers.delete(id);
        (created.get(id) ?? Promise.resolve())
          .then(() => store.saveTable(rt.state))
          .catch((e) => log(`saving table ${id} failed`, e));
      }, SAVE_DEBOUNCE_MS),
    );
  }

  function attach(rt: TableRuntime, ready: Promise<void> = Promise.resolve()) {
    const id = rt.state.id;
    tables.set(id, rt);
    created.set(id, ready);
    rt.onChange = () => {
      broadcast(rt);
      scheduleSave(rt);
    };
    rt.onHandFinished = (record) => {
      (created.get(id) ?? Promise.resolve())
        .then(() => store.saveHand(id, record))
        .catch((e) => log(`saving hand ${record.handNumber} failed`, e));
    };
    return rt;
  }

  const tournaments = new TournamentManager({
    clock,
    rng: deps.rng,
    store: deps.tournaments ?? memoryTournamentStore(),
    tables: {
      createTable: (state) => store.createTable(state),
      loadTable: (id) => store.loadTable(id),
      attach: (rt, _tournamentId, ready) => {
        attach(rt, ready);
      },
      detach: (rt) => {
        tables.delete(rt.state.id);
        // Save the final state so the table's history stays readable.
        store.saveTable(rt.state).catch(() => {});
        broadcast(rt);
      },
    },
    onState: (id) => {
      for (const s of tournamentWatchers.get(id) ?? []) {
        const view = tournaments.view(id, s.data.playerId);
        if (view) s.emit('tournament:state', { id, view });
      }
    },
    onMoved: (playerId, from, to) => {
      for (const s of playerSockets.get(playerId) ?? []) s.emit('table:moved', { from, to });
    },
    log,
  });

  async function getTable(id: string): Promise<TableRuntime | null> {
    const live = tables.get(id);
    if (live) return live;
    // Tournament tables come back with their tournament, which gives them their clock and seats.
    if (await tournaments.loadTableOwner(id)) return tables.get(id) ?? null;
    const saved = await store.loadTable(id);
    if (!saved || saved.settings.table.mode === 'tournament') return null;
    // Another join may have loaded it while we waited.
    if (tables.has(id)) return tables.get(id)!;
    const rt = attach(new TableRuntime(saved, { clock, rng: deps.rng, log }));
    rt.resume();
    return rt;
  }

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) return next(new Error('missing token'));
    try {
      const who = await identity.resolve(token);
      if (!avatars.has(who.playerId)) {
        // A database hiccup shows no picture for now and tries again on the next connect.
        const saved = await avatarStore.get(who.playerId).then(avatarToken, () => undefined);
        if (saved !== undefined) avatars.set(who.playerId, saved);
      }
      socket.data.playerId = who.playerId;
      socket.data.session = { ...who, avatar: avatars.get(who.playerId) ?? null };
      socket.data.tournaments = new Set();
      next();
    } catch (e) {
      next(e instanceof Error ? e : new Error('sign-in failed'));
    }
  });

  io.on('connection', (raw) => {
    const socket = raw as Sock;
    const me = socket.data.playerId;
    socket.emit('session', socket.data.session);
    if (!playerSockets.has(me)) playerSockets.set(me, new Set());
    playerSockets.get(me)!.add(socket);

    const current = () => {
      const rt = socket.data.tableId ? tables.get(socket.data.tableId) : undefined;
      if (!rt) throw new ActionError('join a table first');
      return rt;
    };
    const leave = () => {
      const id = socket.data.tableId;
      if (!id) return;
      watchers.get(id)?.delete(socket);
      tables.get(id)?.disconnect(me);
      socket.data.tableId = undefined;
    };
    /** Remembers a name for every tab of this player. */
    const rename = async (value: unknown) => {
      const name = cleanName(value, NAME_MAX);
      if (!name) throw new ActionError('pick a name');
      if (name === socket.data.session.displayName) return;
      await identity.rename(me, name);
      for (const s of playerSockets.get(me) ?? []) {
        s.data.session = { ...s.data.session, displayName: name };
        s.emit('session', s.data.session);
        // Watchers are listed by this name.
        const rt = s.data.tableId ? tables.get(s.data.tableId) : undefined;
        if (rt) broadcast(rt);
      }
    };
    const on = <K extends keyof C2S>(event: K, handler: C2S[K]) => socket.on(event, handler as never);

    on('session:name', (input, ack) => guarded(ack, () => rename(input?.name), log));

    on('table:create', (input, ack) =>
      guarded(
        ack,
        async () => {
          const patch = input?.settings ?? {};
          // Tables made here are cash tables; tournaments make their own.
          const base = defaultSettings('cash');
          const settings = parseSettings(applyAtNextHand(base, mergePatches(patch, { table: { mode: 'cash' } })).settings);
          const rt = TableRuntime.create({ hostId: me, settings }, { clock, rng: deps.rng, log });
          await store.createTable(rt.state);
          attach(rt);
          return { tableId: rt.state.id };
        },
        log,
      ),
    );

    on('table:join', ({ tableId } = { tableId: '' }, ack) =>
      guarded(
        ack,
        async () => {
          const rt = await getTable(String(tableId));
          if (!rt) throw new ActionError('table not found');
          if (socket.data.tableId !== rt.state.id) {
            leave();
            socket.data.tableId = rt.state.id;
            if (!watchers.has(rt.state.id)) watchers.set(rt.state.id, new Set());
            watchers.get(rt.state.id)!.add(socket);
            rt.connect(me);
          }
          loadAvatars(rt);
          socket.emit('table:state', tableView(rt, me, clock.now(), tournaments.tournamentOf(rt.state.id), audience(rt.state.id), avatarOf));
        },
        log,
      ),
    );
    on('table:leave', () => leave());
    on('table:history', ({ handNumber }, ack) =>
      guarded(
        ack,
        () => {
          const rt = current();
          const record = rt.state.history.find((h) => h.handNumber === Number(handNumber));
          if (!record) throw new ActionError('that hand is no longer available');
          return { hand: handRecordView(rt, record, me) };
        },
        log,
      ),
    );

    on('table:export', (ack) =>
      guarded(
        ack,
        async () => {
          const rt = current();
          // Each download reads every hand of the table, so one per socket every few seconds.
          const now = clock.now();
          if (now - (socket.data.lastExport ?? 0) < EXPORT_GAP_MS) throw new ActionError('one download every few seconds, please');
          socket.data.lastExport = now;
          // Saved hands, with the copies still in memory winning: they include cards shown after the hand.
          const saved = await store.loadHands(rt.state.id);
          const byNumber = new Map(saved.map((h) => [h.handNumber, h]));
          for (const h of rt.state.history) byNumber.set(h.handNumber, pastHand(h));
          const all = [...byNumber.values()].sort((a, b) => a.handNumber - b.handNumber);
          return { hands: all.map((h) => handRecordView(rt, h, me)) };
        },
        log,
      ),
    );

    on('seat:request', (input, ack) =>
      guarded(
        ack,
        async () => {
          current().requestSeat(me, { seat: Number(input?.seat), name: String(input?.name ?? ''), stack: Number(input?.stack) });
          // The name you sit with is the name you register for tournaments with.
          if (!socket.data.session.displayName) await rename(input?.name).catch(() => {});
        },
        log,
      ),
    );
    on('seat:cancel', () => guarded(undefined, () => current().cancelRequest(me), log));
    on('seat:stand', (input) => guarded(undefined, () => current().stand(me, { afterHand: !!input?.afterHand }), log));
    on('seat:sitOut', ({ value }, ack) => guarded(ack, () => current().sitOut(me, !!value), log));
    on('seat:prefs', (prefs, ack) => guarded(ack, () => current().setPreferences(me, prefs ?? {}), log));
    on('seat:rebuy', ({ amount }, ack) => guarded(ack, () => current().rebuy(me, Number(amount)), log));

    on('hand:act', (action, ack) => guarded(ack, () => current().act(me, sanitizeAction(action)), log));
    on('hand:draw', ({ discard }, ack) => guarded(ack, () => current().draw(me, toIndexes(discard)), log));
    on('hand:runItTwice', ({ yes }, ack) => guarded(ack, () => current().voteRunItTwice(me, !!yes), log));
    on('hand:show', ({ cards }, ack) => guarded(ack, () => current().show(me, toIndexes(cards)), log));
    on('hand:timeBank', (ack) => guarded(ack, () => current().useTimeBank(me), log));
    on('hand:rabbit', (ack) => guarded(ack, () => current().rabbitHunt(me), log));
    on('notes:list', (ack) => guarded(ack, async () => ({ notes: await notes.list(me) }), log));
    on('notes:set', (input, ack) =>
      guarded(
        ack,
        async () => {
          const note = await notes.set(me, cleanNote(input));
          // Every tab of mine gets the new list; nobody else ever sees it.
          const all = await notes.list(me);
          for (const s of playerSockets.get(me) ?? []) s.emit('notes', all);
          return { note };
        },
        log,
      ),
    );
    on('chat:send', ({ text }) => guarded(undefined, () => current().chat(me, String(text ?? '')), log));
    on('table:gesture', (input, ack) =>
      guarded(
        ack,
        () => {
          const rt = current();
          const kind = String(input?.kind ?? '') as GestureKind;
          if (!GESTURES.includes(kind)) throw new ActionError('unknown gesture');
          const to = String(input?.to ?? '');
          rt.checkGesture(me, to);
          const now = clock.now();
          const recent = (gestureTimes.get(me) ?? []).filter((t) => now - t < GESTURE_WINDOW_MS);
          if (recent.length >= GESTURE_BURST) throw new ActionError('easy there: a few seconds between gestures');
          gestureTimes.set(me, [...recent, now]);
          for (const s of watchers.get(rt.state.id) ?? []) s.emit('table:gesture', { from: me, to, kind, at: now });
        },
        log,
      ),
    );
    on('avatar:set', (input, ack) =>
      guarded(
        ack,
        async () => {
          const next = cleanAvatar(input);
          const now = clock.now();
          const recent = (avatarChanges.get(me) ?? []).filter((t) => now - t < AVATAR_WINDOW_MS);
          if (recent.length >= AVATAR_BURST) throw new ActionError('too many picture changes; try again in a moment');
          avatarChanges.set(me, [...recent, now]);
          const saved = await avatarStore.set(me, next);
          const avatar = avatarToken(saved);
          avatars.set(me, avatar);
          // Every tab of mine learns it, and every table I'm at shows it.
          const shown = new Set<string>();
          for (const s of playerSockets.get(me) ?? []) {
            s.data.session = { ...s.data.session, avatar };
            s.emit('session', s.data.session);
            if (s.data.tableId) shown.add(s.data.tableId);
          }
          for (const rt of tables.values()) if (rt.seatOf(me)) shown.add(rt.state.id);
          for (const id of shown) {
            const rt = tables.get(id);
            if (rt) broadcast(rt);
          }
          return { avatar };
        },
        log,
      ),
    );

    on('host:approve', ({ requestId }, ack) => guarded(ack, () => current().approve(me, String(requestId)), log));
    on('host:reject', ({ requestId }) => guarded(undefined, () => current().reject(me, String(requestId)), log));
    on('host:start', (ack) => guarded(ack, () => current().start(me), log));
    on('host:stop', (ack) => guarded(ack, () => current().stop(me), log));
    on('host:deal', (ack) => guarded(ack, () => current().dealNext(me), log));
    on('host:pause', ({ value }, ack) => guarded(ack, () => current().pause(me, !!value), log));
    on('host:bombPot', ({ value }, ack) => guarded(ack, () => current().requestBombPot(me, !!value), log));
    on('host:settings', ({ patch }, ack) => guarded(ack, () => current().updateSettings(me, patch ?? {}), log));
    on('host:setStack', ({ playerId, stack }, ack) => guarded(ack, () => current().setStack(me, String(playerId), Number(stack)), log));
    on('host:kick', ({ playerId }, ack) => guarded(ack, () => current().kick(me, String(playerId)), log));
    on('host:sitOut', ({ playerId }, ack) => guarded(ack, () => current().hostSitOut(me, String(playerId)), log));
    on('host:transfer', ({ playerId }, ack) => guarded(ack, () => current().transferHost(me, String(playerId)), log));

    on('tournament:create', (input, ack) => guarded(ack, async () => ({ id: await tournaments.create(me, input?.settings) }), log));
    on('tournament:subscribe', (input, ack) =>
      guarded(
        ack,
        async () => {
          const id = String(input?.id ?? '');
          if (!(await tournaments.get(id))) throw new ActionError('tournament not found');
          if (!tournamentWatchers.has(id)) tournamentWatchers.set(id, new Set());
          tournamentWatchers.get(id)!.add(socket);
          socket.data.tournaments.add(id);
          socket.emit('tournament:state', { id, view: tournaments.view(id, me)! });
        },
        log,
      ),
    );
    on('tournament:unsubscribe', (input) => {
      const id = String(input?.id ?? '');
      tournamentWatchers.get(id)?.delete(socket);
      socket.data.tournaments.delete(id);
    });
    on('tournament:list', (ack) => guarded(ack, async () => ({ tournaments: await tournaments.list(me), serverNow: clock.now() }), log));
    on('tournament:command', (input, ack) =>
      guarded(ack, () => tournaments.command(String(input?.id ?? ''), me, socket.data.session.displayName, input?.command), log),
    );

    socket.on('disconnect', () => {
      leave();
      for (const id of socket.data.tournaments) tournamentWatchers.get(id)?.delete(socket);
      playerSockets.get(me)?.delete(socket);
      if (!playerSockets.get(me)?.size) {
        playerSockets.delete(me);
        gestureTimes.delete(me);
        avatarChanges.delete(me);
      }
    });
  });

  return {
    app,
    http,
    io,
    tables,
    tournaments,
    getTable,
    /** Brings back unfinished tournaments (and their tables) after a restart. */
    resume: () => tournaments.resumeAll(),
    async close() {
      // Everything goes quiet before anything is saved, so tournaments and their tables are saved as of the same moment:
      // no more input, the director acts on every hand already reported, and no table deals, runs a clock or saves again.
      // The server going down is not players leaving, so their tables never see them drop (and time them out).
      for (const s of io.of('/').sockets.values()) s.removeAllListeners('disconnect');
      io.close();
      tournaments.dispose();
      const open = [...tables.values()];
      for (const rt of open) rt.dispose();
      for (const t of saveTimers.values()) clearTimeout(t);
      saveTimers.clear();
      await tournaments.flush();
      await Promise.all(open.map((rt) => (created.get(rt.state.id) ?? Promise.resolve()).then(() => store.saveTable(rt.state)).catch(() => {})));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function toIndexes(value: unknown): number[] {
  if (!Array.isArray(value)) throw new ActionError('pick some cards');
  return value.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 0 && v < 10);
}

function sanitizeAction(action: unknown) {
  const a = (action ?? {}) as { type?: unknown; to?: unknown };
  switch (a.type) {
    case 'fold':
    case 'check':
    case 'call':
    case 'bring-in':
      return { type: a.type } as const;
    case 'bet':
    case 'raise':
      return { type: a.type, to: Number(a.to) } as const;
    default:
      throw new ActionError('unknown action');
  }
}
