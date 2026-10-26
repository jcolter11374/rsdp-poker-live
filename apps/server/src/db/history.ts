/** A player's own record across tables and tournaments, for the profile page. */

import { and, desc, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { hands, tables, tableSnapshots, tournaments } from './schema';

export interface TableHistoryRow {
  tableId: string;
  name: string;
  hands: number;
  lastPlayedAt: Date;
  /** Chips won (above 0) or lost across the player's ids at this table, from its ledger; null when unknown. */
  net: number | null;
  centsMode: boolean;
  /** A practice table with bots. */
  practice: boolean;
}

export interface TournamentHistoryRow {
  id: string;
  name: string;
  status: string;
  /** When it finished, or failing that started, or was made. */
  at: Date;
  entrants: number;
  /** Best finishing place among the player's entries; null while still playing or not placed. */
  place: number | null;
  prize: number;
  hosted: boolean;
}

/** The parts of a runtime snapshot the history reads. */
interface LedgerState {
  seats?: ({ playerId: string; stack: number } | null)[];
  ledger?: Record<string, { buyIn: number; cashOut: number }>;
  bots?: Record<string, unknown>;
  settings?: { stakes?: { centsMode?: boolean } };
}

/** Cash tables where any of `playerIds` was dealt a hand, most recent first. */
export async function tableHistory(db: Db, playerIds: string[], limit = 25): Promise<TableHistoryRow[]> {
  if (playerIds.length === 0) return [];
  const dealt = or(...playerIds.map((id) => sql`${hands.header} -> 'seats' @> ${JSON.stringify([{ playerId: id }])}::jsonb`));
  const rows = await db
    .select({
      tableId: hands.tableId,
      hands: sql<number>`count(*)::int`,
      lastPlayedAt: sql<Date>`max(${hands.startedAt})`,
      name: sql<string>`coalesce(${tables.settings} -> 'table' ->> 'name', '')`,
    })
    .from(hands)
    .innerJoin(tables, sql`${tables.id} = ${hands.tableId}`)
    .where(and(isNull(tables.tournamentId), dealt))
    .groupBy(hands.tableId, tables.settings)
    .orderBy(desc(sql`max(${hands.startedAt})`))
    .limit(limit);
  if (rows.length === 0) return [];

  const snaps = await db
    .select({ tableId: tableSnapshots.tableId, state: tableSnapshots.state })
    .from(tableSnapshots)
    .where(inArray(tableSnapshots.tableId, rows.map((r) => r.tableId)));
  const byTable = new Map(snaps.map((s) => [s.tableId, s.state as LedgerState | undefined]));
  const mine = new Set(playerIds);

  return rows.map((r) => {
    const state = byTable.get(r.tableId);
    let net: number | null = null;
    if (state?.ledger) {
      net = 0;
      for (const [id, row] of Object.entries(state.ledger)) if (mine.has(id)) net += row.cashOut - row.buyIn;
      for (const seat of state.seats ?? []) if (seat && mine.has(seat.playerId)) net += seat.stack;
    }
    return {
      tableId: r.tableId,
      name: r.name,
      hands: Number(r.hands),
      lastPlayedAt: new Date(r.lastPlayedAt),
      net,
      centsMode: !!state?.settings?.stakes?.centsMode,
      practice: Object.keys(state?.bots ?? {}).length > 0,
    };
  });
}

/** Rows of `tournaments` that any of `playerIds` hosted or entered, newest first. */
export async function tournamentRows<S = unknown>(db: Db, playerIds: string[], limit = 25): Promise<{ id: string; hostPlayerId: string; state: S; updatedAt: Date }[]> {
  if (playerIds.length === 0) return [];
  const entered = playerIds.map((id) => sql`${tournaments.state} -> 'entries' @> ${JSON.stringify([{ playerId: id }])}::jsonb`);
  const rows = await db
    .select({ id: tournaments.id, hostPlayerId: tournaments.hostPlayerId, state: tournaments.state, updatedAt: tournaments.updatedAt })
    .from(tournaments)
    .where(or(inArray(tournaments.hostPlayerId, playerIds), ...entered))
    .orderBy(desc(tournaments.updatedAt))
    .limit(limit);
  return rows as { id: string; hostPlayerId: string; state: S; updatedAt: Date }[];
}
