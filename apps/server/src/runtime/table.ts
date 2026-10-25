import { randomUUID } from 'node:crypto';
import { cryptoRng, freshDeck, shuffle, type Rng } from '@rsdp/engine';
import {
  ActionError,
  blindsPassed,
  engine,
  modifierRegistry,
  planForcedBets,
  variants,
  type Action,
  type BettingKind,
  type GameSpec,
  type HandInput,
  type HandState,
  type PlannerSeat,
  type PlayerId,
  type Stakes,
} from '@rsdp/engine/core';
import {
  applyAtNextHand,
  applyImmediate,
  enabledModifiers,
  MAX_CHIPS,
  mergePatches,
  parseSettings,
  SettingsError,
  type SettingsPatch,
  type TableSettings,
} from '@rsdp/engine/settings';
import {
  RUNTIME_VERSION,
  systemClock,
  type Clock,
  type HandRecord,
  type RuntimeState,
  type SeatRequest,
  type SeatState,
  type TournamentHooks,
} from './types';
import { cleanName as cleanDisplayName } from '../names';

const CHAT_LIMIT = 200;
const LOG_LIMIT = 300;
const HISTORY_LIMIT = 30;
const RIT_VOTE_SECONDS = 12;
const NAME_MAX = 20;
/** How long a cash table waits for an offline host before handing the table to a seated player. */
export const HOST_HANDOFF_MS = 3 * 60_000;

export interface RuntimeDeps {
  clock?: Clock;
  rng?: Rng;
  tournament?: TournamentHooks;
  /** Failures nobody is there to be told about (timers, a level that can't be dealt). Default console.error. */
  log?: (message: string, err?: unknown) => void;
}

/** The game, betting and stakes the next hand is dealt with. */
interface HandSetup {
  game: GameSpec;
  betting: BettingKind;
  stakes: Stakes;
}

/**
 * One table: seats, the between-hands pipeline, clocks, host controls and
 * the hand in progress. All state lives in `state` (plain JSON); timers are
 * derived from the deadlines stored there, so a restored table carries on.
 */
export class TableRuntime {
  state: RuntimeState;
  /** Called after every change; the server pushes fresh views and saves a snapshot. */
  onChange: () => void = () => {};
  /** Called with each finished hand, for hand history storage. */
  onHandFinished: (record: HandRecord) => void = () => {};

  private readonly clock: Clock;
  private readonly rng: Rng;
  readonly tournament: TournamentHooks | null;
  private readonly logError: (message: string, err?: unknown) => void;
  private readonly connections = new Map<PlayerId, number>();
  private readonly offlineSince = new Map<PlayerId, number>();
  /** When this runtime came up: players it has never seen get their grace from here. */
  private readonly upSince: number;
  private timers: Record<'turn' | 'next' | 'rit', unknown> = { turn: null, next: null, rit: null };
  /** Hands the table to someone else when the host has been gone a while. */
  private hostTimer: unknown = null;
  /** Why the last tournament deal failed: the table retries on every poke, so each reason is logged once. */
  private dealFailure: string | null = null;

  constructor(state: RuntimeState, deps: RuntimeDeps = {}) {
    this.state = state;
    this.clock = deps.clock ?? systemClock;
    this.rng = deps.rng ?? cryptoRng;
    this.tournament = deps.tournament ?? null;
    this.logError = deps.log ?? ((m, e) => console.error(m, e ?? ''));
    this.upSince = this.clock.now();
  }

  static create(args: { id?: string; hostId: PlayerId; hostName?: string; settings: TableSettings }, deps: RuntimeDeps = {}) {
    const clock = deps.clock ?? systemClock;
    const settings = parseSettings(args.settings);
    const state: RuntimeState = {
      version: RUNTIME_VERSION,
      id: args.id ?? randomUUID().slice(0, 10),
      hostId: args.hostId,
      createdAt: clock.now(),
      settings,
      pendingSettings: null,
      settingsLog: [],
      seats: Array.from({ length: settings.table.maxSeats }, () => null),
      requests: [],
      ledger: {},
      departures: {},
      started: false,
      stopAfterHand: false,
      paused: false,
      pausedLeft: null,
      handNumber: 0,
      hand: null,
      handStartedAt: null,
      positions: null,
      turn: null,
      nextHandAt: null,
      ritDeadline: null,
      level: { index: 0, elapsedMs: 0, runningSince: null, hands: 0 },
      rotation: { step: 0, hands: 0, orbits: 0, anchor: null },
      chat: [],
      log: [],
      history: [],
    };
    return new TableRuntime(state, deps);
  }

  /** Re-arms clocks after construction from a snapshot. */
  resume() {
    this.watchHost();
    this.sync();
  }

  dispose() {
    for (const key of ['turn', 'next', 'rit'] as const) this.clearTimer(key);
    this.clock.clearTimeout(this.hostTimer);
    this.hostTimer = null;
  }

  get settings() {
    return this.state.settings;
  }

  get isTournament() {
    return this.state.settings.table.mode === 'tournament';
  }

  isHost(playerId: PlayerId) {
    return playerId === this.state.hostId;
  }

  seatOf(playerId: PlayerId): SeatState | null {
    return this.state.seats.find((s) => s?.playerId === playerId) ?? null;
  }

  isOnline(playerId: PlayerId) {
    return (this.connections.get(playerId) ?? 0) > 0;
  }

  // ---------------------------------------------------------------- connections

  connect(playerId: PlayerId) {
    this.connections.set(playerId, (this.connections.get(playerId) ?? 0) + 1);
    this.offlineSince.delete(playerId);
    if (this.isHost(playerId)) this.watchHost();
    this.sync();
  }

  disconnect(playerId: PlayerId) {
    const n = (this.connections.get(playerId) ?? 1) - 1;
    if (n > 0) {
      this.connections.set(playerId, n);
      return;
    }
    this.connections.delete(playerId);
    this.offlineSince.set(playerId, this.clock.now());
    if (this.isHost(playerId)) this.watchHost();
    this.sync();
  }

  // ---------------------------------------------------------------- seating

