// Season leaderboards: points and records across the finished events of one
// season (a recurring series, or any events the host puts in it).
//
// Points per event = entrants - place + 1, so the winner of a 12-player event
// scores 12 and last place scores 1; tied players share the better place.

import { standings } from './director';
import type { PlayerId, TournamentState } from './types';

export interface SeasonEvent {
  id: string;
  name: string;
  finishedAt: number;
  entrants: number;
  winners: string[];
}

export interface SeasonRow {
  playerId: PlayerId;
  /** The name used in their latest event. */
  displayName: string;
  points: number;
  games: number;
  wins: number;
  /** Finishes in the money (needs payouts). */
  cashes: number;
  bestPlace: number;
  knockouts: number;
  /** Display-only money (cents): prizes plus bounties won. */
  won: number;
  /** Prizes and bounties won minus what was paid in; null when no event in the season set money values. */
  net: number | null;
  lastPlayedAt: number;
}

export interface SeasonBoard {
  id: string;
  name: string;
  hostId: PlayerId;
  events: SeasonEvent[];
  rows: SeasonRow[];
}

export const seasonPoints = (entrants: number, place: number) => Math.max(1, entrants - place + 1);

/** The leaderboard from a season's events; only finished ones count. Rows are ranked by points, then wins, then fewer games. */
export function seasonBoard(id: string, events: TournamentState[]): SeasonBoard {
  const done = events.filter((s) => s.status === 'finished' && s.settings.season?.id === id).sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  const latest = [...events].sort((a, b) => b.createdAt - a.createdAt)[0];
  const rows = new Map<PlayerId, SeasonRow>();
  const out: SeasonEvent[] = [];
  const anyMoney = done.some((s) => s.settings.payouts || s.settings.bounty);
  for (const s of done) {
    const st = standings(s);
    const entrants = st.length;
    const at = s.finishedAt ?? s.createdAt;
    const money = s.settings.payouts?.money;
    const bountyEach = s.settings.bounty?.amount ?? 0;
    out.push({ id: s.id, name: s.settings.name, finishedAt: at, entrants, winners: st.filter((x) => x.place === 1).map((x) => x.displayName) });
    for (const x of st) {
      if (x.place === null) continue;
      const entries = s.entries.filter((e) => e.playerId === x.playerId);
      const rebuys = entries.reduce((a, e) => a + e.rebuys, 0);
      const addOns = entries.reduce((a, e) => a + e.addOns, 0);
      const paid = (money ? money.buyIn * entries.length + (money.rebuy ?? 0) * rebuys + (money.addOn ?? 0) * addOns : 0) + bountyEach * (entries.length + rebuys);
      const won = x.prize + x.bounties;
      const r = rows.get(x.playerId) ?? {
        playerId: x.playerId,
        displayName: x.displayName,
        points: 0,
        games: 0,
        wins: 0,
        cashes: 0,
        bestPlace: x.place,
        knockouts: 0,
        won: 0,
        net: anyMoney ? 0 : null,
        lastPlayedAt: at,
      };
      r.displayName = x.displayName;
      r.points += seasonPoints(entrants, x.place);
      r.games++;
      if (x.place === 1) r.wins++;
      if (x.prize > 0) r.cashes++;
      r.bestPlace = Math.min(r.bestPlace, x.place);
      r.knockouts += x.knockouts;
      r.won += won;
      if (r.net !== null) r.net += won - paid;
      r.lastPlayedAt = at;
      rows.set(x.playerId, r);
    }
  }
  return {
    id,
    name: latest?.settings.season?.name ?? 'Season',
    hostId: latest?.hostId ?? '',
    events: out,
    rows: [...rows.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || a.games - b.games || a.displayName.localeCompare(b.displayName)),
  };
}
