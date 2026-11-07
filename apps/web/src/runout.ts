import { useEffect, useMemo, useState } from 'react';
import { HIDDEN_CARD, RUNOUT_SETTLE_MS, runoutMs, runoutSteps, runoutWaits, type HandEvent } from '@rsdp/engine/core';
import type { SeatView, TableView } from '@rsdp/engine/wire';
import { gameTitle, getVariant } from '@rsdp/engine/variants';
import { choiceOf, comingMenu, leavingMenu, missedPickIndex } from './components/settings/dealersChoice';

interface Reveal {
  handNumber: number;
  steps: number;
  /** The pause before each street (run it twice is slower; the last card of one run waits longest). */
  waits: number[];
  /** The table just before the runout (Frozen) comes from it. */
  before: Frozen;
}

/**
 * What the server changes as soon as the hand is over, kept as it was until
 * the result shows: the log (who won), seats (busted players sit out, leavers
 * go, tournaments knock players out), the ledger, a game rotation's count
 * (one player fewer is one hand fewer in an orbit) and Dealer's choice (a
 * busted chooser's PICK tag moves on).
 */
export interface Frozen {
  /** The newest log line before the runout. */
  logCut: number;
  seats: TableView['seats'];
  ledger: TableView['ledger'];
  me: TableView['me'];
  nit: TableView['nit'];
  rotation: TableView['rotation'];
  choice?: TableView['choice'];
  /** Whether `choice` is from this hand (false when the hand was dealt and run out in one update). */
  sameHand?: boolean;
  /** The waitlist's seat offers before the result: a newer one waits for it (see holdBack). */
  offers?: TableView['offers'];
  /**
   * Dealer's choice: the people counted, now and once the host's waiting change applies, in the newest view the
   * server sent before it had dealt the runout out itself (see heldChoice). Undefined until there is one.
   */
  shownBefore?: Counts;
}

interface Counts {
  count: number;
  coming: number;
}

/**
 * Dealer's choice: the counts in `view`, when the server sent it before its own time for dealing the runout out
 * (revealUntil on the server) was over. Until then the server's counts are the same whether or not anyone busted
 * (#448): the runout's players are still counted, and their seats taken. Later views can already show the result,
 * while this browser is still dealing it out. Null for those, and for views from a delayed spectator's past.
 */
function countsBeforeServerShown(view: TableView | null): Counts | null {
  const hand = view?.hand;
  const choice = view?.choice;
  if (!hand || !choice) return null;
  const ended = view.history.find((h) => h.handNumber === hand.handNumber)?.endedAt;
  if (ended === undefined || view.serverNow >= ended + runoutMs(hand.events)) return null;
  return { count: choice.count, coming: choice.comingCount ?? choice.count };
}

/**
 * All-in runouts arrive in one update, finished. This holds the table back
 * and deals them out a street at a time (board 1 before board 2), so each card
 * lands with its own sound, then shows the result. The server holds the next
 * hand for as long (runoutMs). Opening the table mid-runout shows it finished.
 */
