/**
 * Hand history. Events are stored unfiltered (hole cards included): run them
 * through the engine's visibleEvents before they leave the server.
 */

import { and, desc, eq, lt } from 'drizzle-orm';
import type { Db } from './client';
import { clampLimit, isUniqueViolation, StorageError } from './errors';
import { newHandId } from './ids';
import { hands } from './schema';

/** Typed by the caller; defaults stay unknown so storage does not pin the engine's event shapes. */
export interface HandRecord<Header = unknown, Event = unknown, Results = unknown> {
  id: string;
  tableId: string;
  number: number;
  gameId: string;
  startedAt: Date;
  endedAt: Date | null;
  header: Header;
  events: Event[];
  results: Results | null;
}

export type HandSummary<Header = unknown, Results = unknown> = Omit<HandRecord<Header, never, Results>, 'events'>;

export interface SaveHandInput<Header, Event, Results> {
  /** Use the id the hand was dealt with (HandInput.handId); defaults to a new hard-to-guess id. */
  id?: string;
  tableId: string;
  number: number;
  gameId: string;
  startedAt: Date;
  endedAt?: Date | null;
  header: Header;
  events: Event[];
  results?: Results | null;
}

/**
 * Inserts a hand, or updates it when the id was saved before (e.g. saved at
 * the deal, finished later). A different hand with the same table and number
 * is a conflict.
 */
export async function saveHand<Header, Event, Results>(
  db: Db,
  input: SaveHandInput<Header, Event, Results>,
): Promise<HandRecord<Header, Event, Results>> {
  if (!Number.isSafeInteger(input.number) || input.number < 0) {
    throw new StorageError('invalid', 'hand number must be a whole number');
  }
  if (!Array.isArray(input.events)) throw new StorageError('invalid', 'events must be an array');
  const values = {
    id: input.id ?? newHandId(),
    tableId: input.tableId,
    number: input.number,
    gameId: input.gameId,
    startedAt: input.startedAt,
    endedAt: input.endedAt ?? null,
    header: input.header as unknown,
    events: input.events as unknown[],
    results: (input.results ?? null) as unknown,
  };
  try {
    const [row] = await db
      .insert(hands)
      .values(values)
      .onConflictDoUpdate({
        target: hands.id,
        set: { endedAt: values.endedAt, header: values.header, events: values.events, results: values.results },
        setWhere: and(eq(hands.tableId, values.tableId), eq(hands.number, values.number)),
      })
      .returning();
    if (!row) throw new StorageError('conflict', 'that hand id belongs to another table or hand number');
    return row as HandRecord<Header, Event, Results>;
  } catch (err) {
    if (isUniqueViolation(err)) throw new StorageError('conflict', `hand ${input.number} is already saved for this table`);
    throw err;
  }
}

export async function getHand<Header = unknown, Event = unknown, Results = unknown>(
  db: Db,
  handId: string,
): Promise<HandRecord<Header, Event, Results> | null> {
  const [row] = await db.select().from(hands).where(eq(hands.id, handId));
  return row ? (row as HandRecord<Header, Event, Results>) : null;
}

export interface HandPage<Header, Results> {
  /** Newest hand first, without events (fetch one with getHand). */
  hands: HandSummary<Header, Results>[];
  /** Pass as `before` to get the next (older) page; null on the last page. */
  nextBefore: number | null;
}

/** A table's hands, newest first, paged by hand number. */
export async function listHandsByTable<Header = unknown, Results = unknown>(
  db: Db,
  tableId: string,
  opts: { limit?: number; before?: number } = {},
): Promise<HandPage<Header, Results>> {
  const limit = clampLimit(opts.limit, 50, 200);
  const rows = await db
    .select({
      id: hands.id,
      tableId: hands.tableId,
      number: hands.number,
      gameId: hands.gameId,
      startedAt: hands.startedAt,
      endedAt: hands.endedAt,
      header: hands.header,
      results: hands.results,
    })
    .from(hands)
    .where(and(eq(hands.tableId, tableId), opts.before !== undefined ? lt(hands.number, opts.before) : undefined))
    .orderBy(desc(hands.number))
    .limit(limit + 1);
  const page = rows.slice(0, limit) as HandSummary<Header, Results>[];
  return { hands: page, nextBefore: rows.length > limit ? page[page.length - 1].number : null };
}
