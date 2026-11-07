/**
 * The public record (packages/engine/src/audit.ts, docs/FAIRNESS.md): hands,
 * chip totals, admin actions and server starts, hash-chained. Entries are
 * numbered and hashed the moment they go in and saved behind, in order; the
 * routes only ever show saved entries, so a crash can't take back one someone saw
 * (unless the disk itself loses writes it said it had made).
 *
 * A hand at a table whose spectators watch on a delay goes in that long after it
 * ends (D38), so the record never tells anyone a hand is over before the people
 * watching see it end. Until then it waits outside the chain, saved as a row in
 * `jobs` (kind 'audit-hand'), and gets its number and hash only when it goes in.
 */

import { asc, desc, eq, gt, and, inArray, sql } from 'drizzle-orm';
import express from 'express';
import { AUDIT_GENESIS, auditHash, handDigest, playerRef, tableRef, type AuditEntry, type AuditKind, type AuditValue } from '@rsdp/engine';
import type { Db } from './db';
import { dbCause, newId, queryRows, schema } from './db';
import type { HandRecord, RuntimeState } from './runtime/types';

/** A hand's entry waiting for the table's spectator delay: not in the chain, so it has no number or hash yet. */
export interface PendingHand {
  id: string;
  table: string;
  hand: number;
  digest: string;
  /** When it goes in, in milliseconds since 1970. */
  at: number;
}

export interface AuditStore {
  last(): Promise<AuditEntry | null>;
  /** Saves an entry. `released`: the waiting hand it is, which stops waiting in the same step, so it is never both or neither. */
  append(entry: AuditEntry, released?: string): Promise<void>;
  /** Every hand waiting to go in, soonest first (those due at the same time in the order they were kept). */
  pending(): Promise<PendingHand[]>;
  /** Keeps a hand until it goes in. */
  hold(p: PendingHand): Promise<void>;
  /** Entries after `seq`, oldest first, optionally of some kinds only. */
  after(seq: number, limit: number, kinds?: AuditKind[]): Promise<AuditEntry[]>;
  /** Each player's latest chip totals at one table. */
  latestChips(table: string): Promise<AuditEntry[]>;
  /** Every entry for one hand at a table (a late show adds another), and whether the table has hand entries before and after it. */
  hand(table: string, hand: number): Promise<HandEntries>;
}

export interface HandEntries {
  entries: AuditEntry[];
  before: boolean;
  after: boolean;
}

export function memoryAuditStore(): AuditStore {
  const rows: AuditEntry[] = [];
  const waiting: PendingHand[] = [];
  return {
    async last() {
      return rows.at(-1) ?? null;
    },
    async append(e, released) {
      rows.push(e);
      const i = waiting.findIndex((p) => p.id === released);
      if (i >= 0) waiting.splice(i, 1);
    },
    async pending() {
      // sort is stable: hands due at the same time stay in the order they were kept.
      return waiting.map((p) => ({ ...p })).sort((a, b) => a.at - b.at);
    },
    async hold(p) {
      if (!waiting.some((x) => x.id === p.id)) waiting.push({ ...p });
    },
    async after(seq, limit, kinds) {
      return rows.filter((e) => e.seq > seq && (!kinds || kinds.includes(e.kind))).slice(0, limit);
    },
    async latestChips(table) {
      const latest = new Map<unknown, AuditEntry>();
      for (const e of rows) if (e.kind === 'chips' && e.data.table === table) latest.set(e.data.player, e);
      return [...latest.values()];
    },
    async hand(table, hand) {
      const hands = rows.filter((e) => e.kind === 'hand' && e.data.table === table);
      return { entries: hands.filter((e) => e.data.hand === hand), before: hands.some((e) => Number(e.data.hand) < hand), after: hands.some((e) => Number(e.data.hand) > hand) };
    },
  };
}

const t = schema.auditLog;
const toEntry = (r: typeof t.$inferSelect): AuditEntry => ({ seq: r.seq, at: r.at, kind: r.kind as AuditKind, data: r.data as AuditEntry['data'], prev: r.prev, hash: r.hash });
/**
 * Waiting hands are rows in `jobs`, the table of timers that outlast a restart: cash tables aren't loaded again at
 * start, so a hand can't wait with its table. The Scheduler only takes kinds it has handlers for, so it leaves them be.
 */
