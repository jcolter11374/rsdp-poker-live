/** Phone alerts: the server's VAPID keys and the browsers that turned alerts on (push/alerts.ts). */

import { and, desc, eq, gt, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { accounts, playerTokens, pushKeys, pushSubscriptions, sessions } from './schema';
import { newVapidKeys, type PushTarget, type VapidKeys } from '../push/webpush';

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = Omit<PushSubscriptionRow, 'createdAt'>;

const VAPID = 'vapid';

/** The server's VAPID keys, made and kept the first time they are asked for (by whichever start gets there first). */
export async function vapidKeys(db: Db): Promise<VapidKeys> {
  const read = () => db.select({ publicKey: pushKeys.publicKey, privateKey: pushKeys.privateKey }).from(pushKeys).where(eq(pushKeys.id, VAPID));
  const [kept] = await read();
  if (kept) return kept;
  await db
    .insert(pushKeys)
    .values({ id: VAPID, ...newVapidKeys() })
    .onConflictDoNothing();
  const [made] = await read();
  return made;
}

/**
 * Adds a browser's subscription, or brings an existing one up to date (who it is for now, its keys, when it was
 * last seen). The player's least recently seen ones past `max` go.
 */
export async function savePushSubscription(db: Db, row: NewPushSubscription, max: number): Promise<void> {
  const { endpoint: _endpoint, ...update } = row;
  await db.transaction(async (tx) => {
    await tx.insert(pushSubscriptions).values(row).onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: update });
    const keep = tx.select({ endpoint: pushSubscriptions.endpoint }).from(pushSubscriptions).where(eq(pushSubscriptions.playerId, row.playerId)).orderBy(desc(pushSubscriptions.seenAt)).limit(max);
    await tx.delete(pushSubscriptions).where(and(eq(pushSubscriptions.playerId, row.playerId), notInArray(pushSubscriptions.endpoint, keep)));
  });
}

export async function removePushSubscription(db: Db, endpoint: string): Promise<boolean> {
  const rows = await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).returning({ endpoint: pushSubscriptions.endpoint });
  return rows.length > 0;
}

export async function removePushSubscriptionsOf(db: Db, playerIds: string[]): Promise<void> {
  if (playerIds.length) await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.playerId, playerIds));
}

/**
 * The browsers to alert for a player: only those that still play as that player, as whoIs (identity.ts) would
 * work it out now. The browser secret must still be there and be the player's own, or the browser must still be
 * signed in to the player's account with the session it subscribed with.
 */
export async function pushTargetsOf(db: Db, playerId: string, now: Date): Promise<PushTarget[]> {
  return db
    .select({ endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth })
    .from(pushSubscriptions)
    .innerJoin(playerTokens, eq(playerTokens.tokenHash, pushSubscriptions.device))
    .leftJoin(sessions, and(eq(sessions.tokenHash, pushSubscriptions.session), gt(sessions.expiresAt, now)))
    .leftJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(and(eq(pushSubscriptions.playerId, playerId), or(eq(playerTokens.playerId, pushSubscriptions.playerId), eq(accounts.primaryPlayerId, pushSubscriptions.playerId))));
}

/**
 * Forgets subscriptions of browsers that haven't opened the site since `before`, and ones that no longer play as
 * their player (signed out of the account, or its session ran out). Returns how many went.
 */
export async function prunePushSubscriptions(db: Db, before: Date, now: Date): Promise<number> {
  const rows = await db.execute(sql`
    delete from ${pushSubscriptions} s
    where s.seen_at < ${before}
      or not exists (
        select 1 from ${playerTokens} t
        left join ${sessions} se on se.token_hash = s.session and se.expires_at > ${now}
        left join ${accounts} a on a.id = se.account_id
        where t.token_hash = s.device and (t.player_id = s.player_id or a.primary_player_id = s.player_id))
    returning s.endpoint`);
  return (rows as unknown as { rows: unknown[] }).rows.length;
}