  requestSeat(playerId: PlayerId, input: { seat: number; name: string; stack: number }) {
    if (this.isTournament) throw new ActionError('the tournament seats players');
    const name = cleanName(input.name);
    const { seat, stack } = input;
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.state.seats.length) throw new ActionError('no such seat');
    if (this.state.seats[seat]) throw new ActionError('that seat is taken');
    if (this.seatOf(playerId)) throw new ActionError('you already have a seat');
    this.checkBuyIn(playerId, stack);
    this.state.requests = this.state.requests.filter((r) => !(r.playerId === playerId && r.kind === 'seat'));
    const request: SeatRequest = { id: randomUUID().slice(0, 8), kind: 'seat', playerId, name, seat, amount: stack, at: this.clock.now() };
    if (!this.settings.seating.requireApproval || this.isHost(playerId)) {
      this.seatPlayer(request);
    } else {
      this.state.requests.push(request);
      this.log(`${name} asked for seat ${seat + 1} with ${stack}`);
    }
    this.sync();
  }

  cancelRequest(playerId: PlayerId) {
    this.state.requests = this.state.requests.filter((r) => r.playerId !== playerId);
    this.sync();
  }

  approve(by: PlayerId, requestId: string) {
    this.requireHost(by);
    const r = this.state.requests.find((x) => x.id === requestId);
    if (!r) throw new ActionError('request not found');
    this.state.requests = this.state.requests.filter((x) => x !== r);
    if (r.kind === 'seat') {
      if (this.state.seats[r.seat!]) throw new ActionError('that seat has been taken');
      if (this.seatOf(r.playerId)) throw new ActionError('already seated');
      this.seatPlayer(r);
    } else {
      this.addChips(r.playerId, r.amount, 'rebuy');
    }
    this.sync();
  }

  reject(by: PlayerId, requestId: string) {
    this.requireHost(by);
    const r = this.state.requests.find((x) => x.id === requestId);
    this.state.requests = this.state.requests.filter((x) => x.id !== requestId);
    if (r) this.log(`${r.name}'s ${r.kind === 'seat' ? 'seat request' : 'rebuy'} was declined`);
    this.sync();
  }

  private checkBuyIn(playerId: PlayerId, stack: number) {
    if (!Number.isInteger(stack) || stack <= 0 || stack > MAX_CHIPS) throw new ActionError('the stack must be a positive whole number');
    const { minBuyIn, maxBuyIn, ratholeMinutes } = this.settings.seating;
    if (minBuyIn > 0 && stack < minBuyIn) throw new ActionError(`the minimum buy-in is ${minBuyIn}`);
    if (maxBuyIn > 0 && stack > maxBuyIn) throw new ActionError(`the maximum buy-in is ${maxBuyIn}`);
    const left = this.state.departures[playerId];
    if (ratholeMinutes > 0 && left && this.clock.now() - left.at < ratholeMinutes * 60_000 && stack < left.stack) {
      throw new ActionError(`you left with ${left.stack} less than ${ratholeMinutes} minutes ago; come back with at least that`);
    }
  }

  private seatPlayer(r: SeatRequest) {
    const { settings } = this;
    this.state.seats[r.seat!] = {
      seat: r.seat!,
      playerId: r.playerId,
      name: r.name,
      stack: r.amount,
      sittingOut: false,
      sitOutReason: null,
      // Before anyone has played there is nothing to post for.
      isNew: this.activePlayers().length >= 2 && this.state.handNumber > 0,
      missedSmallBlind: false,
      missedBigBlind: false,
      waitForBigBlind: false,
      straddle: false,
      timeouts: 0,
      timeBank: settings.timing.timeBankSeconds,
      handsSinceRefill: 0,
      leaveAfterHand: false,
      pendingChips: 0,
      pendingStack: null,
    };
    const row = this.state.ledger[r.playerId];
    if (row) {
      row.buyIn += r.amount;
      row.name = r.name;
    } else {
      this.state.ledger[r.playerId] = { playerId: r.playerId, name: r.name, buyIn: r.amount, cashOut: 0 };
    }
    delete this.state.departures[r.playerId];
    this.log(`${r.name} sat down in seat ${r.seat! + 1} with ${r.amount}`);
  }

  /** Leave the table: folds a live hand now, or with `afterHand` plays it out first. */
  stand(playerId: PlayerId, opts: { afterHand?: boolean } = {}) {
    // The director would keep them seated with chips the table no longer has.
    if (this.isTournament) throw new ActionError('leave through the tournament');
    const seat = this.seatOf(playerId);
    if (!seat) return;
    if (this.inHand(playerId)) {
      seat.leaveAfterHand = true;
      if (!opts.afterHand) this.foldIfLive(playerId);
    } else {
      this.removeSeat(seat);
    }
    this.sync();
  }

  private removeSeat(seat: SeatState) {
    const row = this.state.ledger[seat.playerId];
    const stack = seat.stack + seat.pendingChips;
    if (row) row.cashOut += stack;
    this.state.departures[seat.playerId] = { stack, at: this.clock.now() };
    this.state.seats[seat.seat] = null;
    this.log(`${seat.name} left the table with ${stack}`);
  }

  sitOut(playerId: PlayerId, value: boolean) {
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('you are not seated');
    if (!value && seat.stack + seat.pendingChips <= 0 && seat.pendingStack === null) throw new ActionError('rebuy before sitting back in');
    seat.sittingOut = value;
    seat.sitOutReason = value ? 'player' : null;
    if (!value) seat.timeouts = 0;
    this.sync();
  }

  setPreferences(playerId: PlayerId, prefs: { waitForBigBlind?: boolean; straddle?: boolean }) {
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('you are not seated');
    if (prefs.waitForBigBlind !== undefined) seat.waitForBigBlind = !!prefs.waitForBigBlind;
    if (prefs.straddle !== undefined) seat.straddle = !!prefs.straddle;
    this.sync();
  }

  rebuy(playerId: PlayerId, amount: number) {
    if (this.isTournament) throw new ActionError('use the tournament rebuy');
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('you are not seated');
    if (!this.settings.seating.allowRebuys) throw new ActionError('rebuys are off at this table');
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_CHIPS) throw new ActionError('the amount must be a positive whole number');
    const { maxBuyIn } = this.settings.seating;
    if (maxBuyIn > 0 && seat.stack + seat.pendingChips + amount > maxBuyIn) throw new ActionError(`you can have at most ${maxBuyIn} in front of you`);
    if (this.settings.seating.rebuyRequiresApproval && !this.isHost(playerId)) {
      this.state.requests = this.state.requests.filter((r) => !(r.playerId === playerId && r.kind === 'rebuy'));
      this.state.requests.push({ id: randomUUID().slice(0, 8), kind: 'rebuy', playerId, name: seat.name, seat: seat.seat, amount, at: this.clock.now() });
      this.log(`${seat.name} asked to add ${amount}`);
    } else {
      this.addChips(playerId, amount, 'rebuy');
    }
    this.sync();
  }

  /** Adds chips now between hands, or queues them for the next hand. */
  private addChips(playerId: PlayerId, amount: number, why: 'rebuy' | 'host') {
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('that player is not seated');
    const row = this.state.ledger[playerId];
    if (row) row.buyIn += amount;
    if (this.inHand(playerId)) seat.pendingChips += amount;
    else {
      seat.stack += amount;
      if (seat.sitOutReason === 'busted') {
        seat.sittingOut = false;
        seat.sitOutReason = null;
      }
    }
    this.log(`${seat.name} ${why === 'rebuy' ? 'added' : 'was given'} ${amount}`);
  }

  // ---------------------------------------------------------------- host controls

  private requireHost(by: PlayerId) {
    if (!this.isHost(by)) throw new ActionError('only the host can do that');
  }

  start(by: PlayerId) {
    this.requireHost(by);
    if (this.isTournament) throw new ActionError('the tournament starts this table');
    if (this.activePlayers().length < 2) throw new ActionError('need at least two players with chips');
    this.state.started = true;
    this.state.stopAfterHand = false;
    this.state.paused = false;
    this.state.pausedLeft = null;
    if (!this.state.hand || this.state.hand.phase === 'complete') this.state.nextHandAt = this.clock.now();
    this.log('The host started the game');
    this.sync();
  }

  /** Cash tables: no new hands after the current one. */
  stop(by: PlayerId) {
    this.requireHost(by);
    if (this.isTournament) throw new ActionError('the tournament runs this table');
    this.state.stopAfterHand = true;
    if (!this.handLive()) this.state.started = false;
    this.state.nextHandAt = null;
    this.log('The host stopped the game');
    this.sync();
  }

  /** Deal now (when the next hand doesn't start by itself). */
  dealNext(by: PlayerId) {
    this.requireHost(by);
    if (this.isTournament) throw new ActionError('the tournament runs this table');
    if (this.handLive()) throw new ActionError('a hand is still being played');
    this.state.started = true;
    this.state.nextHandAt = this.clock.now();
    this.sync();
  }

  pause(by: PlayerId, value: boolean) {
    this.requireHost(by);
    // Tournament tables hold through the director's gate when the tournament pauses.
    if (this.isTournament) throw new ActionError('pause the tournament from its lobby');
    this.setPaused(value);
  }

  /** Freezes every clock where it is; resuming gives back the same time. */
  setPaused(value: boolean) {
    const s = this.state;
    if (s.paused === value) return;
    const now = this.clock.now();
    if (value) {
      s.pausedLeft = {
        turn: s.turn?.deadline != null ? Math.max(0, s.turn.deadline - now) : null,
        nextHand: s.nextHandAt != null ? Math.max(0, s.nextHandAt - now) : null,
        rit: s.ritDeadline != null ? Math.max(0, s.ritDeadline - now) : null,
      };
      if (s.level.runningSince !== null) {
        s.level.elapsedMs += now - s.level.runningSince;
        s.level.runningSince = null;
      }
      s.paused = true;
      this.log('Game paused');
    } else {
      const left = s.pausedLeft;
      if (left && s.turn && left.turn !== null) {
        s.turn.deadline = now + left.turn;
        if (s.turn.bankFrom !== null) s.turn.bankFrom = now;
      }
      if (left?.nextHand != null) s.nextHandAt = now + left.nextHand;
      if (left?.rit != null) s.ritDeadline = now + left.rit;
      s.pausedLeft = null;
      s.paused = false;
      for (const id of this.offlineSince.keys()) this.offlineSince.set(id, now);
      if (s.settings.blindSchedule.enabled && s.handNumber > 0) s.level.runningSince = now;
      this.log('Game resumed');
    }
    this.sync();
  }

  /** Host edit: some fields apply now, the rest at the next hand. */
  updateSettings(by: PlayerId, patch: SettingsPatch) {
    this.requireHost(by);
    if (this.isTournament) throw new ActionError('change tournament settings in its lobby');
    const s = this.state;
    const merged = s.pendingSettings ? mergePatches(s.pendingSettings, patch) : patch;
    let result;
    try {
      // Validate the end result now so the host sees errors immediately.
      const target = applyAtNextHand(s.settings, merged).settings;
      this.checkSettings(target);
      result = applyImmediate(s.settings, merged);
    } catch (e) {
      if (e instanceof SettingsError) throw new ActionError(e.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
      throw e;
    }
    s.settings = result.settings;
    s.pendingSettings = result.deferred;
    const now = this.clock.now();
    if (result.diff.length) s.settingsLog.push({ at: now, by, when: 'now', changes: result.diff });
    if (result.deferred) {
      const later = applyAtNextHand(s.settings, result.deferred).diff;
      if (later.length) s.settingsLog.push({ at: now, by, when: 'next-hand', changes: later });
    }
    if (s.settingsLog.length > LOG_LIMIT) s.settingsLog.splice(0, s.settingsLog.length - LOG_LIMIT);
    // Between hands, queued changes can take effect straight away.
    if (!this.handLive()) this.applyPendingSettings();
    this.sync();
  }

  /** Server-side checks the schema can't make: games exist, seats fit, mode fixed. */
  private checkSettings(next: TableSettings) {
    const cur = this.state.settings;
    if (next.table.mode !== cur.table.mode) throw new ActionError('a table cannot switch between cash and tournament');
    const games = next.game.rotation.enabled ? next.game.rotation.steps.map((st) => st.gameId) : [next.game.gameId];
    for (const id of games) {
      let spec: GameSpec;
      try {
        spec = variants.get(id).spec;
      } catch {
        throw new ActionError(`unknown game ${id}`);
      }
      if (next.table.maxSeats > spec.maxPlayers) throw new ActionError(`${spec.name} seats at most ${spec.maxPlayers}`);
    }
    const lastTaken = this.state.seats.reduce((m, seat, i) => (seat ? i : m), -1);
    if (next.table.maxSeats <= lastTaken) throw new ActionError(`seat ${lastTaken + 1} is taken; move that player before removing it`);
  }

  private applyPendingSettings() {
    const s = this.state;
    if (!s.pendingSettings) return;
    const before = s.settings;
    s.settings = applyAtNextHand(s.settings, s.pendingSettings).settings;
    s.pendingSettings = null;
    const seats = s.settings.table.maxSeats;
    if (seats !== s.seats.length) {
      s.seats = Array.from({ length: seats }, (_, i) => s.seats[i] ?? null);
      s.positions = null;
    }
    if (!before.blindSchedule.enabled && s.settings.blindSchedule.enabled) {
      s.level = { index: 0, elapsedMs: 0, runningSince: s.handNumber > 0 && !s.paused ? this.clock.now() : null, hands: 0 };
    }
    if (JSON.stringify(before.game.rotation) !== JSON.stringify(s.settings.game.rotation)) {
      s.rotation = { step: 0, hands: 0, orbits: 0, anchor: null };
    }
  }

  setStack(by: PlayerId, playerId: PlayerId, stack: number) {
    this.requireHost(by);
    if (this.isTournament) throw new ActionError('stacks are set by the tournament');
    if (!Number.isInteger(stack) || stack < 0 || stack > MAX_CHIPS) throw new ActionError('the stack must be a whole number');
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('that player is not seated');
    if (this.inHand(playerId)) {
      seat.pendingStack = stack;
    } else {
      this.state.ledger[playerId].buyIn += stack - seat.stack;
      seat.stack = stack;
    }
    this.log(`The host set ${seat.name}'s stack to ${stack}${this.inHand(playerId) ? ' after this hand' : ''}`);
    this.sync();
  }

  kick(by: PlayerId, playerId: PlayerId) {
    this.requireHost(by);
    if (this.isTournament) throw new ActionError('remove players through the tournament');
    const seat = this.seatOf(playerId);
    this.state.requests = this.state.requests.filter((r) => r.playerId !== playerId);
    if (!seat) return this.sync();
    this.log(`The host removed ${seat.name}`);
    if (this.inHand(playerId)) {
      seat.leaveAfterHand = true;
      this.foldIfLive(playerId);
    } else this.removeSeat(seat);
    this.sync();
  }

  hostSitOut(by: PlayerId, playerId: PlayerId) {
    this.requireHost(by);
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('that player is not seated');
    seat.sittingOut = true;
    seat.sitOutReason = 'host';
    this.sync();
  }

  transferHost(by: PlayerId, to: PlayerId) {
    this.requireHost(by);
    if (to === by) throw new ActionError('you are already the host');
    if (!this.seatOf(to) && !this.isOnline(to)) throw new ActionError('that player is not at the table');
    this.state.hostId = to;
    this.log(`${this.nameOf(by)} made ${this.nameOf(to)} the host`);
    this.watchHost();
    this.sync();
  }

  /**
   * A cash table whose host has been offline for HOST_HANDOFF_MS passes to a
   * seated player who is online and playing, starting from the seat after the
   * host's, so nobody is stuck waiting for approvals. Tournament tables are run
   * by the lobby and have no host to hand off.
   */
  private watchHost() {
    this.clock.clearTimeout(this.hostTimer);
    this.hostTimer = null;
    const host = this.state.hostId;
    if (this.isTournament || this.isOnline(host)) return;
    const since = this.offlineSince.get(host) ?? this.upSince;
    const wait = Math.max(0, since + HOST_HANDOFF_MS - this.clock.now());
    this.hostTimer = this.clock.setTimeout(() => {
      this.hostTimer = null;
      if (this.state.hostId !== host || this.isOnline(host)) return;
      const seats = this.state.seats;
      const from = this.seatOf(host)?.seat ?? -1;
      const order = seats.map((_, i) => seats[(from + 1 + i + seats.length) % seats.length]);
      const next = order.find((x) => x && x.playerId !== host && this.isOnline(x.playerId) && !x.sittingOut) ?? order.find((x) => x && x.playerId !== host && this.isOnline(x.playerId));
      if (!next) {
        // Nobody to take over yet: look again in a while.
        this.offlineSince.set(host, this.clock.now());
        this.watchHost();
        return;
      }
      this.state.hostId = next.playerId;
      this.log(`${this.nameOf(host)} has been away for ${Math.round(HOST_HANDOFF_MS / 60_000)} minutes, so ${next.name} is now the host`);
      this.sync();
    }, wait);
  }

  chat(playerId: PlayerId | null, text: string) {
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
    if (!clean) return;
    this.state.chat.push({ at: this.clock.now(), playerId, name: playerId ? this.nameOf(playerId) : 'Dealer', text: clean });
    if (this.state.chat.length > CHAT_LIMIT) this.state.chat.splice(0, this.state.chat.length - CHAT_LIMIT);
    this.onChange();
  }

  nameOf(playerId: PlayerId) {
    return this.seatOf(playerId)?.name ?? this.state.ledger[playerId]?.name ?? 'Guest';
  }

  // ---------------------------------------------------------------- tournament seating

  /** Tournament: put a player in a seat with a stack (start, late registration, moves). */
  placePlayer(input: { seat: number; playerId: PlayerId; name: string; stack: number }) {
    if (this.state.seats[input.seat]) throw new Error(`seat ${input.seat} is taken`);
    this.state.seats[input.seat] = {
      seat: input.seat,
      playerId: input.playerId,
      name: input.name,
      stack: input.stack,
      sittingOut: false,
      sitOutReason: null,
      isNew: false,
      missedSmallBlind: false,
      missedBigBlind: false,
      waitForBigBlind: false,
      straddle: false,
      timeouts: 0,
      timeBank: this.settings.timing.timeBankSeconds,
      handsSinceRefill: 0,
      leaveAfterHand: false,
      pendingChips: 0,
      pendingStack: null,
    };
    // A moved or newly seated player is still on their way to the table.
    if (!this.isOnline(input.playerId)) this.offlineSince.set(input.playerId, this.clock.now());
    this.sync();
  }

  /** Tournament: take a player off this table (moved, eliminated, quit). */
  unseatPlayer(playerId: PlayerId) {
    const seat = this.seatOf(playerId);
    if (!seat) return;
    if (this.inHand(playerId)) {
      seat.leaveAfterHand = true;
      this.foldIfLive(playerId);
    } else this.state.seats[seat.seat] = null;
    this.sync();
  }

  /** Tournament: rebuy or add-on chips, applied before the next hand. */
  tournamentChips(playerId: PlayerId, chips: number) {
    const seat = this.seatOf(playerId);
    if (!seat) return;
    if (this.inHand(playerId)) seat.pendingChips += chips;
    else seat.stack += chips;
    this.sync();
  }

  /** Tournament: the director may now let this table deal. */
  poke() {
    this.sync();
  }

  // ---------------------------------------------------------------- playing

  act(playerId: PlayerId, action: Action) {
    const hand = this.liveHandFor(playerId);
    const seat = this.seatOf(playerId)!;
    this.spendBank(seat);
    engine.act(hand, seat.seat, action);
    seat.timeouts = 0;
    this.afterEngine();
  }

  draw(playerId: PlayerId, discard: number[]) {
    const hand = this.liveHandFor(playerId);
    const seat = this.seatOf(playerId)!;
    this.spendBank(seat);
    engine.draw(hand, seat.seat, discard);
    seat.timeouts = 0;
    this.afterEngine();
  }

  voteRunItTwice(playerId: PlayerId, yes: boolean) {
    const hand = this.liveHandFor(playerId);
    engine.voteRunItTwice(hand, this.seatOf(playerId)!.seat, yes);
    this.afterEngine();
  }

  show(playerId: PlayerId, cardIndexes: number[]) {
    const hand = this.state.hand;
    const seat = this.seatOf(playerId);
    if (!hand || !seat || !hand.seats.some((x) => x.seat === seat.seat)) throw new ActionError('you were not in the last hand');
    engine.show(hand, seat.seat, cardIndexes);
    this.onChange();
  }

  private liveHandFor(playerId: PlayerId): HandState {
    const hand = this.state.hand;
    if (!hand || hand.phase === 'complete') throw new ActionError('no hand is being played');
    if (this.state.paused) throw new ActionError('the game is paused');
    const seat = this.seatOf(playerId);
    if (!seat || !hand.seats.some((x) => x.seat === seat.seat)) throw new ActionError('you are not in this hand');
    return hand;
  }

  private handLive() {
    return !!this.state.hand && this.state.hand.phase !== 'complete';
  }

  /** In the live hand with cards (not folded out of it). */
  private inHand(playerId: PlayerId) {
    const seat = this.seatOf(playerId);
    if (!seat || !this.handLive()) return false;
    return this.state.hand!.seats.some((x) => x.seat === seat.seat);
  }

  private foldIfLive(playerId: PlayerId) {
    const seat = this.seatOf(playerId);
    const hand = this.state.hand;
    if (!seat || !hand || hand.phase === 'complete') return;
    engine.foldOutOfTurn(hand, seat.seat);
    this.afterEngine(false);
  }

  /** The time bank pays for whatever time was used past the normal clock. */
  private spendBank(seat: SeatState) {
    const turn = this.state.turn;
    if (!turn || turn.seat !== seat.seat || !turn.usingBank || turn.bankFrom === null) return;
    const used = Math.ceil((this.clock.now() - turn.bankFrom) / 1000);
    seat.timeBank = Math.max(0, seat.timeBank - used);
  }

  /** After any engine call: finish the hand or restart the turn clock. */
  private afterEngine(notify = true) {
    const hand = this.state.hand;
    if (hand?.phase === 'complete' && this.state.handStartedAt !== null) this.finishHand();
    if (notify) this.sync();
  }

  // ---------------------------------------------------------------- between hands

  /** Everyone who could be dealt in: seated, not sitting out, with chips. */
  private activePlayers() {
    return this.state.seats.filter((s): s is SeatState => !!s && !s.sittingOut && s.stack > 0);
  }

  private finishHand() {
    const s = this.state;
    const hand = s.hand!;
    const now = this.clock.now();
    const record = { handNumber: s.handNumber, startedAt: s.handStartedAt!, endedAt: now, hand };
    s.history.push(record);
    if (s.history.length > HISTORY_LIMIT) s.history.splice(0, s.history.length - HISTORY_LIMIT);
    s.handStartedAt = null;
    s.turn = null;
    s.ritDeadline = null;

    for (const hs of hand.seats) {
      const seat = s.seats[hs.seat];
      if (seat && seat.playerId === hs.playerId) seat.stack = hs.stack;
    }

    // Queued chips and stack edits land now; leavers go.
    for (const seat of s.seats) {
      if (!seat) continue;
      if (seat.pendingStack !== null) {
        if (s.ledger[seat.playerId]) s.ledger[seat.playerId].buyIn += seat.pendingStack - seat.stack;
        seat.stack = seat.pendingStack;
        seat.pendingStack = null;
      }
      if (seat.pendingChips) {
        seat.stack += seat.pendingChips;
        seat.pendingChips = 0;
      }
      seat.handsSinceRefill++;
      const refill = s.settings.timing.timeBankRefillHands;
      if (refill > 0 && seat.handsSinceRefill >= refill) {
        seat.timeBank = s.settings.timing.timeBankSeconds;
        seat.handsSinceRefill = 0;
      }
    }
    const report = this.tournament ? handReport(record, s.seats) : null;
    for (const seat of s.seats) {
      if (!seat) continue;
      if (seat.leaveAfterHand) {
        if (this.isTournament) s.seats[seat.seat] = null;
        else this.removeSeat(seat);
      } else if (seat.stack === 0 && !this.isTournament) {
        seat.sittingOut = true;
        seat.sitOutReason = 'busted';
      }
    }

    this.onHandFinished(record);
    if (this.tournament && report) this.tournament.handEnded(report);

    if (s.stopAfterHand) {
      s.started = false;
      s.stopAfterHand = false;
    }
    const delay = hand.showdown ? s.settings.timing.showdownSeconds : s.settings.timing.nextHandDelaySeconds;
    const auto = this.isTournament || s.settings.timing.autoStartNextHand;
    s.nextHandAt = s.started && auto ? now + delay * 1000 : null;
  }

  /** The between-hands pipeline. Returns false when no hand could start. */
  private deal(): boolean {
    if (!this.isTournament) return this.dealHand();
    // A tournament table never stops: it holds, and a later level or poke deals.
    try {
      const dealt = this.dealHand();
      if (dealt) this.dealFailure = null;
      return dealt;
    } catch (e) {
      this.dealFailed(e);
      return false;
    }
  }

  private dealFailed(e: unknown) {
    const why = e instanceof Error ? e.message : String(e);
    if (why === this.dealFailure) return;
    this.dealFailure = why;
    // An ActionError's reason is for players; anything else (a bad level, a bug) is for the server log.
    if (e instanceof ActionError) this.log(`Couldn't deal: ${why}`);
    else {
      this.log("Couldn't deal: this level cannot be dealt");
      this.logError(`table ${this.state.id}: dealing failed`, e);
    }
  }

  private dealHand(): boolean {
    const s = this.state;
    const now = this.clock.now();
    s.nextHandAt = null;
    this.applyPendingSettings();
    if (s.paused) return false;
    // Tournament tables also wait for their director (start time, breaks, hand-for-hand).
    if (!s.started) return false;
    if (this.tournament && this.tournament.gate(now) !== 'deal') return false;

    // Busted players can't be dealt in; nor can anyone sitting out (cash).
    for (const seat of s.seats) {
      if (seat && seat.stack === 0 && !this.isTournament && !seat.sittingOut) {
        seat.sittingOut = true;
        seat.sitOutReason = 'busted';
      }
    }
    const offline = (seat: SeatState) => !this.isOnline(seat.playerId);
    const candidates = s.seats.filter((x): x is SeatState => {
      if (!x || x.stack <= 0) return false;
      if (this.isTournament) return true;
      if (x.sittingOut) return false;
      // Offline players are sat out unless the table deals to away players.
      if (offline(x) && !s.settings.seating.dealToAway && this.offlineFor(x) > s.settings.seating.offlineGraceSeconds * 1000) return false;
      return true;
    });
    if (candidates.length < 2) return false;
    // Nobody has played yet (or a game is restarting): deal everyone in free.
    if (candidates.filter((x) => !x.isNew).length < 2) for (const x of candidates) x.isNew = false;

    const plannerSeats: PlannerSeat[] = candidates.map((x) => ({
      seat: x.seat,
      playerId: x.playerId,
      stack: x.stack,
      isNew: x.isNew,
      missedSmallBlind: x.missedSmallBlind,
      missedBigBlind: x.missedBigBlind,
      waitForBigBlind: x.waitForBigBlind,
      straddle: x.straddle,
    }));
    const maxSeats = s.seats.length;
    const firstButton = candidates[this.rng(candidates.length)].seat;
    const planFor = (setup: HandSetup) =>
      planForcedBets({
        game: setup.game,
        stakes: setup.stakes,
        maxSeats,
        seats: plannerSeats,
        lastBigBlindSeat: s.positions?.bigBlind ?? null,
        lastSmallBlindSeat: s.positions?.smallBlind ?? null,
        lastButton: s.positions?.button ?? firstButton,
        mode: this.isTournament ? 'tournament' : 'cash',
        straddles: this.isTournament ? 'off' : s.settings.play.straddle,
        bombPot: null,
      });
    let setup = this.handSetup();
    let plan = planFor(setup);
    if (plan.dealtIn.length < 2) return false;
    // Mixed games: the step may end with this hand's button (orbits), which changes the game.
    if (this.rotationStepDone(plan.button)) {
      setup = this.handSetup();
      plan = planFor(setup);
      if (plan.dealtIn.length < 2) return false;
    }

    // Players sitting out whom the blinds passed now owe them.
    if (!this.isTournament && s.positions) {
      const sittingOut = s.seats.filter((x): x is SeatState => !!x && !plan.dealtIn.includes(x.seat) && !plan.waiting.includes(x.seat)).map((x) => x.seat);
      const passed = blindsPassed(plan, s.positions.bigBlind, sittingOut, maxSeats);
      for (const seat of passed.missedBig) s.seats[seat]!.missedBigBlind = true;
      for (const seat of passed.missedSmall) s.seats[seat]!.missedSmallBlind = true;
    }
    for (const seatNo of plan.dealtIn) {
      const seat = s.seats[seatNo]!;
      seat.isNew = false;
      seat.missedBigBlind = false;
      seat.missedSmallBlind = false;
    }
    if (s.settings.game.rotation.enabled) s.rotation.hands++;

    const dealt = new Set(plan.dealtIn);
    let input: HandInput = {
      handId: `${s.id}-${s.handNumber + 1}`,
      handNumber: s.handNumber + 1,
      game: setup.game,
      betting: setup.betting,
      stakes: setup.stakes,
      maxSeats,
      seats: candidates
        .filter((x) => dealt.has(x.seat))
        .map((x) => ({ seat: x.seat, playerId: x.playerId, stack: x.stack, away: x.sittingOut || (offline(x) && this.offlineFor(x) > s.settings.seating.offlineGraceSeconds * 1000) })),
      button: plan.button,
      buttonDead: plan.buttonDead,
      posts: plan.posts,
      deck: shuffle(freshDeck(), this.rng),
      reshuffleSeed: this.rng(0x7fffffff),
      options: {
        boards: 1,
        bombPot: false,
        runItTwice: this.isTournament ? 'off' : s.settings.play.runItTwice,
        fixedLimitCap: s.settings.play.fixedLimitCap,
        uncappedHeadsUp: s.settings.play.uncappedHeadsUp,
      },
      modifiers: this.isTournament ? [] : enabledModifiers(s.settings),
    };
    for (const m of input.modifiers) {
      const mod = modifierRegistry.get(m.id);
      if (mod?.beforeHand) input = mod.beforeHand(input, m.settings, this.rng);
    }

    let hand: HandState;
    try {
      hand = engine.startHand(input);
    } catch (e) {
      // A setting that can't be dealt (e.g. too many players for the deck): tell the table and stop.
      // Tournament tables hold instead (see deal()).
      if (e instanceof ActionError && !this.isTournament) {
        this.log(`Couldn't deal: ${e.message}`);
        s.started = false;
        return false;
      }
      throw e;
    }
    s.handNumber = input.handNumber;
    s.hand = hand;
    s.handStartedAt = now;
    s.positions = { button: plan.button, smallBlind: plan.smallBlindSeat, bigBlind: plan.bigBlindSeat };
    if (s.settings.blindSchedule.enabled) {
      s.level.hands++;
      if (s.level.runningSince === null) s.level.runningSince = now;
    }
    this.tournament?.handStarted(s.handNumber);
    if (hand.phase === 'complete') this.finishHand();
    return true;
  }

  private offlineFor(seat: SeatState) {
    const since = this.offlineSince.get(seat.playerId);
    if (since !== undefined) return this.clock.now() - since;
    return this.isOnline(seat.playerId) ? 0 : this.clock.now() - this.upSince;
  }

  /** Game, betting and stakes for the next hand: tournament level, rotation step or table settings, with the blind schedule. */
  handSetup(): HandSetup {
    const settings = this.state.settings;
    if (this.tournament) {
      const level = this.tournament.level();
      const game = variants.get(level.gameId).spec;
      return { game, betting: level.betting ?? game.defaultBetting, stakes: fillStakes(level.stakes, game) };
    }
    let gameId = settings.game.gameId;
    let betting: BettingKind = settings.game.betting;
    const rotation = settings.game.rotation;
    if (rotation.enabled && rotation.steps.length) {
      const step = rotation.steps[this.state.rotation.step % rotation.steps.length];
      gameId = step.gameId;
      betting = step.betting;
    }
    const game = variants.get(gameId).spec;
    const { centsMode: _cents, ...base } = settings.stakes;
    const stakes: Stakes = { ...base };
    if (settings.blindSchedule.enabled && settings.blindSchedule.levels.length) {
      const level = settings.blindSchedule.levels[this.currentLevelIndex()];
      stakes.smallBlind = level.smallBlind;
      stakes.bigBlind = level.bigBlind;
      stakes.ante = level.ante;
    }
    return { game, betting, stakes: fillStakes(stakes, game) };
  }

  /** Blind schedule: moves up a level when its time or hand count is used up. */
  private currentLevelIndex() {
    const s = this.state;
    const sched = s.settings.blindSchedule;
    const now = this.clock.now();
    for (;;) {
      const level = sched.levels[s.level.index];
      if (!level || s.level.index >= sched.levels.length - 1) break;
      const elapsed = s.level.elapsedMs + (s.level.runningSince !== null ? now - s.level.runningSince : 0);
      const done = sched.countdown === 'hands' ? s.level.hands >= level.hands : elapsed >= level.minutes * 60_000;
      if (!done) break;
      s.level = { index: s.level.index + 1, elapsedMs: sched.countdown === 'hands' ? 0 : elapsed - level.minutes * 60_000, runningSince: s.level.runningSince !== null ? now : null, hands: 0 };
      this.log(`Blinds are now ${sched.levels[s.level.index].smallBlind}/${sched.levels[s.level.index].bigBlind}`);
    }
    return Math.min(s.level.index, sched.levels.length - 1);
  }

  /**
   * Mixed games: counts orbits (the button reaching the seat where the step
   * began) and moves to the next step once this one has had its hands or
   * orbits. True when the step changed.
   */
  private rotationStepDone(button: number): boolean {
    const s = this.state;
    const rot = s.settings.game.rotation;
    if (!rot.enabled || !rot.steps.length) return false;
    const r = s.rotation;
    const prev = s.positions?.button ?? null;
    if (r.anchor === null) r.anchor = button;
    else if (prev !== null && prev !== button) {
      const n = s.seats.length;
      const d = (from: number, to: number) => (to - from + n) % n;
      if (d(prev, r.anchor) > 0 && d(prev, r.anchor) <= d(prev, button)) r.orbits++;
    }
    const step = rot.steps[r.step % rot.steps.length];
    const done = step.unit === 'hands' ? r.hands >= step.length : r.orbits >= step.length;
    if (!done) return false;
    r.step = (r.step + 1) % rot.steps.length;
    r.hands = 0;
    r.orbits = 0;
    r.anchor = button;
    this.log(`Switching to ${variants.get(rot.steps[r.step].gameId).spec.name}`);
    return true;
  }

  // ---------------------------------------------------------------- clocks

  /**
   * Brings timers in line with the state, runs anything already due, and
   * tells listeners. Every public mutation ends here.
   */
  private sync() {
    for (let guard = 0; guard < 20; guard++) {
      if (!this.step()) break;
    }
    this.armTimers();
    this.onChange();
  }

  /** Does one due thing. True if something changed and another pass is needed. */
  private step(): boolean {
    const s = this.state;
    if (s.paused || this.tournament?.busy()) return false;
    const now = this.clock.now();
    const hand = s.hand;
    if (hand && hand.phase !== 'complete') {
      if (hand.phase === 'rit-vote') {
        if (s.ritDeadline === null) s.ritDeadline = now + RIT_VOTE_SECONDS * 1000;
        if (now >= s.ritDeadline) {
          for (const x of hand.seats) if (!x.folded && x.ritVote === null && hand.phase === 'rit-vote') engine.voteRunItTwice(hand, x.seat, false);
          s.ritDeadline = null;
          this.afterEngine(false);
          return true;
        }
        return false;
      }
      s.ritDeadline = null;
      const toAct = hand.toAct;
      if (toAct === null) return false;
      const key = `${hand.input.handId}:${hand.events.length}`;
      if (!s.turn || s.turn.key !== key) s.turn = this.newTurn(key, toAct);
      const deadline = this.turnDeadline();
      if (deadline !== null && now >= deadline) {
        const seat = s.seats[toAct];
        // Out of normal time: the time bank takes over if there is any.
        if (seat && !s.turn.usingBank && s.turn.deadline !== null && seat.timeBank > 0 && s.settings.timing.autoActivateTimeBank && this.isOnline(seat.playerId) && !seat.sittingOut) {
          s.turn.usingBank = true;
          s.turn.bankFrom = s.turn.deadline;
          s.turn.deadline += seat.timeBank * 1000;
          return true;
        }
        this.timeOut(toAct);
        return true;
      }
      return false;
    }
    if (s.nextHandAt !== null && now >= s.nextHandAt) {
      this.deal();
      return true;
    }
    // Nothing scheduled: a tournament table deals when its gate opens, a running cash
    // table when enough players are back. A failed attempt leaves things as they were.
    if (s.nextHandAt === null && (!hand || hand.phase === 'complete')) {
      const auto = this.tournament || (s.started && s.settings.timing.autoStartNextHand && !s.stopAfterHand);
      if (auto) return this.deal();
    }
    return false;
  }

  private newTurn(key: string, seatNo: number) {
    const now = this.clock.now();
    const clock = this.state.settings.timing.decisionSeconds;
    return { key, seat: seatNo, startedAt: now, deadline: clock > 0 ? now + clock * 1000 : null, usingBank: false, bankFrom: null };
  }

  /**
   * When the current turn runs out: the decision clock (plus any time bank),
   * cut short for a player who is offline (a grace period from when they
   * dropped) or sitting out (at once).
   */
  turnDeadline(): number | null {
    const s = this.state;
    const turn = s.turn;
    if (!turn) return null;
    const seat = s.seats[turn.seat];
    if (!seat) return turn.deadline;
    if (seat.sittingOut) return turn.startedAt;
    if (!this.isOnline(seat.playerId)) {
      const since = this.offlineSince.get(seat.playerId) ?? turn.startedAt;
      const graceEnd = Math.max(since, turn.startedAt) + s.settings.seating.offlineGraceSeconds * 1000;
      return turn.deadline === null ? graceEnd : Math.min(turn.deadline, graceEnd);
    }
    return turn.deadline;
  }

  private timeOut(seatNo: number) {
    const s = this.state;
    const hand = s.hand!;
    engine.timeout(hand, seatNo);
    const seat = s.seats[seatNo];
    if (seat) {
      if (seat.timeBank > 0 && s.turn?.usingBank) seat.timeBank = 0;
      seat.timeouts++;
      const limit = s.settings.seating.awayAfterTimeouts;
      if (limit > 0 && seat.timeouts >= limit && !seat.sittingOut) {
        seat.sittingOut = true;
        seat.sitOutReason = 'timeouts';
        this.log(`${seat.name} is sitting out after running out of time`);
      }
    }
    s.turn = null;
    this.afterEngine(false);
  }

  private armTimers() {
    const s = this.state;
    for (const key of ['turn', 'next', 'rit'] as const) this.clearTimer(key);
    if (s.paused) return;
    const now = this.clock.now();
    const at = (key: 'turn' | 'next' | 'rit', when: number | null | undefined) => {
      if (when == null) return;
      this.timers[key] = this.clock.setTimeout(() => {
        this.timers[key] = null;
        // A throw out of a timer would take the whole server down; the table holds until its next change.
        try {
          this.sync();
        } catch (e) {
          this.logError(`table ${this.state.id}: ${key} timer failed`, e);
        }
      }, Math.max(0, when - now));
    };
    at('turn', this.turnDeadline());
    at('next', s.nextHandAt);
    at('rit', s.ritDeadline);
  }

  private clearTimer(key: 'turn' | 'next' | 'rit') {
    if (this.timers[key] !== null) this.clock.clearTimeout(this.timers[key]);
    this.timers[key] = null;
  }

  private log(text: string) {
    this.state.log.push({ at: this.clock.now(), text });
    if (this.state.log.length > LOG_LIMIT) this.state.log.splice(0, this.state.log.length - LOG_LIMIT);
  }
}

