import { engine, HIDDEN_CARD, variants, type HandState, type PlayerId, type Viewer } from '@rsdp/engine/core';
import { rakeSchema } from '@rsdp/engine/modifiers';
import type { FairRecordView, HandRecordView, HandView, SeatView, TableView } from '@rsdp/engine/wire';
import { cashHandStakes, fairRevealsAt, rabbitCards, type TableRuntime } from './table';
import type { HandRecord, PastHand, RuntimeState } from './types';
import { gameCode, gameTitle } from '@rsdp/engine/variants';
import { applyAtNextHand, IMMEDIATE_FIELDS, spectatorsSeeCards, type TableSettings } from '@rsdp/engine/settings';

const CHAT_SHOWN = 100;
const LOG_SHOWN = 60;

/** Everything one person at (or watching) a table may see. */
export function tableView(
  rt: TableRuntime,
  playerId: PlayerId,
  now: number,
  tournamentId: string | null = null,
  /** Everyone with the table open, seated or not. */
  audience: { playerId: PlayerId; name: string }[] = [],
  /** Each player's picture, as SeatView.avatar has it. */
  avatarOf: (playerId: PlayerId) => string | null = () => null,
  /** hideCards: a spectator's view without the hole cards spectators may see (a delayed feed's twin, see SpectatorFeed). */
  opts: { hideCards?: boolean } = {},
): TableView {
  const s = rt.state;
  const mySeat = rt.seatOf(playerId);
  const isHost = rt.isHost(playerId);
  const hand = s.hand;
  // The host keeps the live table whether seated or not; everyone else unseated is a spectator.
  const staff = rt.isStaff(playerId);
  const isSpectator = !mySeat && !staff;
  const blocked = isSpectator && !s.settings.spectators.allowed;
  // Only hands dealt since it was turned on: the cards of an earlier one, mucked ones included, stay hidden.
  const seeAll = spectatorsSeeCards(s.settings) && (!hand || hand.input.handNumber >= (s.seeAll?.since ?? 0));
  // Cards follow the player, not the chair: after a seat shuffle or move, or once someone new sits where a player of
  // the last hand sat, the hand still on the table shows each person only the cards they were dealt themselves.
  const myDealtSeat = hand?.seats.find((x) => x.playerId === playerId)?.seat ?? null;
  const viewer: Viewer = { seat: myDealtSeat, seeAll: isSpectator && seeAll && !opts.hideCards };
  const handSeats = new Map((hand?.seats ?? []).map((x) => [x.seat, x]));
  const won = new Map<number, number>();
  const handNames = new Map<number, string>();
  if (hand?.phase === 'complete') {
    for (const a of hand.awards) {
      won.set(a.seat, (won.get(a.seat) ?? 0) + a.amount);
      if (a.handName && !handNames.has(a.seat)) handNames.set(a.seat, a.handName);
    }
  }
  const live = !!hand && hand.phase !== 'complete';
  // While paused the clocks stand still: each one shows what resuming now would give.
  const shift = rt.pausedFor(now);
  const waiting = new Set<number>();
  if (live) for (const seat of s.seats) if (seat && !handSeats.has(seat.seat) && !seat.sittingOut && seat.stack > 0) waiting.add(seat.seat);

  const nitRound = s.sideGames?.nit ?? null;
  const rake = rakeSchema.get(s.settings);
  const seats: (SeatView | null)[] = s.seats.map((seat) => {
    if (!seat) return null;
    const hs = hand ? handSeats.get(seat.seat) : undefined;
    // A seat taken by someone new since the hand began has no part in it.
    const inThisHand = !!hs && hs.playerId === seat.playerId;
    const cards = inThisHand && !blocked ? hs!.cards.map((c, i) => visibleCard(hand!, viewer, seat.seat, c.card, c.up, hs!.shown.includes(i))) : [];
    return {
      seat: seat.seat,
      playerId: seat.playerId,
      name: seat.name,
      stack: inThisHand ? hs!.stack : seat.stack,
      sittingOut: seat.sittingOut,
      sitOutReason: seat.sitOutReason,
      online: rt.isOnline(seat.playerId),
      inHand: inThisHand,
      folded: inThisHand && hs!.folded,
      allIn: inThisHand && hs!.allIn && live,
      bet: inThisHand ? hs!.bet : 0,
      cards,
      lastAction: inThisHand ? hs!.lastAction : null,
      timeBank: seat.timeBank,
      leaving: seat.leaveAfterHand,
      owesBlinds: seat.missedBigBlind || seat.missedSmallBlind,
      waiting: waiting.has(seat.seat) || (seat.isNew && !inThisHand),
      waitForBigBlind: seat.waitForBigBlind,
      straddle: seat.straddle,
      nitOptIn: !!seat.nitOptIn,
      nit: nitRound?.participants.includes(seat.playerId) ? (nitRound.holders.includes(seat.playerId) ? 'holder' : 'clear') : null,
      won: inThisHand ? (won.get(seat.seat) ?? 0) : 0,
      handName: inThisHand ? (handNames.get(seat.seat) ?? null) : null,
      avatar: avatarOf(seat.playerId),
      mood: seat.mood ?? null,
      ...botTag(rt, seat.playerId),
    };
  });

  const myHandSeat = mySeat && hand ? handSeats.get(mySeat.seat) : undefined;
  const mine = myHandSeat && myHandSeat.playerId === playerId ? myHandSeat : undefined;
  const myTurn = live && !s.paused && !!mine && hand!.toAct === mine.seat;
  // Coach tips and the bots' reasons: the server decides (TableRuntime.soloPersonOf at the deal, and again at every
  // request), so all the browser does is show or hide the button. It stays on after the hand, until the next deal.
  const tips = !!hand && !!mine && s.coach?.handNumber === hand.input.handNumber && s.coach.person === playerId;
  const settings = s.settings;
  let upcoming: TableView['upcoming'] = null;
  if (!live && !rt.tournament) {
    try {
      const setup = previewSetup(rt);
      upcoming = setup;
    } catch {
      upcoming = null;
    }
  }
  // Mixed games: how many more hands of this game, and the next game (#373). A bad setting never breaks the view.
  let rotation: TableView['rotation'] = null;
  try {
    rotation = rt.rotationProgress();
  } catch {
    rotation = null;
  }

  return {
    id: s.id,
    name: settings.table.name,
    mode: settings.table.mode,
    tournamentId,
    hostId: s.hostId,
    isHost,
    realGame: !!s.realGame,
    powers: rt.powersOf(playerId),
    coHosts: (s.coHosts ?? []).map((c) => ({ ...c, powers: [...c.powers] })),
    me: { playerId, seat: mySeat?.seat ?? null, canSitIn: rt.canSitIn(playerId) },
    settings,
    pendingSettings: s.pendingSettings,
    started: s.started,
    paused: s.paused,
    stopAfterHand: s.stopAfterHand,
    recordsLocked: rt.recordsLocked(playerId),
    seats,
    hand: hand && !blocked ? handView(rt, hand, viewer, now) : null,
    legal: myTurn && hand!.phase === 'betting' ? engine.legalActions(hand!, mine!.seat) : null,
    canDraw: myTurn && hand!.phase === 'drawing' ? { max: hand!.input.game.streets[hand!.street].drawMaxDiscard ?? 0 } : null,
    canVoteRunItTwice: live && !s.paused && hand!.phase === 'rit-vote' && !!mine && !mine.folded && mine.ritVote === null,
    canShow: hand?.phase === 'complete' && mine ? showable(hand, mine.seat) : [],
    ...(tips ? { tips: true } : {}),
    turn: live && s.turn ? { seat: s.turn.seat, startedAt: s.turn.startedAt + shift, deadline: rt.turnDeadline(now), usingBank: s.turn.usingBank } : null,
    nextHandAt: s.nextHandAt,
    serverNow: now,
    bombPotNext: !!s.sideGames?.bombPotNext,
    choice: rt.tournament ? null : rt.choice.view(),
    rabbit: rabbitView(rt, playerId),
    nit: nitRound ? { prize: nitRound.prize, participants: nitRound.participants.length, holders: nitRound.holders.length } : null,
    rakeTotal: rake.enabled || s.sideGames?.rakeTotal ? (staff || rake.visibleTo === 'everyone' ? (s.sideGames?.rakeTotal ?? 0) : null) : null,
    upcoming,
    rotation,
    level: levelView(rt, now),
    // Besides their own, a player sees the requests of bots they added, so they can take them back.
    requests: (rt.can(playerId, 'approve') ? s.requests : s.requests.filter((r) => r.playerId === playerId || rt.botInfo(r.playerId)?.ownerId === playerId)).map((r) => {
      const bot = rt.botInfo(r.playerId);
      return { ...r, ...(bot ? { bot: { ownerId: bot.ownerId, ownerName: bot.ownerName, level: bot.level ?? 'normal' } } : {}) };
    }),
    // Bot rows are flagged: they play for nothing, so settle-up pays only between people.
    ledger: Object.values(s.ledger).map((row) => {
      const seat = rt.seatOf(row.playerId);
      const stack = seat ? seat.stack + seat.pendingChips : 0;
      return { ...row, stack, net: stack + row.cashOut - row.buyIn };
    }),
    chat: s.chat.slice(-CHAT_SHOWN),
    log: s.log.slice(-LOG_SHOWN),
    settingsLog: s.settingsLog.slice(-20).map((e) => ({ ...e, by: rt.nameOf(e.by) })),
    history: s.history.map((h) => ({ handNumber: h.handNumber, endedAt: h.endedAt, gameName: gameTitle(h.hand.input.game.id, h.hand.input.betting) })),
    watchers: audience.filter((a) => !rt.seatOf(a.playerId)),
    waitlist: (s.waitlist ?? []).map((w) => ({ playerId: w.playerId, name: w.name })),
    offers: (s.offers ?? []).map((o) => ({ ...o, name: s.waitlist?.find((w) => w.playerId === o.playerId)?.name ?? rt.nameOf(o.playerId) })),
    muted: [...(s.muted ?? [])],
    cardsWatched: spectatorsSeeCards(settings)
      ? {
          delaySeconds: settings.spectators.delaySeconds,
          at: s.seeAll?.at ?? 0,
          watchers: audience.filter((a) => !rt.seatOf(a.playerId) && !rt.isStaff(a.playerId)).length,
        }
      : null,
    spectator: isSpectator ? { delaySeconds: s.settings.spectators.delaySeconds, seeAll: viewer.seeAll, blocked } : null,
    fair: { nextCommit: rt.nextCommit(), handCommit: hand?.input.fair?.commit ?? null, openThrough: rt.fairOpenThrough() },
  };
}

