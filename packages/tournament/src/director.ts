// The tournament director: a pure state machine over a whole tournament.
//
//   createTournament(...)            -> TournamentState
//   apply(state, command, now)       -> { state, events }
//   tick(state, now)                 -> { state, events }
//   nextWakeAt(state)                -> when the server must call tick next
//   tableGate(state, tableId, now)   -> may this table deal its next hand?
//   levelFor(state, tableId)         -> game and stakes for that next hand
//   standings(state)                 -> places, stacks and prizes
//
// The server checks that a command's `by` may act as host before applying it.
// Invalid commands throw DirectorError and leave the state unchanged. After
// every apply or tick the server re-reads nextWakeAt. Level changes, breaks,
// scheduled starts and offer expiries only take effect in tick, so the server
// must wake at nextWakeAt (a 1 s tick is a fine fallback).

import { placePrizes, prizePool, prizesForPlaces, validatePayoutStructure, type PrizeMoney } from './payouts';
import { nextOccurrence, validateSchedule } from './recurrence';
import { drawSeats, nextBalanceStep, seatToFill, seatToMove, type TableLoad } from './seating';
import { clockAt, levelEndMs, MAX_CHIPS, presetStructure, rowStartMs, validateStructure, type LevelRow } from './structure';
import { cleanText, hasUnstorableText, isId } from './text';
import {
  STATE_VERSION,
  type Command,
  type DirectorEvent,
  type Entry,
  type EntryId,
  type Gate,
  type HandResult,
  type LevelStakes,
  type PendingRequest,
  type PlayerId,
  type RequestKind,
  type Result,
  type SeatInfo,
  type Standing,
  type TableId,
  type TableState,
  type TournamentSettings,
  type TournamentState,
} from './types';

export class DirectorError extends Error {}

const fail = (message: string): never => {
  throw new DirectorError(message);
};

// ---------------------------------------------------------------------------
// Settings

export function defaultSettings(overrides: Partial<TournamentSettings> = {}): TournamentSettings {
  const startingStack = overrides.startingStack ?? 10_000;
  return {
    name: 'Tournament',
    start: { kind: 'manual' },
    games: ['nlhe'],
    structure: presetStructure('regular', { startingStack }),
    startingStack,
    seatsPerTable: 9,
    maxEntrants: 600,
    seatLeadSeconds: 60,
    graceMinutes: 15,
    registrationApproval: false,
    lateRegistration: { enabled: true, throughLevel: 4 },
    reEntry: { enabled: false, throughLevel: null, max: null, approval: false },
    rebuy: { max: 0, chips: startingStack, approval: false, offerSeconds: 15 },
    addOn: { max: 0, chips: startingStack, approval: false },
    allowQuit: false,
    handForHand: true,
    ...overrides,
  };
}

const NAME_MAX = 40;
/** The end of year 9999: later start times cannot be shown, stored in Postgres, or handled by the time-zone maths. */
const MAX_DATE_MS = 253_402_300_799_999;
const CHIPS_LABEL = MAX_CHIPS.toLocaleString('en-US');
/** Most chips the whole field may hold, so any stack or pot the engine adds up stays a safe integer. */
export const MAX_CHIPS_IN_PLAY = Math.floor(Number.MAX_SAFE_INTEGER / 4);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isWhole = (n: unknown, min: number, max: number) => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max;
/** A level number or count of at least 1, or null for no limit. */
const isLimit = (n: unknown) => n === null || isWhole(n, 1, Number.MAX_SAFE_INTEGER);

/** Every setting, so unknown keys never reach the saved state. */
const SETTINGS_KEYS: Record<keyof TournamentSettings, true> = {
  name: true,
  start: true,
  games: true,
  stopRotationAtLevel: true,
  structure: true,
  startingStack: true,
  seatsPerTable: true,
  maxEntrants: true,
  seatLeadSeconds: true,
  graceMinutes: true,
  registrationApproval: true,
  lateRegistration: true,
  reEntry: true,
  rebuy: true,
  addOn: true,
  allowQuit: true,
  payouts: true,
  handForHand: true,
};

/** Only the known settings, with the free text cleaned (names are cut by whole characters). */
function cleanSettings(raw: Partial<TournamentSettings>): Partial<TournamentSettings> {
  const out: Partial<TournamentSettings> = Object.fromEntries(Object.entries(raw ?? {}).filter(([k]) => Object.hasOwn(SETTINGS_KEYS, k)));
  if (typeof out.name === 'string') out.name = cleanText(out.name);
  const payoutName = out.payouts?.structure?.name;
  if (typeof payoutName === 'string') {
    const name = Array.from(cleanText(payoutName)).slice(0, NAME_MAX).join('');
    out.payouts = { ...out.payouts!, structure: { ...out.payouts!.structure, name } };
  }
  return out;
}