const j = schema.jobs;
export const PENDING_HAND_KIND = 'audit-hand';

export function dbAuditStore(db: Db): AuditStore {
  return {
    async last() {
      const [row] = await db.select().from(t).orderBy(desc(t.seq)).limit(1);
      return row ? toEntry(row) : null;
    },
    async append(e, released) {
      const subject = typeof e.data.table === 'string' ? e.data.table : null;
      if (!released) {
        await db.insert(t).values({ ...e, subject });
        return;
      }
      // One transaction: after a crash the hand is either in the record or still waiting, never both or neither.
      await db.transaction(async (tx) => {
        await tx.insert(t).values({ ...e, subject });
        await tx.delete(j).where(and(eq(j.id, released), eq(j.kind, PENDING_HAND_KIND)));
      });
    },
    async pending() {
      const rows = await db
        .select({ id: j.id, runAt: j.runAt, payload: j.payload })
        .from(j)
        .where(and(eq(j.kind, PENDING_HAND_KIND), eq(j.status, 'pending')))
        .orderBy(asc(j.runAt), asc(j.createdAt));
      return rows.map((r) => ({ id: r.id, at: r.runAt.getTime(), ...(r.payload as Pick<PendingHand, 'table' | 'hand' | 'digest'>) }));
    },
    async hold(p) {
      await db
        .insert(j)
        .values({
          id: p.id,
          kind: PENDING_HAND_KIND,
          runAt: new Date(p.at),
          payload: { table: p.table, hand: p.hand, digest: p.digest },
          status: 'pending',
          // Just after the last one kept, so hands due at the same time go in the order they were kept, even on a
          // database whose clock counts in whole milliseconds. (greatest skips the null when none is waiting.)
          createdAt: sql`greatest(now(), (select max(${j.createdAt}) + interval '1 millisecond' from ${j} where ${j.kind} = ${PENDING_HAND_KIND}))`,
        })
        // Kept already: a retry after a save that went through but reported a failure.
        .onConflictDoNothing({ target: j.id });
    },
    async after(seq, limit, kinds) {
      const rows = await db
        .select()
        .from(t)
        .where(and(gt(t.seq, seq), kinds ? inArray(t.kind, kinds) : undefined))
        .orderBy(asc(t.seq))
        .limit(limit);
      return rows.map(toEntry);
    },
    async latestChips(table) {
      const rows = await queryRows<{ seq: string | number }>(
        db,
        sql`select distinct on (data->>'player') seq from audit_log where subject = ${table} and kind = 'chips' order by data->>'player', seq desc`,
      );
      if (!rows.length) return [];
      const full = await db.select().from(t).where(inArray(t.seq, rows.map((r) => Number(r.seq)))).orderBy(asc(t.seq));
      return full.map(toEntry);
    },
    async hand(table, hand) {
      const rows = await db
        .select()
        .from(t)
        .where(and(sql`${t.subject} = ${table}`, sql`${t.kind} = 'hand'`, sql`(${t.data}->>'hand')::int = ${hand}`))
        .orderBy(asc(t.seq));
      const [around] = await queryRows<{ before: boolean; after: boolean }>(
        db,
        sql`select bool_or((data->>'hand')::int < ${hand}) as before, bool_or((data->>'hand')::int > ${hand}) as after from audit_log where subject = ${table} and kind = 'hand'`,
      );
      return { entries: rows.map(toEntry), before: !!around?.before, after: !!around?.after };
    },
  };
}

/** What the server says about the build it runs. Self-reported: the deploy watcher on GitHub checks it from outside. */
export interface BuildInfo {
  /** The git commit the image was built from (BUILD_COMMIT, set by the deploy workflow). */
  commit: string | null;
  /** Fly's own name for the image this machine runs (FLY_IMAGE_REF). */
  image: string | null;
  machine: string | null;
}

