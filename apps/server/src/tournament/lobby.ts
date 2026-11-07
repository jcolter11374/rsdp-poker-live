import { randomBytes } from 'node:crypto';
import { appendTournamentLog, deleteTournamentLogItem, findTournamentLogItem, recentTournamentLog, type Db, type TournamentLogRow } from '../db';
import type { LobbyItem } from '@rsdp/tournament';

/** Where lobby chat and the public event log are kept. */
export interface LobbyStore {
  append(tournamentId: string, items: LobbyItem[]): Promise<void>;
  /** The latest `limit` items, oldest first. */
  recent(tournamentId: string, limit: number): Promise<LobbyItem[]>;
  /** One item by its id, however old, or null. */
  find(tournamentId: string, itemId: string): Promise<LobbyItem | null>;
  /** Deletes one item for good. */
  remove(tournamentId: string, itemId: string): Promise<void>;
}

/** Items a lobby keeps and sends: enough for a long tournament's story without making each subscribe heavy. */
export const LOBBY_KEEP = 300;
/** Lobbies kept in memory at once. */
const LOBBY_CACHE_MAX = 200;

export function memoryLobbyStore(): LobbyStore {
  const rows = new Map<string, LobbyItem[]>();
  return {
    async append(id, items) {
      rows.set(id, [...(rows.get(id) ?? []), ...structuredClone(items)]);
    },
    async recent(id, limit) {
      return structuredClone((rows.get(id) ?? []).slice(-limit));
    },
    async find(id, itemId) {
      return structuredClone((rows.get(id) ?? []).find((x) => x.id === itemId) ?? null);
    },
    async remove(id, itemId) {
      rows.set(id, (rows.get(id) ?? []).filter((x) => x.id !== itemId));
    },
  };
}

type Stored = Omit<LobbyItem, 'id' | 'at'>;
const fromRow = (r: TournamentLogRow<Stored>) => ({ ...r.item, id: r.itemId, at: r.at.getTime() }) as LobbyItem;

export function dbLobbyStore(db: Db): LobbyStore {
  return {
    async append(id, items) {
      await appendTournamentLog(
        db,
        id,
        items.map(({ id: itemId, at, ...rest }) => ({ itemId, at: new Date(at), item: rest })),
      );
    },
    async recent(id, limit) {
      return (await recentTournamentLog<Stored>(db, id, limit)).map(fromRow);
    },
    async find(id, itemId) {
      const row = await findTournamentLogItem<Stored>(db, id, itemId);
      return row && fromRow(row);
    },
    async remove(id, itemId) {
      await deleteTournamentLogItem(db, id, itemId);
    },
  };
}

type NewItem = LobbyItem extends infer I ? (I extends LobbyItem ? Omit<I, 'id'> : never) : never;

/**
 * Each tournament's recent lobby items in memory, loaded on first use, with
 * every new one saved in order behind the ones before it.
 */
export class LobbyLog {
  private readonly cache = new Map<string, Promise<LobbyItem[]>>();
  private readonly saving = new Map<string, Promise<void>>();
  private counter = 0;
  private readonly prefix = randomBytes(3).toString('hex');

  constructor(
    private readonly store: LobbyStore,
    private readonly log: (message: string, err?: unknown) => void,
  ) {}

  items(tournamentId: string): Promise<LobbyItem[]> {
    let list = this.cache.get(tournamentId);
    if (!list) {
      list = this.store.recent(tournamentId, LOBBY_KEEP).catch((e) => {
        this.log(`loading the lobby log of ${tournamentId} failed`, e);
        // Try again next time rather than keep an empty history.
        if (this.cache.get(tournamentId) === list) this.cache.delete(tournamentId);
        return [];
      });
      this.cache.set(tournamentId, list);
      this.trim();
    } else {
      // Most recently used last, for trim().
      this.cache.delete(tournamentId);
      this.cache.set(tournamentId, list);
    }
    return list;
  }

  /** Adds items (with fresh ids) and resolves with them once they are in the in-memory list. */
  async add(tournamentId: string, fresh: NewItem[]): Promise<LobbyItem[]> {
    if (!fresh.length) return [];
    const items = fresh.map((x) => ({ ...x, id: `${this.prefix}${(this.counter++).toString(36)}` }) as LobbyItem);
    const loaded = this.items(tournamentId);
    const next = loaded.then((list) => {
      const have = new Set(list.map((x) => x.id));
      return [...list, ...items.filter((x) => !have.has(x.id))].slice(-LOBBY_KEEP);
    });
    this.cache.set(tournamentId, next);
    // Saved only after the history is read, so a fast insert never shows up in that read as well.
    const saved = Promise.all([this.saving.get(tournamentId), loaded])
      .then(() => this.store.append(tournamentId, items))
      .catch((e) => this.log(`saving the lobby log of ${tournamentId} failed`, e))
      .finally(() => {
        if (this.saving.get(tournamentId) === saved) this.saving.delete(tournamentId);
      });
    this.saving.set(tournamentId, saved);
    await next;
    return items;
  }

  /**
   * One item: from the list in memory, or else from storage, which also holds those too old for the list (a browser
   * that has had the lobby open a long while still shows them). Null when it is not there at all.
   */
  async find(tournamentId: string, itemId: string): Promise<LobbyItem | null> {
    const recent = (await this.items(tournamentId)).find((x) => x.id === itemId);
    if (recent) return recent;
    // After the saves and deletions under way, so storage agrees with the list in memory.
    await this.saving.get(tournamentId);
    return this.store.find(tournamentId, itemId);
  }

  /**
   * Deletes a chat message for good: from storage first (after the save that wrote it), then from the list in memory,
   * so a message that could not be deleted stays where everyone sees it. Rejects when storage refuses.
   */
  async removeChat(tournamentId: string, itemId: string): Promise<void> {
    const removed = Promise.resolve(this.saving.get(tournamentId)).then(() => this.store.remove(tournamentId, itemId));
    // Later saves queue behind it, and trim() keeps the lobby in memory meanwhile, so it is never read back half done.
    const queued = removed
      .catch(() => {})
      .finally(() => {
        if (this.saving.get(tournamentId) === queued) this.saving.delete(tournamentId);
      });
    this.saving.set(tournamentId, queued);
    await removed;
    const next = this.items(tournamentId).then((list) => list.filter((x) => x.id !== itemId));
    this.cache.set(tournamentId, next);
    await next;
  }

  /** Keeps the most recently used lobbies in memory; the rest load again from storage when needed. */
  private trim() {
    for (const id of this.cache.keys()) {
      if (this.cache.size <= LOBBY_CACHE_MAX) break;
      if (!this.saving.has(id)) this.cache.delete(id);
    }
  }

  /** Waits for every save (shutdown). */
  async flush() {
    await Promise.all(this.saving.values());
  }
}
