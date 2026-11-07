import type { HandRecordView, LedgerView } from '@rsdp/engine/wire';
import { eventLines, type Fmt } from './format';

/** Hands the browser a file to save. */
export function download(filename: string, text: string, type = 'text/plain') {
  // A byte-order mark so spreadsheet apps read the suits and names as UTF-8.
  const blob = new Blob([type === 'text/csv' ? '﻿' + text : text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A safe file name stem from the table name and today's date. */
export const fileStem = (tableName: string) =>
  `${tableName.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'table'}-${new Date().toISOString().slice(0, 10)}`;

const csvCell = (v: string | number) => {
  // A leading = + - @ would run as a formula in a spreadsheet.
  const s = typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The ledger as CSV. Amounts are in the units shown at the table (dollars in cents mode). */
export function ledgerCsv(rows: LedgerView[], seated: Set<string>, centsMode: boolean): string {
  const amount = (n: number) => (centsMode ? (n / 100).toFixed(2) : String(n));
  const lines = [['player', 'player_id', 'status', 'bought_in', 'took_out', 'stack', 'net'].join(',')];
  for (const r of rows)
    lines.push(
      [csvCell(r.name), r.playerId, seated.has(r.playerId) ? 'seated' : 'left', amount(r.buyIn), amount(r.cashOut), amount(r.stack), amount(r.net)].join(','),
    );
  return lines.join('\r\n') + '\r\n';
}

export interface Transfer {
  from: string;
  to: string;
  amount: number;
}

/**
 * Who pays whom so everyone ends up square, in as few payments as the simple
 * method gives: the biggest loser pays the biggest winner until one is even.
 * `off` is what the nets fail to add up to (0 when the books balance).
 * Practice bots play for nothing: nobody pays them or is paid by them, and
 * `bots` is what they won (or, below 0, lost) in all. Those chips are left
 * out, so some people stay up or down by them.
 */
export function settleUp(rows: { playerId: string; name: string; net: number; bot?: boolean }[]): { transfers: Transfer[]; off: number; bots: number } {
  const people = rows.filter((r) => !r.bot);
  // Kept per player (two people can share a name); names are only for showing.
  const owe = people.filter((r) => r.net < 0).map((r) => ({ id: r.playerId, name: r.name, left: -r.net }));
  const get = people.filter((r) => r.net > 0).map((r) => ({ id: r.playerId, name: r.name, left: r.net }));
  const off = rows.reduce((a, r) => a + r.net, 0);
  const bots = rows.reduce((a, r) => a + (r.bot ? r.net : 0), 0);
  const transfers: Transfer[] = [];
  for (;;) {
    owe.sort((a, b) => b.left - a.left);
    get.sort((a, b) => b.left - a.left);
    const d = owe[0];
    const c = get[0];
    if (!d || !c || d.left === 0 || c.left === 0) break;
    const amount = Math.min(d.left, c.left);
    transfers.push({ from: d.name, to: c.name, amount });
    d.left -= amount;
    c.left -= amount;
  }
  return { transfers, off, bots };
}

/**
 * What the books are off by once the house fee is allowed for. The fee takes chips off the table and pays them to
 * nobody, so at a table that takes one the nets add up to minus the fees taken, and that is not a mistake in the
 * buy-ins. `fees` is the total taken, or null for a viewer the host doesn't show it to: then a shortfall at a table
 * with the fee on is put down to the fee.
 */
export function offAfterFees(off: number, fees: number | null, feeOn: boolean): number {
  if (fees !== null) return off + fees;
  return feeOn && off < 0 ? 0 : off;
}

/**
 * The hands file (the Hands tab's JSON download), which the replayer opens
 * again. The bots' reasons stay out: they were for the one person in each
 * hand, and a file gets passed around.
 */
export function handsJson(tableName: string, centsMode: boolean, hands: HandRecordView[], exportedAt = new Date()): string {
  const plain = hands.map((h) => {
    const copy = { ...h };
    delete copy.botNotes;
    return copy;
  });
  return JSON.stringify({ format: 'rsdp-hands', version: 1, table: tableName, exportedAt: exportedAt.toISOString(), centsMode, hands: plain }, null, 1);
}

/** Every hand as a readable text log, the same lines as the table's log. */
export function handHistoryText(tableName: string, hands: HandRecordView[], myId: string, fmt: Fmt): string {
  const out = [`${tableName} — hand history (${hands.length} hands)`, ''];
  for (const h of hands) {
    const names = new Map(h.seats.map((s) => [s.seat, s.name]));
    const mySeat = h.seats.find((s) => s.playerId === myId)?.seat ?? null;
    out.push(`${new Date(h.startedAt).toLocaleString()}`);
    out.push(`Seats: ${h.seats.map((s) => `${s.seat + 1}. ${s.name} (${fmt(s.stack)})${s.seat === h.button ? ' [button]' : ''}`).join(', ')}`);
    for (const line of eventLines(h.events, (seat) => names.get(seat) ?? `Seat ${seat + 1}`, fmt, mySeat)) {
      out.push(line.replace(/^--- /, '').replace(/\[([2-9TJQKA])([cdhs])\]/g, (_, r: string, s: string) => (r === 'T' ? '10' : r) + { c: '♣', d: '♦', h: '♥', s: '♠' }[s]));
    }
    out.push('');
  }
  return out.join('\n');
}

/** One line of the full table log: when, what kind, and the text. */
export interface FullLogLine {
  at: number;
  kind: 'table' | 'chat' | 'hand';
  text: string;
}

const SUIT_SYMBOL: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };
const plainCards = (line: string) => line.replace(/\[([2-9TJQKA])([cdhs])\]/g, (_, r: string, s: string) => (r === 'T' ? '10' : r) + SUIT_SYMBOL[s]);

/**
 * Everything that happened at the table in time order: joins and host
 * actions, chat, and every hand's lines (placed at the hand's start).
 */
export function fullLogLines(
  log: { at: number; text: string }[],
  chat: { at: number; playerId: string | null; name: string; text: string }[],
  hands: HandRecordView[],
  myId: string,
  fmt: Fmt,
): FullLogLine[] {
  const lines: (FullLogLine & { order: number })[] = [];
  let order = 0;
  for (const l of log) lines.push({ at: l.at, kind: 'table', text: l.text, order: order++ });
  for (const m of chat) lines.push({ at: m.at, kind: 'chat', text: m.playerId ? `${m.name}: ${m.text}` : m.text, order: order++ });
  for (const h of hands) {
    const names = new Map(h.seats.map((s) => [s.seat, s.name]));
    const mySeat = h.seats.find((s) => s.playerId === myId)?.seat ?? null;
    lines.push({ at: h.startedAt, kind: 'hand', text: `Seats: ${h.seats.map((s) => `${s.seat + 1}. ${s.name} (${fmt(s.stack)})`).join(', ')}`, order: order++ });
    for (const line of eventLines(h.events, (seat) => names.get(seat) ?? `Seat ${seat + 1}`, fmt, mySeat))
      lines.push({ at: h.startedAt, kind: 'hand', text: plainCards(line.replace(/^--- /, '')), order: order++ });
  }
  return lines.sort((a, b) => a.at - b.at || a.order - b.order).map(({ order: _o, ...l }) => l);
}

export function fullLogText(tableName: string, lines: FullLogLine[]): string {
  const out = [`${tableName}: full log (${lines.length} lines)`, ''];
  for (const l of lines) out.push(`${new Date(l.at).toLocaleString()}  ${l.kind === 'chat' ? '[chat] ' : ''}${l.text}`);
  return out.join('\n') + '\n';
}

export function fullLogCsv(lines: FullLogLine[]): string {
  const rows = [['at', 'kind', 'entry'].join(',')];
  for (const l of lines) rows.push([new Date(l.at).toISOString(), l.kind, csvCell(l.text)].join(','));
  return rows.join('\r\n') + '\r\n';
}