export function validateSettings(s: TournamentSettings): string[] {
  if (!isObject(s)) return ['The settings are missing'];
  const missing = (['start', 'lateRegistration', 'reEntry', 'rebuy', 'addOn'] as const).filter((k) => !isObject(s[k]));
  if (missing.length) return [`Missing settings: ${missing.join(', ')}`];
  const { start, lateRegistration: late, reEntry, rebuy, addOn } = s;
  const errors: string[] = [];
  const nameLength = typeof s.name === 'string' ? Array.from(cleanText(s.name)).length : 0;
  if (nameLength < 1 || nameLength > NAME_MAX) errors.push(`Name must be 1-${NAME_MAX} characters`);
  if (!isWhole(s.seatsPerTable, 2, 10)) errors.push('Seats per table must be 2-10');
  if (!isWhole(s.maxEntrants, 2, 600)) errors.push('Max entrants must be 2-600');
  if (!isWhole(s.startingStack, 1, MAX_CHIPS)) errors.push(`Starting stack must be a whole number from 1 to ${CHIPS_LABEL}`);
  if (!Array.isArray(s.games) || !s.games.length) errors.push('Pick at least one game');
  else if (!s.games.every(isId)) errors.push('Every game must be a game id');
  if (s.stopRotationAtLevel != null && !isLimit(s.stopRotationAtLevel)) errors.push('Rotation must stop at level 1 or later');
  errors.push(...validateStructure(s.structure, { maxRebuys: rebuy.max }).errors);
  if (!isWhole(rebuy.max, 0, Number.MAX_SAFE_INTEGER)) errors.push('Rebuys per player must be a whole number');
  // Checked even while off: an open rebuy offer or a pending request still pays these out.
  if (!isWhole(rebuy.chips, 1, MAX_CHIPS)) errors.push(`Rebuy chips must be a whole number from 1 to ${CHIPS_LABEL}`);
  if (!isWhole(addOn.chips, 1, MAX_CHIPS)) errors.push(`Add-on chips must be a whole number from 1 to ${CHIPS_LABEL}`);
  if (!isWhole(rebuy.offerSeconds, 1, 300)) errors.push('Rebuy offer window must be 1-300 seconds');
  if (!isWhole(addOn.max, 0, Number.MAX_SAFE_INTEGER)) errors.push('Add-ons per player must be a whole number');
  if (addOn.max > 0 && (!Array.isArray(s.structure) || !s.structure.some((r) => r?.kind === 'break' && r.addOn)))
    errors.push('Add-ons are on, but no break offers them');
  // All the chips one entry can be given, so stacks stay safe integers in the engine.
  const extra = (b: { max: number; chips: number }) => (b.max > 0 && isWhole(b.max, 0, Number.MAX_SAFE_INTEGER) && isWhole(b.chips, 1, MAX_CHIPS) ? b.max * b.chips : 0);
  if (isWhole(s.startingStack, 1, MAX_CHIPS) && s.startingStack + extra(rebuy) + extra(addOn) > MAX_CHIPS)
    errors.push(`The starting stack plus every rebuy and add-on must be at most ${CHIPS_LABEL} chips`);
  if (!isWhole(s.graceMinutes, 0, 24 * 60)) errors.push('Grace period must be 0-1440 minutes');
  if (!isWhole(s.seatLeadSeconds, 0, 3600)) errors.push('Seating lead must be 0-3600 seconds');
  if (!isLimit(late.throughLevel)) errors.push('Late registration must close at level 1 or later');
  if (!isLimit(reEntry.throughLevel)) errors.push('Re-entry must close at level 1 or later');
  if (!isLimit(reEntry.max)) errors.push('Re-entries per player must be at least 1');
  const flags = [s.registrationApproval, s.allowQuit, s.handForHand, late.enabled, reEntry.enabled, reEntry.approval, rebuy.approval, addOn.approval];
  if (start.kind === 'sng') flags.push(start.autoSpawn);
  if (!flags.every((f) => typeof f === 'boolean')) errors.push('On/off settings must be true or false');
  if (start.kind === 'sng') {
    const { playersNeeded, startDelaySeconds } = start;
    if (!isWhole(playersNeeded, 2, s.maxEntrants)) errors.push('Players needed must be 2 up to max entrants');
    if (!isWhole(startDelaySeconds, 0, 900)) errors.push('Start delay must be 0-900 seconds');
  } else if (start.kind === 'scheduled') {
    if (!isWhole(start.startAt, 0, MAX_DATE_MS)) errors.push('Pick a start time');
    if (start.schedule != null) errors.push(...validateSchedule(start.schedule));
  } else if (start.kind !== 'manual') errors.push('Pick how the tournament starts');
  if (s.payouts) {
    errors.push(...validatePayoutStructure(s.payouts.structure, s.maxEntrants));
    // Standings read these on every finish, so they must be usable numbers.
    const m: Partial<PrizeMoney> = isObject(s.payouts.money) ? s.payouts.money : {};
    if (![m.buyIn, m.rebuy ?? 0, m.addOn ?? 0, m.added ?? 0].every((n) => isWhole(n, 0, Number.MAX_SAFE_INTEGER)))
      errors.push('Prize money must be whole amounts of 0 or more');
    if (m.feePercent !== undefined && !(typeof m.feePercent === 'number' && m.feePercent >= 0 && m.feePercent <= 100)) errors.push('The fee must be 0-100%');
  }
  // The structure checks its own rows.
  if (hasUnstorableText({ ...s, structure: null })) errors.push('Settings contain characters that cannot be saved');
  return errors;
}

export interface CreateInput {
  id: string;
  hostId: PlayerId;
  settings: TournamentSettings;
  now: number;
  /** Any 32-bit integer; the server should pick it with a CSPRNG. */
  seed: number;
}

export function createTournament({ id, hostId, settings: raw, now, seed }: CreateInput): TournamentState {
  const settings = cleanSettings(raw) as TournamentSettings;
  const errors = validateSettings(settings);
  if (settings.start?.kind === 'scheduled' && settings.start.startAt <= now) errors.push('The start time has already passed');
  if (errors.length) fail(errors.join('; '));
  return {
    version: STATE_VERSION,
    id,
    hostId,
    settings: structuredClone(settings),
    status: 'registering',
    createdAt: now,
    startAt: settings.start.kind === 'scheduled' ? settings.start.startAt : null,
    graceUntil: null,
    startedAt: null,
    finishedAt: null,
    clock: { elapsedMs: 0, runningSince: null, rowIndex: 0 },
    entries: [],
    tables: [],
    requests: [],
    eliminations: [],
    handForHand: { active: false, round: 0 },
    counters: { entry: 0, table: 0, request: 0 },
    rng: seed >>> 0,
  };
}

// ---------------------------------------------------------------------------
// Queries

const ALIVE = new Set(['registered', 'seated', 'rebuy-offer']);
const isAlive = (e: Entry) => ALIVE.has(e.status);

