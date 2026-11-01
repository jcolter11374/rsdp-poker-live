// "Sign in with Google": OpenID Connect with the authorization code flow and
// PKCE. Everything is tied to the browser that started it, so a Google link
// passed to someone else (or a callback address, or a finished result) can't
// sign them in to the wrong account:
//
// 1. The page asks POST /api/auth/google/begin for Google's address, sending
//    its guest secret and session like every account call. The server keeps
//    the flow under a one-time `state` and sets an HttpOnly cookie holding a
//    random value only this browser has.
// 2. Google sends the browser to GET /auth/google/callback. The cookie must
//    match. The server swaps the code for an ID token straight from Google,
//    checks it, and sends the page to /auth/done with a one-time ticket.
// 3. The page posts the ticket to POST /api/auth/google/finish with its guest
//    secret and session; the cookie, the guest and (for linking) the signed-in
//    account must all still match. Only then does anything change.
//
// Off unless GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Db } from './db';
import { adoptGuest, checkPassword, createGoogleAccount, findAccountByGoogle, getPlayer, IdentityError, linkGoogle, openSession, setDisplayName, signInMethods, unlinkGoogle, whoIs } from './identity';
import { clientAddress, limiter } from './admin';
import { heldMessage, type AccountHooks } from './accounts';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** The site's address, e.g. https://rsdp-poker-live.fly.dev; defaults to the request's own. */
  publicUrl?: string;
  /** Swaps a code for tokens at Google; tests pass a fake. */
  exchange?: (form: URLSearchParams) => Promise<{ id_token?: string }>;
}

/**
 * Accounts made with Google have no password, so before one sets its first
 * password or is deleted, its owner signs in with Google again ("confirm with
 * Google"). That counts for a few minutes, on that browser only.
 */
export interface GoogleConfirmations {
  mark(accountId: string, guestId: string): void;
  fresh(accountId: string, guestId: string): boolean;
  /** A confirm is good for one change. */
  use(accountId: string, guestId: string): void;
}

const CONFIRM_MS = 5 * 60_000;
/** A confirm needs a Google sign-in this recent, not just an open Google session. */
const CONFIRM_LOGIN_S = 300;

export function googleConfirmations(now: () => number): GoogleConfirmations {
  const until = new Map<string, number>();
  return {
    mark(accountId, guestId) {
      const t = now();
      for (const [k, v] of until) if (v <= t) until.delete(k);
      until.set(`${accountId}:${guestId}`, t + CONFIRM_MS);
    },
    fresh: (accountId, guestId) => (until.get(`${accountId}:${guestId}`) ?? 0) > now(),
    use: (accountId, guestId) => void until.delete(`${accountId}:${guestId}`),
  };
}

type Mode = 'signin' | 'link' | 'confirm';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
/** How long someone has to finish at Google, and then to come back to the page. */
const PENDING_MS = 10 * 60_000;
const TICKET_MS = 2 * 60_000;
const PENDING_MAX = 2_000;
const BEGINS_PER_WINDOW = 20;
/** Wrong passwords allowed when unlinking Google, per address and per account, in a window (as signing in allows). */
const UNLINK_TRIES = 10;
const UNLINK_WINDOW_MS = 15 * 60_000;
const COOKIE = 'rsdp_google';

interface Flow {
  mode: Mode;
  guestId: string;
  /** For linking and confirming: the account signed in when it began. */
  accountId: string | null;
  bringOver: boolean;
  /** sha256 of the cookie value only the starting browser holds. */
  bind: string;
  expires: number;
}
interface Pending extends Flow {
  verifier: string;
  nonce: string;
  redirectUri: string;
}
interface Ticket extends Flow {
  sub: string;
  /** When the person last typed their Google password, in seconds (0 when Google didn't say). */
  authTime: number;
  name: string;
  givenName: string;
}

