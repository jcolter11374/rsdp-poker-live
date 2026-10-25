import { nanoid } from 'nanoid';
import {
  ActionError,
  PokerTable,
  viewFor,
  type Action,
  type ChatMessage,
  type CreateRoomInput,
  type LedgerEntry,
  type RoomView,
  type SeatRequest,
} from '@rsdp/engine';

const NEXT_HAND_DELAY_MS = 3000;
const SHOWDOWN_DELAY_MS = 6000;
/** How long a disconnected player gets before the game acts for them, even with no clock. */
const AWAY_SECONDS = 15;
/** Missed turns in a row before a player is sat out automatically. */
const MAX_MISSED_TURNS = 2;
const MAX_SEATS = 10;

interface LedgerRecord {
  name: string;
  buyIn: number;
  /** Set when the player leaves the table. */
  cashOut: number | null;
}

/** One table plus everything around it: host, seat requests, clock, ledger and chat. */
export class Room {
  readonly id = nanoid(10);
  readonly table: PokerTable;
  hostId: string;
  running = false;
  paused = false;
  turnSeconds: number;
  turnDeadline: number | null = null;
  turnStarted: number | null = null;
  requests: SeatRequest[] = [];
  chat: ChatMessage[] = [];
  lastActivity = Date.now();
  private ledger = new Map<string, LedgerRecord>();
  private names = new Map<string, string>();
  private connections = new Map<string, number>();
  private missedTurns = new Map<string, number>();
  private turnTimer: NodeJS.Timeout | null = null;
  private turnKey = '';
  private turnStartedAt = 0;
  private nextHandTimer: NodeJS.Timeout | null = null;

  /** Called whenever state changes and every viewer needs a fresh view. */
  onChange: () => void = () => {};

  constructor(hostId: string, input: CreateRoomInput) {
    this.hostId = hostId;
    this.names.set(hostId, input.hostName);
    this.turnSeconds = input.turnSeconds;
    this.table = new PokerTable({
      smallBlind: input.smallBlind,
      bigBlind: input.bigBlind,
      maxSeats: MAX_SEATS,
    });
  }

  connect(playerId: string) {
    this.connections.set(playerId, (this.connections.get(playerId) ?? 0) + 1);
    this.armTurnTimer();
    this.changed();
  }

  disconnect(playerId: string) {
    const n = (this.connections.get(playerId) ?? 1) - 1;
    if (n > 0) this.connections.set(playerId, n);
    else this.connections.delete(playerId);
    this.armTurnTimer();
    this.changed();
  }

  isConnected(playerId: string) {
    return this.connections.has(playerId);
  }

  isHost(playerId: string) {
    return playerId === this.hostId;
  }

  // ---------------------------------------------------------------- seats

  requestSeat(playerId: string, seat: number, name: string, stack: number) {
    name = name.trim().slice(0, 20);
    if (!name) throw new ActionError('pick a name');
    if (!Number.isInteger(stack) || stack <= 0) throw new ActionError('stack must be a positive whole number');
    if (this.table.seatOf(playerId) !== -1) throw new ActionError('you already have a seat');
    if (this.table.seats[seat] !== null) throw new ActionError('seat taken');
    this.requests = this.requests.filter((r) => r.playerId !== playerId);
    const request = { id: nanoid(8), playerId, name, seat, stack };
    this.names.set(playerId, name);
    this.requests.push(request);
    // The host doesn't need to approve themselves.
    if (this.isHost(playerId)) this.approve(request.id);
    else this.changed();
  }

  cancelRequest(playerId: string) {
    this.requests = this.requests.filter((r) => r.playerId !== playerId);
    this.changed();
  }