export const aliveEntries = (s: TournamentState) => s.entries.filter(isAlive);

function activeEntry(s: TournamentState, playerId: PlayerId): Entry | undefined {
  return s.entries.find((e) => e.playerId === playerId && isAlive(e));
}

function latestEntry(s: TournamentState, playerId: PlayerId): Entry | undefined {
  return s.entries.filter((e) => e.playerId === playerId).sort((a, b) => b.entryNo - a.entryNo)[0];
}

/** Entries that count toward max entrants and finishing places (re-entries replace the busted entry). */
const rankedEntries = (s: TournamentState) => s.entries.filter((e) => !e.supersededBy);

function table(s: TournamentState, tableId: TableId): TableState {
  return s.tables.find((t) => t.id === tableId) ?? fail(`Unknown table ${tableId}`);
}

function entry(s: TournamentState, id: EntryId): Entry {
  return s.entries.find((e) => e.id === id)!;
}

const tablePlayers = (s: TournamentState, t: TableState) => t.seats.filter((x): x is EntryId => x !== null).map((id) => entry(s, id));

function elapsed(s: TournamentState, now: number): number {
  return s.clock.elapsedMs + (s.clock.runningSince === null ? 0 : now - s.clock.runningSince);
}

/** Where the clock stood at the last tick. */
function position(s: TournamentState) {
  return clockAt(s.settings.structure, rowStartMs(s.settings.structure, s.clock.rowIndex));
}

const started = (s: TournamentState) => s.status === 'running' || s.status === 'paused';

/** Open while the current level is at most `through` (a break after `through` counts as closed). */
function withinLevel(s: TournamentState, through: number | null): boolean {
  if (through === null || !started(s)) return true;
  const p = position(s);
  return p.levelNumber < through || (p.levelNumber === through && !p.onBreak);
}

const hasRoom = (s: TournamentState) => rankedEntries(s).length < s.settings.maxEntrants;

export function registrationOpen(s: TournamentState): boolean {
  if (!hasRoom(s)) return false;
  if (s.status === 'registering' || s.status === 'seating') return true;
  if (!started(s)) return false;
  return s.settings.lateRegistration.enabled && withinLevel(s, s.settings.lateRegistration.throughLevel);
}

export function rebuysOpen(s: TournamentState): boolean {
  if (s.settings.rebuy.max <= 0 || !started(s)) return false;
  const rows = s.settings.structure;
  const i = s.clock.rowIndex;
  const row = rows[i];
  if (row.kind === 'level') return !!row.rebuy;
  const before = rows.slice(0, i).reverse().find((r): r is LevelRow => r.kind === 'level');
  return !!before?.rebuy;
}

export function addOnsOpen(s: TournamentState): boolean {
  const row = s.settings.structure[s.clock.rowIndex];
  return s.settings.addOn.max > 0 && started(s) && row.kind === 'break' && !!row.addOn;
}

export function reEntryOpen(s: TournamentState): boolean {
  return s.settings.reEntry.enabled && started(s) && withinLevel(s, s.settings.reEntry.throughLevel);
}

export function paidPlaces(s: TournamentState): number {
  if (!s.settings.payouts) return 0;
  const range = s.settings.payouts.structure.ranges.find((r) => s.entries.length >= r.minEntries && s.entries.length <= r.maxEntries);
  return range?.percents.length ?? 0;
}

export function currentPrizePool(s: TournamentState): number {
  if (!s.settings.payouts) return 0;
  const sum = (f: (e: Entry) => number) => s.entries.reduce((a, e) => a + f(e), 0);
  return prizePool(s.settings.payouts.money, { entries: s.entries.length, rebuys: sum((e) => e.rebuys), addOns: sum((e) => e.addOns) });
}

/**
 * Finishing places. Elimination groups are ranked from the bottom up in the
 * order they happened. Within a group, players at the same table are ordered
 * by their stack at the start of the hand (bigger places higher, equal stacks
 * tie); players at different tables with the same rank at their table tie
 * (hand-for-hand busts). Tied players share the best place of their block.
 */
function places(s: TournamentState): Map<EntryId, number> {
  const out = new Map<EntryId, number>();
  let next = rankedEntries(s).length;
  for (const group of s.eliminations) {
    const members = group.members.filter((m) => !entry(s, m.entryId).supersededBy);
    const tier = (m: (typeof members)[number]) =>
      new Set(members.filter((o) => o.tableId === m.tableId && o.startStack > m.startStack).map((o) => o.startStack)).size;
    const tiers = members.map(tier);
    const first = next - members.length + 1;
    members.forEach((m, i) => out.set(m.entryId, first + tiers.filter((t) => t < tiers[i]).length));
    next -= members.length;
  }
  return out;
}

export function standings(s: TournamentState): Standing[] {
  const placeOf = places(s);
  const prizes = s.settings.payouts ? placePrizes(currentPrizePool(s), s.settings.payouts.structure, s.entries.length) : [];
  const prizeOf = prizesForPlaces(Object.fromEntries(placeOf), prizes);
  return s.entries
    .filter((e) => !e.supersededBy)
    .map((e) => ({
      entryId: e.id,
      playerId: e.playerId,
      displayName: e.displayName,
      entryNo: e.entryNo,
      place: placeOf.get(e.id) ?? null,
      stack: isAlive(e) ? e.stack : 0,
      rebuys: e.rebuys,
      addOns: e.addOns,
      prize: prizeOf[e.id] ?? 0,
      eliminatedBy: e.bust?.by ?? [],
    }))
    .sort((a, b) => (a.place ?? 0) - (b.place ?? 0) || b.stack - a.stack);
}