/** The part of a spectator's view that runs behind the table. */
export type DelayedPart = Pick<
  TableView,
  | 'seats'
  | 'hand'
  | 'turn'
  | 'ledger'
  | 'history'
  | 'nextHandAt'
  | 'upcoming'
  | 'paused'
  | 'serverNow'
  | 'fair'
  | 'bombPotNext'
  | 'nit'
  | 'rakeTotal'
  | 'started'
  | 'stopAfterHand'
  | 'rotation'
  | 'choice'
  | 'settings'
  | 'pendingSettings'
  | 'level'
  | 'spectator'
  | 'log'
  | 'settingsLog'
  | 'realGame'
  | 'recordsLocked'
  | 'waitlist'
  | 'offers'
>;

/**
 * The ledger, hand list, next-hand countdown and fair-dealing commits run behind too, or they would give away
 * how (and when) a hand ends: a new commit shows up the moment the live hand finishes.
 */
export const delayedPart = (view: TableView): DelayedPart => ({
  seats: view.seats,
  hand: view.hand,
  turn: view.turn,
  ledger: view.ledger,
  history: view.history,
  nextHandAt: view.nextHandAt,
  upcoming: view.upcoming,
  paused: view.paused,
  serverNow: view.serverNow,
  fair: view.fair,
  // These change as the live hand ends or the next is dealt, so they would tell how it went too.
  bombPotNext: view.bombPotNext,
  nit: view.nit,
  rakeTotal: view.rakeTotal,
  started: view.started,
  stopAfterHand: view.stopAfterHand,
  // The count moves on as each hand is dealt, and with whoever leaves when the live hand ends.
  rotation: view.rotation ?? null,
  // Dealer's choice: a pick made as the live hand ends, or the table waiting for one, would tell it had ended.
  choice: view.choice,
  // A change the host makes during a hand waits for the next one, and a blind level counted in hands moves on as
  // each hand is dealt: seen live, either would tell the live hand had ended (#432).
  settings: view.settings,
  pendingSettings: view.pendingSettings,
  level: view.level,
  // "With every card face up" starts with the first hand dealt after it was turned on, which would mark the live deal.
  // The delay itself is the one this moment's hand is watched under (#435).
  spectator: view.spectator,
  // The table log as it was: "X left with 2350" would tell how the hand went, and with only the newest lines kept,
  // each new live line would push one off the top of a log cut by time (#435). So would the host's settings edits.
  log: view.log,
  settingsLog: view.settingsLog,
  // The first hand two people play makes the game real, which closes downloads while it runs; a game stopped after
  // the hand opens them as the live hand ends (#435).
  realGame: view.realGame,
  recordsLocked: view.recordsLocked,
  // A seat a player leaves as the live hand ends is offered from the waitlist at once (#452).
  waitlist: view.waitlist,
  offers: view.offers,
});

