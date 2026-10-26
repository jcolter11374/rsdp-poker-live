/**
 * The public record (rsdp-audit-v1): an append-only, hash-chained list of
 * fingerprints of hands, chip totals, admin actions and server starts. Each
 * entry's hash covers the one before it, so editing or removing an old entry
 * changes every hash after it. Entries hold no names or table links: a table
 * or player appears only as a fingerprint that someone at the table can work
 * out. See docs/FAIRNESS.md and scripts/verify-audit.mjs.
 */

import { sha256Hex } from './fairness';

export const AUDIT_VERSION = 'rsdp-audit-v1';
export const AUDIT_GENESIS = '0'.repeat(64);

export type AuditValue = string | number | boolean | null;
export type AuditKind = 'boot' | 'hand' | 'chips' | 'admin' | 'deleted';

export interface AuditEntry {
  seq: number;
  /** Milliseconds since 1970. */
  at: number;
  kind: AuditKind;
  /** Flat and public: strings, whole numbers, booleans. */
  data: Record<string, AuditValue>;
  prev: string;
  hash: string;
}

/** JSON with keys sorted at every level, no spaces: the same text in every checker. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonicalJson: numbers must be finite');
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function auditHash(e: Omit<AuditEntry, 'hash'>): string {
  return sha256Hex(`${AUDIT_VERSION}|${e.seq}|${e.at}|${e.kind}|${canonicalJson(e.data)}|${e.prev}`);
}

/** Something the public record names without giving away its id or link: a table, a tournament. */
export const subjectRef = (label: string, id: string) => sha256Hex(`${AUDIT_VERSION}|${label}|${id}`).slice(0, 32);
/** A table as the public record names it. Anyone with the table's link can work it out. */
export const tableRef = (tableId: string) => subjectRef('table', tableId);
/** A player at one table; different at every table, so the record can't follow someone around. */
export const playerRef = (tableId: string, playerId: string) => sha256Hex(`${AUDIT_VERSION}|player|${tableId}|${playerId}`).slice(0, 32);

/** What a hand's fingerprint covers: everything "Check this hand" sees once the hand is revealed. */
export interface HandDigestInput {
  handId: string;
  commit: string;
  button: number;
  seats: { seat: number; playerId: string; stack: number }[];
  /** Every event, with every card. */
  events: unknown[];
}

export function handDigest(h: HandDigestInput): string {
  const seats = [...h.seats].sort((a, b) => a.seat - b.seat).map((s) => ({ seat: s.seat, playerId: s.playerId, stack: s.stack }));
  return sha256Hex(`${AUDIT_VERSION}|hand|${canonicalJson({ handId: h.handId, commit: h.commit, button: h.button, seats, events: h.events })}`);
}

/**
 * Checks that entries follow on from each other (and from `after`, the last
 * entry before them, when given). Returns the first problem, or null.
 */
export function chainProblem(entries: AuditEntry[], after?: { seq: number; hash: string } | null): string | null {
  let prev = after ?? null;
  for (const e of entries) {
    if (prev && e.seq !== prev.seq + 1) return `entry ${e.seq} follows entry ${prev.seq}`;
    if (prev && e.prev !== prev.hash) return `entry ${e.seq} doesn't point to entry ${prev.seq}`;
    if (!prev && e.seq === 1 && e.prev !== AUDIT_GENESIS) return 'entry 1 should start the chain';
    if (auditHash(e) !== e.hash) return `entry ${e.seq} was changed after it was written`;
    prev = { seq: e.seq, hash: e.hash };
  }
  return null;
}
