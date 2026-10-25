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
import { bombPotDue, bombPotSchema, bounty72Schema, nitClears, nitSchema, sevenDeuceWinners } from '@rsdp/engine/modifiers';
import {
  RUNTIME_VERSION,
  systemClock,
  type Clock,
  type HandRecord,
  type RuntimeState,
  type SeatRequest,
  type SideGameState,
  type SeatState,
  type TournamentHooks,
  type WaitlistEntry,
} from './types';
import { cleanName as cleanDisplayName } from '../names';
import { maskProfanity } from './profanity';

const CHAT_LIMIT = 200;
const LOG_LIMIT = 300;
const HISTORY_LIMIT = 30;
const RIT_VOTE_SECONDS = 12;
const NAME_MAX = 20;
/** How long a cash table waits for an offline host before handing the table to a seated player. */
export const HOST_HANDOFF_MS = 3 * 60_000;
/** How long a free seat is held for the next person on the waitlist. */
export const SEAT_OFFER_MS = 60_000;

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
  /** Names people go by before they sit (their session name), for chat. Set by the server. */
  readonly guestNames = new Map<PlayerId, string>();
  private readonly offlineSince = new Map<PlayerId, number>();
  /** When this runtime came up: players it has never seen get their grace from here. */
  private readonly upSince: number;
  private timers: Record<TimerKey, unknown> = { turn: null, next: null, rit: null, upkeep: null };
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
    for (const key of TIMER_KEYS) this.clearTimer(key);
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
    // Back before the hand ended: the seat release that was waiting for it is off.
    const seat = this.seatOf(playerId);
    if (seat?.released) {
      seat.leaveAfterHand = false;
      seat.released = false;
    }
    // The host back stops the handoff; anyone else arriving may be the one to take over.
    if (this.isHost(playerId) || this.hostTimer !== null) this.watchHost();
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
    let { seat } = input;
    const { stack } = input;
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.state.seats.length) throw new ActionError('no such seat');
    if (this.seatOf(playerId)) throw new ActionError('you already have a seat');
    const offered = this.offers().find((o) => o.playerId === playerId);
    if (offered) seat = offered.seat;
    else if (this.settings.seating.randomSeats && !this.isHost(playerId)) {
      const open = this.openSeats(playerId);
      if (!open.length) throw new ActionError('every seat is taken');
      seat = open[this.rng(open.length)];
    }
    if (this.state.seats[seat]) throw new ActionError('that seat is taken');
    this.checkSeatFree(playerId, seat);
    this.checkBuyIn(playerId, stack);
    // A new request replaces your earlier one (which never holds a seat against you).
    this.state.requests = this.state.requests.filter((r) => !(r.playerId === playerId && r.kind === 'seat'));
    // Sitting (or asking to) takes you off the waitlist; an offered seat is yours now.
    this.leaveQueue(playerId);
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

  /** Approves a request; for a seat request the host may put the player in another open seat. */
  approve(by: PlayerId, requestId: string, seat?: number) {
    this.requireHost(by);
    const r = this.state.requests.find((x) => x.id === requestId);
    if (!r) throw new ActionError('request not found');
    if (r.kind === 'seat') {
      if (this.seatOf(r.playerId)) throw new ActionError('already seated');
      let target = seat ?? r.seat!;
      if (seat !== undefined) {
        if (!Number.isInteger(seat) || seat < 0 || seat >= this.state.seats.length) throw new ActionError('no such seat');
        if (this.state.seats[seat]) throw new ActionError('that seat is taken');
        this.checkSeatFree(r.playerId, seat);
      } else if (this.state.seats[target]) {
        // Random seating: any open seat will do.
        const open = this.settings.seating.randomSeats ? this.openSeats(r.playerId) : [];
        if (!open.length) throw new ActionError('that seat has been taken');
        target = open[this.rng(open.length)];
      }
      this.state.requests = this.state.requests.filter((x) => x !== r);
      this.seatPlayer({ ...r, seat: target });
    } else {
      this.state.requests = this.state.requests.filter((x) => x !== r);
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

  /** A seat someone else is waiting on: held for a waitlisted player, or asked for and awaiting the host. */
  private checkSeatFree(playerId: PlayerId, seat: number) {
    const offer = this.offers().find((o) => o.seat === seat);
    if (offer && offer.playerId !== playerId) throw new ActionError(`that seat is being held for ${this.queueName(offer.playerId)} from the waitlist`);
    const asked = this.state.requests.find((r) => r.kind === 'seat' && r.seat === seat && r.playerId !== playerId);
    if (asked) throw new ActionError(`${asked.name} has asked for that seat`);
  }

  /** Empty seats nobody else is waiting on. */
  private openSeats(playerId: PlayerId | null = null): number[] {
    const held = new Set([
      ...this.offers().filter((o) => o.playerId !== playerId).map((o) => o.seat),
      ...this.state.requests.filter((r) => r.kind === 'seat' && r.playerId !== playerId).map((r) => r.seat!),
    ]);
    return this.state.seats.flatMap((x, i) => (x || held.has(i) ? [] : [i]));
  }

  private queue(): WaitlistEntry[] {
    return (this.state.waitlist ??= []);
  }

  private offers() {
    return (this.state.offers ??= []);
  }

  private queueName(playerId: PlayerId) {
    return this.state.waitlist?.find((w) => w.playerId === playerId)?.name ?? this.nameOf(playerId);
  }

  /** Takes a player off the waitlist and lets go of any seat held for them. */
  private leaveQueue(playerId: PlayerId) {
    if (this.state.waitlist?.some((w) => w.playerId === playerId)) this.state.waitlist = this.state.waitlist.filter((w) => w.playerId !== playerId);
    if (this.state.offers?.some((o) => o.playerId === playerId)) this.state.offers = this.state.offers.filter((o) => o.playerId !== playerId);
  }

  /** Join the waitlist of a full cash table, with the buy-in to sit with when a seat comes up. */
  joinWaitlist(playerId: PlayerId, input: { name: string; stack: number }) {
    if (this.isTournament) throw new ActionError('the tournament seats players');
    if (!this.settings.seating.waitlist) throw new ActionError('this table has no waitlist');
    const name = cleanName(input.name);
    if (this.seatOf(playerId)) throw new ActionError('you already have a seat');
    if (this.queue().some((w) => w.playerId === playerId)) throw new ActionError("you're already on the waitlist");
    if (this.state.requests.some((r) => r.playerId === playerId && r.kind === 'seat')) throw new ActionError('you have already asked for a seat');
    if (this.openSeats(playerId).length) throw new ActionError('there is a free seat: take it');
    this.checkBuyIn(playerId, input.stack);
    this.queue().push({ playerId, name, stack: input.stack, at: this.clock.now() });
    this.log(`${name} joined the waitlist`);
    this.sync();
  }

  leaveWaitlist(playerId: PlayerId) {
    const entry = this.state.waitlist?.find((w) => w.playerId === playerId);
    if (!entry) return;
    this.leaveQueue(playerId);
    this.log(`${entry.name} left the waitlist`);
    this.sync();
  }

  /** Turns down a held seat: off the waitlist, and the seat goes to the next person. */
  declineOffer(playerId: PlayerId) {
    this.leaveWaitlist(playerId);
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
    this.nitLeaves(seat.playerId);
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

  setPreferences(playerId: PlayerId, prefs: { waitForBigBlind?: boolean; straddle?: boolean; nitGame?: boolean; mood?: string | null }) {
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('you are not seated');
    if (prefs.mood !== undefined) seat.mood = cleanMood(prefs.mood);
    if (prefs.nitGame !== undefined) seat.nitOptIn = !!prefs.nitGame;
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

  /** Cash tables: make the next hand a bomb pot (or take that back). */
  requestBombPot(by: PlayerId, value: boolean) {
    this.requireHost(by);
    if (this.isTournament) throw new ActionError('bomb pots are for cash games');
    const sg = this.sideGames();
    if (sg.bombPotNext === value) return;
    sg.bombPotNext = value;
    this.log(value ? 'The host made the next hand a bomb pot' : 'The host cancelled the bomb pot');
    this.sync();
  }

  /** Bomb pot counters; tables saved before they existed start fresh. */
  sideGames(): SideGameState {
    this.state.sideGames ??= { handsSinceBombPot: 0, bombPotNext: false };
    return this.state.sideGames;
  }

  /** Rake and the Nit game after a cash hand, once stacks are back on the seats. */
  private settleSideGames(hand: HandState) {
    const sg = this.sideGames();
    const rake = hand.events.reduce((n, e) => n + (e.t === 'transfer' && e.kind === 'rake' ? e.amount : 0), 0);
    if (rake) sg.rakeTotal = (sg.rakeTotal ?? 0) + rake;
    this.logBounty(hand, 0);

    const round = sg.nit;
    if (!round || !this.nitStillOn()) return;
    const seatOfPlayer = new Map(hand.seats.map((x) => [x.playerId, x.seat]));
    const inHand = round.holders.filter((id) => seatOfPlayer.has(id));
    const cleared = new Set(nitClears(hand, inHand.map((id) => seatOfPlayer.get(id)!)).map((seat) => hand.seats.find((x) => x.seat === seat)!.playerId));
    if (!cleared.size) return;
    round.holders = round.holders.filter((id) => !cleared.has(id));
    for (const id of cleared) this.log(`${this.nameOf(id)} is off the nit`);
    if (round.holders.length === 1) this.nitPays(round.holders[0], 'is the last nit');
  }

  /** A line in the table log for each 7-2 bounty paid, so the whole table sees it. */
  private logBounty(hand: HandState, fromEvent: number) {
    const collected = new Map<number, number>();
    for (const e of hand.events.slice(fromEvent)) {
      if (e.t === 'transfer' && e.kind === 'bounty-72' && e.to !== 'house') collected.set(e.to, (collected.get(e.to) ?? 0) + e.amount);
    }
    for (const [seatNo, amount] of collected) {
      const playerId = hand.seats.find((x) => x.seat === seatNo)?.playerId;
      if (playerId && amount > 0) this.log(`${this.nameOf(playerId)} wins with 7-2 and collects ${amount} in bounties`);
    }
  }

  /** Starts a Nit game round when enough opted-in players are dealt in. */
  private maybeStartNitRound(dealtIn: number[], bigBlind: number) {
    const sg = this.sideGames();
    const cfg = nitSchema.get(this.settings);
    if (!cfg.enabled) {
      if (sg.nit) this.log('The Nit game is off; the round is cancelled');
      sg.nit = null;
      return;
    }
    if (sg.nit) return;
    const players = dealtIn.map((n) => this.state.seats[n]!).filter((x) => x.nitOptIn).map((x) => x.playerId);
    if (players.length < cfg.minPlayers) return;
    const prize = cfg.prizeBigBlinds * bigBlind;
    sg.nit = { participants: players, holders: [...players], prize };
    this.log(`Nit game: ${players.length} players are in. The last one to win a pot pays ${prize} to each of the others.`);
  }

  /** A participant leaves: a holder forfeits (pays everyone); anyone else just drops out. */
  private nitLeaves(playerId: PlayerId) {
    const round = this.state.sideGames?.nit;
    if (!round || !round.participants.includes(playerId) || !this.nitStillOn()) return;
    if (round.holders.includes(playerId)) {
      this.nitPays(playerId, 'left holding the nit');
      return;
    }
    round.participants = round.participants.filter((id) => id !== playerId);
    if (round.participants.length < 2) {
      this.sideGames().nit = null;
      this.log('The Nit game round ended: not enough players');
    }
  }

  /** Turning the Nit game off cancels a running round straight away, so nobody pays after that. */
  private nitStillOn(): boolean {
    const { pendingSettings } = this.state;
    // A change still waiting for the hand to end counts already.
    const settings = pendingSettings ? applyAtNextHand(this.settings, pendingSettings).settings : this.settings;
    if (nitSchema.get(settings).enabled) return true;
    if (this.state.sideGames?.nit) {
      this.sideGames().nit = null;
      this.log('The Nit game is off; the round is cancelled');
    }
    return false;
  }

  /**
   * The loser pays the full prize to every other participant and the round ends.
   * The prize is guaranteed, as PokerNow's escrow guarantees it: what their
   * stack can't cover is added to their buy-in, as chips brought from outside
   * and paid straight on, so settle-up collects it.
   */
  private nitPays(loserId: PlayerId, why: string) {
    const sg = this.sideGames();
    const round = sg.nit!;
    sg.nit = null;
    const loser = this.seatOf(loserId);
    if (!loser) return;
    const payees = round.participants.filter((id) => id !== loserId).flatMap((id) => this.seatOf(id) ?? []);
    const owed = round.prize * payees.length;
    const fromStack = Math.min(loser.stack, owed);
    const shortfall = owed - fromStack;
    loser.stack -= fromStack;
    if (shortfall > 0) this.ledgerEdit(loserId, shortfall);
    for (const to of payees) {
      // A payee in a live hand gets the chips when it ends, or finishing the hand would overwrite them.
      if (this.inHand(to.playerId)) to.pendingChips += round.prize;
      else to.stack += round.prize;
      if (to.sitOutReason === 'busted') {
        to.sittingOut = false;
        to.sitOutReason = null;
      }
    }
    if (loser.stack === 0 && loser.pendingChips === 0 && !loser.leaveAfterHand) {
      loser.sittingOut = true;
      loser.sitOutReason = 'busted';
    }
    const extra = shortfall > 0 ? ` (${shortfall} of it added to their buy-in)` : '';
    this.log(`${this.nameOf(loserId)} ${why} and pays ${owed} in all${extra} (Nit game)`);
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
        // The bank starts where the extended deadline less the whole bank falls (it may still be ahead).
        const banked = s.seats[s.turn.seat];
        if (s.turn.bankFrom !== null) s.turn.bankFrom = banked ? s.turn.deadline - banked.timeBank * 1000 : now;
      }
      if (left?.nextHand != null) s.nextHandAt = now + left.nextHand;
      if (left?.rit != null) s.ritDeadline = now + left.rit;
      s.pausedLeft = null;
      s.paused = false;
      for (const id of this.offlineSince.keys()) this.offlineSince.set(id, now);
      this.watchHost();
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
    // Turning the Nit game off ends any round now, mid-hand or not.
    this.nitStillOn();
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
    const bombGame = bombPotSchema.get(next).gameId;
    if (bombGame) {
      let spec: GameSpec;
      try {
        spec = variants.get(bombGame).spec;
      } catch {
        throw new ActionError(`unknown bomb pot game ${bombGame}`);
      }
      if (spec.family !== 'flop' || spec.forcedBets !== 'blinds') throw new ActionError(`bomb pots need a game with a flop, not ${spec.name}`);
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
      this.ledgerEdit(playerId, stack - seat.stack);
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
    if (!seat) {
      const waiting = this.state.waitlist?.find((w) => w.playerId === playerId);
      if (waiting) this.log(`The host took ${waiting.name} off the waitlist`);
      this.leaveQueue(playerId);
      return this.sync();
    }
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

  /**
   * Cash tables, between hands: deals everyone seated a random seat among the
   * seats already taken. The button is drawn again and missed blinds are
   * forgiven, as when a game starts.
   */
  shuffleSeats(by: PlayerId) {
    this.requireHost(by);
    if (this.isTournament) throw new ActionError('the tournament seats players');
    if (this.handLive()) throw new ActionError('shuffle between hands');
    const s = this.state;
    const taken = s.seats.flatMap((x, i) => (x ? [i] : []));
    if (taken.length < 2) throw new ActionError('need at least two players to shuffle');
    const players = shuffle(taken.map((i) => s.seats[i]!), this.rng);
    taken.forEach((seatNo, i) => {
      const seat = players[i];
      seat.seat = seatNo;
      seat.isNew = false;
      seat.missedBigBlind = false;
      seat.missedSmallBlind = false;
      s.seats[seatNo] = seat;
    });
    for (const r of s.requests) if (r.kind === 'rebuy') r.seat = this.seatOf(r.playerId)?.seat ?? r.seat;
    s.positions = null;
    s.rotation.anchor = null;
    this.log('The host shuffled the seats');
    this.sync();
  }

  /** Cash tables: the host moves a player who is not in the hand to an empty seat. */
  moveSeat(by: PlayerId, playerId: PlayerId, to: number) {
    this.requireHost(by);
    if (this.isTournament) throw new ActionError('the tournament seats players');
    const seat = this.seatOf(playerId);
    if (!seat) throw new ActionError('that player is not seated');
    if (!Number.isInteger(to) || to < 0 || to >= this.state.seats.length) throw new ActionError('no such seat');
    if (this.state.seats[to]) throw new ActionError('that seat is taken');
    this.checkSeatFree(playerId, to);
    if (this.inHand(playerId)) throw new ActionError('move them once this hand is over');
    const from = seat.seat;
    this.state.seats[from] = null;
    seat.seat = to;
    // A new place at the table: like someone sitting down, they post or wait for the big blind.
    if (this.activePlayers().length >= 2 && this.state.handNumber > 0) seat.isNew = true;
    seat.missedBigBlind = false;
    seat.missedSmallBlind = false;
    this.state.seats[to] = seat;
    for (const r of this.state.requests) if (r.playerId === playerId) r.seat = to;
    this.log(`The host moved ${seat.name} from seat ${from + 1} to seat ${to + 1}`);
    this.sync();
  }

  /** The host mutes (or unmutes) someone's chat for the whole table. */
  mute(by: PlayerId, playerId: PlayerId, value: boolean) {
    this.requireHost(by);
    if (playerId === by) throw new ActionError("you can't mute yourself");
    const muted = (this.state.muted ??= []);
    if (muted.includes(playerId) === value) return;
    this.state.muted = value ? [...muted, playerId] : muted.filter((id) => id !== playerId);
    this.log(`The host ${value ? 'muted' : 'unmuted'} ${this.queueName(playerId)} in chat`);
    this.sync();
  }

  transferHost(by: PlayerId, to: PlayerId) {
    this.requireHost(by);
    if (to === by) throw new ActionError('you are already the host');
    if (!this.seatOf(to) && !this.isOnline(to)) throw new ActionError('that player is not at the table');
    // An offline host would be handed straight on again.
    if (!this.isOnline(to)) throw new ActionError('that player is offline');
    this.state.hostId = to;
    this.log(`${this.nameOf(by)} made ${this.nameOf(to)} the host`);
    this.watchHost();
    this.sync();
  }

  /** A host stack edit: chips added count as brought in, chips removed as taken out. */
  private ledgerEdit(playerId: PlayerId, change: number) {
    const row = this.state.ledger[playerId];
    if (!row) return;
    if (change > 0) row.buyIn += change;
    else row.cashOut -= change;
  }

  /**
   * A cash table whose host has been offline for HOST_HANDOFF_MS passes to a
   * seated player who is online and playing, starting from the seat after the
   * host's, so nobody is stuck waiting for approvals. Tournament tables are run
   * by the lobby and have no host to hand off.
   */
  private watchHost(retry: number | null = null) {
    this.clock.clearTimeout(this.hostTimer);
    this.hostTimer = null;
    const host = this.state.hostId;
    if (this.isTournament || this.isOnline(host)) return;
    const since = this.offlineSince.get(host) ?? this.upSince;
    const wait = retry ?? Math.max(0, since + HOST_HANDOFF_MS - this.clock.now());
    this.hostTimer = this.clock.setTimeout(() => {
      this.hostTimer = null;
      if (this.state.hostId !== host || this.isOnline(host)) return;
      const seats = this.state.seats;
      const from = this.seatOf(host)?.seat ?? -1;
      const order = seats.map((_, i) => seats[(from + 1 + i + seats.length) % seats.length]);
      const next = order.find((x) => x && x.playerId !== host && this.isOnline(x.playerId) && !x.sittingOut) ?? order.find((x) => x && x.playerId !== host && this.isOnline(x.playerId));
      if (!next) {
        // Nobody to take over yet: look again in a while (or as soon as someone connects).
        this.watchHost(HOST_HANDOFF_MS);
        return;
      }
      this.state.hostId = next.playerId;
      this.log(`${this.nameOf(host)} has been away for ${Math.round(HOST_HANDOFF_MS / 60_000)} minutes, so ${next.name} is now the host`);
      this.sync();
    }, wait);
  }

  chat(playerId: PlayerId | null, text: string) {
    let clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
    if (!clean) return;
    if (playerId) {
      if (this.state.muted?.includes(playerId)) throw new ActionError('the host has muted you');
      if (!this.settings.chat.guestChat && !this.seatOf(playerId) && !this.isHost(playerId)) throw new ActionError('only players at the table can chat here');
      if (this.settings.chat.profanityFilter) clean = maskProfanity(clean);
    }
    this.state.chat.push({ at: this.clock.now(), playerId, name: playerId ? this.nameOf(playerId) : 'Dealer', text: clean });
    if (this.state.chat.length > CHAT_LIMIT) this.state.chat.splice(0, this.state.chat.length - CHAT_LIMIT);
    this.onChange();
  }

  nameOf(playerId: PlayerId) {
    return (
      this.seatOf(playerId)?.name ??
      this.state.ledger[playerId]?.name ??
      this.state.handNames?.[playerId] ??
      this.state.waitlist?.find((w) => w.playerId === playerId)?.name ??
      this.guestNames.get(playerId) ??
      'Guest'
    );
  }

  /** Who may throw a gesture at whom: anyone with the table open, at a seated player other than themselves. */
  checkGesture(from: PlayerId, to: PlayerId) {
    if (this.state.settings.chat.gestures === false) throw new ActionError('the host has turned gestures off');
    if (from === to) throw new ActionError('pick another player');
    if (!this.seatOf(to)) throw new ActionError('that player is not seated');
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

  /** Tournament: a host stack edit. The director sends it between this player's hands; during one it waits for the end. */
  tournamentSetStack(playerId: PlayerId, stack: number) {
    const seat = this.seatOf(playerId);
    if (!seat) return;
    if (this.inHand(playerId)) seat.pendingStack = stack;
    else seat.stack = stack;
    this.log(`${seat.name}'s stack was set to ${stack}`);
    this.sync();
  }

  /** A hand is being played here. */
  get handInProgress() {
    return this.handLive();
  }

  /**
   * Tournament, after a crash: this snapshot is behind the director, which has
   * already closed the hand saved here as in progress (or later ones). Drops
   * that hand without playing it again and takes the hand number, button and
   * every stack from the director. Call before resume().
   */
  alignWithDirector(input: { handNumber: number; button: number | null; stacks: Record<PlayerId, number> }) {
    const s = this.state;
    for (const key of ['turn', 'next', 'rit'] as const) this.clearTimer(key);
    if (this.handLive()) {
      s.hand = null;
      s.handStartedAt = null;
      s.turn = null;
      s.ritDeadline = null;
    }
    s.handNumber = input.handNumber;
    if (input.button !== null && s.positions?.button !== input.button) s.positions = { button: input.button, smallBlind: null, bigBlind: null };
    for (const seat of s.seats) {
      const stack = seat ? input.stacks[seat.playerId] : undefined;
      if (!seat || stack === undefined) continue;
      seat.stack = stack;
      seat.pendingChips = 0;
      seat.pendingStack = null;
      seat.leaveAfterHand = false;
    }
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
    // A vote that lands after the vote closed (timed out, decided, or the hand ended) has nothing left to change.
    const current = this.state.hand;
    if (!current || current.phase !== 'rit-vote') return;
    const hand = this.liveHandFor(playerId);
    engine.voteRunItTwice(hand, this.seatOf(playerId)!.seat, yes);
    this.afterEngine();
  }

  show(playerId: PlayerId, cardIndexes: number[]) {
    const hand = this.state.hand;
    // By player, not seat: seats may have been shuffled since the hand.
    const hs = this.seatOf(playerId) ? hand?.seats.find((x) => x.playerId === playerId) : undefined;
    if (!hand || !hs) throw new ActionError('you were not in the last hand');
    const from = hand.events.length;
    engine.show(hand, hs.seat, cardIndexes);
    if (hand.phase === 'complete' && this.state.handStartedAt === null) {
      this.applyLateTransfers(hand, from);
      this.logBounty(hand, from);
    }
    this.onChange();
  }

  /**
   * Transfers a show earned after the hand was settled (a 7-2 bounty claimed
   * late) move chips between the table's stacks as they are now: a payer
   * whose stack changed since the hand pays at most what they have, a player
   * who has left pays out of what they cashed out, and the winner gets only
   * what was collected.
   */
  private applyLateTransfers(hand: HandState, fromEvent: number) {
    const s = this.state;
    const playerAt = (seatNo: number) => hand.seats.find((x) => x.seat === seatNo)?.playerId;
    const take = (seatNo: number, amount: number): number => {
      const playerId = playerAt(seatNo);
      if (!playerId) return 0;
      const seat = this.seatOf(playerId);
      if (seat) {
        const paid = Math.min(amount, seat.stack);
        seat.stack -= paid;
        if (seat.stack === 0 && seat.pendingChips === 0 && !seat.sittingOut) {
          seat.sittingOut = true;
          seat.sitOutReason = 'busted';
        }
        return paid;
      }
      const row = s.ledger[playerId];
      const gone = s.departures[playerId];
      if (!row || !gone) return 0;
      const paid = Math.min(amount, gone.stack, row.cashOut);
      row.cashOut -= paid;
      gone.stack -= paid;
      return paid;
    };
    const give = (seatNo: number, amount: number) => {
      const playerId = playerAt(seatNo);
      if (!playerId || amount <= 0) return;
      const seat = this.seatOf(playerId);
      if (seat) {
        seat.stack += amount;
        if (seat.sitOutReason === 'busted') {
          seat.sittingOut = false;
          seat.sitOutReason = null;
        }
      } else if (s.ledger[playerId]) {
        s.ledger[playerId].cashOut += amount;
        const gone = s.departures[playerId];
        if (gone) gone.stack += amount;
      }
    };
    let changed = false;
    for (const e of hand.events.slice(fromEvent)) {
      if (e.t !== 'transfer') continue;
      const paid = e.from === 'house' ? e.amount : take(e.from, e.amount);
      if (e.to !== 'house') give(e.to, paid);
      // The hand records what really moved, so its history matches the ledger.
      if (paid !== e.amount) {
        const short = e.amount - paid;
        for (const hs of hand.seats) {
          if (hs.seat === e.from) hs.stack += short;
          if (hs.seat === e.to) hs.stack -= short;
        }
        e.amount = paid;
      }
      changed = true;
    }
    // Store the hand again so its history has the claim.
    const record = s.history.find((r) => r.handNumber === hand.input.handNumber);
    if (changed && record) this.onHandFinished({ ...record, hand });
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

  /** The player turns their time bank on: it is added to their clock now and spent only past the normal time. */
  useTimeBank(playerId: PlayerId) {
    const hand = this.liveHandFor(playerId);
    const seat = this.seatOf(playerId)!;
    const turn = this.state.turn;
    if (!turn || hand.toAct !== seat.seat || turn.seat !== seat.seat) throw new ActionError('not your turn');
    if (turn.deadline === null) throw new ActionError('there is no clock at this table');
    if (turn.usingBank) return;
    if (seat.timeBank <= 0) throw new ActionError('your time bank is empty');
    turn.usingBank = true;
    turn.bankFrom = turn.deadline;
    turn.deadline += seat.timeBank * 1000;
    this.sync();
  }

  /** Anyone at the table may peek at the cards a hand that ended early would have dealt. Only they see them. */
  rabbitHunt(playerId: PlayerId) {
    const s = this.state;
    const hand = s.hand;
    if (!hand || hand.phase !== 'complete') throw new ActionError('you can rabbit hunt once the hand is over');
    if (!rabbitCards(hand, s.settings.play.rabbitHunt)) throw new ActionError('there are no cards to rabbit hunt');
    const r = s.rabbit && s.rabbit.handNumber === hand.input.handNumber ? s.rabbit : (s.rabbit = { handNumber: hand.input.handNumber, playerIds: [] });
    if (r.playerIds.includes(playerId)) return;
    r.playerIds.push(playerId);
    this.onChange();
  }

  /** The time bank pays for whatever time was used past the normal clock. */
  private spendBank(seat: SeatState) {
    const turn = this.state.turn;
    if (!turn || turn.seat !== seat.seat || !turn.usingBank || turn.bankFrom === null) return;
    // Acting before a bank turned on early has started costs nothing.
    const used = Math.max(0, Math.ceil((this.clock.now() - turn.bankFrom) / 1000));
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
    this.autoShowBounty(hand);
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
        this.ledgerEdit(seat.playerId, seat.pendingStack - seat.stack);
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
    if (!this.isTournament) this.settleSideGames(hand);
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

  /** 7-2 bounty with auto-show: turn up a winning 7-2 nobody saw, which pays the bounty before stacks are read. */
  private autoShowBounty(hand: HandState) {
    const active = hand.input.modifiers.find((m) => m.id === bounty72Schema.id);
    if (!active) return;
    const cfg = active.settings as ReturnType<typeof bounty72Schema.get>;
    if (!cfg.autoShow) return;
    for (const seat of sevenDeuceWinners(hand, cfg, false)) engine.show(hand, seat, [0, 1]);
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
    const planFor = (setup: HandSetup, bombPot: { amount: number } | null = null) =>
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
        bombPot,
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
    const sideGames = this.sideGames();
    let bombPot = false;
    if (!this.isTournament) {
      const cfg = bombPotSchema.get(s.settings);
      if (bombPotDue(cfg, { handsSince: sideGames.handsSinceBombPot, requested: sideGames.bombPotNext, rng: this.rng })) {
        const bomb = this.bombPotSetup(setup, cfg.gameId, cfg.betting);
        const bombPlan = bomb && planFor(bomb, { amount: cfg.bigBlinds * bomb.stakes.bigBlind });
        if (bomb && bombPlan && bombPlan.dealtIn.length >= 2 && bombPlan.dealtIn.length <= bomb.game.maxPlayers) {
          setup = bomb;
          plan = bombPlan;
          bombPot = true;
        } else if (sideGames.bombPotNext) {
          this.log("Couldn't deal a bomb pot: it needs a game with a flop and blinds");
        }
      }
    }

    // Players sitting out whom the blinds passed now owe them.
    // A bomb pot takes no blinds, so nobody misses one, and debts stay owed until a normal hand.
    // The blind positions still move on one seat, as after any hand.
    if (!this.isTournament && s.positions && !bombPot) {
      const sittingOut = s.seats.filter((x): x is SeatState => !!x && !plan.dealtIn.includes(x.seat) && !plan.waiting.includes(x.seat)).map((x) => x.seat);
      const passed = blindsPassed(plan, s.positions.bigBlind, sittingOut, maxSeats);
      for (const seat of passed.missedBig) s.seats[seat]!.missedBigBlind = true;
      for (const seat of passed.missedSmall) s.seats[seat]!.missedSmallBlind = true;
    }
    for (const seatNo of bombPot ? [] : plan.dealtIn) {
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
        bombPot,
        runItTwice: this.isTournament ? 'off' : s.settings.play.runItTwice,
        showdown: s.settings.play.revealAllAtShowdown ? 'show-all' : 'muck-losers',
        fixedLimitCap: s.settings.play.fixedLimitCap,
        uncappedHeadsUp: s.settings.play.uncappedHeadsUp,
        trimExcessBets: s.settings.play.trimExcessBets,
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
    s.handNames ??= {};
    for (const x of hand.seats) {
      const seat = s.seats[x.seat];
      if (seat?.playerId === x.playerId) s.handNames[x.playerId] = seat.name;
    }
    if (!this.isTournament) {
      sideGames.bombPotNext = false;
      sideGames.handsSinceBombPot = bombPot ? 0 : sideGames.handsSinceBombPot + 1;
      this.maybeStartNitRound(plan.dealtIn, setup.stakes.bigBlind);
    }
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

  /** The game a bomb pot is dealt in: the table's, or the bomb pot game. Null when it can't be a bomb pot. */
  private bombPotSetup(setup: HandSetup, gameId: string, betting: BettingKind): HandSetup | null {
    let next = setup;
    if (gameId) {
      try {
        next = { ...setup, game: variants.get(gameId).spec, betting };
      } catch {
        return null;
      }
    }
    if (next.game.family !== 'flop' || next.game.forcedBets !== 'blinds' || next.stakes.bigBlind < 1) return null;
    return next;
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
    this.upkeep();
    for (let guard = 0; guard < 20; guard++) {
      if (!this.step()) break;
    }
    // A hand that just ended may have freed seats.
    this.upkeep();
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

  /**
   * Cash table housekeeping between and around hands: frees the seats of
   * players offline too long, lets lapsed seat offers go, and holds each
   * free seat for the next waitlisted player who is online.
   */
  private upkeep() {
    if (this.isTournament) return;
    const s = this.state;
    const now = this.clock.now();
    const releaseMs = s.settings.seating.releaseOfflineSeatMinutes * 60_000;
    if (releaseMs > 0 && !s.paused) {
      for (const seat of s.seats) {
        if (!seat || seat.leaveAfterHand || this.isOnline(seat.playerId) || this.offlineFor(seat) < releaseMs) continue;
        this.log(`${seat.name} has been offline for ${s.settings.seating.releaseOfflineSeatMinutes} minutes, so their seat is released`);
        if (this.inHand(seat.playerId)) {
          seat.leaveAfterHand = true;
          seat.released = true;
        } else this.removeSeat(seat);
      }
    }
    if (!s.settings.seating.waitlist) {
      if (s.waitlist?.length) this.log('The waitlist is off; everyone waiting was taken off it');
      s.waitlist = [];
      s.offers = [];
      return;
    }
    for (const o of this.offers().filter((x) => x.expiresAt <= now)) {
      this.log(`${this.queueName(o.playerId)} didn't take seat ${o.seat + 1} in time and left the waitlist`);
      this.leaveQueue(o.playerId);
    }
    // Seats taken some other way (the host moved someone in) are no longer on offer.
    s.offers = this.offers().filter((o) => !s.seats[o.seat] && o.seat < s.seats.length);
    const open = this.openSeats();
    for (const entry of this.queue()) {
      if (!open.length) break;
      if (this.offers().some((o) => o.playerId === entry.playerId) || !this.isOnline(entry.playerId)) continue;
      const seat = open.shift()!;
      this.offers().push({ seat, playerId: entry.playerId, expiresAt: now + SEAT_OFFER_MS });
      this.log(`Seat ${seat + 1} is free: ${entry.name} is next on the waitlist`);
    }
  }

  /** When upkeep next has something to do: an offer running out, or an offline seat to release. */
  private upkeepDue(): number | null {
    if (this.isTournament) return null;
    const s = this.state;
    const times = this.offers().map((o) => o.expiresAt);
    const releaseMs = s.settings.seating.releaseOfflineSeatMinutes * 60_000;
    if (releaseMs > 0 && !s.paused) {
      const now = this.clock.now();
      for (const seat of s.seats) {
        if (seat && !seat.leaveAfterHand && !this.isOnline(seat.playerId)) times.push(now + releaseMs - this.offlineFor(seat));
      }
    }
    return times.length ? Math.min(...times) : null;
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
      // Charge only the bank time actually used (a bank turned on early may not have started).
      this.spendBank(seat);
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
    for (const key of TIMER_KEYS) this.clearTimer(key);
    const now = this.clock.now();
    const at = (key: TimerKey, when: number | null | undefined) => {
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
    // Seat offers run out even while the game is paused.
    at('upkeep', this.upkeepDue());
    if (s.paused) return;
    at('turn', this.turnDeadline());
    at('next', s.nextHandAt);
    at('rit', s.ritDeadline);
  }

  private clearTimer(key: TimerKey) {
    if (this.timers[key] !== null) this.clock.clearTimeout(this.timers[key]);
    this.timers[key] = null;
  }

  private log(text: string) {
    this.state.log.push({ at: this.clock.now(), text });
    if (this.state.log.length > LOG_LIMIT) this.state.log.splice(0, this.state.log.length - LOG_LIMIT);
  }
}

const TIMER_KEYS = ['turn', 'next', 'rit', 'upkeep'] as const;
type TimerKey = (typeof TIMER_KEYS)[number];

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
  const potList = engine.pots(hand);
  for (const hs of hand.seats) {
    startStacks[hs.playerId] = hs.startStack;
    const seat = seats?.[hs.seat];
    const end = seat && seat.playerId === hs.playerId ? seat.stack : hs.stack;
    endStacks[hs.playerId] = end;
    if (end > 0) continue;
    // Whoever won a pot the busted player was in knocked them out; a side pot they had no part in does not count.
    // A player who folded their last chips in had no pot to lose, so anyone who won counts.
    const awards = hand.awards.filter((a) => a.seat !== hs.seat);
    const theirs = awards.filter((a) => potList[a.pot]?.eligible.includes(hs.seat));
    const winners = new Set((theirs.length ? theirs : awards).map((a) => a.seat));
    knockedOutBy[hs.playerId] = hand.seats.filter((x) => winners.has(x.seat)).map((x) => x.playerId);
  }
  return { handNumber: record.handNumber, startStacks, endStacks, knockedOutBy, button: hand.input.button };
}

function cleanName(name: string) {
  const clean = cleanDisplayName(name, NAME_MAX);
  if (!clean) throw new ActionError('pick a name');
  return clean;
}

/**
 * Rabbit hunting: the board cards a flop game would have dealt after a hand
 * that ended early, one list per board (empty when it reached the river or
 * the setting is off). Deck order is fixed at the shuffle and nothing is
 * burned, so these are the real next cards.
 */
export function rabbitCards(hand: HandState, enabled: boolean): string[][] | null {
  if (!enabled || hand.phase !== 'complete' || hand.input.game.family !== 'flop' || hand.runs.length !== 1) return null;
  const perBoard = hand.input.game.streets.reduce((n, st) => n + st.dealBoard, 0);
  const missing = perBoard - hand.runs[0][0].length;
  if (missing <= 0) return null;
  const boards = hand.runs[0].map(() => [] as string[]);
  let pos = hand.deckPos;
  // Street by street, each board in turn, the way the hand would have dealt them.
  let have = hand.runs[0][0].length;
  for (const st of hand.input.game.streets) {
    if (!st.dealBoard) continue;
    if (have > 0) {
      have -= st.dealBoard;
      if (have >= 0) continue;
    }
    for (const b of boards) for (let i = 0; i < st.dealBoard; i++) b.push(hand.input.deck[pos++]);
  }
  if (pos > hand.input.deck.length) return null;
  return boards;
}

/** Longest mood, in UTF-16 units: room for one emoji with skin tone and joiners, not a sentence. */
const MOOD_MAX = 16;

/** A mood emoji from a client: emoji only (no letters or digits), short, or null to clear it. */
export function cleanMood(raw: unknown): string | null {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new ActionError('pick an emoji');
  const mood = raw.replace(/\p{Cs}/gu, '').trim();
  if (!mood) return null;
  // Keycaps (1️⃣, #️⃣) are the one place a digit belongs; joiners and variation selectors are the only invisible characters allowed.
  const rest = mood.replace(/[0-9#*]\uFE0F?\u20E3/gu, '🔢');
  const marks = (rest.match(/\p{M}/gu) ?? []).length;
  if (
    mood.length > MOOD_MAX ||
    !/\p{Extended_Pictographic}/u.test(rest) ||
    /[\p{L}\p{N}\p{Cc}\s]/u.test(rest) ||
    /\p{Cf}/u.test(rest.replace(/[\u200D\uFE0F]/g, '')) ||
    marks > 2
  )
    throw new ActionError('pick one emoji');
  return mood;
}
