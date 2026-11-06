import { and, desc, eq } from 'drizzle-orm';
import type { Db } from './client';
import { tournamentLog } from './schema';

export interface TournamentLogRow<T = unknown> {
  itemId: string;
  at: Date;
  item: T;
}

/** Adds lobby items in the order given. */
export async function appendTournamentLog(db: Db, tournamentId: string, rows: TournamentLogRow[]): Promise<void> {
  if (!rows.length) return;
  await db.insert(tournamentLog).values(rows.map((r) => ({ tournamentId, itemId: r.itemId, at: r.at, item: r.item })));
}

/** The latest `limit` lobby items, oldest first. */
export async function recentTournamentLog<T = unknown>(db: Db, tournamentId: string, limit: number): Promise<TournamentLogRow<T>[]> {
  const rows = await db
    .select({ itemId: tournamentLog.itemId, at: tournamentLog.at, item: tournamentLog.item })
    .from(tournamentLog)
    .where(eq(tournamentLog.tournamentId, tournamentId))
    .orderBy(desc(tournamentLog.n))
    .limit(limit);
  return (rows as TournamentLogRow<T>[]).reverse();
}

/** Deletes one lobby item for good (a chat message the host deleted). */
export async function deleteTournamentLogItem(db: Db, tournamentId: string, itemId: string): Promise<void> {
  await db.delete(tournamentLog).where(and(eq(tournamentLog.tournamentId, tournamentId), eq(tournamentLog.itemId, itemId)));
}