export function buildFromEnv(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const commit = env.BUILD_COMMIT && /^[0-9a-f]{7,40}$/.test(env.BUILD_COMMIT) ? env.BUILD_COMMIT : null;
  return { commit, image: env.FLY_IMAGE_REF || null, machine: env.FLY_MACHINE_ID || null };
}

export interface AuditOptions {
  now?: () => number;
  log?: (message: string, err?: unknown) => void;
}

const RETRY_MS = [1_000, 5_000, 30_000];
/** Reads wait at most this long for entries still being saved. */
const SETTLE_MS = 2_000;
/** setTimeout fires at once for delays past 2^31 - 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Arms a one-shot timer and returns a function that cancels it. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

/** A save still to make: an entry numbered and hashed (with the waiting hand it is, if one), or a hand to keep until it goes in. */
type Unsaved = { entry: AuditEntry; released?: string } | { hold: PendingHand };

export class AuditLog {
  private head: { seq: number; hash: string };
  /** The latest entry saved: what the record shows, so a crash can never take back an entry someone saw. */
  private saved: { seq: number; hash: string };
  /** Saves still to make, oldest first. */
  private unsaved: Unsaved[] = [];
  private saving: Promise<void> | null = null;
  /** The last chip totals written for each player at each loaded table: table id → player id → "buyIn/cashOut". */
  private chips = new Map<string, Map<string, string>>();
  /** Hands waiting for their table's spectator delay, soonest first (those due together in the order they were kept). */
  private waiting: PendingHand[] = [];
  /** Set by start(), until stop(): nothing goes in by itself without it. */
  private setTimer: SetTimer | null = null;
  private cancelTimer: (() => void) | null = null;