export function useRunoutReveal(live: TableView | null): TableView | null {
  const [reveal, setReveal] = useState<Reveal | null>(null);
  // Kept apart from `reveal`, so a newer count doesn't restart the street being dealt.
  const [shownBefore, setShownBefore] = useState<Counts | undefined>(undefined);
  /** Steps shown so far; the count past the last is the settle beat. */
  const [shown, setShown] = useState(0);
  // Checked while rendering (not in an effect), so the finished board never flashes up first.
  const [before, setBefore] = useState(live);
  if (live !== before) {
    setBefore(live);
    const hand = live?.hand;
    if (reveal && reveal.handNumber !== hand?.handNumber) setReveal(null);
    const ranIt = (h: TableView['hand']) => !!h?.events.some((e) => e.t === 'run-it');
    const steps = hand ? runoutSteps(hand.events).length : 0;
    // A hand can also be dealt and run out in one go (a bomb pot with someone all in from the start).
    // The first view after opening the table has nothing to compare with, so it shows the runout finished.
    // Only straight after the hand before, so coming back from a dropped connection doesn't replay an old runout.
    const prior = before?.hand;
    const fresh = !!hand && !!prior && (prior.handNumber === hand.handNumber ? !ranIt(prior) : prior.handNumber === hand.handNumber - 1);
    if (hand && before && steps && fresh) {
      setReveal({
        handNumber: hand.handNumber,
        steps,
        waits: runoutWaits(hand.events),
        before: {
          logCut: before.log.at(-1)?.at ?? 0,
          seats: before.seats,
          ledger: before.ledger,
          me: before.me,
          nit: before.nit,
          rotation: before.rotation,
          choice: before.choice,
          sameHand: prior.handNumber === hand.handNumber,
          offers: before.offers,
        },
      });
      setShown(0);
      setShownBefore(countsBeforeServerShown(live) ?? undefined);
    } else if (reveal && reveal.handNumber === hand?.handNumber) {
      const counts = countsBeforeServerShown(live);
      if (counts && (counts.count !== shownBefore?.count || counts.coming !== shownBefore?.coming)) setShownBefore(counts);
    }
  }

  useEffect(() => {
    if (!reveal) return;
    if (shown > reveal.steps) return setReveal(null);
    const wait = shown === reveal.steps ? RUNOUT_SETTLE_MS : reveal.waits[shown];
    const t = setTimeout(() => setShown((n) => n + 1), wait);
    return () => clearTimeout(t);
  }, [reveal, shown]);

  return useMemo(
    () => (live && reveal && live.hand?.handNumber === reveal.handNumber ? holdBack(live, shownBefore ? { ...reveal.before, shownBefore } : reveal.before, shown) : live),
    [live, reveal, shown, shownBefore],
  );
}

/** The table as it was with only the first `shown` runout steps dealt. */
export function holdBack(view: TableView, before: Frozen, shown: number): TableView {
  const hand = view.hand!;
  const steps = runoutSteps(hand.events);
  const hidden = new Set(steps.slice(shown).flat().map((e) => e.seq));
  const boards = hand.boards.map((run, r) =>
    run.map((cards, b) => {
      // Every card a run still owes waits for its own step. A second run starts with the cards both runs share,
      // on the felt as soon as the board splits, so its first step deals only its own next card (#372).
      const owed = steps
        .slice(shown)
        .flat()
        .filter((e) => e.run === r && e.board === b)
        .reduce((n, e) => n + e.cards.length, 0);
      return cards.slice(0, cards.length - owed);
    }),
  );
  const runItEvent = hand.events.find((e) => e.t === 'run-it')!;
  const runIt = runItEvent.seq;
  // A single run waits longest before its last card: that card waits face down on its board (#308).
  const lastWait = runItEvent.t === 'run-it' && runItEvent.times === 1 && shown === steps.length - 1;
  const comingNext = lastWait ? steps[shown].map((e) => ({ run: e.run, board: e.board })) : undefined;
  const events = hand.events.filter((e) => e.seq <= runIt || (e.t === 'board' && !hidden.has(e.seq)));
  const won = hand.awards.reduce((s, a) => s + a.amount, 0);
  const pots = hand.pots.length ? hand.pots : [{ amount: won, eligible: [] }];
  return {
    ...view,
    hand: { ...hand, phase: 'betting', showdown: false, awards: [], boards, events, pots, potTotal: Math.max(hand.potTotal, won), ...(comingNext ? { comingNext } : {}) },
    seats: seatsDuring(view, before),
    ledger: before.ledger,
    // Knocked out or leaving: you stay in your seat, with the table turned your way, until the result.
    me: view.me.seat === null && before.me.playerId === view.me.playerId ? before.me : view.me,
    nit: before.nit,
    rotation: heldRotation(view, before),
    choice: heldChoice(view, before),
    // A seat offered from the waitlist since the result waits for it too (#437). It can be the seat of someone who busted
    // or left, or a seat a smaller Dealer's choice game had closed that a bust opens up; an offer that was already there
    // stays, unless it was let go meanwhile.
    ...(view.offers ? { offers: view.offers.filter((o) => (before.offers ?? []).some((b) => b.seat === o.seat && b.playerId === o.playerId)) } : {}),
    log: view.log.filter((l) => l.at <= before.logCut),
    history: view.history.filter((h) => h.handNumber !== hand.handNumber),
    canShow: [],
    nextHandAt: null,
    rabbit: { available: false, cards: null },
  };
}

