// Optional accounts: sign up, sign in on other devices, sign out, change or
// reset a password, delete the account, and the profile page's history.
// Guests never need any of this. A browser proves who it is with its guest
// secret (X-Guest-Token) and, once signed in, its session token (X-Session-Token).

import express from 'express';
import { standings, type TournamentState } from '@rsdp/tournament';
import { tableHistory, tournamentRows, type Db } from './db';
import {
  adoptGuest,
  checkPassword,
  createAccount,
  deleteAccount,
  forgetToken,
  IdentityError,
  issueResetCode,
  login,
  logout,
  logoutOthers,
  playersForAccount,
  resetPassword,
  setPassword,
  whoIs,
  type Identity,
} from './identity';
import { clientAddress, limiter, type AdminCheck } from './admin';

/** Wrong passwords one address, or one username, may try per window before sign-in pauses. */
const SIGN_IN_TRIES = 10;
const SIGN_IN_WINDOW_MS = 15 * 60_000;
/** New accounts one address may make per hour. */
const SIGN_UPS_PER_HOUR = 5;
/** Wrong reset codes one address may try per window. */
const RESET_TRIES = 10;

export interface AccountHooks {
  /** A browser now plays as `playerId` (its picture may have come over from the guest). */
  signedIn(playerId: string): void;
  /** These players' names, pictures and secrets were wiped; drop anything kept for them. */
  deleted(playerIds: string[]): void;
}

const HTTP_STATUS: Partial<Record<IdentityError['code'], number>> = {
  'bad-credentials': 401,
  'bad-reset-code': 401,
  'username-taken': 409,
  'already-linked': 409,
  'account-not-found': 404,
  'invalid-token': 401,
};

/** User-facing words for the identity errors people can hit here. */
const MESSAGE: Partial<Record<IdentityError['code'], string>> = {
  'invalid-username': 'Usernames are 3 to 24 letters, numbers, dots, dashes or underscores.',
  'weak-password': 'Passwords need at least 8 characters.',
  'username-taken': 'That username is taken. Try another one.',
  'bad-credentials': 'Wrong username or password.',
  'bad-reset-code': 'That reset code is wrong or has expired. Ask the admin for a new one.',
  'already-linked': 'This device already belongs to an account. Sign in to it instead, or sign out first.',
  'account-not-found': 'No account has that username.',
};

