import { asc, eq } from 'drizzle-orm';
import type { Db } from './client';
import { tableLog } from './schema';

export interface TableLogRow<T = unknown> {
  kind: 'log' | 'chat';
  at: Date;
  item: T;
}

/** Adds a table's log and chat lines in the order given. */
export async function appendTableLog(db: Db, tableId: string, rows: TableLogRow[]): Promise<void> {
  if (!rows.length) return;
  await db.insert(tableLog).values(rows.map((r) => ({ tableId, kind: r.kind, at: r.at, item: r.item })));
}

/** Whether any log or chat line is saved for a table. */
export async function hasTableLog(db: Db, tableId: string): Promise<boolean> {
  const rows = await db.select({ n: tableLog.n }).from(tableLog).where(eq(tableLog.tableId, tableId)).limit(1);
  return rows.length > 0;
}

/** Every log and chat line of a table, oldest first, for downloads. */
export async function allTableLog<T = unknown>(db: Db, tableId: string): Promise<TableLogRow<T>[]> {
  const rows = await db
    .select({ kind: tableLog.kind, at: tableLog.at, item: tableLog.item })
    .from(tableLog)
    .where(eq(tableLog.tableId, tableId))
    .orderBy(asc(tableLog.n));
  return rows as TableLogRow<T>[];
}