/**
 * A game rotation's count during the reveal (#373), as it was before the result: one player fewer in the orbit is
 * one hand fewer, so the live count would tell who busted. A hand dealt and run out in one update has no count of its
 * own from before the result (the one before is the last hand's), so until the result the bar names the game and the
 * next one without a count. Neither depends on how the hand went.
 */
export function heldRotation(view: TableView, before: Frozen): TableView['rotation'] {
  if (before.sameHand !== false) return before.rotation;
  return view.rotation ? { ...view.rotation, handsLeft: null } : before.rotation;
}

/**
 * Dealer's choice during the reveal. The PICK tag stays where it was: once the server has the result it passes over
 * anyone who busted, so moving it would give the result away. A chooser in the all-in picks once the cards are out:
 * a busted chooser would be refused, and a pick in their place shows who busted, so their pick waits for the result
 * too. The pick clock only starts after the reveal, so nobody loses time. A chooser not in it picks as usual, but a
 * pick made in their place (they left or sat out) waits too: the server may have passed over someone who busted.
 *
 * The seat count, the seat limit and closed seats are held the same way (D33): a busted bot leaving lowers the count
 * and can reopen seats, and a pick made in place of a busted chooser can change the limit. They are worked out from
 * what the table held before the result: the count with nobody gone (newcomers count at once), and the limit of the
 * game being dealt, or of a pick that can show. Seats that close for a newcomer, or for a pick that shows, close.
 */
export function heldChoice(view: TableView, before: Frozen): TableView['choice'] {
  const live = view.choice;
  const was = before.choice;
  if (!live || !was) return live;
  const one = before.sameHand === false;
  const events = view.hand?.events ?? [];
  const dealt = events.find((e) => e.t === 'hand-start')?.seats ?? [];
  // A hand dealt and run out in one update, whose deal began a pick nobody had made yet: the chip moved on from the
  // seat that had it, to the next player round from it who could pick. The table only deals while the pick clock runs
  // once the pick is made or the time is up, and either moves the chip, even when the same game carries on again.
  const movedOn = one && was.chip !== null && !was.next && (was.deadline !== null || !samePick(live.current, was.current));
  const chip = movedOn ? nextPicker(was.chip!, before, dealt) : was.chip;
  const inHand = chip !== null && dealt.some((d) => d.seat === chip) && !events.some((e) => e.t === 'action' && e.seat === chip && e.action === 'fold');
  // Players leaving show only with the result. Newcomers show at once. Once the server has dealt the runout out
  // itself, it can give a busted player's seat to someone waiting before this browser has: the counts it sent just
  // before that (shownBefore) stay until the result shows here. The same goes for the count once the host's waiting
  // change applies (#459), which follows the server until then. The change may have applied since (the host saved
  // again once the hand was over): if the table is now bigger, it is counted as it was going to be, up to its seats.
  const sent = before.shownBefore;
  const coming = sent ? sent.coming : (was.comingCount ?? was.count);
  const applied = !view.pendingSettings && was.comingCount !== undefined && view.settings.table.maxSeats > before.seats.length && view.settings.seating.waitlist;
  const count = Math.max(was.count, live.count, sent?.count ?? 0, applied ? Math.min(coming, view.settings.table.maxSeats) : 0);
  const then = Math.max(coming, live.comingCount ?? live.count);
  // A pick that has come in since, for a chooser in the all-in, can only be someone picking in their place (or a
  // missed pick): it waits for the result, and so does the limit it sets. For a chooser not in it, a pick shows only
  // if they made it: anyone else's was made in their place (they left or sat out), and the server may have passed
  // over someone who busted to get to them.
  const fresh = one ? !!live.next : !samePick(live.next, was.next);
  // Theirs: picked from the seat with the tag, by the player who had it before the result and still has it. (Names
  // aren't unique. A server from before the pick's seat was sent leaves it out: the pick then waits, which is safe.)
  const theirs = !!live.next && chip !== null && live.next.seat === chip && !!before.seats[chip] && view.seats[chip]?.playerId === before.seats[chip]!.playerId;
  const held = inHand ? fresh : fresh && !!live.next && !theirs;
  const cap = !held ? live.cap : one ? capOf(live.current) : was.cap;
  // Closed: the held count fills the limit, or it was closed before the result for this same limit (a seat request,
  // which only the host sees, can close seats too), or the live table is closed for some other reason than the result:
  // the result only ever opens seats, unless a pick that waits closes them.
  const closed = (cap !== null && count >= cap) || (was.closed && cap === was.cap) || (!held && live.closed);
  if (held) {
    // The rest of the pick as it was before the pick came in. In one update, the deal may have begun a pick: that
    // much shows, as it doesn't depend on the result.
    if (one) return { ...live, chip, count, cap, closed, open: false, next: null };
    return { ...was, count, cap, closed, open: false };
  }
  if (!inHand) {
    // Their panel stays open only while the tag is still theirs (not, say, for someone who sat down in their seat).
    return { ...live, chip, count, cap, closed, open: live.open && live.chip === chip, ...fallbackFor(view, live, was, count, then) };
  }
  if (one) return { ...live, chip, count, cap, closed, open: false };
  return { ...was, count, cap, closed, open: false };
}