/**
 * The settings as they were, but with what changes at once, mid-hand too (IMMEDIATE_FIELDS: the table's name and
 * felt, chat, who may watch, seating), as it is now: those say nothing about how a hand went, and a spectator
 * should see chat turned off when it is.
 */
export function settingsBehind(past: TableSettings, live: TableSettings): TableSettings {
  if (past === live) return live;
  type Obj = Record<string, unknown>;
  const copy = (to: Obj, from: Obj, [key, ...rest]: string[]): Obj =>
    rest.length ? { ...to, [key]: copy((to[key] ?? {}) as Obj, (from[key] ?? {}) as Obj, rest) } : { ...to, [key]: from[key] };
  return IMMEDIATE_FIELDS.reduce((out, path) => copy(out, live as unknown as Obj, path.split('.')), past as unknown as Obj) as unknown as TableSettings;
}

/** What a spectator on a delay sees of the next hand's commit before anything is old enough to show. */
const NO_FAIR: TableView['fair'] = { nextCommit: '', handCommit: null, openThrough: 0 };
/** Spectators on a delay can't rabbit hunt: the button would show when the live hand ended (app.ts refuses it too). */
const NO_RABBIT: TableView['rabbit'] = { available: false, cards: null };

/** How far a snapshot's clocks move on: by the delay, but a paused snapshot's stand still, moving with the time shown. */
const moveBy = (live: TableView, part: DelayedPart, delayMs: number) => (part.paused ? live.serverNow - part.serverNow : delayMs);

