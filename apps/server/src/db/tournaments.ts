import { eq, inArray, sql } from 'drizzle-orm';
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

/** Inserts or replaces a tournament's state. */
export async function saveTournament(
  db: Db,
  input: { id: string; hostPlayerId: string; status: TournamentStatus; state: unknown; nextId?: string | null },
  now: Date = new Date(),
): Promise<void> {
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
