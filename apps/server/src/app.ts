import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { Server, type Socket } from 'socket.io';
import { ActionError, type PlayerId } from '@rsdp/engine/core';
import { defaultSettings, mergePatches, parseSettings, SettingsError, applyAtNextHand } from '@rsdp/engine/settings';
import type { Ack, ClientToServer, ServerToClient } from '@rsdp/engine/wire';
import { IdentityError } from './identity';
import { TableRuntime } from './runtime/table';
import { systemClock, type Clock, type HandRecord, type RuntimeState } from './runtime/types';
import { handRecordView, tableView } from './runtime/view';

/** Who a browser is. The default derives a player id from the browser secret; the database version adds names and accounts. */
export interface IdentityService {
  resolve(token: string): Promise<{ playerId: PlayerId; displayName: string; account: { username: string } | null }>;
}

/** Where tables and finished hands are kept. The default keeps them in memory. */
export interface TableStore {
  /** A new table, before anything else is saved for it. */
  createTable(state: RuntimeState): Promise<void>;
  saveTable(state: RuntimeState): Promise<void>;
  loadTable(id: string): Promise<RuntimeState | null>;
  saveHand(tableId: string, record: HandRecord): Promise<void>;
}

export const memoryIdentity: IdentityService = {
  async resolve(token) {
    const playerId = createHash('sha256').update(token).digest('base64url').slice(0, 16);
    return { playerId, displayName: '', account: null };
  },
};

export function memoryStore(): TableStore {
  const tables = new Map<string, string>();
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
    async saveHand() {},
  };
}

export interface AppDeps {
  clock?: Clock;
  identity?: IdentityService;
  store?: TableStore;
  /** Built web client to serve (production). */
  webDist?: string | null;
  /** Called once per runtime, e.g. to register modifiers or log. */
  log?: (message: string, err?: unknown) => void;
}

type Sock = Socket<ClientToServer, ServerToClient, object, { playerId: PlayerId; tableId?: string }>;

const SAVE_DEBOUNCE_MS = 500;

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
  const identity = deps.identity ?? memoryIdentity;
  const store = deps.store ?? memoryStore();
  const log = deps.log ?? ((m, e) => console.error(m, e ?? ''));

  const app = express();
  const http = createServer(app);
  const io = new Server<ClientToServer, ServerToClient>(http, {
    cors: process.env.NODE_ENV === 'production' ? undefined : { origin: true },
  });

  const tables = new Map<string, TableRuntime>();
  const watchers = new Map<string, Set<Sock>>();
  const pendingBroadcast = new Set<string>();
  const saveTimers = new Map<string, NodeJS.Timeout>();

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, tables: tables.size });
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
      for (const s of watchers.get(id) ?? []) s.emit('table:state', tableView(rt, s.data.playerId, now));
    });
  }

  function scheduleSave(rt: TableRuntime) {
    const id = rt.state.id;
    if (saveTimers.has(id)) return;
    saveTimers.set(
      id,
      setTimeout(() => {
        saveTimers.delete(id);
        store.saveTable(rt.state).catch((e) => log(`saving table ${id} failed`, e));
      }, SAVE_DEBOUNCE_MS),
    );
  }

  function attach(rt: TableRuntime) {
    tables.set(rt.state.id, rt);
    rt.onChange = () => {
      broadcast(rt);
      scheduleSave(rt);
    };
    rt.onHandFinished = (record) => {
      store.saveHand(rt.state.id, record).catch((e) => log(`saving hand ${record.handNumber} failed`, e));
    };
    return rt;
  }

  async function getTable(id: string): Promise<TableRuntime | null> {
    const live = tables.get(id);
    if (live) return live;
    const saved = await store.loadTable(id);
    if (!saved) return null;
    // Another join may have loaded it while we waited.
    if (tables.has(id)) return tables.get(id)!;
    const rt = attach(new TableRuntime(saved, { clock }));
    rt.resume();
    return rt;
  }

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) return next(new Error('missing token'));
    try {
      const who = await identity.resolve(token);
      socket.data.playerId = who.playerId;
      (socket.data as { session?: typeof who }).session = who;
      next();
    } catch (e) {
      next(e instanceof Error ? e : new Error('sign-in failed'));
    }
  });

  io.on('connection', (raw) => {
    const socket = raw as Sock;
    const me = socket.data.playerId;
    const session = (socket.data as { session?: Parameters<ServerToClient['session']>[0] }).session;
    if (session) socket.emit('session', session);

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
    const on = <K extends keyof ClientToServer>(event: K, handler: ClientToServer[K]) => socket.on(event, handler as never);

    on('table:create', (input, ack) =>
      guarded(
        ack,
        async () => {
          const patch = input?.settings ?? {};
          // Tables made here are cash tables; tournaments make their own.
          const base = defaultSettings('cash');
          const settings = parseSettings(applyAtNextHand(base, mergePatches(patch, { table: { mode: 'cash' } })).settings);
          const rt = TableRuntime.create({ hostId: me, settings }, { clock });
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
          socket.emit('table:state', tableView(rt, me, clock.now()));
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

    on('seat:request', (input, ack) =>
      guarded(ack, () => current().requestSeat(me, { seat: Number(input?.seat), name: String(input?.name ?? ''), stack: Number(input?.stack) }), log),
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
    on('chat:send', ({ text }) => guarded(undefined, () => current().chat(me, String(text ?? '')), log));

    on('host:approve', ({ requestId }, ack) => guarded(ack, () => current().approve(me, String(requestId)), log));
    on('host:reject', ({ requestId }) => guarded(undefined, () => current().reject(me, String(requestId)), log));
    on('host:start', (ack) => guarded(ack, () => current().start(me), log));
    on('host:stop', (ack) => guarded(ack, () => current().stop(me), log));
    on('host:deal', (ack) => guarded(ack, () => current().dealNext(me), log));
    on('host:pause', ({ value }, ack) => guarded(ack, () => current().pause(me, !!value), log));
    on('host:settings', ({ patch }, ack) => guarded(ack, () => current().updateSettings(me, patch ?? {}), log));
    on('host:setStack', ({ playerId, stack }, ack) => guarded(ack, () => current().setStack(me, String(playerId), Number(stack)), log));
    on('host:kick', ({ playerId }, ack) => guarded(ack, () => current().kick(me, String(playerId)), log));
    on('host:sitOut', ({ playerId }, ack) => guarded(ack, () => current().hostSitOut(me, String(playerId)), log));
    on('host:transfer', ({ playerId }, ack) => guarded(ack, () => current().transferHost(me, String(playerId)), log));

    socket.on('disconnect', () => leave());
  });

  return {
    app,
    http,
    io,
    tables,
    getTable,
    async close() {
      for (const t of saveTimers.values()) clearTimeout(t);
      await Promise.all([...tables.values()].map((rt) => store.saveTable(rt.state).catch(() => {})));
      for (const rt of tables.values()) rt.dispose();
      io.close();
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