/** A seat with nothing of a hand in it. */
const noHand = (x: SeatView): SeatView => ({ ...x, cards: [], bet: 0, inHand: false, folded: false, allIn: false, lastAction: null, won: 0, handName: null });

/** What app.ts knows about the viewer and the table that a view on its own doesn't say. */
export interface BehindOptions {
  /** Everyone with the table open, seated or not (the live view's watchers leave out whoever is seated now). */
  audience?: { playerId: PlayerId; name: string }[];
  /** The host and co-hosts, who watch live, so they aren't counted among those watching every card. */
  isStaff?: (playerId: PlayerId) => boolean;
  /** The viewer has never played here, so downloads stay closed to them while the game runs (recordsLocked). */
  neverPlayed?: boolean;
}

/**
 * What a spectator sees of the table's state from a snapshot: what changes as the live hand ends or the next is dealt.
 * The settings keep what changes at once as it is now.
 */
function stateThen(live: TableView, part: DelayedPart, delayMs: number, opts: BehindOptions) {
  const move = moveBy(live, part, delayMs);
  const me = live.me.playerId;
  // Whoever has the table open and isn't in a seat of the table shown: a player who leaves as the live hand ends, tab
  // still open, stays in their seat until the view gets there (#435).
  const seated = new Set(part.seats.flatMap((x) => (x ? [x.playerId] : [])));
  const audience = opts.audience ?? live.watchers;
  const watchers = audience.filter((a) => !seated.has(a.playerId));
  // My own place on the waitlist and my own offer are mine to act on, so they follow what I do: joining shows at once.
  // But a seat offered to me only shows once my view has the seat free (#452).
  const mineWaiting = live.waitlist.find((w) => w.playerId === me);
  const waitlist = part.waitlist.filter((w) => w.playerId !== me || mineWaiting);
  if (mineWaiting && !waitlist.some((w) => w.playerId === me)) waitlist.push(mineWaiting);
  const mineOffered = live.offers.find((o) => o.playerId === me);
  // Other people's offers as they were, their clocks moved on with the rest of the view.
  const offers = part.offers.filter((o) => o.playerId !== me).map((o) => ({ ...o, expiresAt: o.expiresAt + delayMs }));
  // Mine runs out on the live clock: a seat offered to someone on a delay waits the delay longer (#452).
  if (mineOffered && part.offers.some((o) => o.playerId === me && o.seat === mineOffered.seat)) offers.push(mineOffered);
  return {
    paused: part.paused,
    bombPotNext: part.bombPotNext,
    nit: part.nit,
    rakeTotal: part.rakeTotal,
    started: part.started,
    stopAfterHand: part.stopAfterHand,
    settings: settingsBehind(part.settings, live.settings),
    pendingSettings: part.pendingSettings,
    level: part.level && { ...part.level, endsAt: part.level.endsAt === null ? null : part.level.endsAt + move },
    // The delay is the one the hand shown is watched under, so the banner changes with the first hand dealt under a
    // new one; "with every card" starts with its hand too. Whether watching is blocked is as it is now.
    spectator: live.spectator && { ...live.spectator, delaySeconds: part.spectator?.delaySeconds ?? live.spectator.delaySeconds, seeAll: part.spectator?.seeAll ?? false },
    realGame: part.realGame,
    recordsLocked: part.recordsLocked && (opts.neverPlayed ?? true),
    watchers,
    // Whether spectators see every card, and since when, is as it is now: sitting down takes agreeing to it. The delay
    // is the one the next hand will be watched under, which is what someone sitting down agrees to, and moves only
    // when the host changes it, not at the live deal. The count is of those watching the table shown.
    cardsWatched: live.cardsWatched && {
      ...live.cardsWatched,
      delaySeconds: applyAtNextHand(live.settings, live.pendingSettings).settings.spectators.delaySeconds,
      watchers: watchers.filter((w) => !opts.isStaff?.(w.playerId)).length,
    },
    waitlist,
    offers,
  };
}

