/**
 * Identity: a persistent guest player per browser secret, optional username
 * and password accounts that own one or more player ids, and sessions so an
 * account can sign in on other devices.
 */

import { and, eq, inArray, lte, sql, TransactionRollbackError } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { newId } from '../db/ids';
import { accounts, players, playerTokens, sessions } from '../db/schema';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password';
import { hashSecret, isWellFormedSecret, newSecret } from './secrets';

export type Player = typeof players.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Account = Omit<typeof accounts.$inferSelect, 'passwordHash'>;

export type IdentityErrorCode =
  | 'invalid-token'
  | 'invalid-name'
  | 'invalid-username'
  | 'weak-password'
  | 'username-taken'
  | 'bad-credentials'
  | 'player-not-found'
  | 'account-not-found'
  | 'already-linked'
  | 'not-linked';

/** Expected identity failures; the message is safe to show to the user. */
export class IdentityError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const displayNameSchema = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1)
      .max(24)
      .regex(/^\P{Cc}+$/u),
  );

const usernameSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{2,23}$/);
const passwordSchema = z.string().min(8).max(200);

const accountColumns = {
  id: accounts.id,
  username: accounts.username,
  primaryPlayerId: accounts.primaryPlayerId,
  createdAt: accounts.createdAt,
};

// ---------------------------------------------------------------- players

/**
 * Maps a browser secret to its player, creating a guest player the first time
 * the secret is seen. Only the secret's hash is stored. Also bumps last_seen_at.
 */
export async function resolveToken(db: Db, secret: string, opts: { now?: Date } = {}): Promise<Player> {
  if (!isWellFormedSecret(secret)) throw new IdentityError('invalid-token', 'missing or malformed token');
  const now = opts.now ?? new Date();
  const tokenHash = hashSecret(secret);

  const seen = await touchByToken(db, tokenHash, now);
  if (seen) return seen;

  try {
    return await db.transaction(async (tx) => {
      const [player] = await tx
        .insert(players)
        .values({ id: newId(), createdAt: now, lastSeenAt: now })
        .returning();
      const claimed = await tx
        .insert(playerTokens)
        .values({ tokenHash, playerId: player.id, createdAt: now })
        .onConflictDoNothing()
        .returning();
      // Another connection registered the same secret first: drop our guest and use theirs.
      if (claimed.length === 0) tx.rollback();
      return player;
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
    const winner = await touchByToken(db, tokenHash, now);
    if (!winner) throw err;
    return winner;
  }
}

async function touchByToken(db: Db, tokenHash: string, now: Date): Promise<Player | null> {
  const owner = db.select({ id: playerTokens.playerId }).from(playerTokens).where(eq(playerTokens.tokenHash, tokenHash));
  const [player] = await db.update(players).set({ lastSeenAt: now }).where(inArray(players.id, owner)).returning();
  return player ?? null;
}

export async function getPlayer(db: Db, playerId: string): Promise<Player | null> {
  const [player] = await db.select().from(players).where(eq(players.id, playerId));
  return player ?? null;
}

/** Trims and collapses whitespace; 1 to 24 characters, no control characters. */
export async function setDisplayName(db: Db, playerId: string, name: string): Promise<Player> {
  const parsed = displayNameSchema.safeParse(name);
  if (!parsed.success) throw new IdentityError('invalid-name', 'names are 1 to 24 characters');
  const [player] = await db.update(players).set({ displayName: parsed.data }).where(eq(players.id, playerId)).returning();
  if (!player) throw new IdentityError('player-not-found', 'no such player');
  return player;
}

// ---------------------------------------------------------------- accounts

/**
 * Creates an account owned by an existing guest player, which becomes the
 * account's primary player id. Usernames are unique ignoring case.
 */
export async function createAccount(
  db: Db,
  username: string,
  password: string,
  playerId: string,
  opts: { now?: Date } = {},
): Promise<Account> {
  if (!usernameSchema.safeParse(username).success) {
    throw new IdentityError('invalid-username', 'usernames are 3 to 24 letters, digits, dots, dashes or underscores');
  }
  if (!passwordSchema.safeParse(password).success) {
    throw new IdentityError('weak-password', 'passwords are 8 to 200 characters');
  }
  const passwordHash = await hashPassword(password);
  const now = opts.now ?? new Date();

  return db.transaction(async (tx) => {
    const [player] = await tx.select().from(players).where(eq(players.id, playerId)).for('update');
    if (!player) throw new IdentityError('player-not-found', 'no such player');
    if (player.accountId) throw new IdentityError('already-linked', 'this player already belongs to an account');
    const [account] = await tx
      .insert(accounts)
      .values({ id: newId(), username, passwordHash, primaryPlayerId: playerId, createdAt: now })
      .onConflictDoNothing()
      .returning(accountColumns);
    if (!account) throw new IdentityError('username-taken', 'that username is taken');
    await tx.update(players).set({ accountId: account.id }).where(eq(players.id, playerId));
    return account;
  });
}

export async function getAccount(db: Db, accountId: string): Promise<Account | null> {
  const [account] = await db.select(accountColumns).from(accounts).where(eq(accounts.id, accountId));
  return account ?? null;
}

export async function findAccountByUsername(db: Db, username: string): Promise<Account | null> {
  const [account] = await db
    .select(accountColumns)
    .from(accounts)
    .where(sql`lower(${accounts.username}) = lower(${username})`);
  return account ?? null;
}

/**
 * Adds a guest player id to an account, e.g. when someone signs in on a new
 * device. Linking a player the account already owns is a no-op.
 */
export async function linkPlayerToAccount(db: Db, accountId: string, playerId: string): Promise<Player> {
  return db.transaction(async (tx) => {
    const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId));
    if (!account) throw new IdentityError('account-not-found', 'no such account');
    const [player] = await tx.select().from(players).where(eq(players.id, playerId)).for('update');
    if (!player) throw new IdentityError('player-not-found', 'no such player');
    if (player.accountId === accountId) return player;
    if (player.accountId) throw new IdentityError('already-linked', 'this player already belongs to another account');
    const [linked] = await tx.update(players).set({ accountId }).where(eq(players.id, playerId)).returning();
    return linked;
  });
}

