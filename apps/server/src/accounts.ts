// Optional accounts: sign up, sign in on other devices, sign out, change or
// reset a password, delete the account, and the profile page's history
// (with tables hidden from it).
// Guests never need any of this. A browser proves who it is with its guest
// secret (X-Guest-Token) and, once signed in, its session token (X-Session-Token).

import express from 'express';
import { fromLocal, isValidTimeZone, standings, toLocal, type TournamentState } from '@rsdp/tournament';
import { leaderboard, leaderData, practiceResetAt, practiceSessions, practiceTableUse, profitSessions, resetPracticeGraph, setTableHidden, tableHistory, tournamentRows, type Db, type LeaderData, type LeaderRow } from './db';
import { StorageError } from './db/errors';
import {
  adoptGuest,
  checkPassword,
  createAccount,
  deleteAccount,
  forgetDevices,
  forgetToken,
  IdentityError,
  issueResetCode,
  login,
  logout,
  logoutOthers,
  playersForAccount,
  resetPassword,
  setPassword,
  signInMethods,
  whoIs,
  type Identity,
} from './identity';
import { clientAddress, limiter, type AdminCheck } from './admin';
import type { GoogleConfirmations } from './google';

/** Wrong passwords one address, or one username, may try per window before sign-in pauses. */
const SIGN_IN_TRIES = 10;
const SIGN_IN_WINDOW_MS = 15 * 60_000;
/** New accounts one address may make per hour. */
const SIGN_UPS_PER_HOUR = 5;
/** Wrong reset codes one address may try per window. */
const RESET_TRIES = 10;
/** Profile loads one address may make per minute (each one reads hand history). */
const PROFILE_PER_MINUTE = 30;
/** How long a worked-out leaderboard is served before it is worked out again. */
const LEADERBOARD_CACHE_MS = 60_000;