/** May this table deal its next hand? */
export function tableGate(s: TournamentState, tableId: TableId, _now: number): Gate {
  if (s.status !== 'running') return 'hold';
  const t = s.tables.find((x) => x.id === tableId);
  if (!t) return 'hold';
  if (position(s).onBreak) return 'hold';
  const players = tablePlayers(s, t);
  if (players.some((e) => e.status === 'rebuy-offer')) return 'hold';
  if (players.filter((e) => e.status === 'seated' && e.stack > 0).length < 2) return 'hold';
  if (s.handForHand.active && t.hfhPlayed >= s.handForHand.round) return 'hold';
  return 'deal';
}

/** Game and stakes for the next hand (during a break, the level after it). */
export function levelFor(s: TournamentState, _tableId: TableId): LevelStakes {
  const p = position(s);
  const level = p.level;
  const levelNumber = p.onBreak ? p.levelNumber + 1 : p.levelNumber;
  const { games, stopRotationAtLevel } = s.settings;
  const rotationLevel = stopRotationAtLevel ? Math.min(levelNumber, stopRotationAtLevel) : levelNumber;
  const gameId = level.gameId ?? games[(rotationLevel - 1) % games.length];
  const smallBet = level.limit?.smallBet ?? level.bb;
  return {
    levelNumber,
    gameId,
    sb: level.sb,
    bb: level.bb,
    ante: level.ante,
    anteType: level.anteType,
    smallBet,
    bigBet: level.limit?.bigBet ?? smallBet * 2,
    bringIn: level.limit?.bringIn ?? Math.max(1, Math.floor(smallBet / 3)),
  };
}

/** When the server must call tick next, or null when nothing is scheduled. */
export function nextWakeAt(s: TournamentState): number | null {
  const times: number[] = [];
  const { start } = s.settings;
  if (s.status === 'registering' && start.kind === 'scheduled' && s.startAt !== null) {
    if (s.graceUntil !== null) times.push(s.graceUntil);
    else if (aliveEntries(s).length >= 2) times.push(s.startAt - s.settings.seatLeadSeconds * 1000);
    else times.push(s.startAt);
  }
  if (s.status === 'seating' && s.startAt !== null) times.push(s.startAt);
  if (started(s)) {
    for (const e of s.entries) if (e.status === 'rebuy-offer' && e.rebuyOfferExpiresAt !== undefined) times.push(e.rebuyOfferExpiresAt);
    if (s.status === 'running' && s.clock.runningSince !== null) {
      const rows = s.settings.structure;
      const lastLevel = rows.map((r) => r.kind).lastIndexOf('level');
      if (s.clock.rowIndex < lastLevel) {
        times.push(s.clock.runningSince + rowStartMs(rows, s.clock.rowIndex + 1) - s.clock.elapsedMs);
      }
    }
  }
  return times.length ? Math.min(...times) : null;
}

/** Wall time at which a level ends, if the clock keeps running from now. */
export function levelEndsAt(s: TournamentState, levelNumber: number, now: number): number | null {
  const end = levelEndMs(s.settings.structure, levelNumber);
  return end === null ? null : now + end - elapsed(s, now);
}

// ---------------------------------------------------------------------------
// Mutations. Each runs on a private copy through a context.

interface Ctx {
  s: TournamentState;
  events: DirectorEvent[];
  now: number;
}

const emit = (c: Ctx, e: DirectorEvent) => c.events.push(e);

function seatInfo(c: Ctx, e: Entry): SeatInfo {
  return { tableId: e.tableId!, seat: e.seat!, entryId: e.id, playerId: e.playerId, displayName: e.displayName, stack: e.stack };
}

/** Each entry is capped, but unlimited re-entries are not, and their chips can all end up in one stack. */
function checkChipsInPlay(s: TournamentState, chips: number) {
  const inPlay = aliveEntries(s).reduce((sum, e) => sum + e.stack, 0);
  if (inPlay + chips > MAX_CHIPS_IN_PLAY) fail('The tournament cannot hold any more chips');
}

function newEntry(c: Ctx, playerId: PlayerId, displayName: string, entryNo: number): Entry {
  checkChipsInPlay(c.s, c.s.settings.startingStack);
  const e: Entry = {
    id: `${c.s.id}:e${++c.s.counters.entry}`,
    playerId,
    displayName,
    entryNo,
    status: 'registered',
    stack: c.s.settings.startingStack,
    tableId: null,
    seat: null,
    rebuys: 0,
    addOns: 0,
    registeredAt: c.now,
  };
  c.s.entries.push(e);
  return e;
}

function newTable(c: Ctx): TableState {
  const t: TableState = {
    id: `${c.s.id}:t${++c.s.counters.table}`,
    seats: new Array(c.s.settings.seatsPerTable).fill(null),
    inHand: false,
    lastHandNumber: 0,
    button: null,
    hfhPlayed: c.s.handForHand.round,
    hfhHand: null,
  };
  c.s.tables.push(t);
  return t;
}

function register(c: Ctx, playerId: PlayerId, displayName: string) {
  const s = c.s;
  const late = started(s);
  const e = newEntry(c, playerId, displayName, 1);
  emit(c, { type: 'registered', entryId: e.id, playerId, displayName, late, entryNo: 1 });
  if (s.tables.length) seatLate(c, e, 'late-registration');
  afterRegistration(c);
}

/** Starts a delayed scheduled event or a full Sit & Go once enough players are in. */
function afterRegistration(c: Ctx) {
  const s = c.s;
  if (s.status !== 'registering') return;
  const count = aliveEntries(s).length;
  if (s.settings.start.kind === 'scheduled' && s.graceUntil !== null && count >= 2) {
    seatAll(c);
    begin(c);
  } else if (s.settings.start.kind === 'sng' && count >= s.settings.start.playersNeeded) {
    seatAll(c);
    s.startAt = c.now + s.settings.start.startDelaySeconds * 1000;
    if (s.settings.start.autoSpawn) emit(c, { type: 'spawnNext' });
    if (s.startAt <= c.now) begin(c);
  }
}

