import type { Db } from './db';
import { allHandsOfTable, createTable, getTable, loadSnapshot, saveHand, saveSnapshot } from './db';
import { setDisplayName, whoIs } from './identity';
import { RUNTIME_VERSION, type HandRecord, type PastHand, type RuntimeState } from './runtime/types';
import { gameTitle } from '@rsdp/engine/variants';
import type { IdentityService, TableStore } from './app';

/** Browser secrets map to persistent guest players; a signed-in browser plays as its account's player. */
export function dbIdentity(db: Db): IdentityService {
  return {
    async resolve(token, session) {
      const { player, account } = await whoIs(db, token, session);
      return { playerId: player.id, displayName: player.displayName, account: account && { username: account.username } };
    },
    async rename(playerId, name) {
      await setDisplayName(db, playerId, name);
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
    async loadHands(tableId) {
      type Header = { input: Omit<HandRecord['hand']['input'], 'deck'>; seats: PastHand['seats'] };
      const rows = await allHandsOfTable<Header, PastHand['events'][number]>(db, tableId);
      return rows.map((r) => ({
        handNumber: r.number,
        startedAt: r.startedAt.getTime(),
        endedAt: (r.endedAt ?? r.startedAt).getTime(),
        gameName: gameTitle(r.header.input.game.id, r.header.input.betting),
        betting: r.header.input.betting,
        stakes: r.header.input.stakes,
        button: r.header.input.button,
        seats: r.header.seats.map((x) => ({ seat: x.seat, playerId: x.playerId, startStack: x.startStack })),
        events: r.events,
        handId: r.header.input.handId,
        fair: r.header.input.fair,
      }));
    },
  };
}