/** The seat limit a game sets while it is picked or played (the server's seatCap), or none without one. */
function capOf(game: Pick): number | null {
  return game ? getVariant(game.gameId).maxPlayers : null;
}

/**
 * What a missed pick deals, and whether "Keep playing" shows, for the held count: from the server's they would tell
 * a chooser looking at the panel that someone busted. As the server works them out (DealersChoice.defaultIndex,
 * canKeep and missedPick): a game the host's waiting change takes off the menu is neither kept nor dealt by a missed
 * pick, and while that change waits, the game a missed pick deals comes from the menu it brings (#444).
 */
/** The fallback for the held counts: `then` is the count once a waiting change applies (#459), held like `count`. */
function fallbackFor(view: TableView, live: NonNullable<TableView['choice']>, was: NonNullable<TableView['choice']>, count: number, then: number) {
  // The live fallback goes through only when both held counts are the live ones.
  if (count === live.count && then === (live.comingCount ?? live.count)) return {};
  const cur = live.current;
  if (!cur) return { defaultIndex: was.defaultIndex, canKeep: was.canKeep, fallback: was.fallback };
  const menu = choiceOf(view.settings).games;
  const pending = view.pendingSettings ?? null;
  const leaving = leavingMenu(view.settings, pending);
  const defaultIndex = missedPickIndex(menu, cur, count, leaving);
  const canKeep = menu.some((g) => g.gameId === cur.gameId && g.betting === cur.betting && getVariant(g.gameId).maxPlayers >= count && !leaving(g));
  const coming = comingMenu(view.settings, pending);
  const g = coming ? coming[missedPickIndex(coming, cur, then)] : menu[defaultIndex];
  return { defaultIndex, canKeep, ...(g ? { fallback: { gameId: g.gameId, betting: g.betting, gameName: gameTitle(g.gameId, g.betting) } } : {}) };
}

type Pick = NonNullable<TableView['choice']>['current'];
const samePick = (a: Pick, b: Pick) => a === b || (!!a && !!b && a.gameId === b.gameId && a.betting === b.betting && a.by === b.by && a.how === b.how);

