import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_GENESIS, auditHash, handDigest, playerRef, tableRef, type AuditEntry } from '@rsdp/engine';
import type { HandRecordView, LedgerView } from '@rsdp/engine/wire';
import { changedWhileClosed, checkRecord, digestOf, GITHUB_COPY, handInRecord, ledgerMismatches, recordProblem } from './audit';

const store = new Map<string, string>();
let site: AuditEntry[] = [];
let copy: { seq: number; hash: string } | null = null;

function chain(actions: string[]): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const action of actions) {
    const base = { seq: out.length + 1, at: 1_000 * (out.length + 1), kind: 'admin' as const, data: { action, target: null }, prev: out.at(-1)?.hash ?? AUDIT_GENESIS };
    out.push({ ...base, hash: auditHash(base) });
  }
  return out;
}

beforeEach(() => {
  store.clear();
  copy = null;
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.stubGlobal('location', { hostname: 'rsdp-poker-live.fly.dev' });
  vi.stubGlobal('fetch', async (url: string) => {
    const ok = (body: unknown) => ({ ok: true, json: async () => body });
    if (url === GITHUB_COPY) return copy ? ok(copy) : { ok: false, status: 404 };
    if (url === '/api/audit/head') return ok({ seq: site.length, hash: site.at(-1)?.hash ?? AUDIT_GENESIS });
    const m = /after=(\d+)&limit=(\d+)/.exec(url)!;
    return ok({ entries: site.filter((e) => e.seq > +m[1]).slice(0, +m[2]) });
  });
});

describe('remembering the public record', () => {
  it('stays quiet while the record only grows', async () => {
    site = chain(['a', 'b']);
    await checkRecord(true);
    site = chain(['a', 'b', 'c', 'd']);
    await checkRecord(true);
    expect(recordProblem()).toBeNull();
    expect(JSON.parse(store.get('rsdp.auditSeen')!).seq).toBe(4);
  });

  it('warns when an entry it saw was changed', async () => {
    site = chain(['a', 'b']);
    await checkRecord(true);
    site = chain(['a', 'edited', 'c']);
    await checkRecord(true);
    expect(recordProblem()?.text).toMatch(/Entry 2 is not the one this browser saw/);
  });

  it('warns when the record got shorter', async () => {
    site = chain(['a', 'b', 'c']);
    await checkRecord(true);
    site = chain(['a']);
    await checkRecord(true);
    expect(recordProblem()?.text).toMatch(/ends at entry 1, but this browser saw entry 3/);
  });

  it('checks the copy on GitHub too, even on a first visit', async () => {
    copy = { seq: 2, hash: chain(['a', 'b'])[1].hash };
    site = chain(['a', 'rewritten', 'c']);
    await checkRecord(true);
    expect(recordProblem()?.text).toMatch(/copy on GitHub: Entry 2/);
  });

  it('warns when an entry was edited in place, keeping its old hash', async () => {
    site = chain(['a', 'b']);
    await checkRecord(true);
    site = chain(['a', 'b']);
    site[1] = { ...site[1], data: { action: 'edited', target: null } };
    await checkRecord(true);
    expect(recordProblem()?.text).toMatch(/entry 2 was changed after it was written/);
  });

  it('only compares with GitHub on the live site', async () => {
    vi.stubGlobal('location', { hostname: 'localhost' });
    copy = { seq: 2, hash: chain(['a', 'b'])[1].hash };
    site = chain(['other', 'c']);
    await checkRecord(true);
    expect(recordProblem()).toBeNull();
  });

  it('remembers nothing new from a check that could not finish', async () => {
    site = chain(['a', 'b']);
    await checkRecord(true);
    site = chain(['a', 'b', 'c']);
    const real = fetch;
    vi.stubGlobal('fetch', async (url: string) => (url.includes('after=2') ? Promise.reject(new Error('offline')) : real(url)));
    await checkRecord(true);
    expect(recordProblem()).toBeNull();
    expect(JSON.parse(store.get('rsdp.auditSeen')!).seq).toBe(2);
  });

  it('checks at most every few minutes unless asked', async () => {
    site = chain(['a']);
    await checkRecord();
    site = chain(['changed']);
    await checkRecord();
    expect(recordProblem()).toBeNull();
  });
});

describe('a hand and a ledger against the record', () => {
  const events = [{ t: 'deal', seat: 0, cards: [] }];
  const hand = { handNumber: 3, button: 0, seats: [{ seat: 0, playerId: 'p1', name: 'Ann', stack: 100 }], events: [], fair: { handId: 'h3', commit: 'c', serverSeed: 's', events } } as unknown as HandRecordView;
  const digest = handDigest({ handId: 'h3', commit: 'c', serverSeed: 's', button: 0, seats: [{ seat: 0, playerId: 'p1', stack: 100 }], events });
  const entry = (data: AuditEntry['data'], seq = 9): AuditEntry => ({ seq, at: 0, kind: data.digest ? 'hand' : 'chips', data, prev: '', hash: '' });

  it('finds a revealed hand with the same fingerprint, in any of its entries', () => {
    const rec = (entries: AuditEntry[], before = false, after = false) => ({ entries, before, after });
    expect(handInRecord(hand, rec([entry({ table: tableRef('t1'), hand: 3, digest })])).ok).toBe(true);
    // Shown after it ended: recorded again, and the browser may have either version.
    expect(handInRecord(hand, rec([entry({ table: tableRef('t1'), hand: 3, digest }, 8), entry({ table: tableRef('t1'), hand: 3, digest: 'later' })])).ok).toBe(true);
    expect(handInRecord(hand, rec([entry({ table: tableRef('t1'), hand: 3, digest: 'other' })])).ok).toBe(false);
    expect(handInRecord(hand, rec([])).ok).toBeNull();
    expect(handInRecord(hand, rec([], true, false)).ok).toBeNull();
    expect(handInRecord(hand, rec([], true, true)).ok).toBe(false);
  });

  it('has no fingerprint for a hand until its server seed is revealed', () => {
    const sealed = { ...hand, fair: { ...hand.fair!, serverSeed: null } } as HandRecordView;
    expect(digestOf(sealed)).toBeNull();
    expect(digestOf(hand)).toBe(digest);
  });

  it('compares each player with their latest chip totals', () => {
    const ledger = [
      { playerId: 'p1', name: 'Ann', buyIn: 200, cashOut: 0 },
      { playerId: 'p2', name: 'Bo', buyIn: 100, cashOut: 50 },
      { playerId: 'bot-1', name: 'Robo', buyIn: 100, cashOut: 0, bot: true },
    ] as LedgerView[];
    const entries = [
      entry({ table: tableRef('t1'), player: playerRef('t1', 'p1'), buyIn: 100, cashOut: 0 }, 1),
      entry({ table: tableRef('t1'), player: playerRef('t1', 'p2'), buyIn: 100, cashOut: 40 }, 2),
      entry({ table: tableRef('t1'), player: playerRef('t1', 'p1'), buyIn: 200, cashOut: 0 }, 3),
    ];
    expect(ledgerMismatches('t1', ledger, entries).map((r) => r.name)).toEqual(['Bo']);
    expect(changedWhileClosed('t1', ledger, [entry({ table: tableRef('t1'), player: playerRef('t1', 'p2'), buyIn: 100, cashOut: 50, loaded: true })]).map((r) => r.name)).toEqual(['Bo']);
  });
});
