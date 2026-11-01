import type { Db } from './db';
import { allHandsOfTable, allTableLog, appendTableLog, createTable, deleteTableForGood, getTable, loadSnapshot, saveHand, saveSnapshot } from './db';
import { setDisplayName, whoIs } from './identity';
import { RUNTIME_VERSION, type ChatMessage, type HandRecord, type PastHand, type RuntimeState, type TableLine, type TableLogEntry } from './runtime/types';
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
      // Taken now: lines added from here on go to saveLines.
      const lines = startingLines(state);
      if (await getTable(db, state.id)) return;
      await createTable(db, { id: state.id, ownerPlayerId: state.hostId, settings: state.settings, mode: state.settings.table.mode });
      await saveSnapshot(db, state.id, { version: RUNTIME_VERSION, state });
      await saveLines(state.id, lines);
    },
    async saveTable(state) {
      try {
        await saveSnapshot(db, state.id, { version: RUNTIME_VERSION, state });
      } catch (e) {
        // Postgres refuses a whole snapshot over one lone UTF-16 surrogate in any string, which would stop every save
        // of a money table. Anything that lets one in is a bug, but the table is saved without it rather than not at all.
        const clean = withoutLoneSurrogates(state);
        if (clean === state) throw e;
        await saveSnapshot(db, state.id, { version: RUNTIME_VERSION, state: clean });
      }
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
      const rows = await allHandsOfTable<SavedHeader, PastHand['events'][number]>(db, tableId);
      return rows.map(pastHandFromRow);
    },
    saveLines,
    async loadLines(tableId) {
      const rows = await allTableLog<Record<string, unknown>>(db, tableId);
      return splitLines(rows.map((r) => ({ kind: r.kind, entry: { at: r.at.getTime(), ...r.item } }) as TableLine));
    },
    deleteTable: (tableId) => deleteTableForGood(db, tableId),
  };

  async function saveLines(tableId: string, lines: TableLine[]) {
    // The time has its own column; the rest of the line goes in as it is. A lone surrogate (in a name, say) is
    // taken out, as in snapshots, rather than stop every save of the table's log.
    const rows = withoutLoneSurrogates(lines.map(({ kind, entry: { at, ...item } }) => ({ kind, at, item })));
    await appendTableLog(db, tableId, rows.map((r) => ({ ...r, at: new Date(r.at) })));
  }
}

/** The log and chat lines a new table starts with (a practice table's bots are asked for before it is saved). */
export function startingLines(state: RuntimeState): TableLine[] {
  return [...state.log.map((entry) => ({ kind: 'log' as const, entry })), ...state.chat.map((entry) => ({ kind: 'chat' as const, entry }))].sort((a, b) => a.entry.at - b.entry.at);
}

export function splitLines(lines: TableLine[]): { log: TableLogEntry[]; chat: ChatMessage[] } {
  const out = { log: [] as TableLogEntry[], chat: [] as ChatMessage[] };
  for (const l of lines) {
    if (l.kind === 'log') out.log.push(l.entry);
    else out.chat.push(l.entry);
  }
  return out;
}

/** What a saved hand's header holds (see saveHand above). */
export type SavedHeader = { input: Omit<HandRecord['hand']['input'], 'deck'>; seats: PastHand['seats'] };

/** A saved hand row back into the runtime's shape. */
export function pastHandFromRow(r: { number: number; startedAt: Date; endedAt: Date | null; header: SavedHeader; events: PastHand['events'] }): PastHand {
  return {
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
  };
}

/** `value` with lone UTF-16 surrogates taken out of every string; the same object when there are none. */
export function withoutLoneSurrogates<T>(value: T): T {
  const json = JSON.stringify(value);
  // JSON.stringify writes a lone surrogate as an escape (\udxxx); a whole emoji stays as it is.
  if (!/\\ud[89a-f]/i.test(json)) return value;
  return JSON.parse(json, (_key, v: unknown) => (typeof v === 'string' ? v.replace(/\p{Cs}/gu, '') : v)) as T;
}