/** The next player round from `seat` who could pick before the result: dealt in, or seated and not sitting out. */
function nextPicker(seat: number, before: Frozen, dealt: { seat: number }[]): number | null {
  const n = before.seats.length;
  for (let i = 1; i <= n; i++) {
    const at = (seat + i) % n;
    if (dealt.some((d) => d.seat === at) || (before.seats[at] && !before.seats[at]!.sittingOut)) return at;
  }
  return null;
}

/** Seats as they stand with everything in the middle and nothing paid out yet. */
function seatsDuring(view: TableView, before: Frozen): TableView['seats'] {
  const events = view.hand!.events;
  const dealt = events.find((e) => e.t === 'hand-start')?.seats ?? [];
  const paid = new Map<number, number>();
  const pay = (seat: number, n: number) => paid.set(seat, (paid.get(seat) ?? 0) + n);
  for (const e of events) {
    if (e.t === 'post' || e.t === 'action') pay(e.seat, e.amount);
    else if (e.t === 'uncalled') pay(e.seat, -e.amount);
  }
  return view.seats.map((live, i) => {
    const was = before.seats[i] ?? null;
    const start = dealt.find((d) => d.seat === i);
    // Someone dealt in who has since gone (left after the hand, knocked out) is still at the table until the result.
    const gone = !!start && live?.playerId !== start.playerId && was?.playerId === start.playerId;
    const s = gone ? { ...was!, cards: withShown(was!.cards, events, i) } : live;
    if (!s) return s;
    const stack = start?.playerId === s.playerId ? start.stack - (paid.get(i) ?? 0) : s.stack - s.won;
    // Sitting out for being busted, leaving, coming off the nit and the like are the result too.
    // Players not in the hand change as they like.
    const prior = start?.playerId === s.playerId && was?.playerId === s.playerId ? was : s;
    return {
      ...s,
      stack,
      won: 0,
      handName: null,
      allIn: s.inHand && !s.folded && stack === 0,
      sittingOut: prior.sittingOut,
      sitOutReason: prior.sitOutReason,
      leaving: prior.leaving,
      waiting: prior.waiting,
      nit: prior.nit,
    };
  });
}

/**
 * A seat's cards with those its player showed in the hand turned up. The table before the hand ended had them face
 * down; a player who has gone since (knocked out, left) has no seat in the finished table to show them (#308).
 */
export function withShown(cards: SeatView['cards'], events: readonly HandEvent[], seat: number): SeatView['cards'] {
  const shown = events.flatMap((e) => (e.t === 'show' && e.seat === seat ? e.cards : []));
  return cards.map((c) => (c.card === HIDDEN_CARD && !c.up && shown.length ? { ...c, card: shown.shift()! } : c));
}

/**
 * The table as it is shown (an all-in runout dealt a street at a time, a player knocked out kept in their seat), and
 * whether a runout is still being dealt. Only that holds back what waits for the result (following a move to another
 * table, the tournament strip, a reload into a new build). A knocked-out player kept in their seat is only for show:
 * at a table that breaks after that hand no next deal ever comes to clear it, and the players moved off it must still
 * go to their new seats.
 */
export function useShownTable(live: TableView | null): { view: TableView | null; runningOut: boolean } {
  const revealed = useRunoutReveal(live);
  const view = useDepartures(revealed);
  return { view, runningOut: revealed !== live };
}

/**
 * Hands as the table on screen has them: none newer than its own hand list. While an all-in runout is still being
 * dealt here, the server already counts that hand as finished and sends it, result and all, to anyone who asks; the
 * table shown leaves it out of its history until the result shows (holdBack). Same list back when nothing is cut.
 */
export function finishedOnScreen<H extends { handNumber: number }>(hands: H[] | null, view: { history: readonly { handNumber: number }[] }): H[] | null {
  if (!hands) return hands;
  const upTo = view.history.reduce((n, h) => Math.max(n, h.handNumber), 0);
  return hands.every((h) => h.handNumber <= upTo) ? hands : hands.filter((h) => h.handNumber <= upTo);
}

/** Who went out in the hand being shown, kept in their seats until the next deal. */
interface Departures {
  handNumber: number;
  seats: Map<number, SeatView>;
  fading: boolean;
}

