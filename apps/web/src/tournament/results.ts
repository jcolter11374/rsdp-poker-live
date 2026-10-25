import { standings, type TournamentState } from '@rsdp/tournament';

/** A spreadsheet cell: quoted when needed, and never read as a formula. */
function cell(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

/** Standings as CSV: finishing order, entries, rebuys, add-ons, knockouts, bounties, prizes, and chips for those still in. */
export function resultsCsv(s: TournamentState): string {
  const rows = standings(s);
  const money = !!s.settings.payouts;
  const bounties = rows.some((r) => r.bounties || r.knockouts) || !!s.settings.bounty;
  const live = rows.some((r) => r.place === null);
  const head = ['Place', 'Player', 'Entries', 'Rebuys', 'Add-ons', 'Knockouts', ...(bounties ? ['Bounties'] : []), ...(money ? ['Prize'] : []), ...(live ? ['Chips'] : [])];
  const lines = rows.map((r) =>
    [
      r.place ?? '',
      r.displayName,
      r.entryNo,
      r.rebuys,
      r.addOns,
      r.knockouts ?? 0,
      ...(bounties ? [dollars(r.bounties ?? 0)] : []),
      ...(money ? [dollars(r.prize)] : []),
      ...(live ? [r.place === null ? r.stack : ''] : []),
    ].map(cell),
  );
  return [head.map(cell), ...lines].map((l) => l.join(',')).join('\r\n') + '\r\n';
}

/** "Friday Night 2026-10-30.csv" */
export function resultsFileName(s: TournamentState): string {
  const day = new Date(s.startedAt ?? s.createdAt).toISOString().slice(0, 10);
  const name = s.settings.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Tournament';
  return `${name} ${day}.csv`;
}

export function downloadResults(s: TournamentState) {
  // The byte-order mark makes Excel read names with accents and emoji correctly.
  const blob = new Blob(['﻿', resultsCsv(s)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = resultsFileName(s);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
