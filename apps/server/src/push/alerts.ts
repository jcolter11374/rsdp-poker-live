// Phone alerts that reach a closed site: a tournament starting soon, being
// seated or moved, and your turn. A browser that turns alerts on gives the
// server its push subscription (where its push service takes messages, and
// the keys that encrypt them); the server encrypts each alert for that browser
// and hands it to the push service, which only sees the address and ciphertext.
//
// Sending never holds up a table: send() only queues the alert, and the
// queue runs on later turns of the event loop, a few at a time, each push
// service given at most a few seconds.

import express from 'express';
import type { PlayerId } from '@rsdp/engine/core';
import { prunePushSubscriptions, pushTargetsOf, removePushSubscription, removePushSubscriptionsOf, savePushSubscription, vapidKeys, type Db } from '../db';
import { clientAddress, limiter } from '../admin';
import { encryptPayload, newVapidKeys, pushService, sendPush, validKeys, vapidAuthorization, vapidSigningKey, vapidToken, type PushTarget, type SendResult, type Urgency, type VapidKeys } from './webpush';

/** Devices one player may have alerts on at once; turning them on on another one forgets the least recently used. */
export const PUSH_DEVICES_MAX = 10;
/** A browser that hasn't opened the site for this long is forgotten (each visit with alerts on refreshes it). */
export const PUSH_KEEP_MS = 60 * 24 * 60 * 60_000;
/** How long a push service gets to take an alert. */
const SEND_TIMEOUT_MS = 5_000;
/** Players whose alerts go out at once; the rest wait their turn. */
const IN_FLIGHT = 4;
/** Alerts waiting to go beyond this are dropped (the server is in trouble, or a push service is down). */
const QUEUE_MAX = 500;
/** A VAPID token is good for 12 hours and made again an hour before it runs out. */
const TOKEN_LIFE_S = 12 * 3600;
/** Failures are logged at most this often, with how many there were. */
const FAIL_LOG_MS = 10 * 60_000;
/** Subscribe and unsubscribe calls one address may make per window. */
const CALLS_PER_WINDOW = 60;
const CALL_WINDOW_MS = 10 * 60_000;

/** A browser's subscription as kept: who it alerts, and the browser it came from. */
export interface StoredSubscription extends PushTarget {
  playerId: PlayerId;
  /** The browser secret's fingerprint. */
  device: string;
  /** The sign-in session's fingerprint, when the browser was signed in. */
  session: string | null;
  seenAt: Date;
}

/** Where the VAPID keys and subscriptions are kept. The default keeps them in memory. */
export interface PushStore {
  keys(): Promise<VapidKeys>;
  save(sub: StoredSubscription, max: number): Promise<void>;
  remove(endpoint: string): Promise<void>;
  removePlayers(playerIds: PlayerId[]): Promise<void>;
  /** The browsers to alert for a player (on the database, only those that still play as them). */
  targets(playerId: PlayerId, now: Date): Promise<PushTarget[]>;
  /** Forgets browsers not seen since `before`, and (on the database) those that no longer play as their player. */
  prune(before: Date, now: Date): Promise<number>;
}

export function memoryPushStore(): PushStore {
  let keys: VapidKeys | null = null;
  const subs = new Map<string, StoredSubscription>();
  return {
    async keys() {
      return (keys ??= newVapidKeys());
    },
    async save(sub, max) {
      subs.set(sub.endpoint, { ...sub });
      const mine = [...subs.values()].filter((s) => s.playerId === sub.playerId).sort((a, b) => b.seenAt.getTime() - a.seenAt.getTime());
      for (const old of mine.slice(max)) subs.delete(old.endpoint);
    },
    async remove(endpoint) {
      subs.delete(endpoint);
    },
    async removePlayers(ids) {
      for (const [endpoint, s] of subs) if (ids.includes(s.playerId)) subs.delete(endpoint);
    },
    async targets(playerId) {
      return [...subs.values()].filter((s) => s.playerId === playerId).map(({ endpoint, p256dh, auth }) => ({ endpoint, p256dh, auth }));
    },
    async prune(before) {
      let n = 0;
      for (const [endpoint, s] of subs) if (s.seenAt < before) subs.delete(endpoint), n++;
      return n;
    },
  };
}

export function dbPushStore(db: Db): PushStore {
  let keys: Promise<VapidKeys> | null = null;
  return {
    keys() {
      // Asked once; a failure is asked again next time.
      keys ??= vapidKeys(db).catch((e) => {
        keys = null;
        throw e;
      });
      return keys;
    },
    save: (sub, max) => savePushSubscription(db, sub, max),
    remove: async (endpoint) => void (await removePushSubscription(db, endpoint)),
    removePlayers: (ids) => removePushSubscriptionsOf(db, ids),
    targets: (playerId, now) => pushTargetsOf(db, playerId, now),
    prune: (before, now) => prunePushSubscriptions(db, before, now),
  };
}

