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

/** Every log and chat line of a table, oldest first, for downloads. */
export async function allTableLog<T = unknown>(db: Db, tableId: string): Promise<TableLogRow<T>[]> {
  const rows = await db
    .select({ kind: tableLog.kind, at: tableLog.at, item: tableLog.item })
    .from(tableLog)
    .where(eq(tableLog.tableId, tableId))
    .orderBy(asc(tableLog.n));
  return rows as TableLogRow<T>[];
}
