// Errors in players' browsers: the page reports what broke and the server
// writes one line to its log, like its own errors. Nothing is saved, and the
// line never says who sent it (no address, browser or name) or which page
// exactly: only its kind (/t/:id), since a table link is a private invite.

import express from 'express';
import { clientAddress, limiter } from './admin';
import type { BuildInfo } from './audit';

/** Reports one address may send per window, and the whole site per hour, so a script can't flood the log. */
const PER_ADDRESS = 10;
const ADDRESS_WINDOW_MS = 10 * 60_000;
const SITE_PER_HOUR = 120;
export const MESSAGE_MAX = 300;
export const STACK_MAX = 2_000;

/** What the page saw, as the log says it. */
const KINDS: Record<string, string> = {
  crash: 'the page crashed',
  part: 'part of a page crashed',
  error: 'uncaught',
  rejection: 'unhandled rejection',
};

/** A route pattern such as /t/:id or /whats-new: lower-case words and :names only, so no real id gets through. */
const ROUTE = /^(?:\/(?:[a-z]+(?:-[a-z]+)*|:[a-z]+|\*))*\/?$/;
/** The entry script a built page loads (see webBuild). */
const ENTRY = /^\/assets\/[\w.-]{1,80}\.js$/;

/** Table, tournament, season and hand links are private invites: an error's text keeps only their kind. */
export function withoutLinks(text: string): string {
  return text.replace(/\/(t|tn|h|season)\/[\w-]+/g, '/$1/:id');
}

/** Cuts text to `max` characters, marking the cut. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One line of text: a stack's lines joined with " | ", control characters dropped. */
function oneLine(text: string): string {
  return text
    .split(/\s*[\r\n]+\s*/)
    .filter(Boolean)
    .join(' | ')
    .replace(/\p{Cc}+/gu, ' ');
}

export function clientErrorRoutes(
  app: express.Express,
  opts: {
    now: () => number;
    log: (message: string, err?: unknown) => void;
    build: BuildInfo;
    /** The entry script of the web app this server hands out; null without one (development). */
    served: string | null;
  },
) {
  const { now, log, build, served } = opts;
  const perAddress = limiter(PER_ADDRESS, ADDRESS_WINDOW_MS, now);
  const site = limiter(SITE_PER_HOUR, 60 * 60_000, now);
  const json = express.json({ limit: '8kb' });

  // Counted before the body is read, so junk and oversize bodies count too.
  const admit: express.RequestHandler = (req, res, next) => {
    if (!site('all', false) || !perAddress(clientAddress(req))) return void res.status(429).end();
    site('all');
    next();
  };
  const record: express.RequestHandler = (req, res) => {
    const body: Record<string, unknown> = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (typeof body.message !== 'string' || !body.message.trim()) return void res.status(400).end();
    const raw = body.message;
    // Most browsers start the stack with the message itself.
    let stack = typeof body.stack === 'string' ? body.stack : '';
    if (stack.startsWith(raw)) stack = stack.slice(raw.length);
    const message = cut(oneLine(withoutLinks(raw)), MESSAGE_MAX);
    stack = cut(oneLine(withoutLinks(stack)), STACK_MAX);
    const route = typeof body.route === 'string' && body.route.length <= 40 && ROUTE.test(body.route) ? body.route : 'an unknown page';
    const kind = (typeof body.kind === 'string' && Object.hasOwn(KINDS, body.kind) && KINDS[body.kind]) || KINDS.error;
    // The page names its build by its entry script; the commit is known only for the build served now.
    const page = typeof body.build === 'string' && ENTRY.test(body.build) ? body.build : null;
    let which = 'unknown';
    if (page) {
      which = page.slice('/assets/'.length, -'.js'.length);
      if (page === served && build.commit) which += ` (commit ${build.commit.slice(0, 7)})`;
      else if (served && page !== served) which += ' (not the build served now)';
    }
    log(`browser error (${kind}) on ${route}, build ${which}: ${message}${stack ? ` | ${stack}` : ''}`);
    res.status(204).end();
  };
  // A body too big or not JSON is answered, never logged: that would let anyone fill the log.
  const refuse: express.ErrorRequestHandler = (err, _req, res, _next) => {
    if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) return void res.status(err.status).end();
    log('client error report failed', err);
    res.status(500).end();
  };
  app.post('/api/client-error', admit, json, record, refuse);
}