/**
 * A spectator's view with the table as it was: seats, cards, bets, the clock, the log and the table's state come
 * from `past`, the moment shown (see SpectatorFeed). Its clocks move forward by `delayMs`, how far behind it is shown
 * (the delay, or more while a longer delay takes over), so they count down in step with the live server clock. Chat
 * and everything else stay live.
 *
 * The seats are those of the moment shown, as many as it had, each player where they sat then: someone who sat down
 * since shows once the view gets to it, and a change to the number of seats, a seat move or a shuffle shows with the
 * hand it was made before (#435).
 *
 * `past` is null when nothing is that old yet. That happens for the first part of the delay at a new table or once a
 * delay is turned on, and after a restart. The table's state then comes from `oldest`, the oldest snapshot kept, if
 * there is one: it will be shown next, so nothing jumps back when it is. Its seats show no hand, with each player's
 * chips before the hand it is in (#435).
 */
export function behind(live: TableView, past: DelayedPart | null, delayMs: number, oldest: DelayedPart | null = null, opts: BehindOptions = {}): TableView {
  const blocked = !!live.spectator?.blocked;
  if (!past) {
    const from = oldest ?? delayedPart(live);
    // Chips in front of a player in the hand are theirs until it ends: the ledger has what they had before it.
    const before = new Map(from.ledger.map((r) => [r.playerId, r.stack]));
    const seats = from.seats.map((x) => x && { ...noHand(x), stack: x.inHand ? (before.get(x.playerId) ?? x.stack) : x.stack });
    const cutoff = live.serverNow - delayMs;
    const then = stateThen(live, from, delayMs, opts);
    return {
      ...live,
      ...then,
      seats,
      hand: null,
      turn: null,
      log: from.log.filter((l) => l.at <= cutoff),
      settingsLog: from.settingsLog.filter((e) => e.at <= cutoff),
      nextHandAt: null,
      upcoming: null,
      rotation: null,
      history: [],
      ledger: [],
      fair: NO_FAIR,
      rabbit: NO_RABBIT,
      choice: from.choice && { ...from.choice, open: false, deadline: null, next: null },
    };
  }
  const move = moveBy(live, past, delayMs);
  const later = (t: number | null) => (t === null ? null : t + move);
  const turn = past.turn && { ...past.turn, startedAt: past.turn.startedAt + move, deadline: later(past.turn.deadline) };
  // Watching turned off: the hand goes at once, as it does for the table live.
  const hand = blocked ? null : past.hand && { ...past.hand, runItTwice: { ...past.hand.runItTwice, deadline: later(past.hand.runItTwice.deadline) } };
  return {
    ...live,
    seats: blocked ? past.seats.map((x) => x && { ...x, cards: [] }) : past.seats,
    hand,
    turn,
    ...stateThen(live, past, delayMs, opts),
    log: past.log,
    settingsLog: past.settingsLog,
    ledger: past.ledger,
    history: past.history,
    nextHandAt: later(past.nextHandAt),
    upcoming: past.upcoming,
    fair: past.fair,
    choice: past.choice ? { ...past.choice, deadline: later(past.choice.deadline) } : (past.choice ?? null),
    rotation: past.rotation ?? null,
    rabbit: NO_RABBIT,
  };
}

