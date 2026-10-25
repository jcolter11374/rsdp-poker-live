/** Private player notes: one row per owner and target, deleted when emptied. */

import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import type { Db } from './client';
import { playerNotes, type NoteColor } from './schema';

export type PlayerNoteRow = typeof playerNotes.$inferSelect;

export async function listNotes(db: Db, ownerPlayerId: string): Promise<PlayerNoteRow[]> {
  return db.select().from(playerNotes).where(eq(playerNotes.ownerPlayerId, ownerPlayerId)).orderBy(asc(playerNotes.targetPlayerId));
}

/** How many notes the owner keeps on players other than `except`. */
export async function countNotes(db: Db, ownerPlayerId: string, except: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(playerNotes)
    .where(and(eq(playerNotes.ownerPlayerId, ownerPlayerId), ne(playerNotes.targetPlayerId, except)));
  return row?.n ?? 0;
}

/** Upserts a note; empty text with no colour removes it and returns null. */
export async function setNote(
  db: Db,
  input: { ownerPlayerId: string; targetPlayerId: string; text: string; color: NoteColor; now?: Date },
): Promise<PlayerNoteRow | null> {
  const where = and(eq(playerNotes.ownerPlayerId, input.ownerPlayerId), eq(playerNotes.targetPlayerId, input.targetPlayerId));
  if (!input.text && input.color === 'none') {
    await db.delete(playerNotes).where(where);
    return null;
  }
  const updatedAt = input.now ?? new Date();
  const [row] = await db
    .insert(playerNotes)
    .values({ ownerPlayerId: input.ownerPlayerId, targetPlayerId: input.targetPlayerId, text: input.text, color: input.color, updatedAt })
    .onConflictDoUpdate({
      target: [playerNotes.ownerPlayerId, playerNotes.targetPlayerId],
      set: { text: sql`excluded.text`, color: sql`excluded.color`, updatedAt },
    })
    .returning();
  return row!;
}