  private constructor(
    private store: AuditStore,
    last: AuditEntry | null,
    private now: () => number,
    private log: (message: string, err?: unknown) => void,
  ) {
    this.head = last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: AUDIT_GENESIS };
    this.saved = { ...this.head };
  }

  /** Carries on with the store's record, and the hands still waiting when the last server stopped (start() puts them in). */
  static async open(store: AuditStore, opts: AuditOptions = {}) {
    const log = AuditLog.after(store, await store.last(), opts);
    log.waiting = await store.pending();
    return log;
  }

  /** Carries on after `last`, the store's latest entry (null for a new record). Hands waiting in the store need open(). */
  static after(store: AuditStore, last: AuditEntry | null, opts: AuditOptions = {}) {
    return new AuditLog(store, last, opts.now ?? Date.now, opts.log ?? ((m, e) => console.error(m, dbCause(e) ?? '')));
  }

  record(kind: AuditKind, data: Record<string, AuditValue>): AuditEntry {
    return this.write(kind, data);
  }

  private write(kind: AuditKind, data: Record<string, AuditValue>, released?: string): AuditEntry {
    const base = { seq: this.head.seq + 1, at: this.now(), kind, data, prev: this.head.hash };
    const entry = { ...base, hash: auditHash(base) };
    this.head = { seq: entry.seq, hash: entry.hash };
    this.unsaved.push(released ? { entry, released } : { entry });
    this.save();
    return entry;
  }

  /** The latest saved entry. */
  latest() {
    return { ...this.saved };
  }

  private save() {
    if (this.saving) return;
    this.saving = (async () => {
      let tries = 0;
      while (this.unsaved.length) {
        const next = this.unsaved[0];
        try {
          if ('hold' in next) await this.store.hold(next.hold);
          else {
            await this.store.append(next.entry, next.released);
            this.saved = { seq: next.entry.seq, hash: next.entry.hash };
          }
          this.unsaved.shift();
          tries = 0;
        } catch (e) {
          this.log('hold' in next ? `keeping hand ${next.hold.hand} for the public record failed` : `saving public record entry ${next.entry.seq} failed`, e);
          await new Promise((r) => setTimeout(r, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]));
        }
      }
    })().finally(() => {
      this.saving = null;
      if (this.unsaved.length) this.save();
    });
  }

  /** Waits until everything recorded so far is saved, hands kept for later too. */
  async flush() {
    while (this.saving) await this.saving;
  }

  /** Gives entries being saved a moment, so a read right after a change sees it; never waits on a database that keeps failing. */
  private settle() {
    return Promise.race([this.flush(), new Promise((r) => setTimeout(r, SETTLE_MS).unref?.())]);
  }

  /** Saved entries after `seq`, oldest first (only up to the latest saved one). */
  async after(seq: number, limit: number, kinds?: AuditKind[]) {
    await this.settle();
    const upTo = this.saved.seq;
    return (await this.store.after(seq, limit, kinds)).filter((e) => e.seq <= upTo);
  }

  async latestChips(table: string) {
    await this.settle();
    return this.store.latestChips(table);
  }

  async handEntries(table: string, hand: number) {
    await this.settle();
    return this.store.hand(table, hand);
  }

  /** Runs a recording step without ever letting a problem with the record break the game. */
  safely(what: string, fn: () => void) {
    try {
      fn();
    } catch (e) {
      this.log(`recording ${what} in the public record failed`, e);
    }
  }

  // ------------------------------------------------------------ hands waiting for a spectator delay

  /** Puts waiting hands in when they are due, those due already straight away. Call it after boot(), which stays first. */
  start(setTimer: SetTimer) {
    this.setTimer = setTimer;
    this.releaseDue();
  }

  /** Stops putting waiting hands in. They stay saved (flush() finishes keeping them), and the next server puts them in on time. */
  stop() {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.setTimer = null;
  }

  private releaseDue() {
    const now = this.now();
    this.safely('hands whose spectator delay has passed', () => this.release((p) => p.at <= now));
    this.arm();
  }

  /** Puts these waiting hands in the record, in the order they wait. */
  private release(which: (p: PendingHand) => boolean) {
    const going = this.waiting.filter(which);
    if (!going.length) return;
    this.waiting = this.waiting.filter((p) => !which(p));
    for (const p of going) this.write('hand', { table: p.table, hand: p.hand, digest: p.digest }, p.id);
  }

  /** One timer, for the soonest waiting hand. One that fires late puts in everything due by then; one that fires early arms again. */
  private arm() {
    this.cancelTimer?.();
    this.cancelTimer = null;
    const next = this.waiting[0];
    if (!this.setTimer || !next) return;
    this.cancelTimer = this.setTimer(
      () => {
        this.cancelTimer = null;
        this.releaseDue();
      },
      Math.min(Math.max(0, next.at - this.now()), MAX_TIMER_MS),
    );
  }

  // ------------------------------------------------------------ what gets recorded

  boot(build: BuildInfo) {
    this.record('boot', { commit: build.commit, image: build.image });
  }

  /**
   * A finished hand (again after a late show). Hands dealt before provably fair dealing aren't recorded.
   * `publishAt`: when the table's spectators on a delay see it end. Until then it waits (D38), and always behind the
   * table's hands already waiting, so a table's hands go in in order even when its delay is shortened.
   */
  hand(tableId: string, record: HandRecord, publishAt?: number) {
    const { input, seats, events } = record.hand;
    if (!input.handId || !input.fair) return;
    // Worked out now: a card shown later changes record.hand, and goes in as an entry of its own.
    const digest = handDigest({
      handId: input.handId,
      commit: input.fair.commit,
      serverSeed: input.fair.serverSeed,
      button: input.button,
      seats: seats.map((s) => ({ seat: s.seat, playerId: s.playerId, stack: s.startStack })),
      events,
    });
    const data = { table: tableRef(tableId), hand: record.handNumber, digest };
    const behind = this.waiting.filter((p) => p.table === data.table).at(-1)?.at;
    if ((publishAt === undefined || publishAt <= this.now()) && behind === undefined) return void this.record('hand', data);
    const p: PendingHand = { id: newId(), ...data, at: Math.max(publishAt ?? this.now(), behind ?? -Infinity) };
    // After every hand due no later, so those due together go in the order they were kept.
    const i = this.waiting.findIndex((x) => x.at > p.at);
    this.waiting.splice(i < 0 ? this.waiting.length : i, 0, p);
    this.unsaved.push({ hold: p });
    this.save();
    this.arm();
  }

  /**
   * A table was loaded: from now on its chip totals are recorded whenever they
   * change. Totals that differ from the last ones recorded are recorded straight
   * away and marked `loaded`: they changed while the table was put away (a
   * crash between saves, or someone editing the database).
   */
  async watchTable(state: RuntimeState) {
    const seen = new Map<string, string>();
    try {
      const refs = new Map(Object.keys(state.ledger).map((id) => [playerRef(state.id, id), id]));
      for (const e of await this.latestChips(tableRef(state.id))) {
        const id = refs.get(String(e.data.player));
        if (id) seen.set(id, `${e.data.buyIn}/${e.data.cashOut}`);
      }
    } catch (e) {
      // Recorded again from scratch rather than not at all.
      this.log(`reading the public record for table ${state.id} failed`, e);
    }
    this.chips.set(state.id, seen);
    this.tableChanged(state, true);
  }

  /** Records the chip totals that changed. Practice bots play for nothing and aren't recorded. */
  tableChanged(state: RuntimeState, loaded = false) {
    const seen = this.chips.get(state.id);
    if (!seen) return;
    for (const row of Object.values(state.ledger)) {
      if (row.bot) continue;
      const now = `${row.buyIn}/${row.cashOut}`;
      const before = seen.get(row.playerId);
      if (before === now) continue;
      seen.set(row.playerId, now);
      this.record('chips', {
        table: tableRef(state.id),
        player: playerRef(state.id, row.playerId),
        buyIn: row.buyIn,
        cashOut: row.cashOut,
        ...(loaded && before !== undefined ? { loaded: true } : {}),
      });
    }
  }

  forgetTable(tableId: string) {
    this.chips.delete(tableId);
  }

  /** A table deleted for good. Unlike one put away or moved on (forgetTable), it has nobody left watching on a delay. */
  deleted(tableId: string, by: 'host' | 'admin' | 'player') {
    this.forgetTable(tableId);
    const table = tableRef(tableId);
    // Its waiting hands go in now, so they come before the entry that ends the table.
    this.release((p) => p.table === table);
    this.arm();
    this.record('deleted', { table, by });
  }

  admin(action: string, target: string | null = null) {
    this.record('admin', { action, target });
  }
}

