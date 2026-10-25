// "Sign in with Google": OpenID Connect with the authorization code flow and
// PKCE. The browser asks /api/auth/google/begin for Google's address (sending
// its guest secret and session like every account call), goes there, and
// Google sends it back to /auth/google/callback. The server swaps the code for
// an ID token straight from Google, then signs the browser in (or makes the
// account, or links Google to the signed-in account) and hands the session
// token to the page in the address fragment, which never reaches a server.
// Off unless GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.

import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import type { Db } from './db';
import { adoptGuest, createGoogleAccount, findAccountByGoogle, getPlayer, IdentityError, linkGoogle, openSession, setDisplayName, unlinkGoogle, whoIs } from './identity';
import { clientAddress, limiter } from './admin';
import type { AccountHooks } from './accounts';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** The site's address, e.g. https://rsdp-poker-live.fly.dev; defaults to the request's own. */
  publicUrl?: string;
  /** Swaps a code for tokens at Google; tests pass a fake. */
  exchange?: (form: URLSearchParams) => Promise<{ id_token?: string }>;
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
/** How long someone has to finish at Google. */
const PENDING_MS = 10 * 60_000;
const PENDING_MAX = 2_000;
const BEGINS_PER_WINDOW = 20;

interface Pending {
  mode: 'signin' | 'link';
  guestId: string;
  /** For linking: the account signed in when it began. */
  accountId: string | null;
  bringOver: boolean;
  verifier: string;
  nonce: string;
  redirectUri: string;
  expires: number;
}

/** The Google settings from the environment, or null when sign-in with Google is off. */
export function googleFromEnv(env = process.env): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret, publicUrl: env.PUBLIC_URL?.trim() || undefined } : null;
}

const b64url = (b: Buffer) => b.toString('base64url');

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

export function googleRoutes(app: express.Express, db: Db | null, opts: { config: GoogleConfig | null; hooks: AccountHooks; now: () => number; log: (message: string, err?: unknown) => void }) {
  const { config, hooks, now, log } = opts;
  const pending = new Map<string, Pending>();
  const begins = limiter(BEGINS_PER_WINDOW, PENDING_MS, now);
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

  app.post('/api/auth/google/begin', json, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!enabled || !config || !db) return void res.status(404).json({ error: 'Sign in with Google is not set up on this server.' });
    if (!begins(clientAddress(req))) return void res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
    const mode = req.body?.mode === 'link' ? 'link' : 'signin';
    whoIs(db, req.get('x-guest-token') ?? '', req.get('x-session-token'))
      .then((who) => {
        if (mode === 'signin' && who.account) return void res.status(409).json({ error: `You're signed in as ${who.account.username}. Sign out first.` });
        if (mode === 'link' && !who.account) return void res.status(401).json({ error: 'Sign in first.' });
        const t = now();
        for (const [k, p] of pending) if (p.expires <= t) pending.delete(k);
        if (pending.size >= PENDING_MAX) return void res.status(503).json({ error: 'Busy right now. Try again in a minute.' });
        const state = b64url(randomBytes(24));
        const verifier = b64url(randomBytes(32));
        const nonce = b64url(randomBytes(16));
        const redirectUri = `${siteUrl(req)}/auth/google/callback`;
        pending.set(state, { mode, guestId: who.guest.id, accountId: who.account?.id ?? null, bringOver: req.body?.bringOver === true, verifier, nonce, redirectUri, expires: t + PENDING_MS });
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
          prompt: 'select_account',
        }).toString();
        res.json({ ok: true, url: url.toString() });
      })
      .catch((e: unknown) => {
        log('google begin failed', e);
        res.status(500).json({ error: 'Something went wrong. Try again.' });
      });
  });

  /** Back to the app: `#session=...` on success, `#error=...` otherwise. */
  const finish = (res: express.Response, fragment: Record<string, string>) => {
    res.set('Cache-Control', 'no-store').redirect(303, `/auth/done#${new URLSearchParams(fragment).toString()}`);
  };

  app.get('/auth/google/callback', (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const p = pending.get(state);
    pending.delete(state);
    if (!enabled || !config || !db) return finish(res, { error: 'Sign in with Google is not set up on this server.' });
    if (!p || p.expires <= now()) return finish(res, { error: 'That sign-in took too long or was already used. Try again.' });
    if (typeof req.query.error === 'string') return finish(res, { error: req.query.error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in did not work. Try again.' });
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return finish(res, { error: 'Google sign-in did not work. Try again.' });

    (async () => {
      const tokens = await exchange(
        new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: p.redirectUri, grant_type: 'authorization_code', code_verifier: p.verifier }),
      );
      const c = tokens.id_token ? claims(tokens.id_token) : null;
      const sub = typeof c?.sub === 'string' ? c.sub : '';
      const valid =
        !!c && !!sub && ISSUERS.includes(String(c.iss)) && c.aud === config.clientId && typeof c.exp === 'number' && c.exp * 1000 > now() && c.nonce === p.nonce;
      if (!valid) {
        log('google id token rejected', { iss: c?.iss, aud: c?.aud });
        return finish(res, { error: 'Google sign-in did not work. Try again.' });
      }
      const at = new Date(now());

      if (p.mode === 'link') {
        if (!p.accountId) return finish(res, { error: 'Sign in first.' });
        await linkGoogle(db, p.accountId, sub);
        return finish(res, { linked: '1' });
      }

      let account = await findAccountByGoogle(db, sub);
      let fresh = false;
      let merged = false;
      if (account) {
        merged = p.bringOver && (await adoptGuest(db, account.id, p.guestId));
      } else {
        const name = typeof c.name === 'string' ? c.name : typeof c.given_name === 'string' ? c.given_name : '';
        const made = await createGoogleAccount(db, { sub, name, guestId: p.guestId }, { now: at });
        account = made.account;
        fresh = true;
        // A new player (or a guest who never picked a name) is called by their Google first name at the table.
        const player = await getPlayer(db, account.primaryPlayerId);
        const tableName = (typeof c.given_name === 'string' ? c.given_name : name).trim().slice(0, 20);
        if (player && !player.displayName && tableName) await setDisplayName(db, player.id, tableName).catch(() => {});
      }
      const { token } = await openSession(db, account, { now: at });
      hooks.signedIn(account.primaryPlayerId);
      finish(res, { session: token, ...(fresh ? { welcome: '1' } : {}), ...(merged ? { merged: '1' } : {}) });
    })().catch((e: unknown) => {
      if (e instanceof IdentityError && e.code === 'google-taken') return finish(res, { error: 'That Google account already belongs to another account here.' });
      log('google callback failed', e);
      finish(res, { error: 'Google sign-in did not work. Try again.' });
    });
  });

  app.post('/api/account/google/unlink', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!db) return void res.status(503).json({ error: 'Accounts are not available on this server.' });
    whoIs(db, req.get('x-guest-token') ?? '', req.get('x-session-token'))
      .then(async (who) => {
        if (!who.account) return void res.status(401).json({ error: 'Sign in first.' });
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