  approve(requestId: string) {
    const r = this.requests.find((x) => x.id === requestId);
    if (!r) throw new ActionError('request not found');
    this.requests = this.requests.filter((x) => x !== r);
    this.table.sit(r.seat, r.playerId, r.name, r.stack);
    const rec = this.ledger.get(r.playerId);
    if (rec) {
      rec.buyIn += r.stack;
      rec.cashOut = null;
      rec.name = r.name;
    } else {
      this.ledger.set(r.playerId, { name: r.name, buyIn: r.stack, cashOut: null });
    }
    this.changed();
    this.maybeScheduleHand();
  }

  reject(requestId: string) {
    this.requests = this.requests.filter((x) => x.id !== requestId);
    this.changed();
  }

  stand(playerId: string) {
    const seat = this.table.seatOf(playerId);
    if (seat === -1) return;
    const stack = this.table.seats[seat]!.stack;
    this.table.stand(playerId);
    // If the seat is still there they're finishing a hand; the ledger updates when it frees.
    if (this.table.seatOf(playerId) === -1) this.recordCashOut(playerId, stack);
    this.afterTableChange();
  }

  sitOut(playerId: string, value: boolean) {
    this.table.setSittingOut(playerId, value);
    if (!value) this.missedTurns.delete(playerId);
    this.changed();
    if (!value) this.maybeScheduleHand();
  }

  setStack(playerId: string, stack: number) {
    const seat = this.table.seatOf(playerId);
    if (seat === -1) throw new ActionError('not seated');
    const before = this.table.seats[seat]!.stack;
    this.table.setStack(playerId, stack);
    // Host adjustments count as buy-ins (or cash-outs when negative) so the ledger balances.
    this.ledger.get(playerId)!.buyIn += stack - before;
    this.changed();
    this.maybeScheduleHand();
  }

  private recordCashOut(playerId: string, stack: number) {
    const rec = this.ledger.get(playerId);
    if (rec) rec.cashOut = stack;
  }

  // ---------------------------------------------------------------- game control

  start() {
    if (this.table.eligibleCount() < 2) throw new ActionError('need at least two seated players');
    this.running = true;
    this.paused = false;
    this.changed();
    this.maybeScheduleHand(0);
  }

  setPaused(value: boolean) {
    if (!this.running) return;
    this.paused = value;
    if (value) {
      this.clearTurnTimer();
      if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
      this.nextHandTimer = null;
    } else {
      this.armTurnTimer();
      this.maybeScheduleHand();
    }
    this.changed();
  }

  settings(smallBlind: number, bigBlind: number, turnSeconds: number) {
    if (!Number.isInteger(smallBlind) || !Number.isInteger(bigBlind) || smallBlind <= 0 || bigBlind < smallBlind) {
      throw new ActionError('blinds must be whole numbers with big blind ≥ small blind');
    }
    if (!Number.isInteger(turnSeconds) || turnSeconds < 0 || turnSeconds > 600) {
      throw new ActionError('turn clock must be 0 to 600 seconds');
    }
    // Blinds apply from the next hand; the engine reads them at hand start.
    this.table.config.smallBlind = smallBlind;
    this.table.config.bigBlind = bigBlind;
    this.turnSeconds = turnSeconds;
    this.changed();
  }

  act(playerId: string, action: Action) {
    if (this.paused) throw new ActionError('the game is paused');
    this.table.act(playerId, action);
    this.missedTurns.delete(playerId);
    this.afterTableChange();
  }

  addChat(playerId: string, text: string) {
    text = text.trim().slice(0, 300);
    if (!text) return;
    this.chat.push({ at: Date.now(), name: this.names.get(playerId) ?? 'Spectator', text });
    if (this.chat.length > 200) this.chat.shift();
    this.changed();
  }

  /** Re-arms timers and settles the ledger after anything that may have moved the hand along. */
  private afterTableChange() {
    for (const [playerId, rec] of this.ledger) {
      if (rec.cashOut === null && this.table.seatOf(playerId) === -1) {
        // Freed at the end of a hand; their final stack was the one they had when the seat cleared.
        rec.cashOut = this.lastStacks.get(playerId) ?? 0;
      }
    }
    this.snapshotStacks();
    this.armTurnTimer();
    this.changed();
    this.maybeScheduleHand();
  }

