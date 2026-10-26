/** Saved setups of signed-in players: one row per player, kind and name. */

import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { players, savedSetups, type SetupKind } from './schema';

export type SavedSetupRow = typeof savedSetups.$inferSelect;

const of = (playerId: string, kind: SetupKind) => and(eq(savedSetups.playerId, playerId), eq(savedSetups.kind, kind));

export async function listSavedSetups(db: Db, playerId: string, kind: SetupKind): Promise<SavedSetupRow[]> {
  return db.select().from(savedSetups).where(of(playerId, kind)).orderBy(asc(savedSetups.name));
}

/**
 * Saves a setup, replacing one of the same name. A new name is refused (false) when the player
 * already keeps `limit`; the player's row is locked first, so tabs saving at once can't pass it.
 */
export async function putSavedSetup(db: Db, input: { playerId: string; kind: SetupKind; name: string; json: string; limit: number; now?: Date }): Promise<boolean> {
  const updatedAt = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${players} where ${players.id} = ${input.playerId} for update`);
    const rows = await tx.select({ name: savedSetups.name }).from(savedSetups).where(of(input.playerId, input.kind));
    if (!rows.some((r) => r.name === input.name) && rows.length >= input.limit) return false;
    await tx
      .insert(savedSetups)
      .values({ playerId: input.playerId, kind: input.kind, name: input.name, json: input.json, updatedAt })
      .onConflictDoUpdate({ target: [savedSetups.playerId, savedSetups.kind, savedSetups.name], set: { json: sql`excluded.json`, updatedAt } });
    return true;
  });
}

/** Renames a setup (with its new JSON). False when there is none by that name or the new name is taken. */
export async function renameSavedSetup(db: Db, input: { playerId: string; kind: SetupKind; from: string; to: string; json: string }): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (input.from !== input.to) {
      const [taken] = await tx.select({ n: count() }).from(savedSetups).where(and(of(input.playerId, input.kind), eq(savedSetups.name, input.to)));
      if (taken && taken.n > 0) return false;
    }
    const done = await tx
      .update(savedSetups)
      .set({ name: input.to, json: input.json, updatedAt: new Date() })
      .where(and(of(input.playerId, input.kind), eq(savedSetups.name, input.from)))
      .returning({ name: savedSetups.name });
    return done.length > 0;
  });
}

export async function deleteSavedSetup(db: Db, playerId: string, kind: SetupKind, name: string): Promise<void> {
  await db.delete(savedSetups).where(and(of(playerId, kind), eq(savedSetups.name, name)));
}