/** How long before the next deal a departed player's seat fades out. */
export const DEPART_FADE_MS = 1000;

/**
 * A player who busts out of a tournament is gone from the server's table the moment the hand ends.
 * Taking them away just as the result shows felt abrupt (#308), so the table keeps them in their seat, cards up,
 * marked as out, through the result, and fades them just before the next deal. Display only: the seat is free
 * on the server, and anyone who sits in it takes it at once.
 */
export function useDepartures(view: TableView | null): TableView | null {
  const [kept, setKept] = useState<Departures | null>(null);
  const [before, setBefore] = useState(view);
  if (view !== before) {
    setBefore(view);
    const next = departures(before, view, kept);
    if (next !== kept) setKept(next);
  }

  // Fade out a little before the next deal (or after a while if no deal is coming).
  const nextAt = view?.nextHandAt ?? null;
  const serverNow = view?.serverNow ?? 0;
  useEffect(() => {
    if (!kept || kept.fading || kept.seats.size === 0) return;
    const wait = nextAt === null ? 8000 : Math.max(1500, nextAt - serverNow - DEPART_FADE_MS);
    const t = setTimeout(() => setKept((k) => (k && k.handNumber === kept.handNumber ? { ...k, fading: true } : k)), wait);
    return () => clearTimeout(t);
  }, [kept, nextAt, serverNow]);

  return useMemo(() => {
    if (!view || !kept || view.hand?.handNumber !== kept.handNumber) return view;
    let changed = false;
    const seats = view.seats.map((s, i) => {
      const gone = kept.seats.get(i);
      if (s || !gone) return s;
      changed = true;
      return kept.fading ? { ...gone, departed: 'fading' as const } : gone;
    });
    return changed ? { ...view, seats } : view;
  }, [view, kept]);
}

/** Who to keep at the table after `view` arrives, `before` being the table as last shown. */
export function departures(before: TableView | null, view: TableView | null, kept: Departures | null): Departures | null {
  const hand = view?.hand;
  if (!hand || view!.mode !== 'tournament') return null;
  let out = kept && kept.handNumber === hand.handNumber ? kept : null;
  const prior = before?.hand;
  if (hand.phase !== 'complete' || !prior || prior.handNumber !== hand.handNumber) return out;
  const dealt = hand.events.find((e) => e.t === 'hand-start')?.seats ?? [];
  const end = [...hand.events].reverse().find((e) => e.t === 'hand-end');
  for (const d of dealt) {
    const was = before!.seats[d.seat];
    if (view!.seats[d.seat] || !was || was.playerId !== d.playerId || out?.seats.has(d.seat)) continue;
    // Only a bust: a player moved to another table, or who quit, just goes.
    const stack = end && end.t === 'hand-end' ? end.stacks[d.seat] : undefined;
    if (stack !== 0 || was.folded) continue;
    const gone: SeatView = {
      ...was,
      cards: withShown(was.cards, hand.events, d.seat),
      stack: 0,
      bet: 0,
      won: 0,
      allIn: false,
      lastAction: null,
      handName: null,
      leaving: false,
      departed: 'out',
    };
    out = { handNumber: hand.handNumber, seats: new Map(out?.seats ?? []).set(d.seat, gone), fading: out?.fading ?? false };
  }
  return out;
}

/**
 * How many of a run's first cards on a board it shares with the first run: the cards dealt before the hand was run
 * twice. The second run shows them from the moment the board splits, carried down from the first run's board rather
 * than dealt again; only its own cards are dealt (#372). Cards are unique in the deck, so the shared cards are
 * exactly the two boards' common start.
 */
export function sharedWithFirstRun(runs: readonly (readonly (readonly string[])[])[], run: number, board: number): number {
  if (run === 0) return 0;
  const first = runs[0]?.[board] ?? [];
  const cards = runs[run]?.[board] ?? [];
  let n = 0;
  while (n < cards.length && n < first.length && cards[n] === first[n]) n++;
  return n;
}
