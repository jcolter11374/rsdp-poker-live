import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, queryRows, type Db } from '../src/db/client';
import { accounts, playerTokens, sessions } from '../src/db/schema';
import { createTestDb, resetTestDb } from '../src/db/testing';
import {
  createAccount,
  findAccountByUsername,
  getPlayer,
  hashPassword,
  hashSecret,
  IdentityError,
  linkPlayerToAccount,
  login,
  logout,
  playersForAccount,
  resolveSession,
  resolveToken,
  setDisplayName,
  setPrimaryPlayer,
  verifyPassword,
} from '../src/identity';

const SECRET_A = 'browser-secret-aaaaaaaaaaaaaaaa';
const SECRET_B = 'browser-secret-bbbbbbbbbbbbbbbb';

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  await resetTestDb(db);
});

async function expectIdentityError(p: Promise<unknown>, code: IdentityError['code']) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).code).toBe(code);
}

describe('resolveToken', () => {
  it('creates a guest player the first time a secret is seen and reuses it after', async () => {
    const first = await resolveToken(db, SECRET_A);
    expect(first.id).toMatch(/^[\w-]{21}$/);
    expect(first.accountId).toBeNull();
    expect(first.displayName).toBe('');

    const again = await resolveToken(db, SECRET_A);
    expect(again.id).toBe(first.id);

    const other = await resolveToken(db, SECRET_B);
    expect(other.id).not.toBe(first.id);
  });

  it('stores only the hash of the secret, and the player id is not derived from it', async () => {
    const player = await resolveToken(db, SECRET_A);
    const rows = await db.select().from(playerTokens);
    expect(rows).toEqual([expect.objectContaining({ tokenHash: hashSecret(SECRET_A), playerId: player.id })]);
    expect(JSON.stringify(rows)).not.toContain(SECRET_A);
    expect(hashSecret(SECRET_A)).not.toContain(player.id);
  });

  it('bumps last_seen_at on every resolve', async () => {
    const t0 = new Date('2026-03-01T10:00:00Z');
    const t1 = new Date('2026-03-02T10:00:00Z');
    const first = await resolveToken(db, SECRET_A, { now: t0 });
    expect(first.createdAt).toEqual(t0);
    const later = await resolveToken(db, SECRET_A, { now: t1 });
    expect(later.createdAt).toEqual(t0);
    expect(later.lastSeenAt).toEqual(t1);
  });

  it('resolves concurrent first sightings of one secret to a single player', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => resolveToken(db, SECRET_A)));
    expect(new Set(results.map((p) => p.id)).size).toBe(1);
    expect(await queryRows(db, sql`select count(*)::int as n from players`)).toEqual([{ n: 1 }]);
  });

  it('rejects missing, short and oversized secrets', async () => {
    await expectIdentityError(resolveToken(db, 'short'), 'invalid-token');
    await expectIdentityError(resolveToken(db, 'x'.repeat(129)), 'invalid-token');
    await expectIdentityError(resolveToken(db, undefined as unknown as string), 'invalid-token');
  });
});

describe('setDisplayName', () => {
  it('trims and collapses whitespace', async () => {
    const p = await resolveToken(db, SECRET_A);
    const named = await setDisplayName(db, p.id, '  Ada   Lovelace ');
    expect(named.displayName).toBe('Ada Lovelace');
    expect((await getPlayer(db, p.id))?.displayName).toBe('Ada Lovelace');
  });

  it('allows emoji and accents but rejects empty, long and control-character names', async () => {
    const p = await resolveToken(db, SECRET_A);
    expect((await setDisplayName(db, p.id, 'Zoë 🃏')).displayName).toBe('Zoë 🃏');
    await expectIdentityError(setDisplayName(db, p.id, '   '), 'invalid-name');
    await expectIdentityError(setDisplayName(db, p.id, 'x'.repeat(25)), 'invalid-name');
    await expectIdentityError(setDisplayName(db, p.id, 'bad\u0007bell'), 'invalid-name');
  });

  it('fails for an unknown player', async () => {
    await expectIdentityError(setDisplayName(db, 'nobody', 'Ada'), 'player-not-found');
  });
});

