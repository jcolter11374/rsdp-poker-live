// Seating draws and table balancing (TRN-31, TRN-32), as pure functions over
// table occupancy. The director applies the results to its state.

/** mulberry32: returns [value in [0, 1), next state]. */
export function nextRandom(state: number): [number, number] {
  const s = (state + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

/** Fisher-Yates with the mulberry32 state; returns the shuffled copy and the next state. */
export function shuffle<T>(items: T[], rng: number): [T[], number] {
  const out = [...items];
  let s = rng;
  for (let i = out.length - 1; i > 0; i--) {
    let r: number;
    [r, s] = nextRandom(s);
    const j = Math.floor(r * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return [out, s];
}

export function tablesNeeded(players: number, seatsPerTable: number): number {
  return Math.max(1, Math.ceil(players / seatsPerTable));
}

/**
 * Random initial seating: ceil(n / seats) tables whose counts differ by at
 * most one, with random seats at each table. Returns one seat array per table.
 */
export function drawSeats<T>(players: T[], seatsPerTable: number, rng: number): [(T | null)[][], number] {
  const [shuffled, s1] = shuffle(players, rng);
  const count = tablesNeeded(players.length, seatsPerTable);
  const groups: T[][] = Array.from({ length: count }, () => []);
  shuffled.forEach((p, i) => groups[i % count].push(p));
  let s = s1;
  const tables = groups.map((group) => {
    let seatOrder: number[];
    [seatOrder, s] = shuffle(
      Array.from({ length: seatsPerTable }, (_, i) => i),
      s,
    );
    const seats: (T | null)[] = new Array(seatsPerTable).fill(null);
    group.forEach((p, i) => (seats[seatOrder[i]] = p));
    return seats;
  });
  return [tables, s];
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