function seatAll(c: Ctx) {
  const s = c.s;
  const waiting = s.entries.filter((e) => e.status === 'registered');
  const [draw, rng] = drawSeats(waiting.map((e) => e.id), s.settings.seatsPerTable, s.rng);
  s.rng = rng;
  const created: { tableId: TableId; seats: SeatInfo[] }[] = [];
  for (const seats of draw) {
    const t = newTable(c);
    t.seats = seats;
    seats.forEach((id, seat) => {
      if (id === null) return;
      const e = entry(s, id);
      Object.assign(e, { status: 'seated', tableId: t.id, seat });
    });
    created.push({ tableId: t.id, seats: tablePlayers(s, t).map((e) => seatInfo(c, e)) });
  }
  s.status = 'seating';
  emit(c, { type: 'tablesCreated', tables: created });
}

function begin(c: Ctx) {
  const s = c.s;
  s.status = 'running';
  s.startedAt = c.now;
  s.startAt ??= c.now;
  s.graceUntil = null;
  s.clock = { elapsedMs: 0, runningSince: c.now, rowIndex: 0 };
  emit(c, { type: 'started', at: c.now });
  emitLevel(c);
  const { start } = s.settings;
  if (start.kind === 'scheduled' && start.schedule?.repeat) {
    const next = nextOccurrence(start.schedule, start.startAt);
    if (next !== null) emit(c, { type: 'scheduleNext', startAt: next });
  }
  updateHandForHand(c);
}

function emitLevel(c: Ctx) {
  const l = levelFor(c.s, '');
  emit(c, { type: 'levelUp', levelNumber: l.levelNumber, sb: l.sb, bb: l.bb, ante: l.ante, anteType: l.anteType, gameId: l.gameId });
}

/** Seats one player at the table with the fewest players, opening a table if all are full. */
function seatLate(c: Ctx, e: Entry, reason: 'late-registration' | 're-entry') {
  const s = c.s;
  const open = s.tables.filter((t) => t.seats.includes(null)).sort((a, b) => tablePlayers(s, a).length - tablePlayers(s, b).length);
  let t = open[0];
  if (!t) {
    t = newTable(c);
    emit(c, { type: 'tableOpened', tableId: t.id });
  }
  const seat = seatToFill(t.seats, t.button);
  t.seats[seat] = e.id;
  Object.assign(e, { status: 'seated', tableId: t.id, seat });
  emit(c, { type: 'seatPlayer', seat: seatInfo(c, e), reason });
  rebalance(c);
}

function unseat(c: Ctx, e: Entry) {
  if (e.tableId) {
    const t = table(c.s, e.tableId);
    if (t.seats[e.seat!] === e.id) t.seats[e.seat!] = null;
  }
}

/**
 * Knocks out a set of entries together. The emitted place is provisional:
 * later re-entries or hand-for-hand ties can change it; standings() is final.
 */
function eliminate(c: Ctx, members: Entry[], reason: 'busted' | 'quit' | 'removed', hfhRound?: number) {
  if (!members.length) return;
  const s = c.s;
  const groupMembers = members.map((e) => ({ entryId: e.id, startStack: e.bust?.startStack ?? e.stack, tableId: e.bust?.tableId ?? e.tableId }));
  // Hand-for-hand busts in the same round share one group, so they tie across tables.
  const existing = hfhRound !== undefined ? s.eliminations.find((g) => g.hfhRound === hfhRound) : undefined;
  if (existing) existing.members.push(...groupMembers);
  else s.eliminations.push({ members: groupMembers, at: c.now, ...(hfhRound !== undefined ? { hfhRound } : {}) });
  const seats = members.map((e) => ({ tableId: e.tableId, seat: e.seat }));
  for (const e of members) {
    unseat(c, e);
    e.status = reason === 'busted' ? 'busted' : reason;
    e.bust ??= { at: c.now, startStack: e.stack, tableId: e.tableId, by: [] };
    e.stack = 0;
    e.tableId = null;
    e.seat = null;
    delete e.rebuyOfferExpiresAt;
    delete e.leaveRequested;
  }
  const placeOf = places(s);
  members.forEach((e, i) =>
    emit(c, { type: 'eliminated', entryId: e.id, playerId: e.playerId, place: placeOf.get(e.id)!, by: e.bust!.by, ...seats[i], reason }),
  );
  s.requests = s.requests.filter((r) => !(r.kind === 'rebuy' && members.some((e) => e.id === r.entryId)));
}

function canRebuy(s: TournamentState, e: Entry): boolean {
  return rebuysOpen(s) && e.rebuys < s.settings.rebuy.max;
}

function addChips(c: Ctx, e: Entry, chips: number, reason: 'rebuy' | 'add-on') {
  checkChipsInPlay(c.s, chips);
  e.stack += chips;
  if (reason === 'rebuy') {
    e.rebuys++;
    e.status = 'seated';
    delete e.rebuyOfferExpiresAt;
    delete e.bust;
  } else e.addOns++;
  emit(c, { type: 'stackAdded', entryId: e.id, playerId: e.playerId, tableId: e.tableId, seat: e.seat, chips, reason });
}

function reEnter(c: Ctx, old: Entry) {
  const e = newEntry(c, old.playerId, old.displayName, old.entryNo + 1);
  old.supersededBy = e.id;
  emit(c, { type: 'registered', entryId: e.id, playerId: e.playerId, displayName: e.displayName, late: true, entryNo: e.entryNo });
  seatLate(c, e, 're-entry');
}

function request(c: Ctx, kind: RequestKind, e: { playerId: PlayerId; displayName: string }, entryId?: EntryId) {
  const r: PendingRequest = { id: `${c.s.id}:r${++c.s.counters.request}`, kind, playerId: e.playerId, displayName: e.displayName, at: c.now, ...(entryId ? { entryId } : {}) };
  c.s.requests.push(r);
  emit(c, { type: 'requestPending', request: r });
}

