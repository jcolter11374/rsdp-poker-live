import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { tournaments, type TournamentStatus } from './schema';

export interface TournamentRecord<S = unknown> {
  id: string;
  hostPlayerId: string;
  status: TournamentStatus;
  state: S;
  nextId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type TournamentInput = { id: string; hostPlayerId: string; status: TournamentStatus; state: unknown; nextId?: string | null };

/** Saves a new tournament. False when the id is taken: an existing tournament is never written over. */
export async function insertTournament(db: Db, input: TournamentInput, now: Date = new Date()): Promise<boolean> {
  const rows = await db
    .insert(tournaments)
    .values({ id: input.id, hostPlayerId: input.hostPlayerId, status: input.status, state: input.state, nextId: input.nextId ?? null, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: tournaments.id })
    .returning({ id: tournaments.id });
  return rows.length > 0;
}

/** Inserts or replaces a tournament's state. */
export async function saveTournament(db: Db, input: TournamentInput, now: Date = new Date()): Promise<void> {
  const nextId = input.nextId ?? null;
  await db
    .insert(tournaments)
    .values({ id: input.id, hostPlayerId: input.hostPlayerId, status: input.status, state: input.state, nextId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: tournaments.id,
      set: { status: input.status, state: input.state, nextId: sql`coalesce(${nextId}, ${tournaments.nextId})`, updatedAt: now },
    });
}

export async function loadTournament<S = unknown>(db: Db, id: string): Promise<TournamentRecord<S> | null> {
  const [row] = await db.select().from(tournaments).where(eq(tournaments.id, id));
  return row ? (row as TournamentRecord<S>) : null;
}

/** Tournaments that still need the server: not finished or cancelled. */
export async function listLiveTournaments<S = unknown>(db: Db): Promise<TournamentRecord<S>[]> {
  const rows = await db
    .select()
    .from(tournaments)
    .where(inArray(tournaments.status, ['registering', 'seating', 'running', 'paused']));
  return rows as TournamentRecord<S>[];
}

/** Tournaments a player hosted or holds an entry in, changed since `since`, newest first. */
export async function listPlayerTournaments<S = unknown>(db: Db, playerId: string, since: Date, limit = 50): Promise<TournamentRecord<S>[]> {
  const entered = sql`${tournaments.state} -> 'entries' @> ${JSON.stringify([{ playerId }])}::jsonb`;
  const rows = await db
    .select()
    .from(tournaments)
    .where(and(gt(tournaments.updatedAt, since), or(eq(tournaments.hostPlayerId, playerId), entered)))
    .orderBy(desc(tournaments.updatedAt))
    .limit(limit);
  return rows as TournamentRecord<S>[];
}