  private lastStacks = new Map<string, number>();
  private snapshotStacks() {
    for (const s of this.table.seats) if (s) this.lastStacks.set(s.playerId, s.stack);
  }

  private maybeScheduleHand(delay?: number) {
    if (!this.running || this.paused || this.nextHandTimer) return;
    delay ??= this.table.hand?.showdown ? SHOWDOWN_DELAY_MS : NEXT_HAND_DELAY_MS;
    if (!this.table.canStartHand()) return;
    this.nextHandTimer = setTimeout(() => {
      this.nextHandTimer = null;
      if (!this.running || this.paused || !this.table.canStartHand()) return;
      this.table.startHand();
      this.afterTableChange();
    }, delay);
  }

  private clearTurnTimer() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.turnDeadline = null;
    this.turnStarted = null;
  }

  private armTurnTimer() {
    this.clearTurnTimer();
    const hand = this.table.hand;
    if (this.paused || !hand || hand.toAct === null) return;
    const seat = hand.toAct;
    const handNumber = hand.number;
    const playerId = this.table.seats[seat]!.playerId;
    // Someone who has dropped off gets a short grace period, so the table doesn't stall.
    const seconds = this.isConnected(playerId)
      ? this.turnSeconds
      : Math.min(this.turnSeconds || AWAY_SECONDS, AWAY_SECONDS);
    if (!seconds) return;
    // Keep the original start when re-arming for the same turn (e.g. on reconnect).
    const key = `${handNumber}:${seat}:${this.table.log.length}`;
    if (this.turnKey !== key) {
      this.turnKey = key;
      this.turnStartedAt = Date.now();
    }
    this.turnStarted = this.turnStartedAt;
    this.turnDeadline = this.turnStartedAt + seconds * 1000;
    this.turnTimer = setTimeout(() => {
      const h = this.table.hand;
      if (!h || h.number !== handNumber || h.toAct !== seat) return;
      const legal = this.table.legalActions(playerId)!;
      this.table.act(playerId, legal.canCheck ? { type: 'check' } : { type: 'fold' });
      const missed = (this.missedTurns.get(playerId) ?? 0) + 1;
      this.missedTurns.set(playerId, missed);
      if (missed >= MAX_MISSED_TURNS) this.table.setSittingOut(playerId, true);
      this.afterTableChange();
    }, Math.max(0, this.turnDeadline - Date.now()));
  }

  private changed() {
    this.lastActivity = Date.now();
    this.snapshotStacks();
    this.onChange();
  }

  dispose() {
    this.clearTurnTimer();
    if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
  }

  // ---------------------------------------------------------------- views

  ledgerView(): LedgerEntry[] {
    return [...this.ledger.entries()].map(([playerId, rec]) => {
      const seat = this.table.seatOf(playerId);
      const stack = seat !== -1 ? this.table.seats[seat]!.stack : (rec.cashOut ?? 0);
      return { playerId, name: rec.name, buyIn: rec.buyIn, stack, net: stack - rec.buyIn };
    });
  }

  viewFor(playerId: string): RoomView {
    const isHost = this.isHost(playerId);
    return {
      ...viewFor(this.table, playerId),
      roomId: this.id,
      hostId: this.hostId,
      isHost,
      running: this.running,
      paused: this.paused,
      requests: isHost ? this.requests : this.requests.filter((r) => r.playerId === playerId),
      ledger: this.ledgerView(),
      chat: this.chat.slice(-50),
      turnDeadline: this.turnDeadline,
      turnStarted: this.turnStarted,
      away: this.table.seats.filter((s) => s && !this.isConnected(s.playerId)).map((s) => s!.playerId),
      turnSeconds: this.turnSeconds,
    };
  }
}
