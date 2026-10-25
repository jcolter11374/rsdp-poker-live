/** Roadmap suggestions: ideas anyone sends, with a status only the admin changes. */

import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import { suggestions, type SUGGESTION_STATUSES } from './schema';

export type SuggestionRow = typeof suggestions.$inferSelect;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export async function insertSuggestion(db: Db, row: { name: string; title: string; detail: string }): Promise<SuggestionRow> {
  const [created] = await db.insert(suggestions).values(row).returning();
  return created;
}

/** Oldest first; only the given statuses when some are given. */
export async function listSuggestions(db: Db, statuses?: readonly SuggestionStatus[]): Promise<SuggestionRow[]> {
  const q = db.select().from(suggestions);
  return (statuses?.length ? q.where(inArray(suggestions.status, [...statuses])) : q).orderBy(asc(suggestions.id));
}

export async function updateSuggestion(db: Db, id: number, patch: { status?: SuggestionStatus; reply?: string }): Promise<SuggestionRow | null> {
  const [row] = await db
    .update(suggestions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(suggestions.id, id))
    .returning();
  return row ?? null;
}

export async function deleteSuggestion(db: Db, id: number): Promise<boolean> {
  const rows = await db.delete(suggestions).where(eq(suggestions.id, id)).returning({ id: suggestions.id });
  return rows.length > 0;
}