/** Push alerts are on when the server knows its public address, which goes in each claim as the contact. */
export interface PushConfig {
  /** The VAPID subject (RFC 8292): the site's https address. */
  subject: string;
}

/**
 * On only with PUBLIC_URL (fly.toml sets the live address). A copy of the site run without it, such as the backup
 * restore drill on a real backup, never alerts the players in it.
 */
export function pushFromEnv(env = process.env): PushConfig | null {
  const url = env.PUBLIC_URL?.trim();
  return url ? { subject: url } : null;
}

/** What an alert says and where tapping it goes. Kept short: no cards, no amounts. */
export interface PushAlert {
  title: string;
  body: string;
  /** A page of this site (/t/… or /tn/…). */
  url: string;
  /** The same tag the page itself uses for the alert, so one device shows it once. */
  tag: string;
  /** Alerts whose tag starts with this are out of date once this one shows (an earlier turn at the same table). */
  replaces?: string;
}

export interface SendOptions {
  /** Seconds the push service may hold it for a phone that is off. */
  ttl: number;
  urgency: Urgency;
}

export class PushError extends Error {}

interface Job {
  playerId: PlayerId;
  alert: PushAlert;
  opts: SendOptions;
  current?: () => boolean;
}

export class PushAlerts {
  private readonly queue: Job[] = [];
  private running = 0;
  private closed = false;
  private readonly idleWaiters: (() => void)[] = [];
  private readonly tokens = new Map<string, { value: string; until: number }>();
  private failures = { count: 0, last: '', loggedAt: -Infinity };
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      store: PushStore;
      config: PushConfig | null;
      now: () => number;
      log: (message: string, err?: unknown) => void;
      /** The push services' HTTP; tests pass a fake one. */
      fetch?: typeof fetch;
    },
  ) {
    if (deps.config) {
      const prune = () => {
        const now = deps.now();
        deps.store.prune(new Date(now - PUSH_KEEP_MS), new Date(now)).catch((e) => deps.log('forgetting old phone alerts failed', e));
      };
      prune();
      // Every few hours, so a server that runs for weeks still forgets browsers on time.
      this.pruneTimer = setInterval(prune, 6 * 3_600_000);
      this.pruneTimer.unref();
    }
  }

  /** Whether this server sends alerts at all. */
  get on(): boolean {
    return !!this.deps.config && !this.closed;
  }

  /** The public key browsers subscribe with, or null when alerts are off here. */
  async publicKey(): Promise<string | null> {
    return this.on ? (await this.deps.store.keys()).publicKey : null;
  }

  /** Keeps (or refreshes) a browser's subscription for `playerId`. Throws PushError for one that can't be used. */
  async subscribe(input: unknown, who: { playerId: PlayerId; device: string; session: string | null }): Promise<void> {
    if (!this.on) throw new PushError('alerts are off on this server');
    const sub = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
    const endpoint = typeof sub?.endpoint === 'string' && sub.endpoint.length <= 1000 ? sub.endpoint : '';
    const p256dh = typeof sub?.keys?.p256dh === 'string' && sub.keys.p256dh.length <= 200 ? sub.keys.p256dh : '';
    const auth = typeof sub?.keys?.auth === 'string' && sub.keys.auth.length <= 100 ? sub.keys.auth : '';
    if (!endpoint || !pushService(endpoint)) throw new PushError('that is not a push service this site sends to');
    if (!validKeys({ p256dh, auth })) throw new PushError('those keys are not right');
    await this.deps.store.save({ endpoint, p256dh, auth, ...who, seenAt: new Date(this.deps.now()) }, PUSH_DEVICES_MAX);
  }

  async unsubscribe(endpoint: unknown): Promise<void> {
    if (typeof endpoint === 'string' && endpoint.length <= 1000) await this.deps.store.remove(endpoint);
  }

  /** Forgets every browser of these players (their account was deleted). */
  forget(playerIds: PlayerId[]): void {
    if (playerIds.length) this.deps.store.removePlayers(playerIds).catch((e) => this.deps.log('forgetting phone alerts failed', e));
  }

  /**
   * Queues an alert for every browser of the player that has alerts on. Returns at once; nothing waits on the push
   * services. `current`, when given, is asked again as the alert leaves the queue: false (the turn was played while
   * a slow push service held up the queue) drops it.
   */
  send(playerId: PlayerId, alert: PushAlert, opts: SendOptions, current?: () => boolean): void {
    if (!this.on) return;
    if (this.queue.length >= QUEUE_MAX) return this.failed('the queue is full');
    this.queue.push({ playerId, alert, opts, current });
    setImmediate(() => this.pump());
  }

  /** Resolves once every queued alert has gone (or failed). */
  idle(): Promise<void> {
    if (!this.queue.length && !this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Sends nothing more. Alerts already on their way finish by themselves. */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (!this.running) this.settle();
  }

  private settle() {
    for (const done of this.idleWaiters.splice(0)) done();
  }

  private pump() {
    while (this.running < IN_FLIGHT && this.queue.length) {
      const job = this.queue.shift()!;
      if (!still(job)) continue;
      this.running++;
      this.deliver(job)
        .catch((e) => this.deps.log('a phone alert failed', e))
        .finally(() => {
          this.running--;
          if (this.queue.length) this.pump();
          else if (!this.running) this.settle();
        });
    }
    if (!this.running && !this.queue.length) this.settle();
  }

  private async deliver(job: Job) {
    const { playerId, alert, opts } = job;
    const targets = await this.deps.store.targets(playerId, new Date(this.deps.now()));
    if (!targets.length || !still(job)) return;
    const keys = await this.deps.store.keys();
    const payload = Buffer.from(JSON.stringify(alert));
    await Promise.all(
      targets.map(async (target) => {
        const host = pushService(target.endpoint);
        // Kept before this list existed, or edited by hand: never posted to.
        if (!host) return void (await this.deps.store.remove(target.endpoint));
        let body: Buffer;
        try {
          body = encryptPayload(payload, target);
        } catch {
          return void (await this.deps.store.remove(target.endpoint));
        }
        const { result, status } = await sendPush(target, body, { ...opts, authorization: this.authorization(target.endpoint, keys), timeoutMs: SEND_TIMEOUT_MS, fetch: this.deps.fetch });
        await this.after(target, host, result, status);
      }),
    );
  }

  private async after(target: PushTarget, host: string, result: SendResult, status: number) {
    // The browser unsubscribed, or its push service dropped it: it will never take another alert.
    if (result === 'gone') await this.deps.store.remove(target.endpoint);
    else if (result === 'failed') this.failed(`${host} answered ${status || 'nothing'}`);
  }

  /** One log line per stretch of failures, never one per alert, and never a subscription's address (it is a secret). */
  private failed(why: string) {
    const f = this.failures;
    f.count++;
    f.last = why;
    const now = this.deps.now();
    if (now - f.loggedAt < FAIL_LOG_MS) return;
    this.deps.log(`phone alerts failed ${f.count} time${f.count === 1 ? '' : 's'}; the last: ${f.last}`);
    f.count = 0;
    f.loggedAt = now;
  }

  /** A signed claim for the push service's origin, made again an hour before it runs out. */
  private authorization(endpoint: string, keys: VapidKeys): string {
    const audience = new URL(endpoint).origin;
    const now = Math.floor(this.deps.now() / 1000);
    let token = this.tokens.get(audience);
    if (!token || token.until - now < 3600) {
      token = { value: vapidToken(audience, this.deps.config!.subject, now + TOKEN_LIFE_S, vapidSigningKey(keys)), until: now + TOKEN_LIFE_S };
      this.tokens.set(audience, token);
    }
    return vapidAuthorization(token.value, keys.publicKey);
  }
}

