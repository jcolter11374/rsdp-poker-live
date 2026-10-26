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

/**
 * Whether the site's record still holds `old` unchanged (its hash recomputed
 * from its contents), with everything after it following on, up to
 * MAX_PAGES pages. Returns a problem, or the last entry it checked.
 */
async function followsOn(old: Head, head: Head): Promise<{ problem: string } | { reached: Head }> {
  if (head.seq < old.seq) return { problem: `The record now ends at entry ${head.seq}, but this browser saw entry ${old.seq}.` };
  const [same] = await entriesAfter(old.seq - 1, 1);
  if (!same || same.seq !== old.seq || same.hash !== old.hash) return { problem: `Entry ${old.seq} is not the one this browser saw.` };
  // Its stored contents must still give the hash this browser remembers.
  const changed = chainProblem([same]);
  if (changed) return { problem: `The record is broken: ${changed}.` };
  let prev: Head = old;
  for (let page = 0; page < MAX_PAGES && prev.seq < head.seq; page++) {
    const next = await entriesAfter(prev.seq);
    if (!next.length) break;
    const problem = chainProblem(next, prev);
    if (problem) return { problem: `The record is broken: ${problem}.` };
    prev = { seq: next.at(-1)!.seq, hash: next.at(-1)!.hash };
  }
  return { reached: prev };
}

/** The live site, the only one GitHub copies. */
export const LIVE_HOST = 'rsdp-poker-live.fly.dev';

/**
 * Checks the record (at most every few minutes unless forced). Only a check
 * that finishes moves on what this browser remembers, to the last entry it
 * checked. Failures to reach the site or GitHub are not problems.
 */
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
  if (head.seq <= 0) return;
  const problems: string[] = [];
  const seen = read<Head>(SEEN);
  let reached: Head | null = null;
  try {
    if (seen && seen.seq > 0) {
      const r = await followsOn(seen, head);
      if ('problem' in r) problems.push(r.problem);
      else reached = r.reached;
    } else {
      // Nothing remembered yet: start from the latest entry, once it is checked to be whole.
      const [latest] = await entriesAfter(head.seq - 1, 1);
      if (latest && latest.seq === head.seq && !chainProblem([latest])) reached = { seq: latest.seq, hash: latest.hash };
    }
    if (location.hostname === LIVE_HOST) {
      const copied = await json<Head>(GITHUB_COPY).catch(() => null);
      if (copied && copied.seq > 0) {
        const r = await followsOn(copied, head);
        if ('problem' in r) problems.push(`Compared with the copy on GitHub: ${r.problem}`);
      }
    }
  } catch {
    // Couldn't reach the record partway: try again next time, remembering what was there before.
    if (!problems.length) return;
  }
  if (problems.length) write(PROBLEM, { at: now, text: problems.join(' ') });
  else if (reached) write(SEEN, reached);
}

/** Each player's latest buy-ins and cash-outs at a table, in the public record. */
export const tableChips = (tableId: string) => json<{ entries: AuditEntry[] }>(`/api/audit/table/${tableRef(tableId)}/chips`).then((r) => r.entries);

export type HandEntries = { entries: AuditEntry[]; before: boolean; after: boolean };
/** Every public record entry for one hand, and whether the table has recorded hands before and after it. */
export const tableHand = (tableId: string, handNumber: number) => json<HandEntries>(`/api/audit/table/${tableRef(tableId)}/hand/${handNumber}`);

/** What a revealed hand's fingerprint is, from what "Check this hand" was given. Null while it is sealed. */
export function digestOf(hand: HandRecordView): string | null {
  const fair = hand.fair;
  if (!fair?.events || !fair.serverSeed) return null;
  return handDigest({ handId: fair.handId, commit: fair.commit, serverSeed: fair.serverSeed, button: hand.button, seats: hand.seats, events: fair.events });
}

/** How a revealed hand compares with the public record. A hand shown after it ends is recorded again, so any of its entries may match. */
export function handInRecord(hand: HandRecordView, record: HandEntries): { ok: boolean | null; detail: string } {
  const digest = digestOf(hand);
  if (!digest) return { ok: null, detail: 'once the hand is revealed' };
  const entries = record.entries.filter((e) => e.kind === 'hand');
  if (!entries.length) {
    if (record.before && record.after)
      return { ok: false, detail: 'it is missing, though hands before and after it are recorded (an honest server only does that if it crashed just as the hand finished)' };
    return { ok: null, detail: 'this hand was played before hands went in the public record' };
  }
  const match = entries.find((e) => e.data.digest === digest);
  return match
    ? { ok: true, detail: `entry ${match.seq}, written ${new Date(match.at).toLocaleString()}` }
    : { ok: false, detail: `entry ${entries.at(-1)!.seq} has a different fingerprint: this hand was changed after it was recorded` };
}

/** Rows of the ledger whose buy-ins or cash-outs differ from the latest ones in the public record (bots aren't recorded). */
export function ledgerMismatches(tableId: string, ledger: LedgerView[], entries: AuditEntry[]): LedgerView[] {
  const latest = new Map<string, AuditEntry>();
  // Oldest first, so the last one per player wins.
  for (const e of entries) if (e.kind === 'chips') latest.set(String(e.data.player), e);
  return ledger.filter((row) => {
    if (row.bot) return false;
    const e = latest.get(playerRef(tableId, row.playerId));
    return !e || e.data.buyIn !== row.buyIn || e.data.cashOut !== row.cashOut;
  });
}

/** Rows whose latest totals in the record were found changed when the table was loaded again, after being closed. */
export function changedWhileClosed(tableId: string, ledger: LedgerView[], entries: AuditEntry[]): LedgerView[] {
  const loaded = new Set(entries.filter((e) => e.kind === 'chips' && e.data.loaded === true).map((e) => String(e.data.player)));
  return ledger.filter((row) => !row.bot && loaded.has(playerRef(tableId, row.playerId)));
}