/** Fills in limit sizes and the bring-in when the settings leave them at 0. */
export function fillStakes(stakes: Stakes, game: GameSpec): Stakes {
  const out = { ...stakes };
  if (out.smallBet <= 0) out.smallBet = Math.max(1, out.bigBlind);
  if (out.bigBet <= 0) out.bigBet = out.smallBet * 2;
  if (game.family === 'stud' && out.bringIn <= 0) out.bringIn = Math.max(1, Math.floor(out.smallBet / 3));
  if (game.forcedBets === 'ante-bring-in' && out.anteType === 'big-blind') out.anteType = 'per-player';
  return out;
}

/**
 * What a tournament table tells the director when a hand ends. The director takes the end stacks as the
 * new stacks, so chips bought during the hand (a rebuy or add-on, already in `seats`) must be in them,
 * and a player they cover is not knocked out. Without `seats`, the hand's own end stacks count.
 */
export function handReport(record: HandRecord, seats: RuntimeState['seats'] | null): Parameters<TournamentHooks['handEnded']>[0] {
  const { hand } = record;
  const startStacks: Record<PlayerId, number> = {};
  const endStacks: Record<PlayerId, number> = {};
  const knockedOutBy: Record<PlayerId, PlayerId[]> = {};
  for (const hs of hand.seats) {
    startStacks[hs.playerId] = hs.startStack;
    const seat = seats?.[hs.seat];
    const end = seat && seat.playerId === hs.playerId ? seat.stack : hs.stack;
    endStacks[hs.playerId] = end;
    if (end > 0) continue;
    const winners = new Set(hand.awards.map((a) => a.seat).filter((seat) => seat !== hs.seat));
    knockedOutBy[hs.playerId] = hand.seats.filter((x) => winners.has(x.seat)).map((x) => x.playerId);
  }
  return { handNumber: record.handNumber, startStacks, endStacks, knockedOutBy, button: hand.input.button };
}

function cleanName(name: string) {
  const clean = cleanDisplayName(name, NAME_MAX);
  if (!clean) throw new ActionError('pick a name');
  return clean;
}