/** Why a Google sign-in failed; the page shows a fixed message for each. */
export type GoogleError = 'stale' | 'off' | 'expired' | 'cancelled' | 'failed' | 'other-browser' | 'taken' | 'signed-in' | 'signed-out' | 'not-yours';

const MESSAGES: Record<GoogleError, string> = {
  stale: 'Google didn’t ask for your password again. Try once more.',
  off: 'Sign in with Google is not set up on this server.',
  expired: 'That sign-in took too long or was already used. Try again.',
  cancelled: 'Google sign-in was cancelled.',
  failed: 'Google sign-in did not work. Try again.',
  'other-browser': 'That Google sign-in was started in another browser. Start it again here.',
  taken: 'That Google account already belongs to another account here.',
  'signed-in': 'You signed in to another account in the meantime. Sign out first.',
  'signed-out': 'You are not signed in any more. Sign in and try again.',
  'not-yours': 'That is not the Google account linked to this account.',
};

/** The Google settings from the environment, or null when sign-in with Google is off. */
export function googleFromEnv(env = process.env): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret, publicUrl: env.PUBLIC_URL?.trim() || undefined } : null;
}

const b64url = (b: Buffer) => b.toString('base64url');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** The claims of an ID token that came straight from Google's token endpoint over TLS (so no signature check is needed, per OpenID Connect 3.1.3.7). */
function claims(idToken: string): Record<string, unknown> | null {
  const part = idToken.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function cookieValue(req: express.Request): string {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return '';
}

/** True when the request carries the cookie of the browser that began `flow`. */
function sameBrowser(req: express.Request, flow: Flow): boolean {
  const value = cookieValue(req);
  return !!value && timingSafeEqual(Buffer.from(sha(value)), Buffer.from(flow.bind));
}

export function googleRoutes(
  app: express.Express,
  db: Db | null,
  opts: { config: GoogleConfig | null; hooks: AccountHooks; confirmations: GoogleConfirmations; now: () => number; log: (message: string, err?: unknown) => void },
) {
  const { config, hooks, confirmations, now, log } = opts;
  const pending = new Map<string, Pending>();
  const tickets = new Map<string, Ticket>();
  const begins = limiter(BEGINS_PER_WINDOW, PENDING_MS, now);
  /** Wrong passwords to unlink Google, by address and by account, as for every other password check. */
  const unlinkFailures = limiter(UNLINK_TRIES, UNLINK_WINDOW_MS, now);
  const json = express.json({ limit: '1kb' });
  const enabled = !!(config && db);

  app.get('/api/auth/config', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ google: enabled });
  });

  const exchange =
    config?.exchange ??
    (async (form: URLSearchParams) => {
      const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
      if (!res.ok) throw new Error(`Google token endpoint answered ${res.status}`);
      return (await res.json()) as { id_token?: string };
    });

  const siteUrl = (req: express.Request) => (config?.publicUrl ?? `${req.get('x-forwarded-proto') ?? req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const sweep = () => {
    const t = now();
    for (const [k, p] of pending) if (p.expires <= t) pending.delete(k);
    for (const [k, p] of tickets) if (p.expires <= t) tickets.delete(k);
  };
  const fail = (res: express.Response, status: number, code: GoogleError) => res.status(status).json({ error: MESSAGES[code], code });

  app.post('/api/auth/google/begin', json, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!enabled || !config || !db) return void fail(res, 404, 'off');
    if (!begins(clientAddress(req))) return void res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
    const mode: Mode = req.body?.mode === 'link' ? 'link' : req.body?.mode === 'confirm' ? 'confirm' : 'signin';
    whoIs(db, req.get('x-guest-token') ?? '', req.get('x-session-token'))
      .then(async (who) => {
        if (mode === 'signin' && who.account) return void fail(res, 409, 'signed-in');
        if (mode !== 'signin' && !who.account) return void fail(res, 401, 'signed-out');
        // Linking needs the password too, so a stolen session can't add its own Google as a way back in.
        if (mode === 'link' && who.account) {
          const { hasPassword } = await signInMethods(db, who.account.id);
          if (hasPassword && !(await checkPassword(db, who.account.id, req.body?.password))) return void res.status(401).json({ error: 'Your password is not right.' });
        }
        sweep();
        if (pending.size >= PENDING_MAX) return void res.status(503).json({ error: 'Busy right now. Try again in a minute.' });
        const state = b64url(randomBytes(24));
        const bind = b64url(randomBytes(24));
        const verifier = b64url(randomBytes(32));
        const nonce = b64url(randomBytes(16));
        const site = siteUrl(req);
        const redirectUri = `${site}/auth/google/callback`;
        pending.set(state, {
          mode,
          guestId: who.guest.id,
          accountId: who.account?.id ?? null,
          bringOver: req.body?.bringOver === true,
          bind: sha(bind),
          verifier,
          nonce,
          redirectUri,
          expires: now() + PENDING_MS,
        });
        res.cookie(COOKIE, bind, { httpOnly: true, sameSite: 'lax', secure: site.startsWith('https:'), path: '/', maxAge: PENDING_MS });
        const url = new URL(AUTH_URL);
        url.search = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'openid profile',
          state,
          nonce,
          code_challenge: b64url(createHash('sha256').update(verifier).digest()),
          code_challenge_method: 'S256',
          // Confirming should really ask, not slip through on an open Google session.
          ...(mode === 'confirm' ? { prompt: 'login', max_age: String(CONFIRM_LOGIN_S) } : { prompt: 'select_account' }),
        }).toString();
        res.json({ ok: true, url: url.toString() });
      })
      .catch((e: unknown) => {
        log('google begin failed', e);
        res.status(500).json({ error: 'Something went wrong. Try again.' });
      });
  });

  /** Back to the page: `#ticket=...` to finish, or `#error=<code>`. */
  const back = (res: express.Response, fragment: { ticket: string } | { error: GoogleError }) => {
    res.set('Cache-Control', 'no-store').redirect(303, `/auth/done#${new URLSearchParams(fragment).toString()}`);
  };

  app.get('/auth/google/callback', (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const p = pending.get(state);
    pending.delete(state);
    if (!enabled || !config || !db) return back(res, { error: 'off' });
    if (!p || p.expires <= now()) return back(res, { error: 'expired' });
    if (!sameBrowser(req, p)) return back(res, { error: 'other-browser' });
    if (typeof req.query.error === 'string') return back(res, { error: req.query.error === 'access_denied' ? 'cancelled' : 'failed' });
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return back(res, { error: 'failed' });

    exchange(new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: p.redirectUri, grant_type: 'authorization_code', code_verifier: p.verifier }))
      .then((tokens) => {
        const c = tokens.id_token ? claims(tokens.id_token) : null;
        const sub = typeof c?.sub === 'string' ? c.sub : '';
        const valid = !!c && !!sub && ISSUERS.includes(String(c.iss)) && c.aud === config.clientId && typeof c.exp === 'number' && c.exp * 1000 > now() && c.nonce === p.nonce;
        if (!valid) {
          log('google id token rejected', { iss: c?.iss, aud: c?.aud });
          return back(res, { error: 'failed' });
        }
        sweep();
        const ticket = b64url(randomBytes(24));
        const str = (v: unknown) => (typeof v === 'string' ? v : '');
        tickets.set(ticket, { mode: p.mode, guestId: p.guestId, accountId: p.accountId, bringOver: p.bringOver, bind: p.bind, sub, authTime: typeof c.auth_time === 'number' ? c.auth_time : 0, name: str(c.name), givenName: str(c.given_name), expires: now() + TICKET_MS });
        back(res, { ticket });
      })
      .catch((e: unknown) => {
        log('google callback failed', e);
        back(res, { error: 'failed' });
      });
  });

  app.post('/api/auth/google/finish', json, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!enabled || !db) return void fail(res, 404, 'off');
    const key = typeof req.body?.ticket === 'string' ? req.body.ticket : '';
    const t = tickets.get(key);
    tickets.delete(key);
    if (!t || t.expires <= now()) return void fail(res, 400, 'expired');
    if (!sameBrowser(req, t)) return void fail(res, 403, 'other-browser');
    res.clearCookie(COOKIE, { path: '/' });

    (async () => {
      const who = await whoIs(db, req.get('x-guest-token') ?? '', req.get('x-session-token'));
      if (who.guest.id !== t.guestId) return void fail(res, 403, 'other-browser');

      if (t.mode === 'link' || t.mode === 'confirm') {
        if (!who.account || who.account.id !== t.accountId) return void fail(res, 401, 'signed-out');
        if (t.mode === 'link') {
          await linkGoogle(db, who.account.id, t.sub);
          return void res.json({ ok: true, linked: true });
        }
        const owner = await findAccountByGoogle(db, t.sub);
        if (owner?.id !== who.account.id) return void fail(res, 403, 'not-yours');
        if (t.authTime * 1000 < now() - (CONFIRM_LOGIN_S + 60) * 1000) return void fail(res, 403, 'stale');
        confirmations.mark(who.account.id, who.guest.id);
        return void res.json({ ok: true, confirmed: true });
      }

      if (who.account) return void fail(res, 409, 'signed-in');
      const at = new Date(now());
      let account = await findAccountByGoogle(db, t.sub);
      let welcome = false;
      let merged = false;
      if (account) {
        // A new account below keeps playing as this guest; an existing one would leave its seat or entry behind.
        const held = await heldMessage(hooks, who.guest.id);
        if (held) return void res.status(409).json(held);
        merged = t.bringOver && (await adoptGuest(db, account.id, who.guest.id));
      } else {
        const made = await createGoogleAccount(db, { sub: t.sub, name: t.name || t.givenName, guestId: who.guest.id }, { now: at });
        account = made.account;
        welcome = true;
        // A new player (or a guest who never picked a name) is called by their Google first name at the table.
        const player = await getPlayer(db, account.primaryPlayerId);
        const tableName = (t.givenName || t.name).trim().slice(0, 20);
        if (player && !player.displayName && tableName) await setDisplayName(db, player.id, tableName).catch(() => {});
      }
      const { token } = await openSession(db, account, { now: at });
      hooks.signedIn(account.primaryPlayerId);
      res.json({ ok: true, session: token, welcome, merged });
    })().catch((e: unknown) => {
      if (e instanceof IdentityError && e.code === 'google-taken') return void fail(res, 409, 'taken');
      log('google finish failed', e);
      res.status(500).json({ error: 'Something went wrong. Try again.' });
    });
  });

  app.post('/api/account/google/unlink', json, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!db) return void res.status(503).json({ error: 'Accounts are not available on this server.' });
    whoIs(db, req.get('x-guest-token') ?? '', req.get('x-session-token'))
      .then(async (who) => {
        if (!who.account) return void res.status(401).json({ error: 'Sign in first.' });
        const keys = [`address:${clientAddress(req)}`, `account:${who.account.id}`];
        if (!keys.every((k) => unlinkFailures(k, false))) return void res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
        const { hasPassword } = await signInMethods(db, who.account.id);
        if (hasPassword && !(await checkPassword(db, who.account.id, req.body?.password))) {
          for (const k of keys) unlinkFailures(k);
          return void res.status(401).json({ error: 'Your password is not right.' });
        }
        await unlinkGoogle(db, who.account.id);
        res.json({ ok: true });
      })
      .catch((e: unknown) => {
        if (e instanceof IdentityError) return void res.status(400).json({ error: 'Set a password first, or you could not sign in any more.' });
        log('google unlink failed', e);
        res.status(500).json({ error: 'Something went wrong. Try again.' });
      });
  });
}
