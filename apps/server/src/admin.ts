// Small helpers shared by the HTTP routes: rate limits, the caller's address,
// and the ADMIN_KEY check for the admin pages.

import { createHash, timingSafeEqual } from 'node:crypto';
import type express from 'express';

/** Sliding-window counter: true (and counted) when `key` has room for one more. */
export function limiter(burst: number, windowMs: number, now: () => number) {
  const hits = new Map<string, number[]>();
  return (key: string, count = true) => {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((x) => x > t - windowMs);
    if (recent.length >= burst) return hits.set(key, recent), false;
    if (count) recent.push(t);
    if (recent.length) hits.set(key, recent);
    else hits.delete(key);
    // Old keys are swept now and then.
    if (hits.size > 5_000) for (const [k, v] of hits) if (v.every((x) => x <= t - windowMs)) hits.delete(k);
    return true;
  };
}

/** The caller's address; Fly puts the real one in a header. */
export const clientAddress = (req: express.Request) => req.get('fly-client-ip') ?? req.socket.remoteAddress ?? '';

/** Wrong admin keys one address may try per window. */
const ADMIN_TRIES = 10;
const ADMIN_WINDOW_MS = 10 * 60_000;

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Responds and returns false unless the request carries the admin key (header X-Admin-Key). */
export type AdminCheck = (req: express.Request, res: express.Response) => boolean;

/** One check for every admin route, so wrong keys count against one limit. */
export function adminGate(key: string | undefined, now: () => number): AdminCheck {
  // A short key would be guessable; treat it as unset.
  const adminKey = key && key.length >= 12 ? digest(key) : null;
  const tries = limiter(ADMIN_TRIES, ADMIN_WINDOW_MS, now);
  return (req, res) => {
    if (!adminKey) return res.status(403).json({ error: 'The admin key is not set up on this server yet.' }), false;
    const ip = clientAddress(req);
    if (!tries(ip, false)) return res.status(429).json({ error: 'Too many wrong keys. Try again in a few minutes.' }), false;
    const given = req.get('x-admin-key') ?? '';
    if (given && timingSafeEqual(digest(given), adminKey)) return true;
    tries(ip);
    res.status(401).json({ error: 'That admin key is not right.' });
    return false;
  };
}