/**
 * What a view shows, apart from when it was built: a spectator on a delay is sent a view only when this changes, or
 * the moment each update reached the live table would show (#435). A paused view's clocks are counted from its
 * serverNow, as the page counts them, since behind() moves them with the time shown.
 */
export function shownKey(view: TableView): string {
  const base = view.paused ? view.serverNow : 0;
  const at = (t: number | null | undefined) => (t === null || t === undefined ? (t ?? null) : t - base);
  return JSON.stringify({
    ...view,
    serverNow: 0,
    turn: view.turn && { ...view.turn, startedAt: at(view.turn.startedAt), deadline: at(view.turn.deadline) },
    hand: view.hand && { ...view.hand, runItTwice: { ...view.hand.runItTwice, deadline: at(view.hand.runItTwice.deadline) } },
    nextHandAt: at(view.nextHandAt),
    choice: view.choice && { ...view.choice, deadline: at(view.choice.deadline) },
    level: view.level && { ...view.level, endsAt: at(view.level.endsAt) },
  });
}

function botTag(rt: TableRuntime, playerId: PlayerId): Pick<SeatView, 'bot'> {
  const bot = rt.botInfo(playerId);
  return bot ? { bot: { ownerId: bot.ownerId, ownerName: bot.ownerName, look: bot.look ?? 0, level: bot.level ?? 'normal' } } : {};
}

function rabbitView(rt: TableRuntime, playerId: PlayerId): TableView['rabbit'] {
  const s = rt.state;
  const cards = s.hand ? rabbitCards(s.hand, s.settings.play.rabbitHunt) : null;
  if (!cards) return { available: false, cards: null };
  const asked = s.rabbit?.handNumber === s.hand!.input.handNumber && s.rabbit.playerIds.includes(playerId);
  return { available: true, cards: asked ? cards : null };
}

function visibleCard(hand: HandState, viewer: Viewer, seat: number, card: string, up: boolean, shown: boolean) {
  const visible = up || shown || viewer.seeAll || viewer.seat === seat;
  return { card: visible ? card : HIDDEN_CARD, up };
}

function showable(hand: HandState, seat: number) {
  const hs = hand.seats.find((x) => x.seat === seat);
  if (!hs) return [];
  if (hs.folded && hand.input.game.family === 'draw') return [];
  return hs.cards.map((_, i) => i).filter((i) => !hs.shown.includes(i) && !hs.cards[i].up);
}

function handView(rt: TableRuntime, hand: HandState, viewer: Viewer, now: number): HandView {
  const s = rt.state;
  const { input } = hand;
  const runItTwiceEvent = [...hand.events].reverse().find((e) => e.t === 'run-it');
  const offered = hand.events.some((e) => e.t === 'rit-offer');
  const street = input.game.streets[hand.street];
  return {
    handNumber: input.handNumber,
    ...(input.fair ? { fair: { commit: input.fair.commit, clientSeeds: input.fair.clientSeeds.map((c) => ({ ...c })) } } : {}),
    gameId: input.game.id,
    gameName: gameTitle(input.game.id, input.betting),
    shortName: gameCode(input.game.id, input.betting),
    family: input.game.family,
    betting: input.betting,
    stakes: input.stakes,
    names: Object.fromEntries(hand.seats.map((x) => [x.seat, rt.nameOf(x.playerId)])),
    phase: hand.phase,
    street: hand.street,
    streetName: street?.name ?? '',
    button: input.button,
    buttonDead: input.buttonDead,
    smallBlind: s.positions?.smallBlind ?? null,
    bigBlind: s.positions?.bigBlind ?? null,
    boards: hand.runs.map((run) => run.map((b) => [...b])),
    pots: engine.pots({ ...hand, seats: hand.seats.map((x) => ({ ...x, total: x.total - x.bet })) }),
    potTotal: hand.seats.reduce((a, x) => a + x.total, 0),
    toAct: hand.phase === 'complete' ? null : hand.toAct,
    currentBet: hand.currentBet,
    drawMax: hand.phase === 'drawing' ? (street?.drawMaxDiscard ?? null) : null,
    runItTwice: {
      offered,
      votes: Object.fromEntries(hand.seats.filter((x) => !x.folded).map((x) => [x.seat, x.ritVote])),
      deadline: rt.ritDeadlineShown(now),
      times: runItTwiceEvent && runItTwiceEvent.t === 'run-it' ? runItTwiceEvent.times : null,
    },
    showdown: hand.showdown,
    bombPot: input.options.bombPot,
    awards: hand.phase === 'complete' ? hand.awards : [],
    events: engine.visibleEvents(hand, viewer),
  };
}

