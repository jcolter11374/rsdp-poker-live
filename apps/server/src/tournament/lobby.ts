import { randomBytes } from 'node:crypto';
import { appendTournamentLog, recentTournamentLog, type Db } from '../db';
import type { LobbyItem } from '@rsdp/tournament';

/** Where lobby chat and the public event log are kept. */
export interface LobbyStore {
  append(tournamentId: string, items: LobbyItem[]): Promise<void>;
  /** The latest `limit` items, oldest first. */
  recent(tournamentId: string, limit: number): Promise<LobbyItem[]>;
}

/** Items a lobby keeps and sends: enough for a long tournament's story without making each subscribe heavy. */
export const LOBBY_KEEP = 300;

export function memoryLobbyStore(): LobbyStore {
  const rows = new Map<string, LobbyItem[]>();
  return {
    async append(id, items) {
      rows.set(id, [...(rows.get(id) ?? []), ...structuredClone(items)]);
    },
    async recent(id, limit) {
      return structuredClone((rows.get(id) ?? []).slice(-limit));
    },
  };
}

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
      return (await recentTournamentLog<Omit<LobbyItem, 'id' | 'at'>>(db, id, limit)).map((r) => ({ ...r.item, id: r.itemId, at: r.at.getTime() }) as LobbyItem);
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
        return [];
      });
      this.cache.set(tournamentId, list);
    }
    return list;
  }

  /** Adds items (with fresh ids) and resolves with them once they are in the in-memory list. */
  async add(tournamentId: string, fresh: NewItem[]): Promise<LobbyItem[]> {
    if (!fresh.length) return [];
    const items = fresh.map((x) => ({ ...x, id: `${this.prefix}${(this.counter++).toString(36)}` }) as LobbyItem);
    const next = this.items(tournamentId).then((list) => [...list, ...items].slice(-LOBBY_KEEP));
    this.cache.set(tournamentId, next);
    const saved = (this.saving.get(tournamentId) ?? Promise.resolve())
      .then(() => this.store.append(tournamentId, items))
      .catch((e) => this.log(`saving the lobby log of ${tournamentId} failed`, e));
    this.saving.set(tournamentId, saved);
    await next;
    return items;
  }

  /** Waits for every save (shutdown). */
  async flush() {
    await Promise.all(this.saving.values());
  }
}