/** Makes one of the account's linked players the one it plays as. */
export async function setPrimaryPlayer(db: Db, accountId: string, playerId: string): Promise<Account> {
  const [player] = await db.select({ accountId: players.accountId }).from(players).where(eq(players.id, playerId));
  if (!player) throw new IdentityError('player-not-found', 'no such player');
  if (player.accountId !== accountId) throw new IdentityError('not-linked', 'link the player to this account first');
  const [account] = await db
    .update(accounts)
    .set({ primaryPlayerId: playerId })
    .where(eq(accounts.id, accountId))
    .returning(accountColumns);
  if (!account) throw new IdentityError('account-not-found', 'no such account');
  return account;
}

/** Every player id the account owns, oldest first. */
export async function playersForAccount(db: Db, accountId: string): Promise<Player[]> {
  return db.select().from(players).where(eq(players.accountId, accountId)).orderBy(players.createdAt, players.id);
}

// ---------------------------------------------------------------- sessions

export interface LoginResult {
  /** The raw session secret. Hand it to the client once; only its hash is stored. */
  token: string;
  session: Session;
  account: Account;
}

/** Checks the password and opens a session. Wrong usernames and wrong passwords fail the same way. */
export async function login(
  db: Db,
  username: string,
  password: string,
  opts: { now?: Date; ttlMs?: number } = {},
): Promise<LoginResult> {
  const [row] =
    typeof username === 'string' && username.length <= 64
      ? await db.select().from(accounts).where(sql`lower(${accounts.username}) = lower(${username})`)
      : [];
  const ok = typeof password === 'string' && password.length <= 200;
  const matches = await verifyPassword(ok ? password : '', row?.passwordHash ?? (await dummyPasswordHash()));
  if (!row || !ok || !matches) throw new IdentityError('bad-credentials', 'wrong username or password');

  const now = opts.now ?? new Date();
  const token = newSecret();
  await db.delete(sessions).where(and(eq(sessions.accountId, row.id), lte(sessions.expiresAt, now)));
  const [session] = await db
    .insert(sessions)
    .values({
      id: newId(),
      accountId: row.id,
      tokenHash: hashSecret(token),
      createdAt: now,
      expiresAt: new Date(now.getTime() + (opts.ttlMs ?? SESSION_TTL_MS)),
    })
    .returning();
  const account: Account = {
    id: row.id,
    username: row.username,
    primaryPlayerId: row.primaryPlayerId,
    createdAt: row.createdAt,
  };
  return { token, session, account };
}

/** The live session for a token, or null when it is unknown or expired. */
export async function resolveSession(
  db: Db,
  token: string,
  opts: { now?: Date } = {},
): Promise<{ session: Session; account: Account } | null> {
  if (!isWellFormedSecret(token)) return null;
  const now = opts.now ?? new Date();
  const [row] = await db
    .select({ session: sessions, account: accountColumns })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(eq(sessions.tokenHash, hashSecret(token)));
  if (!row || row.session.expiresAt.getTime() <= now.getTime()) return null;
  return row;
}

/** Ends a session. Returns false when the token matched nothing. */
export async function logout(db: Db, token: string): Promise<boolean> {
  if (!isWellFormedSecret(token)) return false;
  const deleted = await db.delete(sessions).where(eq(sessions.tokenHash, hashSecret(token))).returning({ id: sessions.id });
  return deleted.length > 0;
}