/** Game and stakes of the next cash hand, without moving the blind schedule. */
function previewSetup(rt: TableRuntime): TableView['upcoming'] {
  const s = rt.state;
  // The host's change ends Dealer's choice with this hand (#423): the next hand is dealt with it applied, and a new
  // rotation starts at its first step, a new blind schedule at its first level (#444).
  const ending = rt.choice.ending() && !!s.pendingSettings;
  const settings = ending ? applyAtNextHand(s.settings, s.pendingSettings!).settings : s.settings;
  const rot = settings.game.rotation;
  const at = ending ? 0 : rt.previewRotationStep();
  // Dealer's choice: the game picked (or what a missed pick would deal).
  const step = rt.choice.upcoming() ?? (rot.enabled && rot.steps.length ? rot.steps[at % rot.steps.length] : null);
  const game = variants.get(step?.gameId ?? settings.game.gameId).spec;
  const level = ending && !s.settings.blindSchedule.enabled ? 0 : s.level.index;
  const stakes = cashHandStakes(settings, Math.min(level, settings.blindSchedule.levels.length - 1), game);
  const betting = step?.betting ?? settings.game.betting;
  return { gameId: game.id, gameName: gameTitle(game.id, betting), betting, stakes };
}

function levelView(rt: TableRuntime, now: number): TableView['level'] {
  const s = rt.state;
  const sched = s.settings.blindSchedule;
  if (!sched.enabled || !sched.levels.length) return null;
  const index = Math.min(s.level.index, sched.levels.length - 1);
  const level = sched.levels[index];
  const last = index === sched.levels.length - 1;
  if (sched.countdown === 'hands') return { index, count: sched.levels.length, endsAt: null, handsLeft: last ? null : Math.max(0, level.hands - s.level.hands) };
  const elapsed = s.level.elapsedMs + (s.level.runningSince !== null ? now - s.level.runningSince : 0);
  const endsAt = last || s.level.runningSince === null ? null : now + Math.max(0, level.minutes * 60_000 - elapsed);
  return { index, count: sched.levels.length, endsAt, handsLeft: null };
}

/** The parts of a finished hand that history keeps. */
export function pastHand(record: HandRecord): PastHand {
  const { hand } = record;
  return {
    handNumber: record.handNumber,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    gameName: gameTitle(hand.input.game.id, hand.input.betting),
    betting: hand.input.betting,
    stakes: hand.input.stakes,
    button: hand.input.button,
    seats: hand.seats.map((x) => ({ seat: x.seat, playerId: x.playerId, startStack: x.startStack })),
    events: hand.events,
    handId: hand.input.handId,
    fair: hand.input.fair,
    ...(record.coach ? { coach: { person: record.coach.person, notes: record.coach.notes.map((n) => ({ ...n })) } } : {}),
  };
}

