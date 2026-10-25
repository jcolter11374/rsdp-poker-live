/** Roadmap suggestions: talks to /api/suggestions. */

export const STATUSES = ['new', 'approved', 'planned', 'in_progress', 'shipped', 'declined'] as const;
export type SuggestionStatus = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<SuggestionStatus, string> = {
  new: 'New',
  approved: 'Approved',
  planned: 'Planned',
  in_progress: 'In progress',
  shipped: 'Shipped',
  declined: 'Declined',
};

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

async function call<T>(path: string, init?: RequestInit & { adminKey?: string }): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init?.adminKey) headers['x-admin-key'] = init.adminKey;
  const res = await fetch(`/api/suggestions${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? 'Something went wrong. Try again.');
  return body;
}

export const fetchSuggestions = () => call<{ suggestions: Suggestion[] }>('').then((r) => r.suggestions);

export const sendSuggestion = (input: { name: string; title: string; detail: string; website: string }) =>
  call<{ suggestion?: Suggestion }>('', { method: 'POST', body: JSON.stringify(input) });

export const checkAdminKey = (adminKey: string) => call('/admin', { adminKey });

export const updateSuggestion = (adminKey: string, id: number, patch: { status?: SuggestionStatus; reply?: string }) =>
  call<{ suggestion: Suggestion }>(`/${id}`, { method: 'PATCH', body: JSON.stringify(patch), adminKey }).then((r) => r.suggestion);

export const deleteSuggestion = (adminKey: string, id: number) => call(`/${id}`, { method: 'DELETE', adminKey });

/** Newest first, with finished and declined ideas after the open ones. */
export function logOrder(list: Suggestion[]): Suggestion[] {
  const done = (s: Suggestion) => (s.status === 'shipped' || s.status === 'declined' ? 1 : 0);
  return [...list].sort((a, b) => done(a) - done(b) || b.id - a.id);
}

/** "Oct 25", or "Oct 25, 2025" when it isn't this year. */
export function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}
