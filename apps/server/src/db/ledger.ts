/**
 * Seat sessions and the append-only chip ledger.
 *
 * Every movement records the signed change to one player's stack (rake
 * records chips leaving the table). Hands move chips between players without
 * ledger rows and are zero-sum apart from rake, so at any hand boundary the
 * seated players' stacks add up to the sum of every amount at the table:
 * that is the invariant checkLedger verifies.
 */

import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from './client';
import { assertChips, StorageError } from './errors';
import { newId } from './ids';
import { chipMovements, seatSessions, type MovementKind } from './schema';

export type SeatSession = typeof seatSessions.$inferSelect;
export type ChipMovement = typeof chipMovements.$inferSelect;

type Sign = 'positive' | 'negative' | 'not-positive' | 'not-zero';

/** Which way each kind may move a stack. */
const SIGN: Record<MovementKind, Sign> = {
  'buy-in': 'positive',
  rebuy: 'positive',
  'add-on': 'positive',
  'host-add': 'positive',
  'host-remove': 'negative',
  'host-set': 'not-zero',
  'cash-out': 'not-positive',
  'escrow-in': 'negative',
  'escrow-out': 'positive',
  bounty: 'not-zero',
  rake: 'negative',
};

const HOST_KINDS: MovementKind[] = ['host-add', 'host-remove', 'host-set'];
const ESCROW_KINDS: MovementKind[] = ['escrow-in', 'escrow-out'];

// ---------------------------------------------------------------- seat sessions