function loads(s: TournamentState): TableLoad[] {
  return s.tables.map((t) => {
    const players = tablePlayers(s, t);
    return { id: t.id, players: players.length, inHand: t.inHand || players.some((e) => e.status === 'rebuy-offer') };
  });
}

function moveEntry(c: Ctx, e: Entry, to: TableState) {
  const from = { tableId: e.tableId!, seat: e.seat! };
  unseat(c, e);
  const seat = seatToFill(to.seats, to.button);
  to.seats[seat] = e.id;
  e.tableId = to.id;
  e.seat = seat;
  emit(c, { type: 'moveSeat', entryId: e.id, playerId: e.playerId, from, to: { tableId: to.id, seat }, stack: e.stack });
}

/** Breaks tables and evens them out, only touching tables between hands. */
function rebalance(c: Ctx) {
  const s = c.s;
  if (!(s.status === 'seating' || started(s))) return;
  for (let guard = 0; guard < 1000; guard++) {
    const step = nextBalanceStep(loads(s), s.settings.seatsPerTable);
    if (!step) break;
    if (step.kind === 'break') {
      const victim = table(s, step.tableId);
      for (const e of tablePlayers(s, victim)) {
        const dest = s.tables
          .filter((t) => t !== victim && t.seats.includes(null))
          .sort((a, b) => tablePlayers(s, a).length - tablePlayers(s, b).length)[0];
        moveEntry(c, e, dest);
      }
      s.tables = s.tables.filter((t) => t !== victim);
      emit(c, { type: 'tableBroken', tableId: victim.id });
    } else {
      const from = table(s, step.from);
      const to = table(s, step.to);
      let seat = seatToMove(from.seats, from.button);
      const chosen = entry(s, from.seats[seat]!);
      if (chosen.status !== 'seated') seat = from.seats.findIndex((id) => id !== null && entry(s, id).status === 'seated');
      moveEntry(c, entry(s, from.seats[seat]!), to);
    }
  }
  updateHandForHand(c);
}

function updateHandForHand(c: Ctx) {
  const s = c.s;
  const paid = paidPlaces(s);
  const shouldBeOn = started(s) && s.settings.handForHand && paid > 0 && s.tables.length > 1 && aliveEntries(s).length === paid + 1;
  if (shouldBeOn && !s.handForHand.active) {
    s.handForHand = { active: true, round: s.handForHand.round + 1 };
    for (const t of s.tables) t.hfhPlayed = s.handForHand.round - 1;
    emit(c, { type: 'handForHand', active: true });
  } else if (!shouldBeOn && s.handForHand.active) {
    s.handForHand = { ...s.handForHand, active: false };
    emit(c, { type: 'handForHand', active: false });
  }
}

/** Advances a hand-for-hand round once every table has played it. */
function advanceHandForHand(s: TournamentState) {
  const h = s.handForHand;
  if (h.active && s.tables.every((t) => !t.inHand && t.hfhPlayed >= h.round)) h.round++;
}

function checkFinish(c: Ctx) {
  const s = c.s;
  if (!started(s)) return;
  const alive = aliveEntries(s);
  if (alive.length > 1 || alive.some((e) => e.status === 'rebuy-offer')) return;
  // A lone survivor waits while a busted player can still re-enter. Open late registration does not
  // hold it: once one player has every chip the tournament is over.
  const { max } = s.settings.reEntry;
  const canReEnter = s.entries.some((e) => e.status === 'busted' && !e.supersededBy && (max === null || e.entryNo - 1 < max));
  if (alive.length === 1 && reEntryOpen(s) && canReEnter) return;
  finish(c);
}

function finish(c: Ctx) {
  const s = c.s;
  const alive = aliveEntries(s);
  if (alive.length) {
    s.eliminations.push({ members: alive.map((e) => ({ entryId: e.id, startStack: e.stack, tableId: null })), at: c.now });
  }
  s.status = 'finished';
  s.finishedAt = c.now;
  if (s.clock.runningSince !== null) s.clock = { ...s.clock, elapsedMs: elapsed(s, c.now), runningSince: null };
  s.handForHand.active = false;
  s.requests = [];
  emit(c, { type: 'finished', standings: standings(s) });
}

function cancel(c: Ctx, reason: 'not-enough-players' | 'host') {
  c.s.status = 'cancelled';
  c.s.finishedAt = c.now;
  c.s.requests = [];
  emit(c, { type: 'cancelled', reason });
}

/** Moves the clock to `now`, announcing level changes, breaks and closing windows. */
function advanceClock(c: Ctx) {
  const s = c.s;
  if (s.status !== 'running') return;
  const target = clockAt(s.settings.structure, elapsed(s, c.now)).rowIndex;
  while (s.clock.rowIndex < target) {
    const before = { late: registrationOpen(s), rebuy: rebuysOpen(s), reEntry: reEntryOpen(s) };
    const wasBreak = s.settings.structure[s.clock.rowIndex].kind === 'break';
    s.clock.rowIndex++;
    const row = s.settings.structure[s.clock.rowIndex];
    if (wasBreak) emit(c, { type: 'breakEnded' });
    if (row.kind === 'break') {
      const endsAt = s.clock.runningSince! + rowStartMs(s.settings.structure, s.clock.rowIndex + 1) - s.clock.elapsedMs;
      emit(c, { type: 'breakStarted', minutes: row.minutes, endsAt, addOn: !!row.addOn && s.settings.addOn.max > 0 });
    } else emitLevel(c);
    if (before.late && !registrationOpen(s) && s.settings.lateRegistration.enabled) emit(c, { type: 'lateRegistrationClosed' });
    if (before.rebuy && !rebuysOpen(s)) emit(c, { type: 'rebuysClosed' });
    if (before.reEntry && !reEntryOpen(s)) emit(c, { type: 'reEntryClosed' });
  }
}

function expireOffers(c: Ctx) {
  const expired = c.s.entries.filter((e) => e.status === 'rebuy-offer' && e.rebuyOfferExpiresAt! <= c.now);
  eliminate(c, expired, 'busted');
}

