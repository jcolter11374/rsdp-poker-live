import { chainProblem, handDigest, playerRef, tableRef, type AuditEntry } from '@rsdp/engine';
import type { HandRecordView, LedgerView } from '@rsdp/engine/wire';

// The public record (docs/FAIRNESS.md, "Checking John"): this browser remembers
// the latest entry it saw, and checks on every visit that the record still
// holds it, unchanged, with everything since following on from it. It also
// checks the last entry GitHub copied. A record that was rewritten after
// either saw it shows a warning on every page.

const SEEN = 'rsdp.auditSeen';
const PROBLEM = 'rsdp.auditProblem';
const CHECKED = 'rsdp.auditChecked';
/** Checked at most this often per browser. */
const EVERY_MS = 10 * 60_000;
/** Beyond this many new entries, only the remembered one is checked. */
const MAX_PAGES = 10;
export const GITHUB_COPY = 'https://raw.githubusercontent.com/jcolter11374/rsdp-poker-live/transparency/audit/head.json';

type Head = { seq: number; hash: string };

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked: nothing to remember the record by */
  }
}

/** What went wrong the last time a check failed, until it is dismissed. */
export function recordProblem(): { at: number; text: string } | null {
  return read(PROBLEM);
}

/** Forgets the problem and the entry it was about, so the record is remembered afresh from the next check. */
export function dismissRecordProblem() {
  try {
    localStorage.removeItem(PROBLEM);
    localStorage.removeItem(SEEN);
  } catch {
    /* ignore */
  }
}

const json = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as T;
};
const entriesAfter = (seq: number, limit = 1000) => json<{ entries: AuditEntry[] }>(`/api/audit/entries?after=${seq}&limit=${limit}`).then((r) => r.entries);

/** Whether the site's record still holds `old` unchanged, with everything after it following on (up to a point). Null when fine. */
async function followsOn(old: Head, head: Head): Promise<string | null> {
  if (head.seq < old.seq) return `The record now ends at entry ${head.seq}, but this browser saw entry ${old.seq}.`;
  const [same] = await entriesAfter(old.seq - 1, 1);
  if (!same || same.hash !== old.hash) return `Entry ${old.seq} is not the one this browser saw.`;
  let prev = old;
  for (let page = 0; page < MAX_PAGES && prev.seq < head.seq; page++) {
    const next = await entriesAfter(prev.seq);
    if (!next.length) break;
    const problem = chainProblem(next, prev);
    if (problem) return `The record is broken: ${problem}.`;
    prev = next.at(-1)!;
  }
  return null;
}

/** Checks the record (at most every few minutes unless forced), then remembers its latest entry. Failures to reach it are not problems. */
export async function checkRecord(force = false): Promise<void> {
  const now = Date.now();
  if (!force && Math.abs(now - (read<number>(CHECKED) ?? 0)) < EVERY_MS) return;
  write(CHECKED, now);
  let head: Head;
  try {
    head = await json<Head>('/api/audit/head');
  } catch {
    return;
  }
  const problems: string[] = [];
  const seen = read<Head>(SEEN);
  if (seen && seen.seq > 0) {
    const p = await followsOn(seen, head).catch(() => null);
    if (p) problems.push(p);
  }
  const copied = await json<Head>(GITHUB_COPY).catch(() => null);
  if (copied && copied.seq > 0) {
    const p = await followsOn(copied, head).catch(() => null);
    if (p) problems.push(`Compared with the copy on GitHub: ${p}`);
  }
  if (problems.length) write(PROBLEM, { at: now, text: problems.join(' ') });
  else write(SEEN, head);
}

/** The latest entries about one table, newest first. */
export const tableRecord = (tableId: string) => json<{ entries: AuditEntry[] }>(`/api/audit/table/${tableRef(tableId)}`).then((r) => r.entries);

/** What a revealed hand's fingerprint is, from what "Check this hand" was given. Null while it is sealed. */
export function digestOf(hand: HandRecordView): string | null {
  const fair = hand.fair;
  if (!fair?.events) return null;
  return handDigest({ handId: fair.handId, commit: fair.commit, button: hand.button, seats: hand.seats, events: fair.events });
}

/** How a revealed hand compares with the public record. */
export function handInRecord(tableId: string, hand: HandRecordView, entries: AuditEntry[]): { ok: boolean | null; detail: string } {
  const digest = digestOf(hand);
  if (!digest) return { ok: null, detail: 'once the hand is revealed' };
  const ref = tableRef(tableId);
  const saved = entries.find((e) => e.kind === 'hand' && e.data.table === ref && e.data.hand === hand.handNumber);
  if (!saved) return { ok: null, detail: 'this hand was played before hands went in the public record' };
  return saved.data.digest === digest
    ? { ok: true, detail: `entry ${saved.seq}, written ${new Date(saved.at).toLocaleString()}` }
    : { ok: false, detail: `entry ${saved.seq} has a different fingerprint: this hand was changed after it was recorded` };
}

/** Rows of the ledger whose buy-ins or cash-outs differ from the latest ones in the public record (bots aren't recorded). */
export function ledgerMismatches(tableId: string, ledger: LedgerView[], entries: AuditEntry[]): LedgerView[] {
  const latest = new Map<string, AuditEntry>();
  for (const e of entries) if (e.kind === 'chips' && !latest.has(String(e.data.player))) latest.set(String(e.data.player), e);
  return ledger.filter((row) => {
    if (row.bot) return false;
    const e = latest.get(playerRef(tableId, row.playerId));
    return !e || e.data.buyIn !== row.buyIn || e.data.cashOut !== row.cashOut;
  });
}
