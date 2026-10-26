// The public record's rules (rsdp-audit-v1), written again from scratch with
// Node's built-in OpenSSL SHA-256 and nothing from the app, so a check doesn't
// rely on the code it checks. Must agree with packages/engine/src/audit.ts.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const GENESIS = '0'.repeat(64);
const hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v === undefined ? null : v)).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export const entryHash = (e) => hex(`rsdp-audit-v1|${e.seq}|${e.at}|${e.kind}|${canonical(e.data)}|${e.prev}`);
export const tableRef = (tableId) => hex(`rsdp-audit-v1|table|${tableId}`).slice(0, 32);
export const playerRef = (tableId, playerId) => hex(`rsdp-audit-v1|player|${tableId}|${playerId}`).slice(0, 32);

export function handDigest({ handId, commit, button, seats, events }) {
  const s = [...seats].sort((a, b) => a.seat - b.seat).map((x) => ({ seat: x.seat, playerId: x.playerId, stack: x.stack }));
  return hex(`rsdp-audit-v1|hand|${canonical({ handId, commit, button, seats: s, events })}`);
}

/** The first problem with a run of entries that should follow on from `after` (or start the chain), or null. */
export function chainProblem(entries, after = null) {
  let prev = after;
  for (const e of entries) {
    if (prev && e.seq !== prev.seq + 1) return `entry ${e.seq} follows entry ${prev.seq}`;
    if (prev && e.prev !== prev.hash) return `entry ${e.seq} doesn't point to entry ${prev.seq}`;
    if (!prev && e.seq !== 1) return `the record should start at entry 1, not ${e.seq}`;
    if (!prev && e.prev !== GENESIS) return 'entry 1 should start the chain';
    if (entryHash(e) !== e.hash) return `entry ${e.seq} was changed after it was written`;
    prev = { seq: e.seq, hash: e.hash };
  }
  return null;
}

/** Every entry in a copy of the record (the transparency branch's audit folder), oldest first. */
export function readMirror(dir) {
  const folder = path.join(dir, 'audit');
  let files = [];
  try {
    files = readdirSync(folder).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
  return files.flatMap((f) =>
    readFileSync(path.join(folder, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
}

/** Reads the whole record, or the part after `after`, from a running site. */
export async function fetchEntries(site, after = 0, until = Infinity) {
  const out = [];
  for (;;) {
    const from = out.at(-1)?.seq ?? after;
    if (from >= until) return out;
    const res = await fetch(`${site}/api/audit/entries?after=${from}`);
    if (!res.ok) throw new Error(`${site} answered ${res.status} for the record`);
    const { entries } = await res.json();
    if (!entries.length) return out;
    out.push(...entries);
  }
}