export interface AccountHooks {
  /** A browser now plays as `playerId` (its picture may have come over from the guest). */
  signedIn(playerId: string): void;
  /** These players' names, pictures and secrets were wiped; drop anything kept for them. */
  deleted(playerIds: string[]): void;
  /** The account's sign-ins ended (new password): drop these players' connections, except the browser with `keepGuestToken`. */
  signedOutElsewhere(playerIds: string[], keepGuestToken?: string): void;
  /** How many people have this table open right now (0 when nobody is at it). */
  peopleAt?(tableId: string): number;
  /**
   * Deletes a practice table that only `playerIds` (one person's devices) and bots played at, for good. Once nobody
   * can open the table any more and its last saves are written, `stillOnlyMine` is asked again. Throws a StorageError
   * 'conflict' when it can't go now (someone is at it). Without this hook, practice games are hidden instead.
   */
  deletePracticeTable?(tableId: string, playerIds: string[], stillOnlyMine: () => Promise<boolean>): Promise<void>;
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

export function accountRoutes(
  app: express.Express,
  db: Db | null,
  opts: {
    hooks: AccountHooks;
    isAdmin: AdminCheck;
    confirmations: GoogleConfirmations;
    now: () => number;
    log: (message: string, err?: unknown) => void;
    /** Admin actions go in the public record (audit.ts). */
    onAdmin?: (action: string) => void;
  },
) {
  const { hooks, isAdmin, confirmations, now, log } = opts;
  const json = express.json({ limit: '4kb' });
  const failuresByAddress = limiter(SIGN_IN_TRIES, SIGN_IN_WINDOW_MS, now);
  const failuresByName = limiter(SIGN_IN_TRIES, SIGN_IN_WINDOW_MS, now);
  const signUps = limiter(SIGN_UPS_PER_HOUR, 60 * 60_000, now);
  const resetTries = limiter(RESET_TRIES, SIGN_IN_WINDOW_MS, now);
  const profileLoads = limiter(PROFILE_PER_MINUTE, 60_000, now);

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

  /** Every player id that is me: the account's devices when signed in, else this browser's guest. */
  async function myPlayerIds(who: Identity, db: Db) {
    const ids = who.account ? (await playersForAccount(db, who.account.id)).map((p) => p.id) : [who.player.id];
    if (!ids.includes(who.player.id)) ids.push(who.player.id);
    return ids;
  }

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
      const address = clientAddress(req);
      if (!signUps(address, false)) return void tooMany(res);
      const username = str(req.body?.username).trim();
      const password = str(req.body?.password);
      await createAccount(db, username, password, who.guest.id, { now: new Date(now()) });
      // Only accounts actually made count, so typos don't use up a shared wifi's allowance.
      signUps(address);
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
      // Per username and address, so nobody can lock a friend out by typing wrong passwords for them.
      const name = `u:${username.toLowerCase().slice(0, 64)}@${address}`;
      if (!failuresByAddress(address, false) || !failuresByName(name, false)) return void tooMany(res);
      const who = await identify(req, db);
      if (who.account) return void res.status(409).json({ error: `You're signed in as ${who.account.username}. Sign out first.` });
      let result;
      try {
        result = await login(db, username, password, { now: new Date(now()) });
      } catch (e) {
        if (e instanceof IdentityError && e.code === 'bad-credentials') failuresByAddress(address), failuresByName(name);
        throw e;
      }
      const { token, account } = result;
      // Only when asked (it's their own device): what it did as a guest comes along, its notes and picture,
      // and its tables and tournaments in the history. On a friend's device the friend's guest stays theirs.
      const broughtOver = req.body?.bringOver === true && (await adoptGuest(db, account.id, who.guest.id));
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
      // Only a secret tied to an account is forgotten; a friend's device that was signed in on keeps its own guest.
      const forgot = !!who.guest.accountId;
      if (forgot) await forgetToken(db, req.get('x-guest-token') ?? '');
      res.json({ ok: true, forgot });
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
      // An account made with Google has no password yet: its owner confirms with Google instead of the current one.
      const { hasPassword } = await signInMethods(db, who.account.id);
      if (!hasPassword && !confirmations.fresh(who.account.id, who.guest.id)) return void res.status(403).json({ error: 'Confirm with Google first.', code: 'confirm-google' });
      if (hasPassword && !(await checkPassword(db, who.account.id, req.body?.current))) {
        failuresByAddress(address);
        return void res.status(401).json({ error: 'Your current password is not right.' });
      }
      await setPassword(db, who.account.id, str(req.body?.password));
      confirmations.use(who.account.id, who.guest.id);
      // Other devices have to sign in again with the new password, this one excepted.
      const guestToken = req.get('x-guest-token') ?? '';
      await logoutOthers(db, who.account.id, req.get('x-session-token'));
      await forgetDevices(db, who.account.id, guestToken);
      hooks.signedOutElsewhere((await playersForAccount(db, who.account.id)).map((p) => p.id), guestToken);
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
      // Without a password (a Google account): a fresh confirm with Google, and the username typed.
      const { hasPassword } = await signInMethods(db, who.account.id);
      if (!hasPassword && !confirmations.fresh(who.account.id, who.guest.id)) return void res.status(403).json({ error: 'Confirm with Google first.', code: 'confirm-google' });
      const confirmed = hasPassword
        ? await checkPassword(db, who.account.id, req.body?.password)
        : str(req.body?.username).trim().toLowerCase() === who.account.username.toLowerCase();
      if (!confirmed) {
        failuresByAddress(address);
        return void res.status(401).json({ error: hasPassword ? 'That password is not right.' : 'Type your username exactly to confirm.' });
      }
      confirmations.use(who.account.id, who.guest.id);
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
      let account;
      try {
        account = await resetPassword(db, str(req.body?.username).trim(), str(req.body?.code), str(req.body?.password), { now: new Date(now()) });
      } catch (e) {
        if (e instanceof IdentityError && e.code === 'bad-reset-code') resetTries(address);
        throw e;
      }
      // Every device signs in again, including the one that made the account.
      await forgetDevices(db, account.id);
      hooks.signedOutElsewhere((await playersForAccount(db, account.id)).map((p) => p.id));
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
      // Which account stays private; that one was issued doesn't.
      opts.onAdmin?.('password reset code issued for an account');
      res.json({ ok: true, username: issued.username, code: issued.code, expiresAt: issued.expiresAt.toISOString() });
    }),
  );

  // My result at each real cash game, for the profit graph on my profile.
  app.get(
    '/api/account/graph',
    route(async (req, res, db) => {
      if (!profileLoads(clientAddress(req))) return void tooMany(res);
      const who = await identify(req, db);
      const sessions = await profitSessions(db, await myPlayerIds(who, db));
      res.json({ sessions: sessions.map((x) => ({ ...x, at: x.at.toISOString() })) });
    }),
  );

  // The group's leaderboards: this month, this year or all time. The hands are read at most once a minute for all of
  // them, from every time zone, and each board is worked out once from that read.
  let read: { at: number; data: Promise<LeaderData>; boards: Map<string, Promise<LeaderRow[]>> } | null = null;
  app.get(
    '/api/leaderboard',
    route(async (req, res, db) => {
      if (!profileLoads(clientAddress(req))) return void tooMany(res);
      const period = ['month', 'year', 'all'].includes(String(req.query.period)) ? String(req.query.period) : 'month';
      // The month and year start at midnight where the browser is (it sends its time zone), so a game on the last
      // evening of a month counts in that month. A missing or unknown time zone counts in UTC.
      const tz = typeof req.query.tz === 'string' && req.query.tz.length <= 64 && isValidTimeZone(req.query.tz) ? req.query.tz : 'UTC';
      const t = now();
      const here = toLocal(t, tz);
      const since = period === 'all' ? undefined : new Date(fromLocal({ year: here.year, month: period === 'month' ? here.month : 1, day: 1, hour: 0, minute: 0 }, tz));
      if (!read || t - read.at >= LEADERBOARD_CACHE_MS) {
        const fresh = { at: t, data: leaderData(db), boards: new Map<string, Promise<LeaderRow[]>>() };
        read = fresh;
        fresh.data.catch(() => read === fresh && (read = null));
      }
      const { data, boards } = read;
      // Time zones whose period starts at the same moment share one answer.
      const key = `${period} ${since?.getTime() ?? ''}`;
      let rows = boards.get(key);
      if (!rows) {
        const made = data.then((d) => leaderboard(db, d, since));
        boards.set(key, (rows = made));
        made.catch(() => boards.get(key) === made && boards.delete(key));
      }
      res.json({ period, since: since?.toISOString() ?? null, rows: await rows });
    }),
  );

  // Hide a cash table from my profile, or show it again. Only my own list changes; the table stays for everyone else.
  app.post(
    '/api/account/tables/hide',
    json,
    route(async (req, res, db) => {
      const who = await identify(req, db);
      const tableId = str(req.body?.tableId);
      if (!/^[\w-]{4,40}$/.test(tableId)) return void res.status(400).json({ error: 'No such table.' });
      const found = await setTableHidden(db, who.player.id, await myPlayerIds(who, db), tableId, req.body?.hidden !== false);
      if (!found) return void res.status(404).json({ error: 'No such table.' });
      res.json({ ok: true });
    }),
  );

  // My practice results (bots, or on my own) since I last reset the practice graph. Never mixed into the real graph.
  app.get(
    '/api/account/practice-graph',
    route(async (req, res, db) => {
      if (!profileLoads(clientAddress(req))) return void tooMany(res);
      const who = await identify(req, db);
      const ids = await myPlayerIds(who, db);
      const since = await practiceResetAt(db, ids);
      const sessions = await practiceSessions(db, ids, since);
      res.json({ since: since?.toISOString() ?? null, sessions: sessions.map((x) => ({ ...x, at: x.at.toISOString() })) });
    }),
  );

  // Start the practice graph again from now. The games stay in my list; only the graph forgets them.
  app.post(
    '/api/account/practice-graph/reset',
    json,
    route(async (req, res, db) => {
      const who = await identify(req, db);
      await resetPracticeGraph(db, who.player.id, new Date(now()));
      res.json({ ok: true });
    }),
  );

  // Delete practice games from my profile: one ({ tableId }) or all of them ({ all: true }). A table I made that only I
  // and bots played at is deleted for good; any other is only hidden from my profile, so other people's records stay. Real games are never deleted here (hide them instead). The public record keeps the hands' fingerprints
  // and notes the deletion, as when a host deletes a table.
  app.post(
    '/api/account/tables/delete-practice',
    json,
    route(async (req, res, db) => {
      const who = await identify(req, db);
      const ids = await myPlayerIds(who, db);
      const all = req.body?.all === true;
      const tableId = str(req.body?.tableId);
      if (!all && !/^[\w-]{4,40}$/.test(tableId)) return void res.status(400).json({ error: 'No such table.' });
      const targets = all ? (await tableHistory(db, ids, 500)).filter((t) => t.practice).map((t) => t.tableId) : [tableId];
      const done = { deleted: 0, hidden: 0, busy: 0 };
      for (const id of targets) {
        const use = await practiceTableUse(db, id, ids);
        if (!use || !use.mine) {
          if (!all) return void res.status(404).json({ error: 'No such table.' });
          continue;
        }
        if (!use.practice) {
          if (!all) return void res.status(409).json({ error: "That was a real game, so it can't be deleted. You can hide it from your profile instead." });
          continue;
        }
        // Only a table I made goes for good: one someone else made (and maybe only watched) stays theirs.
        if (use.others || !use.owner || !hooks.deletePracticeTable) {
          await setTableHidden(db, who.player.id, ids, id, true);
          done.hidden++;
          continue;
        }
        try {
          await hooks.deletePracticeTable(id, ids, async () => {
            const again = await practiceTableUse(db, id, ids);
            return !!again && again.practice && again.owner && !again.others;
          });
          done.deleted++;
        } catch (e) {
          if (!(e instanceof StorageError && e.code === 'conflict')) throw e;
          if (!all) return void res.status(409).json({ error: e.message });
          done.busy++;
        }
      }
      res.json({ ok: true, ...done });
    }),
  );

  // The profile: who you are and what you've played, on every device you've signed in on. Guests see this device's.
  app.get(
    '/api/account/me',
    route(async (req, res, db) => {
      if (!profileLoads(clientAddress(req))) return void tooMany(res);
      const who = await identify(req, db);
      const ids = await myPlayerIds(who, db);
      const [tables, hidden, tournaments] = await Promise.all([tableHistory(db, ids, 50), tableHistory(db, ids, 25, { hidden: true }), tournamentRows<TournamentState>(db, ids)]);
      const mine = new Set(ids);
      res.json({
        playerId: who.player.id,
        displayName: who.player.displayName,
        account: who.account && { username: who.account.username, createdAt: who.account.createdAt.toISOString(), devices: ids.length, ...(await signInMethods(db, who.account.id)) },
        tables: tables.map((t) => ({ ...t, lastPlayedAt: t.lastPlayedAt.toISOString(), playingNow: hooks.peopleAt?.(t.tableId) ?? 0 })),
        hiddenTables: hidden.map((t) => ({ ...t, lastPlayedAt: t.lastPlayedAt.toISOString() })),
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