/** Starts a player's stretch in a seat. A seat, and a player, can have only one open session per table. */
export async function openSeatSession(
  db: Db,
  input: { tableId: string; playerId: string; seat: number; now?: Date },
): Promise<SeatSession> {
  if (!Number.isSafeInteger(input.seat) || input.seat < 0) throw new StorageError('invalid', 'seat must be a seat index');
  const [row] = await db
    .insert(seatSessions)
    .values({
      id: newId(),
      tableId: input.tableId,
      playerId: input.playerId,
      seat: input.seat,
      startedAt: input.now ?? new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new StorageError('conflict', 'that seat is taken or the player is already seated');
  return row;
}

/** Ends a seat session. Closing one that already ended keeps its original end time. */
export async function closeSeatSession(db: Db, seatSessionId: string, now: Date = new Date()): Promise<SeatSession> {
  const [row] = await db
    .update(seatSessions)
    .set({ endedAt: sql`coalesce(${seatSessions.endedAt}, ${now})` })
    .where(eq(seatSessions.id, seatSessionId))
    .returning();
  if (!row) throw new StorageError('not-found', 'no such seat session');
  return row;
}

export async function openSeatSessions(db: Db, tableId: string): Promise<SeatSession[]> {
  return db
    .select()
    .from(seatSessions)
    .where(and(eq(seatSessions.tableId, tableId), isNull(seatSessions.endedAt)))
    .orderBy(asc(seatSessions.seat));
}

// ---------------------------------------------------------------- movements

export interface MovementInput {
  tableId: string;
  kind: MovementKind;
  /**
   * Signed change to the player's stack: positive for buy-in, rebuy, add-on,
   * host-add and escrow-out; negative for host-remove, escrow-in and rake;
   * minus the whole stack for cash-out; either way for host-set and bounty.
   */
  amount: number;
  /** Required for every kind except rake. */
  playerId?: string | null;
  seatSessionId?: string | null;
  /** The stack just before the movement. Required for every kind except rake. */
  stackBefore?: number | null;
  /** Null when the system moved the chips. */
  actorPlayerId?: string | null;
  handNumber?: number | null;
  now?: Date;
}

type MovementShape = Pick<ChipMovement, 'kind' | 'amount' | 'playerId' | 'stackBefore' | 'stackAfter'>;

/** Why a movement breaks the ledger rules, or null when it is fine. */
function movementProblem(m: MovementShape): string | null {
  if (!Number.isSafeInteger(m.amount)) return 'amount must be a whole number of chips';
  const sign = SIGN[m.kind];
  if (!sign) return `unknown kind ${m.kind}`;
  if (sign === 'positive' && m.amount <= 0) return `${m.kind} must add chips`;
  if (sign === 'negative' && m.amount >= 0) return `${m.kind} must remove chips`;
  if (sign === 'not-positive' && m.amount > 0) return `${m.kind} cannot add chips`;
  if (sign === 'not-zero' && m.amount === 0) return `${m.kind} must change the stack`;
  if (m.kind !== 'rake' && (m.playerId === null || m.stackBefore === null)) return `${m.kind} needs a player and a stack`;
  if (m.stackBefore === null) return m.stackAfter === null ? null : 'stack_after without stack_before';
  if (!Number.isSafeInteger(m.stackBefore) || m.stackBefore < 0) return 'stack_before must be a whole, non-negative number';
  if (m.stackAfter !== m.stackBefore + m.amount) return 'stack_after must equal stack_before + amount';
  if (m.stackAfter < 0) return 'the stack cannot go below zero';
  if (m.kind === 'cash-out' && m.stackAfter !== 0) return 'cash-out takes the whole stack';
  return null;
}

/** Appends one movement after checking it against the ledger rules. There is no update or delete. */
export async function recordMovement(db: Db, input: MovementInput): Promise<ChipMovement> {
  assertChips(input.amount, 'amount');
  if (input.stackBefore != null) assertChips(input.stackBefore, 'stackBefore');
  const shape: MovementShape = {
    kind: input.kind,
    amount: input.amount,
    playerId: input.playerId ?? null,
    stackBefore: input.stackBefore ?? null,
    stackAfter: input.stackBefore == null ? null : input.stackBefore + input.amount,
  };
  const problem = movementProblem(shape);
  if (problem) throw new StorageError('invalid', problem);
  if (input.handNumber != null && (!Number.isSafeInteger(input.handNumber) || input.handNumber < 0)) {
    throw new StorageError('invalid', 'handNumber must be a hand number');
  }

  if (input.seatSessionId) {
    const [session] = await db.select().from(seatSessions).where(eq(seatSessions.id, input.seatSessionId));
    if (!session || session.tableId !== input.tableId || session.playerId !== shape.playerId) {
      throw new StorageError('invalid', 'the seat session belongs to another table or player');
    }
  }

  const [row] = await db
    .insert(chipMovements)
    .values({
      id: newId(),
      tableId: input.tableId,
      seatSessionId: input.seatSessionId ?? null,
      playerId: shape.playerId,
      kind: input.kind,
      amount: input.amount,
      stackBefore: shape.stackBefore,
      stackAfter: shape.stackAfter,
      actorPlayerId: input.actorPlayerId ?? null,
      handNumber: input.handNumber ?? null,
      createdAt: input.now ?? new Date(),
    })
    .returning();
  return row;
}

/** Every movement at a table in the order it was recorded. */
export async function listMovements(db: Db, tableId: string, opts: { playerId?: string } = {}): Promise<ChipMovement[]> {
  return db
    .select()
    .from(chipMovements)
    .where(and(eq(chipMovements.tableId, tableId), opts.playerId ? eq(chipMovements.playerId, opts.playerId) : undefined))
    .orderBy(asc(chipMovements.seq));
}

// ---------------------------------------------------------------- ledger

export interface LedgerEntry {
  playerId: string;
  buyIn: number;
  rebuys: number;
  addOns: number;
  /** Net of host-add, host-remove and host-set. */
  hostAdjust: number;
  /** Chips taken off the table when leaving (positive). */
  cashOut: number;
  /** Net bounty transfers to (positive) or from this player. */
  bounty: number;
  /** Net escrow movement: negative while the player has chips in escrow. */
  escrow: number;
  /** buyIn + rebuys + addOns + hostAdjust. */
  totalIn: number;
  seated: boolean;
  seat: number | null;
  seatSessionId: string | null;
  /** Live stack when the caller passed one, otherwise the last stack the ledger saw; 0 once the player left. */
  stack: number;
  /** Profit or loss so far: stack + cashOut - totalIn. */
  net: number;
}

export interface Ledger {
  tableId: string;
  /** Seated players by seat, then everyone who left. */
  players: LedgerEntry[];
  totals: {
    buyIns: number;
    rebuys: number;
    addOns: number;
    hostAdjust: number;
    cashOut: number;
    /** Chips taken by the house (positive). */
    rake: number;
    /** Chips sitting in escrow (nit game), not in anyone's stack. */
    escrowHeld: number;
    bounty: number;
    /** Sum of every amount: what the seated players' stacks should add up to. */
    onTable: number;
  };
}

function emptyEntry(playerId: string): LedgerEntry {
  return {
    playerId,
    buyIn: 0,
    rebuys: 0,
    addOns: 0,
    hostAdjust: 0,
    cashOut: 0,
    bounty: 0,
    escrow: 0,
    totalIn: 0,
    seated: false,
    seat: null,
    seatSessionId: null,
    stack: 0,
    net: 0,
  };
}

/**
 * Per-player buy-ins, rebuys, add-ons, cash-outs, stacks and results for a
 * table, plus table totals. Pass the runtime's live stacks (by player id);
 * without them a seated player's stack is the last one the ledger recorded,
 * which is stale once hands have been played.
 */
export async function ledgerFor(db: Db, tableId: string, stacks?: Record<string, number>): Promise<Ledger> {
  const sums = await db
    .select({
      playerId: chipMovements.playerId,
      kind: chipMovements.kind,
      total: sql<number>`coalesce(sum(${chipMovements.amount}), 0)::bigint`.mapWith(Number),
    })
    .from(chipMovements)
    .where(eq(chipMovements.tableId, tableId))
    .groupBy(chipMovements.playerId, chipMovements.kind);
  const open = await openSeatSessions(db, tableId);
  const lastStacks = await db
    .selectDistinctOn([chipMovements.playerId], { playerId: chipMovements.playerId, stack: chipMovements.stackAfter })
    .from(chipMovements)
    .where(and(eq(chipMovements.tableId, tableId), isNotNull(chipMovements.playerId), isNotNull(chipMovements.stackAfter)))
    .orderBy(chipMovements.playerId, desc(chipMovements.seq));

  const entries = new Map<string, LedgerEntry>();
  const entry = (playerId: string) => {
    let e = entries.get(playerId);
    if (!e) entries.set(playerId, (e = emptyEntry(playerId)));
    return e;
  };
  const totals: Ledger['totals'] = {
    buyIns: 0,
    rebuys: 0,
    addOns: 0,
    hostAdjust: 0,
    cashOut: 0,
    rake: 0,
    escrowHeld: 0,
    bounty: 0,
    onTable: 0,
  };

  for (const { playerId, kind, total } of sums) {
    assertChips(total, 'ledger total');
    totals.onTable += total;
    if (kind === 'rake') totals.rake -= total;
    if (ESCROW_KINDS.includes(kind)) totals.escrowHeld -= total;
    if (!playerId) continue;
    const e = entry(playerId);
    if (kind === 'buy-in') e.buyIn += total;
    else if (kind === 'rebuy') e.rebuys += total;
    else if (kind === 'add-on') e.addOns += total;
    else if (HOST_KINDS.includes(kind)) e.hostAdjust += total;
    else if (kind === 'cash-out') e.cashOut -= total;
    else if (kind === 'bounty') e.bounty += total;
    else if (ESCROW_KINDS.includes(kind)) e.escrow += total;
  }

  const last = new Map(lastStacks.map((r) => [r.playerId!, r.stack ?? 0]));
  for (const s of open) {
    const e = entry(s.playerId);
    e.seated = true;
    e.seat = s.seat;
    e.seatSessionId = s.id;
    e.stack = stacks?.[s.playerId] ?? last.get(s.playerId) ?? 0;
  }

  for (const e of entries.values()) {
    e.totalIn = e.buyIn + e.rebuys + e.addOns + e.hostAdjust;
    e.net = e.stack + e.cashOut - e.totalIn;
    totals.buyIns += e.buyIn;
    totals.rebuys += e.rebuys;
    totals.addOns += e.addOns;
    totals.hostAdjust += e.hostAdjust;
    totals.cashOut += e.cashOut;
    totals.bounty += e.bounty;
  }

  const players = [...entries.values()].sort((a, b) =>
    a.seated !== b.seated ? (a.seated ? -1 : 1) : a.seated ? a.seat! - b.seat! : a.playerId.localeCompare(b.playerId),
  );
  return { tableId, players, totals };
}

export interface LedgerCheck {
  ok: boolean;
  problems: string[];
  /** Chips the ledger says are in seated stacks. */
  expectedOnTable: number;
  /** Sum of the stacks passed in, or null when none were. */
  actualOnTable: number | null;
}

/**
 * Re-verifies every stored movement and the table-wide invariants: escrow
 * never pays out more than it took in, bounties net to zero, and (given the
 * runtime's stacks at a hand boundary) the seated stacks add up to the ledger.
 */
export async function checkLedger(db: Db, tableId: string, stacks?: Record<string, number>): Promise<LedgerCheck> {
  const problems: string[] = [];
  for (const m of await listMovements(db, tableId)) {
    const problem = movementProblem(m);
    if (problem) problems.push(`movement ${m.id} (${m.kind}): ${problem}`);
  }
  const ledger = await ledgerFor(db, tableId, stacks);
  const { totals } = ledger;
  if (totals.escrowHeld < 0) problems.push(`escrow paid out ${-totals.escrowHeld} more than it took in`);
  if (totals.bounty !== 0) problems.push(`bounty transfers net to ${totals.bounty}, not 0`);

  let actualOnTable: number | null = null;
  if (stacks) {
    actualOnTable = 0;
    const seated = new Set(ledger.players.filter((p) => p.seated).map((p) => p.playerId));
    for (const [playerId, stack] of Object.entries(stacks)) {
      if (!Number.isSafeInteger(stack) || stack < 0) problems.push(`stack for ${playerId} is not a whole, non-negative number`);
      else actualOnTable += stack;
      if (!seated.has(playerId)) problems.push(`stack given for ${playerId}, who has no open seat session`);
    }
    for (const playerId of seated) if (!(playerId in stacks)) problems.push(`no stack given for seated player ${playerId}`);
    if (actualOnTable !== totals.onTable) {
      problems.push(`seated stacks add up to ${actualOnTable} but the ledger expects ${totals.onTable}`);
    }
  }
  return { ok: problems.length === 0, problems, expectedOnTable: totals.onTable, actualOnTable };
}
