import { STATE_VERSION, type TournamentState } from '@rsdp/tournament';
import { insertTournament, listHostSeasons, listLiveTournaments, listPlayerTournaments, listSeasonTournaments, loadTournament, saveTournament, type Db } from '../db';
import type { TournamentStore } from './manager';

const LIVE = new Set(['registering', 'seating', 'running', 'paused']);
/** Most of a player's own tournaments the home page shows. */
const PLAYER_LIST_MAX = 50;

export function memoryTournamentStore(): TournamentStore {
  const rows = new Map<string, string>();
  const read = (json: string) => JSON.parse(json) as { state: TournamentState; nextId: string | null };
  return {
    async create(state) {
      if (rows.has(state.id)) return false;
      rows.set(state.id, JSON.stringify({ state, nextId: null }));
      return true;
    },
    async save(state, nextId) {
      const prev = rows.get(state.id);
      rows.set(state.id, JSON.stringify({ state, nextId: nextId ?? (prev ? read(prev).nextId : null) }));
    },
    async load(id) {
      const json = rows.get(id);
      return json ? read(json) : null;
    },
    async listLive() {
      return [...rows.values()].map(read).filter((r) => LIVE.has(r.state.status));
    },
    async listForPlayer(playerId, since) {
      return [...rows.values()]
        .map(read)
        .filter((r) => (r.state.hostId === playerId || r.state.entries.some((e) => e.playerId === playerId)) && (r.state.finishedAt ?? Infinity) > since)
        .slice(-PLAYER_LIST_MAX);
    },
    async listSeason(seasonId) {
      return [...rows.values()].map((json) => read(json).state).filter((s) => s.settings.season?.id === seasonId);
    },
    async hostSeasons(hostId) {
      const seasons = new Map<string, { id: string; name: string; events: number }>();
      const mine = [...rows.values()].map((json) => read(json).state).filter((s) => s.hostId === hostId && s.settings.season);
      for (const s of mine.sort((a, b) => b.createdAt - a.createdAt)) {
        const { id, name } = s.settings.season!;
        const seen = seasons.get(id);
        if (seen) seen.events++;
        else seasons.set(id, { id, name, events: 1 });
      }
      return [...seasons.values()];
    },
  };
}

export function dbTournamentStore(db: Db): TournamentStore {
  // A state saved by an older or newer director is left alone rather than misread.
  const usable = (r: { state: TournamentState; nextId: string | null }) => r.state.version === STATE_VERSION;
  return {
    async create(state) {
      return insertTournament(db, { id: state.id, hostPlayerId: state.hostId, status: state.status, state });
    },
    async save(state, nextId) {
      await saveTournament(db, { id: state.id, hostPlayerId: state.hostId, status: state.status, state, nextId });
    },
    async load(id) {
      const row = await loadTournament<TournamentState>(db, id);
      if (!row) return null;
      const r = { state: row.state, nextId: row.nextId };
      return usable(r) ? r : null;
    },
    async listLive() {
      return (await listLiveTournaments<TournamentState>(db)).map((row) => ({ state: row.state, nextId: row.nextId })).filter(usable);
    },
    async listForPlayer(playerId, since) {
      return (await listPlayerTournaments<TournamentState>(db, playerId, new Date(since), PLAYER_LIST_MAX)).map((row) => ({ state: row.state, nextId: row.nextId })).filter(usable);
    },
    async listSeason(seasonId) {
      return (await listSeasonTournaments<TournamentState>(db, seasonId)).map((row) => row.state).filter((s) => s.version === STATE_VERSION);
    },
    hostSeasons: (hostId) => listHostSeasons(db, hostId),
  };
}