/** A finished hand as one person may see it (their own cards, and whatever was shown). */
export function handRecordView(
  rt: TableRuntime,
  record: HandRecord | PastHand,
  playerId: PlayerId,
  /** asOf: the moment a spectator on a delay is shown, so a reveal time the live table has moved since doesn't show (#435). */
  opts: { hideMine?: boolean; notes?: boolean; asOf?: number } = {},
): HandRecordView {
  const past = 'hand' in record ? pastHand(record) : record;
  // hideMine: as someone who wasn't in the hand sees it, so only shown cards are face up.
  const seat = opts.hideMine ? null : (past.seats.find((x) => x.playerId === playerId)?.seat ?? null);
  // Why the bots played as they did, for the one person in the hand, and only where the caller asks: a caller that
  // doesn't (a share link, a full-log download) shows none.
  const notes = opts.notes && !opts.hideMine && past.coach?.person === playerId ? past.coach.notes : [];
  return {
    handNumber: past.handNumber,
    startedAt: past.startedAt,
    endedAt: past.endedAt,
    gameName: past.gameName,
    betting: past.betting,
    stakes: past.stakes,
    button: past.button,
    seats: past.seats.map((x) => {
      const bot = rt.botBadge(x.playerId);
      return { seat: x.seat, playerId: x.playerId, name: rt.nameOf(x.playerId), stack: x.startStack, ...(bot ? { bot } : {}) };
    }),
    // Only events matter for what a viewer may see; the rest of the hand state is not kept.
    events: engine.visibleEvents({ events: past.events } as HandState, { seat, seeAll: false }),
    // Hiding my cards would be undone by the seeds, which rebuild the whole deck.
    fair: opts.hideMine ? null : fairRecordView(past, rt.fairRevealsAt(past.handNumber, past.endedAt, opts.asOf), rt.now(), (id) => rt.nameOf(id)),
    ...(notes.length ? { botNotes: notes.map((n) => ({ ...n })) } : {}),
  };
}

function fairRecordView(past: PastHand, revealsAt: number, now: number, nameOf: (id: PlayerId) => string): FairRecordView | null {
  const { fair, handId } = past;
  if (!fair || !handId) return null;
  const revealed = now >= revealsAt;
  return {
    version: fair.version,
    handId,
    commit: fair.commit,
    clientSeeds: fair.clientSeeds.map((c) => ({ ...c, name: nameOf(c.playerId) })),
    serverSeed: revealed ? fair.serverSeed : null,
    handSeed: revealed ? fair.handSeed : null,
    revealsAt: revealed ? null : revealsAt,
    events: revealed ? past.events : null,
  };
}

/**
 * A saved hand as one player may see it, from the table's saved state rather
 * than a running table (hand search reads many tables). Names and bots come
 * from the snapshot. With `now`, the fairness record comes too (revealed as
 * the table would reveal it); a share link never carries it.
 */
export function savedHandView(
  state: Partial<Pick<RuntimeState, 'seats' | 'ledger' | 'handNames' | 'bots' | 'fair'>> | undefined,
  past: PastHand,
  playerId: PlayerId,
  opts: { hideMine?: boolean; now?: number } = {},
): HandRecordView {
  const nameOf = (id: PlayerId) => state?.seats?.find((x) => x?.playerId === id)?.name ?? state?.ledger?.[id]?.name ?? state?.handNames?.[id] ?? 'Guest';
  const botOf = (id: PlayerId) => {
    const bot = state?.bots?.[id];
    if (bot) return { ownerName: bot.ownerName, look: bot.look ?? 0 };
    // As TableRuntime.botBadge: the table's bots and the ledger rows bots keep for good (bots have had flagged rows
    // since they came), never the 'bot-' prefix, which a person's id may have too.
    const row = state?.ledger?.[id];
    return row?.bot ? { ownerName: row.owner ?? '', look: row.look ?? 0 } : null;
  };
  const seat = opts.hideMine ? null : (past.seats.find((x) => x.playerId === playerId)?.seat ?? null);
  return {
    handNumber: past.handNumber,
    startedAt: past.startedAt,
    endedAt: past.endedAt,
    gameName: past.gameName,
    betting: past.betting,
    stakes: past.stakes,
    button: past.button,
    seats: past.seats.map((x) => {
      const bot = botOf(x.playerId);
      return { seat: x.seat, playerId: x.playerId, name: nameOf(x.playerId), stack: x.startStack, ...(bot ? { bot } : {}) };
    }),
    events: engine.visibleEvents({ events: past.events } as HandState, { seat, seeAll: false }),
    fair:
      opts.now === undefined || opts.hideMine
        ? null
        : fairRecordView(past, fairRevealsAt(state?.fair, past.handNumber, past.endedAt), opts.now, nameOf),
  };
}
