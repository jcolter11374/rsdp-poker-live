import type { SharedHandView } from '@rsdp/engine/wire';
import { deleteSharedHand, getSharedHand, insertSharedHand, type Db } from './db';

/** Where shared hand links are kept. The default keeps them in memory. */
export interface SharedHandStore {
  create(input: { id: string; tableId: string; handNumber: number; createdBy: string; snapshot: SharedHandView }): Promise<void>;
  get(id: string): Promise<SharedHandView | null>;
  /** True when the link existed and was made by `by`. */
  remove(id: string, by: string): Promise<boolean>;
}

export function memorySharedHands(): SharedHandStore {
  const rows = new Map<string, { createdBy: string; snapshot: SharedHandView }>();
  return {
    async create(input) {
      rows.set(input.id, { createdBy: input.createdBy, snapshot: structuredClone(input.snapshot) });
    },
    async get(id) {
      const row = rows.get(id);
      return row ? structuredClone(row.snapshot) : null;
    },
    async remove(id, by) {
      if (rows.get(id)?.createdBy !== by) return false;
      return rows.delete(id);
    },
  };
}

export function dbSharedHands(db: Db): SharedHandStore {
  return {
    async create(input) {
      await insertSharedHand(db, { ...input, createdAt: new Date(input.snapshot.createdAt) });
    },
    async get(id) {
      const row = await getSharedHand(db, id);
      return row ? (row.snapshot as SharedHandView) : null;
    },
    remove: (id, by) => deleteSharedHand(db, id, by),
  };
}