function settle(c: Ctx) {
  rebalance(c);
  checkFinish(c);
}

// ---------------------------------------------------------------------------
// Public transitions

function run(state: TournamentState, now: number, fn: (c: Ctx) => void): Result {
  const c: Ctx = { s: structuredClone(state), events: [], now };
  fn(c);
  return { state: c.s, events: c.events };
}

export function tick(state: TournamentState, now: number): Result {
  return run(state, now, (c) => {
    const s = c.s;
    const { start } = s.settings;
    if (s.status === 'registering' && start.kind === 'scheduled' && s.startAt !== null) {
      const count = aliveEntries(s).length;
      if (count >= 2 && now >= s.startAt - s.settings.seatLeadSeconds * 1000) seatAll(c);
      else if (now >= s.startAt) {
        if (s.graceUntil === null) {
          s.graceUntil = s.startAt + s.settings.graceMinutes * 60_000;
          emit(c, { type: 'startDelayed', reason: 'not-enough-players', graceUntil: s.graceUntil });
        }
        if (now >= s.graceUntil) cancel(c, 'not-enough-players');
      }
    }
    if (s.status === 'seating' && s.startAt !== null && now >= s.startAt) begin(c);
    if (started(s)) {
      advanceClock(c);
      expireOffers(c);
      settle(c);
    }
  });
}

export function apply(state: TournamentState, cmd: Command, now: number): Result {
  if (state.status === 'finished' || state.status === 'cancelled') fail('This tournament is over');
  return run(state, now, (c) => {
    const s = c.s;
    // Commands act on the clock as of now.
    if (started(s)) {
      advanceClock(c);
      expireOffers(c);
    }
    switch (cmd.type) {
      case 'register': {
        if (activeEntry(s, cmd.playerId)) fail('Already registered');
        if (latestEntry(s, cmd.playerId)) fail('Already played this event; use re-entry');
        if (!registrationOpen(s)) fail(hasRoom(s) ? 'Registration is closed' : 'The tournament is full');
        if (s.settings.registrationApproval) {
          if (s.requests.some((r) => r.kind === 'register' && r.playerId === cmd.playerId)) fail('Already requested');
          request(c, 'register', cmd);
        } else register(c, cmd.playerId, cmd.displayName);
        break;
      }
      case 'unregister': {
        const pending = s.requests.find((r) => r.kind === 'register' && r.playerId === cmd.playerId);
        if (pending) {
          s.requests = s.requests.filter((r) => r !== pending);
          emit(c, { type: 'unregistered', playerId: cmd.playerId });
          break;
        }
        const e = activeEntry(s, cmd.playerId) ?? fail('Not registered');
        if (e.status !== 'registered' || s.status !== 'registering') fail('Seats are drawn; you can only quit now');
        s.entries = s.entries.filter((x) => x !== e);
        emit(c, { type: 'unregistered', playerId: cmd.playerId });
        break;
      }
      case 'rebuy': {
        const e = activeEntry(s, cmd.playerId);
        if (!e || e.status !== 'rebuy-offer') fail('No rebuy on offer');
        if (s.settings.rebuy.approval) {
          if (!s.requests.some((r) => r.kind === 'rebuy' && r.entryId === e!.id)) request(c, 'rebuy', e!, e!.id);
        } else addChips(c, e!, s.settings.rebuy.chips, 'rebuy');
        break;
      }
      case 'declineRebuy': {
        const e = activeEntry(s, cmd.playerId);
        if (!e || e.status !== 'rebuy-offer') fail('No rebuy on offer');
        eliminate(c, [e!], 'busted');
        break;
      }
      case 'addOn': {
        const e = activeEntry(s, cmd.playerId) ?? fail('Not playing');
        if (!addOnsOpen(s)) fail('Add-ons are not open');
        if (e.status !== 'seated') fail('Not seated');
        if (e.addOns >= s.settings.addOn.max) fail('No add-ons left');
        if (s.settings.addOn.approval) {
          if (!s.requests.some((r) => r.kind === 'add-on' && r.entryId === e.id)) request(c, 'add-on', e, e.id);
        } else addChips(c, e, s.settings.addOn.chips, 'add-on');
        break;
      }
      case 'reEnter': {
        if (activeEntry(s, cmd.playerId)) fail('Still in the tournament');
        const old = latestEntry(s, cmd.playerId);
        if (!old || old.status !== 'busted') fail('Nothing to re-enter');
        if (!reEntryOpen(s)) fail('Re-entry is closed');
        const { max, approval } = s.settings.reEntry;
        if (max !== null && old!.entryNo - 1 >= max) fail('No re-entries left');
        if (approval) {
          if (!s.requests.some((r) => r.kind === 're-entry' && r.playerId === cmd.playerId)) request(c, 're-entry', old!, old!.id);
        } else reEnter(c, old!);
        break;
      }
      case 'quit':
      case 'remove': {
        const reason = cmd.type === 'quit' ? 'quit' : 'removed';
        if (cmd.type === 'quit' && !s.settings.allowQuit) fail('Quitting is not allowed in this tournament');
        const e = activeEntry(s, cmd.playerId) ?? fail('Not playing');
        if (e.status === 'registered') {
          if (s.status !== 'registering') fail('Not seated yet');
          s.entries = s.entries.filter((x) => x !== e);
          emit(c, { type: 'unregistered', playerId: e.playerId });
        } else if (e.status === 'seated' && e.tableId && table(s, e.tableId).inHand) {
          e.leaveRequested = reason;
        } else eliminate(c, [e], reason);
        break;
      }
      case 'approve':
      case 'reject': {
        const r = s.requests.find((x) => x.id === cmd.requestId) ?? fail('Request not found');
        s.requests = s.requests.filter((x) => x !== r);
        const e = r.entryId ? entry(s, r.entryId) : undefined;
        if (cmd.type === 'reject') {
          emit(c, { type: 'requestRejected', request: r });
          if (r.kind === 'rebuy' && e?.status === 'rebuy-offer') eliminate(c, [e], 'busted');
          break;
        }
        if (r.kind === 'register') {
          if (activeEntry(s, r.playerId)) fail('Already registered');
          if (!hasRoom(s)) fail('The tournament is full');
          register(c, r.playerId, r.displayName);
        } else if (r.kind === 'rebuy') {
          if (e?.status !== 'rebuy-offer') fail('The rebuy offer has expired');
          addChips(c, e!, s.settings.rebuy.chips, 'rebuy');
        } else if (r.kind === 'add-on') {
          if (e?.status !== 'seated') fail('Not seated');
          addChips(c, e!, s.settings.addOn.chips, 'add-on');
        } else {
          if (!e || e.status !== 'busted' || e.supersededBy || activeEntry(s, r.playerId)) fail('Nothing to re-enter');
          reEnter(c, e!);
        }
        break;
      }
      case 'pause': {
        if (s.status !== 'running') fail('Not running');
        s.clock = { ...s.clock, elapsedMs: elapsed(s, now), runningSince: null };
        s.status = 'paused';
        emit(c, { type: 'paused' });
        break;
      }
      case 'resume': {
        if (s.status !== 'paused') fail('Not paused');
        s.clock = { ...s.clock, runningSince: now };
        s.status = 'running';
        emit(c, { type: 'resumed' });
        break;
      }
      case 'startNow': {
        if (s.status === 'registering') {
          if (aliveEntries(s).length < 2) fail('Need at least 2 players');
          seatAll(c);
        }
        if (s.status !== 'seating') fail('Already started');
        begin(c);
        break;
      }
      case 'editStructure': {
        const issues = validateStructure(cmd.structure, { maxRebuys: s.settings.rebuy.max });
        if (issues.errors.length) fail(issues.errors.join('; '));
        if (started(s)) {
          const keep = s.clock.rowIndex + 1;
          if (JSON.stringify(cmd.structure.slice(0, keep)) !== JSON.stringify(s.settings.structure.slice(0, keep)))
            fail('Only levels after the current one can change');
        }
        s.settings.structure = structuredClone(cmd.structure);
        emit(c, { type: 'structureEdited' });
        break;
      }
      case 'updateSettings': {
        const changes = cleanSettings(cmd.settings);
        const next = { ...s.settings, ...structuredClone(changes) };
        const locked: (keyof TournamentSettings)[] = s.tables.length
          ? ['start', 'games', 'stopRotationAtLevel', 'startingStack', 'seatsPerTable', 'structure']
          : ['structure'];
        for (const k of locked) {
          if (k in changes && JSON.stringify(next[k]) !== JSON.stringify(s.settings[k]))
            fail(k === 'structure' ? 'Use editStructure to change levels' : `${k} is locked once tables exist`);
        }
        const errors = validateSettings(next);
        if (next.maxEntrants < rankedEntries(s).length) errors.push('Max entrants is below the current field');
        if (errors.length) fail(errors.join('; '));
        s.settings = next;
        if (next.start.kind === 'scheduled' && s.status === 'registering') {
          // A new start time ends the grace period the old one began.
          if (next.start.startAt !== s.startAt) s.graceUntil = null;
          s.startAt = next.start.startAt;
        }
        emit(c, { type: 'settingsUpdated' });
        break;
      }
      case 'end': {
        if (s.status === 'registering' || s.status === 'seating') cancel(c, 'host');
        else {
          if (s.status !== 'paused') fail('Pause the tournament first');
          if (s.tables.some((t) => t.inHand)) fail('Wait for the hands in progress to finish');
          eliminate(c, s.entries.filter((e) => e.status === 'rebuy-offer'), 'busted');
          finish(c);
        }
        break;
      }
      case 'handStarted': {
        const t = table(s, cmd.tableId);
        t.inHand = true;
        t.lastHandNumber = cmd.handNumber;
        t.hfhHand = s.handForHand.active ? s.handForHand.round : null;
        if (s.handForHand.active) t.hfhPlayed = s.handForHand.round;
        break;
      }
      case 'handResult':
        handResult(c, cmd.result);
        break;
    }
    if (c.s.status !== 'finished' && c.s.status !== 'cancelled') settle(c);
  });
}

