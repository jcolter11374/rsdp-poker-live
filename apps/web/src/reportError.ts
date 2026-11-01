import { pageBuild } from './freshness';
import { Refusal } from './call';

/*
 * When something breaks in the browser, the server is told (POST
 * /api/client-error) and writes one line to its log: the error and its
 * stack, the kind of page (/t/:id, never the address: a table link is a
 * private invite) and the build this page runs. Nothing else is sent: no
 * names, nothing typed, not even the server's answer to a request nobody
 * caught (see Refusal). Each different error is sent once, at most a few per
 * page load (and the page crashing), and reporting never throws, so it can't
 * set off another report.
 */

/** Where the error was caught: the whole page, one part of it, or nowhere (a plain error or rejected promise). */
export type ErrorKind = 'crash' | 'part' | 'error' | 'rejection';

export interface ErrorReport {
  message: string;
  stack: string;
  route: string;
  build: string | null;
  kind: ErrorKind;
}

/** Reports one page load sends at most. */
const MAX_REPORTS = 3;
/** The server keeps no more than this of each, so the page sends no more. */
const MESSAGE_MAX = 300;
const STACK_MAX = 2_000;

/** Pages whose address carries an id, and the pattern sent instead (App.tsx has the same list). */
const WITH_ID: [RegExp, string][] = [
  [/^\/tn\/new\/?$/, '/tn/new'],
  [/^\/t\/[^/]+/, '/t/:id'],
  [/^\/tn\/[^/]+/, '/tn/:id'],
  [/^\/season\/[^/]+/, '/season/:id'],
  [/^\/h\/[^/]+/, '/h/:id'],
  [/^\/rules\/[^/]+/, '/rules/:game'],
];
/** Pages with a fixed address, as App.tsx has them. */
const FIXED = new Set(['/', '/rules', '/roadmap', '/roadmap/admin', '/whats-new', '/changelog', '/fairness', '/transparency', '/privacy', '/terms', '/credits', '/about', '/signin', '/signup', '/reset', '/profile', '/leaderboard', '/hands', '/auth/done']);

/** The kind of page an address is, such as /t/:id. Any other address could hold anything, so it is only '/*'. */
export function routePattern(path: string): string {
  for (const [re, pattern] of WITH_ID) if (re.test(path)) return pattern;
  const page = path.length > 1 ? path.replace(/\/$/, '') : path;
  return FIXED.has(page) ? page : '/*';
}

/** Says whether to send an error: each different one once, no more than `max` in all, and the page crashing always. */
export function reportGate(max = MAX_REPORTS) {
  const seen = new Set<string>();
  let crashed = false;
  return (kind: ErrorKind, key: string) => {
    // The crash matters most, so earlier errors never use up its report. It comes once: it replaces the page.
    if (kind === 'crash') return crashed ? false : (crashed = true);
    if (seen.size >= max || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

/** Reads something off a thrown value that may throw itself (a getter, a toString). */
function safely(read: () => unknown, otherwise: string): string {
  try {
    const value = read();
    return typeof value === 'string' ? value : otherwise;
  } catch {
    return otherwise;
  }
}

/** What is sent about one error. */
export function errorReport(error: unknown, kind: ErrorKind, path: string, build: string | null): ErrorReport {
  let message =
    error instanceof Error ? safely(() => `${error.name}: ${error.message}`, 'Error') : safely(() => String(error), 'something that is not an error');
  let stack = error instanceof Error ? safely(() => error.stack, '') : '';
  if (error instanceof Refusal) {
    // Only which request the server refused: its answer stays out of the message and the stack.
    message = `Refusal of ${error.event} (the server's answer is left out)`;
    if (error.message) stack = stack.split(error.message).join('…');
  }
  return { message: message.slice(0, MESSAGE_MAX), stack: stack.slice(0, STACK_MAX), route: routePattern(path), build, kind };
}

/** The build a page runs, as people see it: its entry script's name, such as index-AbC123. */
export function buildName(src: string | null): string | null {
  return src?.replace(/^.*\//, '').replace(/\.js$/, '') ?? null;
}

const gate = reportGate();

/** Tells the server about an error, unless it was sent already or this page load has sent enough. Never throws. */
export function reportError(error: unknown, kind: ErrorKind) {
  try {
    // The dev server shows errors on screen already (and, as for the service worker in pwa.tsx, nothing is sent from it).
    if (!import.meta.env.PROD) return;
    const report = errorReport(error, kind, location.pathname, pageBuild());
    if (!gate(kind, `${report.message}\n${report.stack}`)) return;
    // keepalive: still sent if the player reloads at once.
    fetch('/api/client-error', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) }).catch(() => {});
  } catch {
    // Reporting must never be what breaks the page.
  }
}

/** Reports errors nothing caught: in event handlers, timers and promises nobody waited for. */
export function watchForErrors() {
  addEventListener('error', (e) => {
    // Without an error object (another site's script says only "Script error.") there is nothing to learn.
    if (e.error) reportError(e.error, 'error');
  });
  addEventListener('unhandledrejection', (e) => reportError(e.reason, 'rejection'));
}
