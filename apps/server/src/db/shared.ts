/** Shared hand links: a frozen copy of one hand, readable by anyone with the id. */

import { and, eq } from 'drizzle-orm';
import type { Db } from './client';
import { sharedHands } from './schema';

export type SharedHandRow = typeof sharedHands.$inferSelect;

export async function insertSharedHand(db: Db, row: typeof sharedHands.$inferInsert): Promise<void> {
  await db.insert(sharedHands).values(row);
}

export async function getSharedHand(db: Db, id: string): Promise<SharedHandRow | null> {
  const [row] = await db.select().from(sharedHands).where(eq(sharedHands.id, id));
  return row ?? null;
}

/** Removes a link; only the player who made it may. True when one was removed. */
export async function deleteSharedHand(db: Db, id: string, createdBy: string): Promise<boolean> {
  const rows = await db
    .delete(sharedHands)
    .where(and(eq(sharedHands.id, id), eq(sharedHands.createdBy, createdBy)))
    .returning({ id: sharedHands.id });
  return rows.length > 0;
}
