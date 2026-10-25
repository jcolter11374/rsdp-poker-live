/** Player pictures: one row per player, deleted when they clear it. */

import { eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { playerAvatars, type AvatarKind } from './schema';

export type PlayerAvatarRow = typeof playerAvatars.$inferSelect;

export async function getAvatar(db: Db, playerId: string): Promise<PlayerAvatarRow | null> {
  const [row] = await db.select().from(playerAvatars).where(eq(playerAvatars.playerId, playerId));
  return row ?? null;
}

/** Upserts the player's picture; null removes it. */
export async function setAvatar(db: Db, playerId: string, avatar: { kind: AvatarKind; value: string; now?: Date } | null): Promise<PlayerAvatarRow | null> {
  if (!avatar) {
    await db.delete(playerAvatars).where(eq(playerAvatars.playerId, playerId));
    return null;
  }
  const updatedAt = avatar.now ?? new Date();
  const [row] = await db
    .insert(playerAvatars)
    .values({ playerId, kind: avatar.kind, value: avatar.value, updatedAt })
    .onConflictDoUpdate({ target: playerAvatars.playerId, set: { kind: sql`excluded.kind`, value: sql`excluded.value`, updatedAt } })
    .returning();
  return row!;
}
