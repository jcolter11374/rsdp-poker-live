import { STATE_VERSION, type TournamentState } from '@rsdp/tournament';
import { listLiveTournaments, loadTournament, saveTournament, type Db } from '../db';
import type { TournamentStore } from './manager';

const LIVE = new Set(['registering', 'seating', 'running', 'paused']);

export function memoryTournamentStore(): TournamentStore {
  const rows = new Map<string, string>();
  const read = (json: string) => JSON.parse(json) as { state: TournamentState; nextId: string | null };
  return {
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
  };
}

export function dbTournamentStore(db: Db): TournamentStore {
  // A state saved by an older or newer director is left alone rather than misread.
  const usable = (r: { state: TournamentState; nextId: string | null }) => r.state.version === STATE_VERSION;
  return {
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
  };
}
