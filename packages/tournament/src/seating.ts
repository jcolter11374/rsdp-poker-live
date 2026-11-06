// Seating draws and table balancing (TRN-31, TRN-32), as pure functions over
// table occupancy. The director applies the results to its state.

import { sha256, shuffle, utf8, type Rng } from '@rsdp/engine';
import type { SeatRngState } from './types';

/** Version tag hashed into every block of the seat-draw stream, so a future scheme can't be confused with this one. */
export const SEAT_RNG_VERSION = 'rsdp-seats-v1';

/** A seat-draw seed: 32 bytes as 64 lowercase hex characters. */
export const isSeatSeed = (seed: unknown): seed is string => typeof seed === 'string' && /^[0-9a-f]{64}$/.test(seed);

/**
 * The seat-draw generator (rsdp-seats-v1): a cryptographically strong stream
 * of numbers from a tournament's secret seed. Word i of the stream is the
 * big-endian 32-bit word i mod 8 of SHA-256("rsdp-seats-v1|<seed>|<i div 8>"),
 * the seed written as its hex text and the block number in decimal. A number
 * in [0, n) is taken by rejection sampling, so every value is equally likely.
 *
 * It starts at `state.at` and moves `state.at` on past every word it reads, so
 * a later draw from the same saved state carries on where this one stopped.
 * The same seed and position always give the same numbers.
 */
export function seatRng(state: SeatRngState): Rng {
  let block = -1;
  let bytes: Uint8Array = new Uint8Array(32);
  const word = () => {
    const b = Math.floor(state.at / 8);
    if (b !== block) {
      bytes = sha256(utf8(`${SEAT_RNG_VERSION}|${state.seed}|${b}`));
      block = b;
    }
    const i = (state.at++ % 8) * 4;
    // Big-endian, then >>> 0 so the top bit doesn't make it negative.
    return ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
  };
  return (n) => {
    if (!Number.isInteger(n) || n < 1 || n > 0x100000000) throw new RangeError(`bad range ${n}`);
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) {
      const x = word();
      if (x < limit) return x % n;
    }
  };
}

/** mulberry32, which drew seats before 2026-11-06: returns [value in [0, 1), next state]. */
export function nextRandom(state: number): [number, number] {
  const s = (state + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

/**
 * The old generator for a tournament saved before 2026-11-06 that has no
 * seat-draw seed: mulberry32 from `holder.rng`, scaled the way the old draws
 * scaled it, so such a state draws exactly what it would have before. It moves
 * `holder.rng` on as it goes.
 */
export function legacySeatRng(holder: { rng: number }): Rng {
  return (n) => {
    const [r, next] = nextRandom(holder.rng);
    holder.rng = next;
    return Math.floor(r * n);
  };
}

export function tablesNeeded(players: number, seatsPerTable: number): number {
  return Math.max(1, Math.ceil(players / seatsPerTable));
}

/**
 * Random initial seating: ceil(n / seats) tables whose counts differ by at
 * most one, with random seats at each table. Returns one seat array per table.
 * The players are shuffled first (Fisher-Yates, `shuffle` in the engine) and
 * dealt round the tables in turn; then each table's seat numbers are shuffled,
 * table by table, and its players take them in order.
 */
export function drawSeats<T>(players: T[], seatsPerTable: number, rng: Rng): (T | null)[][] {
  const shuffled = shuffle(players, rng);
  const count = tablesNeeded(players.length, seatsPerTable);
  const groups: T[][] = Array.from({ length: count }, () => []);
  shuffled.forEach((p, i) => groups[i % count].push(p));
  return groups.map((group) => {
    const seatOrder = shuffle(
      Array.from({ length: seatsPerTable }, (_, i) => i),
      rng,
    );
    const seats: (T | null)[] = new Array(seatsPerTable).fill(null);
    group.forEach((p, i) => (seats[seatOrder[i]] = p));
    return seats;
  });
}

export interface TableLoad {
  id: string;
  players: number;
  /** A hand is running; players can't leave this table until it ends. */
  inHand: boolean;
}

export type BalanceStep =
  | { kind: 'break'; tableId: string }
  | { kind: 'move'; from: string; to: string }
  | null;

/**
 * The next balancing step. Break a table once everyone fits in one fewer
 * table (the table with the fewest players, ties to the newest). Otherwise move
 * one player from the fullest table to the shortest when they differ by two
 * or more. Only tables not in a hand can give up players; returns null when
 * the step has to wait for a hand to end.
 */
export function nextBalanceStep(tables: TableLoad[], seatsPerTable: number): BalanceStep {
  if (tables.length < 2) return null;
  const total = tables.reduce((a, t) => a + t.players, 0);
  if (tables.length > tablesNeeded(total, seatsPerTable)) {
    // Break the shortest table; among equals prefer one that is free now, then the newest.
    const order = [...tables].sort((a, b) => a.players - b.players || Number(a.inHand) - Number(b.inHand) || tables.indexOf(b) - tables.indexOf(a));
    const victim = order[0];
    return victim.inHand ? null : { kind: 'break', tableId: victim.id };
  }
  const max = Math.max(...tables.map((t) => t.players));
  const min = Math.min(...tables.map((t) => t.players));
  if (max - min < 2) return null;
  const to = tables.find((t) => t.players === min)!;
  const from = tables.find((t) => t.players === max && !t.inHand);
  return from ? { kind: 'move', from: from.id, to: to.id } : null;
}

/**
 * Which occupied seat should move off a table: the player due the big blind
 * next, so nobody skips or doubles up on blinds. With no known button, the
 * first occupied seat.
 */
export function seatToMove(seats: (unknown | null)[], button: number | null): number {
  const occupied = seats.map((s, i) => (s === null ? -1 : i)).filter((i) => i >= 0);
  if (!occupied.length) throw new Error('No players to move');
  if (button === null || occupied.length < 3) return occupied[0];
  // Next hand's button is the first occupied seat after this button; the big blind is two after that.
  const after = (seat: number) => occupied.find((i) => i > seat) ?? occupied[0];
  const nextButton = after(button);
  return after(after(nextButton));
}

/**
 * An empty seat at a destination table: the first one clockwise after the
 * last button, or the first empty seat when no button is known. The runtime
 * decides whether a new arrival waits a hand (dead button rules).
 */
export function seatToFill(seats: (unknown | null)[], button: number | null): number {
  const empty = seats.map((s, i) => (s === null ? i : -1)).filter((i) => i >= 0);
  if (!empty.length) throw new Error('Table is full');
  if (button === null) return empty[0];
  return empty.find((i) => i > button) ?? empty[0];
}