/** False once a queued alert is out of date; a check that throws counts as out of date. */
function still(job: Job): boolean {
  try {
    return !job.current || job.current();
  } catch {
    return false;
  }
}

/**
 * The routes a page uses: the public key to subscribe with, and turning this browser's alerts on or off. The
 * browser says who it is the way the account routes do (X-Guest-Token, and X-Session-Token when signed in).
 */
export function pushRoutes(
  app: express.Express,
  alerts: PushAlerts,
  opts: {
    /** Who a browser is, from its secrets; throws for a malformed one. */
    resolve: (guestToken: string, session?: string) => Promise<{ playerId: PlayerId }>;
    /** A secret's fingerprint, as player_tokens and sessions keep it. */
    fingerprint: (secret: string) => string;
    now: () => number;
    log: (message: string, err?: unknown) => void;
  },
) {
  const json = express.json({ limit: '4kb' });
  const calls = limiter(CALLS_PER_WINDOW, CALL_WINDOW_MS, opts.now);
  const failed = (res: express.Response) => (e: unknown) => {
    if (e instanceof PushError) return void res.status(400).json({ error: e.message });
    opts.log('phone alert route failed', e);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  };

  app.get('/api/push/key', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    alerts
      .publicKey()
      .then((key) => res.json({ key }))
      .catch(failed(res));
  });

  app.post('/api/push/subscribe', json, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!calls(clientAddress(req))) return void res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
    const token = req.get('x-guest-token') ?? '';
    if (token.length < 16 || token.length > 128) return void res.status(401).json({ error: 'missing token' });
    const session = req.get('x-session-token') || undefined;
    opts
      .resolve(token, session)
      .then((who) => alerts.subscribe(req.body, { playerId: who.playerId, device: opts.fingerprint(token), session: session ? opts.fingerprint(session) : null }))
      .then(() => res.json({ ok: true }))
      .catch(failed(res));
  });

  // Anyone holding a subscription's address may drop it: only its browser (and its push service) has it.
  app.post('/api/push/unsubscribe', json, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!calls(clientAddress(req))) return void res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
    alerts
      .unsubscribe((req.body as { endpoint?: unknown } | undefined)?.endpoint)
      .then(() => res.json({ ok: true }))
      .catch(failed(res));
  });
}