export function accountRoutes(app: express.Express, db: Db | null, opts: { hooks: AccountHooks; isAdmin: AdminCheck; now: () => number; log: (message: string, err?: unknown) => void }) {
  const { hooks, isAdmin, now, log } = opts;
  const json = express.json({ limit: '4kb' });
  const failuresByAddress = limiter(SIGN_IN_TRIES, SIGN_IN_WINDOW_MS, now);
  const failuresByName = limiter(SIGN_IN_TRIES, SIGN_IN_WINDOW_MS, now);
  const signUps = limiter(SIGN_UPS_PER_HOUR, 60 * 60_000, now);
  const resetTries = limiter(RESET_TRIES, SIGN_IN_WINDOW_MS, now);

  const tooMany = (res: express.Response) => res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  /** Runs a route; identity errors become a clear message, anything else a 500. */
  const route =
    (fn: (req: express.Request, res: express.Response, db: Db) => Promise<unknown>) =>
    (req: express.Request, res: express.Response) => {
      res.set('Cache-Control', 'no-store');
      if (!db) return void res.status(503).json({ error: 'Accounts are not available on this server.' });
      fn(req, res, db).catch((e: unknown) => {
        if (e instanceof IdentityError) return void res.status(HTTP_STATUS[e.code] ?? 400).json({ error: MESSAGE[e.code] ?? e.message, code: e.code });
        log('account route failed', e);
        res.status(500).json({ error: 'Something went wrong. Try again.' });
      });
    };

  const identify = (req: express.Request, db: Db): Promise<Identity> => whoIs(db, req.get('x-guest-token') ?? '', req.get('x-session-token'), { now: new Date(now()) });

  /** The signed-in account, or a 401 response. */
  async function signedIn(req: express.Request, res: express.Response, db: Db) {
    const who = await identify(req, db);
    if (!who.account) return void res.status(401).json({ error: 'Sign in first.' });
    return who as Identity & { account: NonNullable<Identity['account']> };
  }

  app.post(
    '/api/account/signup',
    json,
    route(async (req, res, db) => {
      const who = await identify(req, db);
      if (who.account) return void res.status(409).json({ error: `You're signed in as ${who.account.username}. Sign out first.` });
      if (!signUps(clientAddress(req))) return void tooMany(res);
      const username = str(req.body?.username).trim();
      const password = str(req.body?.password);
      await createAccount(db, username, password, who.guest.id, { now: new Date(now()) });
      const { token, account } = await login(db, username, password, { now: new Date(now()) });
      res.json({ ok: true, session: token, username: account.username });
    }),
  );

  app.post(
    '/api/account/signin',
    json,
    route(async (req, res, db) => {
      const username = str(req.body?.username).trim();
      const password = str(req.body?.password);
      const address = clientAddress(req);
      const name = `u:${username.toLowerCase().slice(0, 64)}`;
      if (!failuresByAddress(address, false) || !failuresByName(name, false)) return void tooMany(res);
      const who = await identify(req, db);
      let result;
      try {
        result = await login(db, username, password, { now: new Date(now()) });
      } catch (e) {
        if (e instanceof IdentityError && e.code === 'bad-credentials') failuresByAddress(address), failuresByName(name);
        throw e;
      }
      const { token, account } = result;
      // What this device did as a guest comes along: its notes and picture, and its tables and tournaments in the history.
      const broughtOver = await adoptGuest(db, account.id, who.guest.id);
      hooks.signedIn(account.primaryPlayerId);
      res.json({ ok: true, session: token, username: account.username, broughtOver });
    }),
  );

  // The browser also throws its guest secret away and starts over as a new guest.
  app.post(
    '/api/account/signout',
    route(async (req, res, db) => {
      const session = req.get('x-session-token');
      if (session) await logout(db, session);
      const who = await identify(req, db);
      // Only a secret tied to an account is forgotten, so a guest who presses this by mistake loses nothing.
      if (who.guest.accountId) await forgetToken(db, req.get('x-guest-token') ?? '');
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/account/password',
    json,
    route(async (req, res, db) => {
      const who = await signedIn(req, res, db);
      if (!who) return;
      const address = clientAddress(req);
      if (!failuresByAddress(address, false)) return void tooMany(res);
      if (!(await checkPassword(db, who.account.id, req.body?.current))) {
        failuresByAddress(address);
        return void res.status(401).json({ error: 'Your current password is not right.' });
      }
      await setPassword(db, who.account.id, str(req.body?.password));
      // Other devices have to sign in again with the new password.
      await logoutOthers(db, who.account.id, req.get('x-session-token'));
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/account/delete',
    json,
    route(async (req, res, db) => {
      const who = await signedIn(req, res, db);
      if (!who) return;
      const address = clientAddress(req);
      if (!failuresByAddress(address, false)) return void tooMany(res);
      if (!(await checkPassword(db, who.account.id, req.body?.password))) {
        failuresByAddress(address);
        return void res.status(401).json({ error: 'That password is not right.' });
      }
      const ids = await deleteAccount(db, who.account.id);
      hooks.deleted(ids);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/account/reset',
    json,
    route(async (req, res, db) => {
      const address = clientAddress(req);
      if (!resetTries(address, false)) return void tooMany(res);
      try {
        await resetPassword(db, str(req.body?.username).trim(), str(req.body?.code), str(req.body?.password), { now: new Date(now()) });
      } catch (e) {
        if (e instanceof IdentityError && e.code === 'bad-reset-code') resetTries(address);
        throw e;
      }
      res.json({ ok: true });
    }),
  );

  // The admin makes a one-time code for someone who forgot their password, and sends it to them (in WhatsApp, say).
  app.post(
    '/api/admin/accounts/reset-code',
    json,
    route(async (req, res, db) => {
      if (!isAdmin(req, res)) return;
      const issued = await issueResetCode(db, str(req.body?.username).trim(), { now: new Date(now()) });
      res.json({ ok: true, username: issued.username, code: issued.code, expiresAt: issued.expiresAt.toISOString() });
    }),
  );

  // The profile: who you are and what you've played, on every device you've signed in on. Guests see this device's.
  app.get(
    '/api/account/me',
    route(async (req, res, db) => {
      const who = await identify(req, db);
      const ids = who.account ? (await playersForAccount(db, who.account.id)).map((p) => p.id) : [who.player.id];
      if (!ids.includes(who.player.id)) ids.push(who.player.id);
      const [tables, tournaments] = await Promise.all([tableHistory(db, ids), tournamentRows<TournamentState>(db, ids)]);
      const mine = new Set(ids);
      res.json({
        playerId: who.player.id,
        displayName: who.player.displayName,
        account: who.account && { username: who.account.username, createdAt: who.account.createdAt.toISOString(), devices: ids.length },
        tables: tables.map((t) => ({ ...t, lastPlayedAt: t.lastPlayedAt.toISOString() })),
        tournaments: tournaments.flatMap((row) => {
          const s = row.state;
          if (!s?.settings || !Array.isArray(s.entries)) return [];
          const placed = standings(s)
            .filter((x) => mine.has(x.playerId))
            .sort((a, b) => (a.place ?? Infinity) - (b.place ?? Infinity));
          const at = s.finishedAt ?? s.startedAt ?? s.startAt ?? s.createdAt;
          return [{
            id: s.id,
            name: s.settings.name,
            status: s.status,
            at: new Date(at).toISOString(),
            entrants: new Set(s.entries.map((e) => e.playerId)).size,
            place: placed[0]?.place ?? null,
            prize: placed.reduce((a, x) => a + x.prize, 0),
            entered: placed.length > 0,
            hosted: mine.has(row.hostPlayerId),
          }];
        }),
      });
    }),
  );
}