describe('passwords', () => {
  it('salts each hash and verifies only the right password', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$3\$[^$]+\$[^$]+$/);
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('correct horsf', a)).toBe(false);
    expect(await verifyPassword('correct horse', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('correct horse', 'scrypt$0$8$1$AAAA$AAAA')).toBe(false);
  });

  it('treats canonically equivalent unicode passwords as the same', async () => {
    const hash = await hashPassword('café-password');
    expect(await verifyPassword('café-password', hash)).toBe(true);
  });
});

describe('accounts', () => {
  it('creates an account that owns the guest player and stores no plaintext password', async () => {
    const guest = await resolveToken(db, SECRET_A);
    const account = await createAccount(db, 'Ada_L', 'hunter2hunter2', guest.id);
    expect(account).toMatchObject({ username: 'Ada_L', primaryPlayerId: guest.id });
    expect(account).not.toHaveProperty('passwordHash');
    expect((await getPlayer(db, guest.id))?.accountId).toBe(account.id);

    const [row] = await db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(row.passwordHash).not.toContain('hunter2');
    expect(await verifyPassword('hunter2hunter2', row.passwordHash)).toBe(true);
  });

  it('logs in with the right password, case-insensitively on the username', async () => {
    const guest = await resolveToken(db, SECRET_A);
    const account = await createAccount(db, 'Ada_L', 'hunter2hunter2', guest.id);
    const res = await login(db, 'ada_l', 'hunter2hunter2');
    expect(res.account).toEqual(account);
    expect(res.token.length).toBeGreaterThanOrEqual(40);

    const [stored] = await db.select().from(sessions);
    expect(stored.tokenHash).toBe(hashSecret(res.token));
    expect(stored.tokenHash).not.toBe(res.token);
  });

  it('rejects a wrong password and an unknown username with the same error', async () => {
    const guest = await resolveToken(db, SECRET_A);
    await createAccount(db, 'ada', 'hunter2hunter2', guest.id);
    await expectIdentityError(login(db, 'ada', 'hunter3hunter3'), 'bad-credentials');
    await expectIdentityError(login(db, 'nobody', 'hunter2hunter2'), 'bad-credentials');
    await expectIdentityError(login(db, 'ada', ''), 'bad-credentials');
    await expectIdentityError(login(db, 'ada', 'x'.repeat(500)), 'bad-credentials');
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it('keeps usernames unique ignoring case', async () => {
    const a = await resolveToken(db, SECRET_A);
    const b = await resolveToken(db, SECRET_B);
    await createAccount(db, 'Ada', 'hunter2hunter2', a.id);
    await expectIdentityError(createAccount(db, 'ADA', 'hunter2hunter2', b.id), 'username-taken');
    await expectIdentityError(createAccount(db, 'ada', 'hunter2hunter2', b.id), 'username-taken');
    expect((await getPlayer(db, b.id))?.accountId).toBeNull();
    expect((await findAccountByUsername(db, 'aDa'))?.username).toBe('Ada');
  });

  it('validates usernames and passwords before touching the database', async () => {
    const guest = await resolveToken(db, SECRET_A);
    await expectIdentityError(createAccount(db, 'ab', 'hunter2hunter2', guest.id), 'invalid-username');
    await expectIdentityError(createAccount(db, 'has space', 'hunter2hunter2', guest.id), 'invalid-username');
    await expectIdentityError(createAccount(db, '.dotfirst', 'hunter2hunter2', guest.id), 'invalid-username');
    await expectIdentityError(createAccount(db, 'x'.repeat(25), 'hunter2hunter2', guest.id), 'invalid-username');
    await expectIdentityError(createAccount(db, 'ada', 'short', guest.id), 'weak-password');
  });

  it('refuses an unknown player or a player that already has an account', async () => {
    const guest = await resolveToken(db, SECRET_A);
    await expectIdentityError(createAccount(db, 'ada', 'hunter2hunter2', 'missing'), 'player-not-found');
    await createAccount(db, 'ada', 'hunter2hunter2', guest.id);
    await expectIdentityError(createAccount(db, 'ada2', 'hunter2hunter2', guest.id), 'already-linked');
    expect(await findAccountByUsername(db, 'ada2')).toBeNull();
  });
});

describe('sessions', () => {
  it('resolves a session until it expires', async () => {
    const guest = await resolveToken(db, SECRET_A);
    const account = await createAccount(db, 'ada', 'hunter2hunter2', guest.id);
    const now = new Date('2026-05-01T00:00:00Z');
    const { token, session } = await login(db, 'ada', 'hunter2hunter2', { now, ttlMs: 60_000 });
    expect(session.expiresAt).toEqual(new Date(now.getTime() + 60_000));

    const live = await resolveSession(db, token, { now: new Date(now.getTime() + 59_999) });
    expect(live?.account).toEqual(account);
    expect(live?.session.id).toBe(session.id);
    expect(await resolveSession(db, token, { now: new Date(now.getTime() + 60_000) })).toBeNull();
    expect(await resolveSession(db, 'not-a-real-session-token-at-all')).toBeNull();
    expect(await resolveSession(db, '')).toBeNull();
  });

  it('works across devices: each login is its own session', async () => {
    const guest = await resolveToken(db, SECRET_A);
    await createAccount(db, 'ada', 'hunter2hunter2', guest.id);
    const phone = await login(db, 'ada', 'hunter2hunter2');
    const laptop = await login(db, 'ADA', 'hunter2hunter2');
    expect(phone.token).not.toBe(laptop.token);
    expect((await resolveSession(db, phone.token))?.account.id).toBe(phone.account.id);
    expect(await logout(db, phone.token)).toBe(true);
    expect(await logout(db, phone.token)).toBe(false);
    expect(await resolveSession(db, phone.token)).toBeNull();
    expect(await resolveSession(db, laptop.token)).not.toBeNull();
  });

  it('cleans up the account’s expired sessions on the next login', async () => {
    const guest = await resolveToken(db, SECRET_A);
    await createAccount(db, 'ada', 'hunter2hunter2', guest.id);
    const t0 = new Date('2026-05-01T00:00:00Z');
    await login(db, 'ada', 'hunter2hunter2', { now: t0, ttlMs: 1000 });
    await login(db, 'ada', 'hunter2hunter2', { now: new Date(t0.getTime() + 5000), ttlMs: 1000 });
    expect(await db.select().from(sessions)).toHaveLength(1);
  });
});

describe('linking guests to accounts', () => {
  it('links a second device’s guest id and keeps the first as primary', async () => {
    const home = await resolveToken(db, SECRET_A);
    const account = await createAccount(db, 'ada', 'hunter2hunter2', home.id);
    const phone = await resolveToken(db, SECRET_B);

    const linked = await linkPlayerToAccount(db, account.id, phone.id);
    expect(linked.accountId).toBe(account.id);
    expect((await playersForAccount(db, account.id)).map((p) => p.id).sort()).toEqual([home.id, phone.id].sort());
    expect((await login(db, 'ada', 'hunter2hunter2')).account.primaryPlayerId).toBe(home.id);

    // The phone's secret still resolves to its own player, now owned by the account.
    expect((await resolveToken(db, SECRET_B)).accountId).toBe(account.id);
  });

  it('is idempotent for the same account and refuses a player owned by another', async () => {
    const a = await resolveToken(db, SECRET_A);
    const b = await resolveToken(db, SECRET_B);
    const accA = await createAccount(db, 'ada', 'hunter2hunter2', a.id);
    const accB = await createAccount(db, 'bob', 'hunter2hunter2', b.id);
    expect((await linkPlayerToAccount(db, accA.id, a.id)).accountId).toBe(accA.id);
    await expectIdentityError(linkPlayerToAccount(db, accA.id, b.id), 'already-linked');
    await expectIdentityError(linkPlayerToAccount(db, 'missing', a.id), 'account-not-found');
    await expectIdentityError(linkPlayerToAccount(db, accA.id, 'missing'), 'player-not-found');
    expect((await getPlayer(db, b.id))?.accountId).toBe(accB.id);
  });

  it('switches the primary player only to a linked one', async () => {
    const home = await resolveToken(db, SECRET_A);
    const phone = await resolveToken(db, SECRET_B);
    const account = await createAccount(db, 'ada', 'hunter2hunter2', home.id);
    await expectIdentityError(setPrimaryPlayer(db, account.id, phone.id), 'not-linked');
    await linkPlayerToAccount(db, account.id, phone.id);
    expect((await setPrimaryPlayer(db, account.id, phone.id)).primaryPlayerId).toBe(phone.id);
  });
});
