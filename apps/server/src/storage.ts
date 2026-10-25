import type { Db } from './db';
import { createTable, getTable, loadSnapshot, saveHand, saveSnapshot } from './db';
import { resolveToken } from './identity';
import { RUNTIME_VERSION, type RuntimeState } from './runtime/types';
import type { IdentityService, TableStore } from './app';

/** Browser secrets map to persistent guest players; accounts come with the account pages. */
export function dbIdentity(db: Db): IdentityService {
  return {
    async resolve(token) {
      const player = await resolveToken(db, token);
      return { playerId: player.id, displayName: player.displayName, account: null };
    },
  };
}

/** Tables are saved as runtime snapshots; finished hands go to hand history. */
export function dbStore(db: Db): TableStore {
  return {
    async createTable(state) {
      if (await getTable(db, state.id)) return;
      await createTable(db, { id: state.id, ownerPlayerId: state.hostId, settings: state.settings, mode: state.settings.table.mode });
      await saveSnapshot(db, state.id, { version: RUNTIME_VERSION, state });
    },
    async saveTable(state) {
      await saveSnapshot(db, state.id, { version: RUNTIME_VERSION, state });
    },
    async loadTable(id) {
      const snap = await loadSnapshot<RuntimeState>(db, id);
      // A snapshot from a newer or older runtime is not loaded rather than misread.
      if (!snap || snap.version !== RUNTIME_VERSION) return null;
      return snap.state;
    },
    async saveHand(tableId, record) {
      const { hand } = record;
      // The deck order stays out of history; everything dealt is in the events.
      const { deck: _deck, ...input } = hand.input;
      await saveHand(db, {
        id: input.handId,
        tableId,
        number: record.handNumber,
        gameId: input.game.id,
        startedAt: new Date(record.startedAt),
        endedAt: new Date(record.endedAt),
        header: { input, seats: hand.seats.map((x) => ({ seat: x.seat, playerId: x.playerId, startStack: x.startStack, shown: x.shown })) },
        events: hand.events,
        results: { awards: hand.awards },
      });
    },
  };
}
