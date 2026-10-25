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
 */
export function settleUp(rows: { playerId: string; name: string; net: number }[]): { transfers: Transfer[]; off: number } {
  // Kept per player (two people can share a name); names are only for showing.
  const owe = rows.filter((r) => r.net < 0).map((r) => ({ id: r.playerId, name: r.name, left: -r.net }));
  const get = rows.filter((r) => r.net > 0).map((r) => ({ id: r.playerId, name: r.name, left: r.net }));
  const off = rows.reduce((a, r) => a + r.net, 0);
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
  return { transfers, off };
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