function handResult(c: Ctx, r: HandResult) {
  const s = c.s;
  const t = table(s, r.tableId);
  t.inHand = false;
  t.lastHandNumber = r.handNumber;
  if (r.button !== undefined) t.button = r.button;
  const hfhRound = t.hfhHand ?? undefined;
  t.hfhHand = null;

  const players = tablePlayers(s, t);
  for (const e of players) {
    const end = r.endStacks[e.playerId];
    if (end !== undefined && e.status === 'seated') e.stack = end;
  }
  const leavers = players.filter((e) => e.leaveRequested);
  for (const reason of ['quit', 'removed'] as const) eliminate(c, leavers.filter((e) => e.leaveRequested === reason), reason, hfhRound);

  const busted = players.filter((e) => e.status === 'seated' && e.stack <= 0);
  const out: Entry[] = [];
  for (const e of busted) {
    e.bust = { at: c.now, startStack: r.startStacks[e.playerId] ?? 0, tableId: t.id, by: r.knockedOutBy?.[e.playerId] ?? [] };
    if (canRebuy(s, e)) {
      e.status = 'rebuy-offer';
      e.rebuyOfferExpiresAt = c.now + s.settings.rebuy.offerSeconds * 1000;
      emit(c, { type: 'rebuyOffered', entryId: e.id, playerId: e.playerId, expiresAt: e.rebuyOfferExpiresAt, chips: s.settings.rebuy.chips });
    } else out.push(e);
  }
  eliminate(c, out, 'busted', hfhRound);
  advanceHandForHand(s);
}