const KINDS: AuditKind[] = ['boot', 'hand', 'chips', 'admin', 'deleted'];
const PAGE = 1_000;

/** Read-only routes anyone may use; GitHub's Transparency watcher copies them every few hours. */
export function auditRoutes(app: express.Express, audit: AuditLog, build: BuildInfo, startedAt: number, log: (message: string, err?: unknown) => void) {
  const fail = (res: express.Response) => (e: unknown) => {
    log('public record read failed', e);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  };
  app.get('/api/version', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ...build, startedAt: new Date(startedAt).toISOString() });
  });
  app.get('/api/audit/head', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(audit.latest());
  });
  app.get('/api/audit/entries', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const after = Math.max(0, Math.floor(Number(req.query.after ?? 0)) || 0);
    const limit = Math.min(PAGE, Math.max(1, Math.floor(Number(req.query.limit ?? PAGE)) || PAGE));
    const kinds = typeof req.query.kind === 'string' ? req.query.kind.split(',').filter((k): k is AuditKind => KINDS.includes(k as AuditKind)) : undefined;
    audit.after(after, limit, kinds?.length ? kinds : undefined).then((entries) => res.json({ entries }), fail(res));
  });
  const tableRefOf = (req: express.Request, res: express.Response) => {
    res.set('Cache-Control', 'no-store');
    const ref = String(req.params.ref);
    if (/^[0-9a-f]{32}$/.test(ref)) return ref;
    res.status(404).json({ error: 'No such table.' });
    return null;
  };
  app.get('/api/audit/table/:ref/chips', (req, res) => {
    const ref = tableRefOf(req, res);
    if (ref) audit.latestChips(ref).then((entries) => res.json({ entries }), fail(res));
  });
  app.get('/api/audit/table/:ref/hand/:n', (req, res) => {
    const ref = tableRefOf(req, res);
    const n = Number(req.params.n);
    if (!ref) return;
    if (!Number.isSafeInteger(n) || n < 0) return void res.status(404).json({ error: 'No such hand.' });
    audit.handEntries(ref, n).then((r) => res.json(r), fail(res));
  });
}
