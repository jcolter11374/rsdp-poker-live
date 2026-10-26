// Roadmap suggestions: anyone can send an idea from /roadmap and everyone sees
// the log. Only someone holding ADMIN_KEY changes a status or removes spam.

import express from 'express';
import { clientAddress, limiter, type AdminCheck } from './admin';
import { deleteSuggestion, insertSuggestion, listSuggestions, updateSuggestion, type Db, type SuggestionStatus } from './db';
import { SUGGESTION_STATUSES } from './db/schema';

export interface Suggestion {
  id: number;
  name: string;
  title: string;
  detail: string;
  status: SuggestionStatus;
  reply: string;
  createdAt: string;
  updatedAt: string;
}

/** Where suggestions are kept. The default keeps them in memory. */
export interface SuggestionStore {
  create(input: { name: string; title: string; detail: string }): Promise<Suggestion>;
  list(statuses?: readonly SuggestionStatus[]): Promise<Suggestion[]>;
  update(id: number, patch: { status?: SuggestionStatus; reply?: string }): Promise<Suggestion | null>;
  remove(id: number): Promise<boolean>;
}

export function memorySuggestions(): SuggestionStore {
  const rows = new Map<number, Suggestion>();
  let next = 1;
  return {
    async create(input) {
      const now = new Date().toISOString();
      const row: Suggestion = { id: next++, ...input, status: 'new', reply: '', createdAt: now, updatedAt: now };
      rows.set(row.id, row);
      return { ...row };
    },
    async list(statuses) {
      return [...rows.values()].filter((r) => !statuses?.length || statuses.includes(r.status)).map((r) => ({ ...r }));
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) return null;
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      return { ...row };
    },
    async remove(id) {
      return rows.delete(id);
    },
  };
}

export function dbSuggestions(db: Db): SuggestionStore {
  const view = (r: Awaited<ReturnType<typeof insertSuggestion>>): Suggestion => ({
    ...r,
    status: r.status as SuggestionStatus,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  });
  return {
    create: async (input) => view(await insertSuggestion(db, input)),
    list: async (statuses) => (await listSuggestions(db, statuses)).map(view),
    update: async (id, patch) => {
      const row = await updateSuggestion(db, id, patch);
      return row ? view(row) : null;
    },
    remove: (id) => deleteSuggestion(db, id),
  };
}

export const NAME_MAX = 30;
export const TITLE_MAX = 100;
export const DETAIL_MAX = 1000;
export const REPLY_MAX = 300;
/** Suggestions one address may send per window, and the whole site per hour, so a script can't flood the log. */
const SEND_BURST = 3;
const SEND_WINDOW_MS = 10 * 60_000;
const SITE_PER_HOUR = 60;

const isStatus = (s: unknown): s is SuggestionStatus => typeof s === 'string' && (SUGGESTION_STATUSES as readonly string[]).includes(s);

/** One line of plain text: control characters dropped, spaces collapsed. */
function clean(v: unknown, max: number, multiline = false): string | null {
  if (typeof v !== 'string') return null;
  let s = v.replace(multiline ? /[^\P{Cc}\n]/gu : /\p{Cc}/gu, ' ');
  s = multiline ? s.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : s.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : null;
}

export function suggestionRoutes(
  app: express.Express,
  store: SuggestionStore,
  opts: {
    isAdmin: AdminCheck;
    now: () => number;
    log: (message: string, err?: unknown) => void;
    /** Admin changes go in the public record (audit.ts). */
    onAdmin?: (action: string, target: string) => void;
  },
) {
  const { now, log, isAdmin } = opts;
  const onAdmin = opts.onAdmin ?? (() => {});
  const perAddress = limiter(SEND_BURST, SEND_WINDOW_MS, now);
  const site = limiter(SITE_PER_HOUR, 60 * 60_000, now);
  const json = express.json({ limit: '8kb' });
  const address = clientAddress;
  const failed = (res: express.Response) => (e: unknown) => {
    log('suggestions failed', e);
    res.status(500).json({ error: 'something went wrong' });
  };

  // The public log, or only some statuses (e.g. ?status=approved, for planning new work).
  app.get('/api/suggestions', (req, res) => {
    const statuses = String(req.query.status ?? '')
      .split(',')
      .filter(Boolean);
    if (!statuses.every(isStatus)) return void res.status(400).json({ error: `status must be some of ${SUGGESTION_STATUSES.join(', ')}` });
    store
      .list(statuses)
      .then((list) => res.set('Cache-Control', 'no-store').json({ suggestions: list }))
      .catch(failed(res));
  });

  app.post('/api/suggestions', json, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // A field people never see: only bots fill it in. Pretend it worked.
    if (body.website) return void res.json({ ok: true });
    const name = clean(body.name, NAME_MAX);
    const title = clean(body.title, TITLE_MAX);
    const detail = clean(body.detail ?? '', DETAIL_MAX, true);
    if (!name) return void res.status(400).json({ error: `Add your name (up to ${NAME_MAX} characters) so we can credit you.` });
    if (!title) return void res.status(400).json({ error: `Add a short idea (up to ${TITLE_MAX} characters).` });
    if (detail === null) return void res.status(400).json({ error: `Keep the details under ${DETAIL_MAX} characters.` });
    if (!site('all', false) || !perAddress(address(req))) return void res.status(429).json({ error: 'Thanks! That is a lot of ideas at once. Try again in a few minutes.' });
    site('all');
    store
      .create({ name, title, detail })
      .then((suggestion) => res.json({ ok: true, suggestion }))
      .catch(failed(res));
  });

  // Lets the admin page check a key before showing the controls.
  app.get('/api/suggestions/admin', (req, res) => {
    if (isAdmin(req, res)) res.json({ ok: true });
  });

  app.patch('/api/suggestions/:id', json, (req, res) => {
    if (!isAdmin(req, res)) return;
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: { status?: SuggestionStatus; reply?: string } = {};
    if (body.status !== undefined) {
      if (!isStatus(body.status)) return void res.status(400).json({ error: 'unknown status' });
      patch.status = body.status;
    }
    if (body.reply !== undefined) {
      const reply = clean(body.reply, REPLY_MAX);
      if (reply === null) return void res.status(400).json({ error: `Keep the reply under ${REPLY_MAX} characters.` });
      patch.reply = reply;
    }
    if (!Number.isSafeInteger(id) || id < 1) return void res.status(404).json({ error: 'not found' });
    store
      .update(id, patch)
      .then((s) => {
        if (!s) return void res.status(404).json({ error: 'not found' });
        onAdmin(`suggestion ${patch.status ? `marked ${patch.status}` : 'answered'}`, `#${id}`);
        res.json({ ok: true, suggestion: s });
      })
      .catch(failed(res));
  });

  // For spam: removes it from the log for good.
  app.delete('/api/suggestions/:id', (req, res) => {
    if (!isAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return void res.status(404).json({ error: 'not found' });
    store
      .remove(id)
      .then((ok) => {
        if (!ok) return void res.status(404).json({ error: 'not found' });
        onAdmin('suggestion removed', `#${id}`);
        res.json({ ok: true });
      })
      .catch(failed(res));
  });
}
