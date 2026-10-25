import type { Card } from '../cards';
import { drawReplacements } from '../variants/draw';
import { classifyRaise, computeLegal, type BettingContext } from './betting';
import { computePots, uncalledBet } from './pots';
import { modifierRegistry, variants } from './registry';
import { oddChipOrder, settle } from './settle';
import {
  ActionError,
  type Action,
  type Chips,
  type DealtCard,
  type HandEvent,
  type HandInput,
  type HandSeat,
  type HandState,
  type LegalActions,
  type PlannedPost,
  type Pot,
  type SeatIndex,
} from './types';

/**
 * The hand state machine. Functions mutate the plain-JSON HandState in place
 * and append events; the runtime snapshots state and forwards events.
 */

type EventBody = HandEvent extends infer E ? (E extends { seq: number } ? Omit<E, 'seq'> : never) : never;

function emit(state: HandState, e: EventBody) {
  state.events.push({ seq: state.events.length, ...e } as HandEvent);
}

// ---------------------------------------------------------------- start

export function startHand(input: HandInput): HandState {
  const { spec } = variants.get(input.game.id);
  if (input.seats.length < 2) throw new ActionError('need at least two players');
  if (input.seats.length > spec.maxPlayers) throw new ActionError(`${spec.name} deals at most ${spec.maxPlayers} players`);
  checkDeckCapacity(input);

  const seats: HandSeat[] = [...input.seats]
    .sort((a, b) => a.seat - b.seat)
    .map((s) => ({
      seat: s.seat,
      playerId: s.playerId,
      startStack: s.stack,
      stack: s.stack,
      cards: [],
      away: s.away,
      folded: false,
      allIn: false,
      bet: 0,
      total: 0,
      hasActed: false,
      canRaise: true,
      lastAction: null,
      shown: [],
      ritVote: null,
    }));

  const state: HandState = {
    input,
    phase: 'betting',
    street: 0,
    seats,
    deckPos: 0,
    runs: [Array.from({ length: input.options.boards }, () => [])],
    muck: [],
    toAct: null,
    currentBet: 0,
    lastFullRaise: input.stakes.bigBlind,
    raisesThisRound: 0,
    runout: false,
    showdown: false,
    awards: [],
    events: [],
  };

  emit(state, {
    t: 'hand-start',
    handId: input.handId,
    handNumber: input.handNumber,
    gameId: input.game.id,
    betting: input.betting,
    stakes: input.stakes,
    button: input.button,
    buttonDead: input.buttonDead,
    seats: seats.map((s) => ({ seat: s.seat, playerId: s.playerId, stack: s.stack })),
    boards: input.options.boards,
    bombPot: input.options.bombPot,
  });

  for (const post of input.posts) postForced(state, post);
  state.currentBet = Math.max(0, ...state.seats.map((s) => s.bet));
  // A big blind all in for less still makes everyone else call the full blind.
  if (input.posts.some((p) => p.kind === 'big-blind')) state.currentBet = Math.max(state.currentBet, input.stakes.bigBlind);
  // A straddle acts as the opening bet: the next raise must be at least its size.
  state.lastFullRaise = Math.max(input.stakes.bigBlind, state.currentBet);

  dealStreet(state);
  if (input.options.bombPot) {
    // Bomb pot: everyone is in for the forced amount and the first betting round is skipped.
    endRound(state);
    return state;
  }
  beginBetting(state, true);
  return state;
}

function checkDeckCapacity(input: HandInput) {
  if (input.game.family === 'draw') return; // draws reshuffle the muck
  const players = input.seats.length;
  const streets = input.game.streets;
  let needed = 0;
  streets.forEach((st, i) => {
    // Stud's last card becomes one shared card if the deck runs short.
    const studShortcut = input.game.family === 'stud' && i === streets.length - 1;
    needed += studShortcut ? 1 : (st.dealDown + st.dealUp) * players + st.dealBoard * input.options.boards;
  });
  if (needed > input.deck.length) {
    throw new ActionError(`not enough cards: ${players} players need ${needed}`);
  }
}

function postForced(state: HandState, post: PlannedPost) {
  const s = seatAt(state, post.seat);
  if (!s) throw new ActionError(`post for seat ${post.seat} who is not dealt in`);
  const amount = Math.min(post.amount, s.stack);
  s.stack -= amount;
  s.total += amount;
  if (post.live) s.bet += amount;
  if (s.stack === 0) s.allIn = true;
  emit(state, { t: 'post', seat: s.seat, kind: post.kind, amount, live: post.live, allIn: s.allIn });
}

// ---------------------------------------------------------------- dealing

function drawCard(state: HandState): Card {
  if (state.deckPos >= state.input.deck.length) throw new ActionError('the deck ran out of cards');
  return state.input.deck[state.deckPos++];
}

/**
 * Draw games: replacements come off the stub; when it runs short, its last card
 * and the muck (not this player's discards) are reshuffled, deterministically
 * from the hand's seed so a replayed hand deals the same cards.
 */
function dealReplacements(state: HandState, thrown: Card[]): Card[] {
  let seed = (state.input.reshuffleSeed ^ (state.deckPos * 2654435761)) >>> 0 || 1;
  const rng = (n: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % n;
  };
  const { deck } = state.input;
  const result = drawReplacements({ discards: thrown, stub: deck.slice(state.deckPos), muck: state.muck, rng });
  state.input.deck = [...deck.slice(0, state.deckPos), ...result.cards, ...result.stub];
  state.deckPos += result.cards.length;
  state.muck = result.muck;
  return result.cards;
}

/** Draw games: a folded hand goes to the muck and can be reshuffled for later draws. */
function muckHand(state: HandState, s: HandSeat) {
  if (state.input.game.family === 'draw') state.muck.push(...s.cards.map((c) => c.card));
}

/** Seats from the first one clockwise after `from`, wrapping around. */
function clockwiseFrom(state: HandState, from: SeatIndex): HandSeat[] {
  const i = state.seats.findIndex((s) => s.seat > from);
  return i === -1 ? state.seats : [...state.seats.slice(i), ...state.seats.slice(0, i)];
}

function dealStreet(state: HandState) {
  const st = state.input.game.streets[state.street];
  const live = clockwiseFrom(state, state.input.button).filter((s) => !s.folded);
  const perPlayer = st.dealDown + st.dealUp;
  if (state.input.game.family === 'stud' && perPlayer * live.length > state.input.deck.length - state.deckPos) {
    // Not enough cards left for everyone: one shared card face up in the middle.
    if (perPlayer !== 1) throw new ActionError('the deck ran out of cards');
    const card = drawCard(state);
    state.runs[0][0].push(card);
    emit(state, { t: 'board', run: 0, board: 0, cards: [card] });
  } else if (perPlayer) {
    // One card at a time around the table, down cards before up cards.
    const pattern: boolean[] = [...Array(st.dealDown).fill(false), ...Array(st.dealUp).fill(true)];
    const dealt = new Map<SeatIndex, DealtCard[]>(live.map((s) => [s.seat, []]));
    for (const up of pattern) {
      for (const s of live) {
        const card = { card: drawCard(state), up };
        s.cards.push(card);
        dealt.get(s.seat)!.push(card);
      }
    }
    for (const s of live) emit(state, { t: 'deal', seat: s.seat, cards: dealt.get(s.seat)! });
  }
  if (st.dealBoard) {
    state.runs[0].forEach((board, b) => {
      const cards = Array.from({ length: st.dealBoard }, () => drawCard(state));
      board.push(...cards);
      emit(state, { t: 'board', run: 0, board: b, cards });
    });
  }
  if (state.street > 0 || st.dealBoard) emit(state, { t: 'street', street: state.street, name: st.name });
}

// ---------------------------------------------------------------- betting rounds

function seatAt(state: HandState, seat: SeatIndex): HandSeat | undefined {
  return state.seats.find((s) => s.seat === seat);
}

function live(state: HandState) {
  return state.seats.filter((s) => !s.folded);
}

function canStillAct(state: HandState) {
  return state.seats.filter((s) => !s.folded && !s.allIn);
}

function upCards(state: HandState): Record<SeatIndex, Card[]> {
  const out: Record<SeatIndex, Card[]> = {};
  for (const s of live(state)) out[s.seat] = s.cards.filter((c) => c.up).map((c) => c.card);
  return out;
}

/** Seat of the last live big blind or straddle post, which closes the first round. */
function lastBlindSeat(state: HandState): SeatIndex | null {
  let seat: SeatIndex | null = null;
  for (const p of state.input.posts) {
    if (p.live && (p.kind === 'big-blind' || p.kind === 'straddle')) seat = p.seat;
  }
  return seat;
}

function beginBetting(state: HandState, firstRound: boolean) {
  state.phase = 'betting';
  const { game } = state.input;
  const { rules } = variants.get(game.id);
  let first: SeatIndex | null = null;

  if (game.family === 'stud') {
    if (firstRound) {
      if (!rules.bringInSeat) throw new Error(`${game.id} has no bringInSeat rule`);
      first = rules.bringInSeat(game, upCards(state));
    } else {
      if (!rules.firstToActSeat) throw new Error(`${game.id} has no firstToActSeat rule`);
      const order = clockwiseFrom(state, state.input.button).filter((s) => !s.folded).map((s) => s.seat);
      first = rules.firstToActSeat(game, upCards(state), order);
    }
    // Starts at the chosen seat, or the next one with chips if it is all in from the ante.
    state.toAct = nextToAct(state, first, true);
  } else if (firstRound) {
    const closer = lastBlindSeat(state);
    state.toAct = nextToAct(state, closer ?? state.input.button, false);
  } else {
    state.toAct = nextToAct(state, state.input.button, false);
  }
  settleAutomatic(state);
}

/**
 * The next seat that still has to act this round, starting AFTER `from`
 * (or AT `from` when inclusive). Null when the round is over.
 */
function nextToAct(state: HandState, from: SeatIndex, inclusive: boolean): SeatIndex | null {
  if (live(state).length < 2) return null;
  const order = inclusive ? clockwiseFrom(state, from - 1) : clockwiseFrom(state, from);
  const actors = canStillAct(state);
  for (const s of order) {
    if (s.folded || s.allIn) continue;
    const facing = s.bet < state.currentBet;
    // A lone player with chips who isn't facing a bet has nobody left to bet against.
    if (actors.length === 1 && !facing) continue;
    if (!s.hasActed || facing) return s.seat;
  }
  return null;
}

/** Acts for away players and moves on when nobody can act. */
function settleAutomatic(state: HandState) {
  for (let guard = 0; guard < 100; guard++) {
    if (state.phase !== 'betting') return;
    if (state.toAct === null) {
      endRound(state);
      continue;
    }
    const s = seatAt(state, state.toAct)!;
    if (!s.away) return;
    applyAction(state, s, autoAction(legalActions(state, s.seat)!), true);
  }
}

function bringInContext(state: HandState) {
  const { game, stakes } = state.input;
  if (game.family !== 'stud' || state.street !== 0) return undefined;
  if (state.currentBet > stakes.bringIn) return undefined;
  return { amount: stakes.bringIn, completeTo: stakes.smallBet };
}

function bettingContext(state: HandState, s: HandSeat): BettingContext {
  const { input } = state;
  const st = input.game.streets[state.street];
  const potTotal = state.seats.reduce((sum, x) => sum + x.total, 0);
  return {
    betting: input.betting,
    stack: s.stack,
    bet: s.bet,
    currentBet: state.currentBet,
    lastFullRaise: state.lastFullRaise,
    raisesThisRound: state.raisesThisRound,
    bigBlind: input.stakes.bigBlind,
    potTotal,
    seatCanRaise: s.canRaise,
    fixed:
      input.betting === 'fixed-limit'
        ? {
            unit: st.betSize === 'big' ? input.stakes.bigBet : input.stakes.smallBet,
            cap: input.options.fixedLimitCap,
            uncapped: input.options.uncappedHeadsUp && live(state).length === 2,
          }
        : undefined,
    bringIn: bringInContext(state),
  };
}

export function legalActions(state: HandState, seat: SeatIndex): LegalActions | null {
  if (state.phase !== 'betting' || state.toAct !== seat) return null;
  const s = seatAt(state, seat)!;
  return computeLegal(bettingContext(state, s));
}

export function act(state: HandState, seat: SeatIndex, action: Action, opts: { auto?: boolean } = {}) {
  if (state.phase !== 'betting') throw new ActionError('no betting right now');
  if (state.toAct !== seat) throw new ActionError('not your turn');
  applyAction(state, seatAt(state, seat)!, action, !!opts.auto);
  settleAutomatic(state);
}

function commit(state: HandState, s: HandSeat, amount: Chips) {
  const chips = Math.min(amount, s.stack);
  s.stack -= chips;
  s.bet += chips;
  s.total += chips;
  if (s.stack === 0) s.allIn = true;
  return chips;
}

function applyAction(state: HandState, s: HandSeat, action: Action, auto: boolean) {
  const legal = computeLegal(bettingContext(state, s));
  const before = s.bet;
  let kind: Extract<HandEvent, { t: 'action' }>['action'];

  switch (action.type) {
    case 'fold':
      s.folded = true;
      s.lastAction = 'Fold';
      muckHand(state, s);
      kind = 'fold';
      break;
    case 'check':
      if (!legal.canCheck) throw new ActionError('cannot check');
      s.lastAction = 'Check';
      kind = 'check';
      break;
    case 'call':
      if (legal.canCheck) throw new ActionError('nothing to call');
      commit(state, s, legal.callAmount);
      s.lastAction = s.allIn ? 'All in' : 'Call';
      kind = 'call';
      break;
    case 'bring-in': {
      if (!legal.canBringIn) throw new ActionError('no bring-in now');
      commit(state, s, state.input.stakes.bringIn - s.bet);
      state.currentBet = Math.max(state.currentBet, s.bet);
      s.lastAction = s.allIn ? 'All in' : 'Bring-in';
      kind = 'bring-in';
      break;
    }
    case 'bet':
    case 'raise': {
      const to = Math.floor(action.to);
      if (!Number.isFinite(to)) throw new ActionError('invalid amount');
      if (!legal.canRaise) throw new ActionError('cannot raise');
      if (to > legal.maxTo) throw new ActionError(`at most ${legal.maxTo}`);
      if (to < legal.minTo) throw new ActionError(`at least ${legal.minTo}`);
      const ctx = bettingContext(state, s);
      const completing = !!ctx.bringIn && state.currentBet <= ctx.bringIn.amount;
      const { full, increment } = classifyRaise(ctx, to);
      commit(state, s, to - s.bet);
      if (full) {
        state.lastFullRaise = Math.max(increment, completing ? to : 0);
        for (const o of state.seats) {
          if (o !== s) {
            o.hasActed = false;
            o.canRaise = true;
          }
        }
      } else {
        // Incomplete all-in raise: players who already acted may only call or fold.
        for (const o of state.seats) {
          if (o !== s) {
            if (o.hasActed) o.canRaise = false;
            o.hasActed = false;
          }
        }
      }
      state.raisesThisRound++;
      state.currentBet = to;
      kind = completing ? 'complete' : legal.raiseKind;
      s.lastAction = s.allIn ? 'All in' : kind === 'bet' ? 'Bet' : kind === 'complete' ? 'Complete' : 'Raise';
      break;
    }
    default:
      throw new ActionError('unknown action');
  }
  s.hasActed = true;
  emit(state, { t: 'action', seat: s.seat, action: kind, amount: s.bet - before, to: s.bet, allIn: s.allIn, auto });

  if (live(state).length === 1) {
    finish(state);
    return;
  }
  state.toAct = nextToAct(state, s.seat, false);
}

/** What the engine does for a player who is away or out of time: check, post a stud bring-in, or fold. */
function autoAction(legal: LegalActions): Action {
  if (legal.canCheck) return { type: 'check' };
  if (legal.canBringIn) return { type: 'bring-in' };
  return { type: 'fold' };
}

export function timeout(state: HandState, seat: SeatIndex) {
  if (state.phase === 'drawing' && state.toAct === seat) {
    draw(state, seat, []);
    return;
  }
  const legal = legalActions(state, seat);
  if (!legal) return;
  act(state, seat, autoAction(legal), { auto: true });
}

export function foldOutOfTurn(state: HandState, seat: SeatIndex) {
  const s = seatAt(state, seat);
  if (!s || s.folded || state.phase === 'complete') return;
  if (state.toAct === seat && state.phase === 'betting') {
    act(state, seat, { type: 'fold' }, { auto: true });
    return;
  }
  s.folded = true;
  s.lastAction = 'Fold';
  muckHand(state, s);
  emit(state, { t: 'action', seat, action: 'fold', amount: 0, to: s.bet, allIn: false, auto: true });
  if (live(state).length === 1) {
    finish(state);
    return;
  }
  if (state.phase === 'drawing' && state.toAct === seat) {
    state.toAct = nextDrawer(state, seat);
    if (state.toAct === null) beginBetting(state, false);
    else if (seatAt(state, state.toAct)!.away) draw(state, state.toAct, []);
  }
  if (state.phase === 'rit-vote') resolveVotes(state);
}

// ---------------------------------------------------------------- round transitions

/** The unmatched part of the round's top bet goes back, unless its owner folded (a player who left: it stays in as dead money). */
function returnUncalled(state: HandState) {
  const back = uncalledBet(state.seats.map((s) => ({ seat: s.seat, bet: s.bet })));
  if (!back) return;
  const s = seatAt(state, back.seat)!;
  if (s.folded) return;
  s.bet -= back.amount;
  s.total -= back.amount;
  s.stack += back.amount;
  if (s.allIn && s.stack > 0) s.allIn = false;
  emit(state, { t: 'uncalled', seat: s.seat, amount: back.amount });
}

function endRound(state: HandState) {
  returnUncalled(state);
  if (live(state).length === 1) {
    finish(state);
    return;
  }
  for (const s of state.seats) {
    s.bet = 0;
    s.hasActed = false;
    s.canRaise = true;
    if (!s.folded && !s.allIn) s.lastAction = null;
  }
  state.currentBet = 0;
  state.raisesThisRound = 0;
  state.lastFullRaise = state.input.stakes.bigBlind;
  state.toAct = null;

  const lastStreet = state.street >= state.input.game.streets.length - 1;
  if (lastStreet) {
    finish(state);
    return;
  }
  // Nobody (or only one player) can bet any more: deal the rest without betting.
  // Draw games still play each draw, so they carry on street by street with no betting.
  if (canStillAct(state).length <= 1 && state.input.game.family === 'draw') state.runout = true;
  if (canStillAct(state).length <= 1 && state.input.game.family !== 'draw') {
    state.runout = true;
    // Hands go face up once nobody can bet.
    revealLive(state);
    const ritMode = state.input.options.runItTwice;
    const boardGame = state.input.game.family === 'flop';
    if (boardGame && ritMode !== 'off' && live(state).length >= 2 && cardsForSecondRun(state)) {
      if (ritMode === 'always') {
        runOut(state, 2);
        return;
      }
      state.phase = 'rit-vote';
      for (const s of live(state)) s.ritVote = null;
      emit(state, { t: 'rit-offer', seats: live(state).map((s) => s.seat) });
      // Away players decline automatically.
      for (const s of live(state)) if (s.away && state.phase === 'rit-vote') voteRunItTwice(state, s.seat, false);
      return;
    }
    runOut(state, 1);
    return;
  }
  state.street++;
  dealStreet(state);
  if (state.input.game.streets[state.street].drawMaxDiscard !== undefined) {
    beginDrawing(state);
    return;
  }
  beginBetting(state, false);
}

/** Whether the deck still holds enough cards to run the rest of the board twice. */
function cardsForSecondRun(state: HandState) {
  const streets = state.input.game.streets.slice(state.street + 1);
  const perRun = streets.reduce((n, st) => n + st.dealBoard, 0) * state.input.options.boards;
  return perRun > 0 && state.input.deck.length - state.deckPos >= perRun * 2;
}

/** Deals every remaining street with no betting, once or twice, then settles. */
function runOut(state: HandState, times: 1 | 2) {
  emit(state, { t: 'run-it', times });
  const firstUndealt = state.street + 1;
  const streets = state.input.game.streets;
  if (times === 2) {
    // The second run shares every card dealt so far and gets its own remaining cards.
    state.runs.push(state.runs[0].map((b) => [...b]));
  }
  for (let run = 0; run < times; run++) {
    for (let st = firstUndealt; st < streets.length; st++) {
      const n = streets[st].dealBoard;
      if (!n) continue;
      state.runs[run].forEach((board, b) => {
        const cards = Array.from({ length: n }, () => drawCard(state));
        board.push(...cards);
        emit(state, { t: 'board', run, board: b, cards });
      });
    }
  }
  // Stud cards for players still in come out too, face as dealt.
  if (state.input.game.family !== 'flop') {
    for (let st = firstUndealt; st < streets.length; st++) {
      state.street = st;
      dealStreet(state);
    }
  }
  state.street = streets.length - 1;
  finish(state);
}

export function voteRunItTwice(state: HandState, seat: SeatIndex, yes: boolean) {
  if (state.phase !== 'rit-vote') throw new ActionError('no run it twice vote now');
  const s = seatAt(state, seat);
  if (!s || s.folded) throw new ActionError('not in this hand');
  if (s.ritVote !== null) return;
  s.ritVote = yes;
  emit(state, { t: 'rit-vote', seat, yes });
  resolveVotes(state);
}

function resolveVotes(state: HandState) {
  const voters = live(state);
  if (voters.some((s) => s.ritVote === false)) runOut(state, 1);
  else if (voters.every((s) => s.ritVote === true)) runOut(state, 2);
}

// ---------------------------------------------------------------- draw games

function beginDrawing(state: HandState) {
  state.phase = 'drawing';
  state.toAct = nextDrawer(state, state.input.button);
  for (let guard = 0; guard < 20 && state.phase === 'drawing' && state.toAct !== null; guard++) {
    const s = seatAt(state, state.toAct)!;
    if (!s.away) return;
    draw(state, s.seat, []);
  }
}

function nextDrawer(state: HandState, after: SeatIndex): SeatIndex | null {
  const drawn = new Set(
    state.events
      .filter((e): e is Extract<HandEvent, { t: 'draw' }> => e.t === 'draw')
      .filter((e) => e.seq > lastStreetEventSeq(state))
      .map((e) => e.seat),
  );
  for (const s of clockwiseFrom(state, after)) if (!s.folded && !drawn.has(s.seat)) return s.seat;
  return null;
}

function lastStreetEventSeq(state: HandState) {
  for (let i = state.events.length - 1; i >= 0; i--) if (state.events[i].t === 'street') return state.events[i].seq;
  return -1;
}

export function draw(state: HandState, seat: SeatIndex, discard: number[]) {
  if (state.phase !== 'drawing') throw new ActionError('no draw right now');
  if (state.toAct !== seat) throw new ActionError('not your turn to draw');
  const s = seatAt(state, seat)!;
  const max = state.input.game.streets[state.street].drawMaxDiscard ?? 0;
  const unique = [...new Set(discard)].sort((a, b) => b - a);
  if (unique.length > max) throw new ActionError(`discard at most ${max}`);
  if (unique.some((i) => i < 0 || i >= s.cards.length)) throw new ActionError('no such card');
  const thrown = unique.map((i) => s.cards.splice(i, 1)[0].card);
  const fresh = dealReplacements(state, thrown).map((card) => ({ card, up: false }));
  s.cards.push(...fresh);
  s.lastAction = unique.length === 0 ? 'Stand pat' : `Draw ${unique.length}`;
  emit(state, { t: 'draw', seat, discarded: unique.length, cards: fresh.map((c) => c.card), positions: unique });
  state.toAct = nextDrawer(state, seat);
  if (state.toAct === null) {
    beginBetting(state, false);
    return;
  }
  const nextSeat = seatAt(state, state.toAct)!;
  if (nextSeat.away) draw(state, nextSeat.seat, []);
}

// ---------------------------------------------------------------- finishing

export function pots(state: HandState): Pot[] {
  // Dead blinds and big blind antes are paid for the table: they go to the main pot.
  const dead = new Map<SeatIndex, Chips>();
  for (const e of state.events) {
    if (e.t === 'post' && (e.kind === 'dead-small-blind' || e.kind === 'big-blind-ante')) dead.set(e.seat, (dead.get(e.seat) ?? 0) + e.amount);
  }
  return computePots(state.seats.map((s) => ({ seat: s.seat, total: s.total, folded: s.folded, dead: dead.get(s.seat) })));
}

function finish(state: HandState) {
  const { input } = state;
  const { spec, rules } = variants.get(input.game.id);
  state.toAct = null;
  // Return anything unmatched in the final round before building pots.
  returnUncalled(state);
  const contested = live(state).length > 1;
  state.showdown = contested;

  const active = input.modifiers.map((m) => ({ mod: modifierRegistry.get(m.id), settings: m.settings }));
  const potList = pots(state);
  const fees: number[] = potList.map((pot) =>
    active.reduce((sum, { mod, settings }) => sum + (mod?.potFee?.(pot, state, settings) ?? 0), 0),
  );

  const muckLosers = contested && input.options.showdown === 'muck-losers';
  // Every live hand is shown at showdown, unless losing hands may muck (decided once the awards are known).
  if (contested && !muckLosers) revealLive(state);

  const holeBySeat: Record<SeatIndex, Card[]> = {};
  for (const s of state.seats) holeBySeat[s.seat] = s.cards.map((c) => c.card);
  state.awards = settle({
    pots: potList,
    runs: state.runs,
    button: input.button,
    maxSeats: input.maxSeats,
    holeBySeat,
    spec,
    rules,
    fee: (_pot, i) => fees[i],
  });
  if (muckLosers) showInOrder(state, holeBySeat);
  const rake = fees.reduce((sum, f) => sum + f, 0);
  // Pot fees leave the table: recorded as a transfer to the house.
  if (rake > 0) emit(state, { t: 'transfer', kind: 'rake', from: 'house', to: 'house', amount: rake });
  for (const a of state.awards) {
    seatAt(state, a.seat)!.stack += a.amount;
    emit(state, {
      t: 'award',
      pot: a.pot,
      run: a.run,
      board: a.board,
      half: a.half,
      seat: a.seat,
      amount: a.amount,
      handName: a.handName,
      cards: a.cards,
    });
  }
  for (const s of state.seats) s.bet = 0;
  state.phase = 'complete';

  for (const { mod, settings } of active) {
    for (const t of mod?.afterSettle?.(state, settings) ?? []) {
      applyTransfer(state, t);
    }
  }
  emit(state, { t: 'hand-end', stacks: Object.fromEntries(state.seats.map((s) => [s.seat, s.stack])) });
}

/**
 * Showdown with mucking: the last aggressor of the final round shows first
 * (or, if it was checked through, the first live player after the button).
 * Going clockwise, a hand is shown if it is all in, wins a contested pot, or
 * beats or ties every hand shown so far on some board or half; the rest are
 * mucked unseen.
 */
function showInOrder(state: HandState, holeBySeat: Record<SeatIndex, Card[]>) {
  const { spec, rules } = variants.get(state.input.game.id);
  const contenders = live(state);
  let lastStreet = -1;
  for (const e of state.events) if (e.t === 'street') lastStreet = e.seq;
  let aggressor: SeatIndex | null = null;
  for (const e of state.events) {
    if (e.seq > lastStreet && e.t === 'action' && (e.action === 'bet' || e.action === 'raise' || e.action === 'complete')) aggressor = e.seat;
  }
  const first = aggressor !== null && contenders.some((s) => s.seat === aggressor) ? aggressor : null;
  const order = first !== null ? clockwiseFrom(state, first - 1).filter((s) => !s.folded) : clockwiseFrom(state, state.input.button).filter((s) => !s.folded);
  // Winners of a contested pot must show; a pot nobody else could win is handed over unseen.
  const potList = pots(state);
  const winners = new Set(state.awards.filter((a) => (potList[a.pot]?.eligible.length ?? 0) > 1).map((a) => a.seat));
  const runs = state.runs.length > 0 ? state.runs : [[[]]];
  const shown: SeatIndex[] = [];
  const beatsShown = (seat: SeatIndex) =>
    runs.some((run) =>
      run.some((board) => {
        const eligible = [...shown, seat];
        return rules.awardPortion(spec, 1000 * eligible.length, eligible, holeBySeat, board).some((a) => a.seat === seat && a.amount > 0);
      }),
    );
  for (const s of order) {
    const faceUp = s.cards.every((c, i) => c.up || s.shown.includes(i));
    // A player who is all in always shows, as in cardroom rules.
    if (shown.length === 0 || faceUp || s.allIn || winners.has(s.seat) || beatsShown(s.seat)) {
      shown.push(s.seat);
      revealSeat(state, s);
    } else {
      emit(state, { t: 'muck', seat: s.seat });
    }
  }
}

function revealSeat(state: HandState, s: HandSeat) {
  const fresh = s.cards.map((_, i) => i).filter((i) => !s.shown.includes(i) && !s.cards[i].up);
  if (!fresh.length) return;
  s.shown.push(...fresh);
  emit(state, { t: 'show', seat: s.seat, cards: fresh.map((i) => s.cards[i].card) });
}

/** Shows every card of every live hand that is not already face up. */
function revealLive(state: HandState) {
  for (const s of live(state)) {
    const fresh = s.cards.map((_, i) => i).filter((i) => !s.shown.includes(i) && !s.cards[i].up);
    if (!fresh.length) continue;
    s.shown.push(...fresh);
    emit(state, { t: 'show', seat: s.seat, cards: fresh.map((i) => s.cards[i].card) });
  }
}

function applyTransfer(state: HandState, t: Omit<Extract<HandEvent, { t: 'transfer' }>, 'seq'>) {
  if (t.from !== 'house') seatAt(state, t.from)!.stack -= t.amount;
  if (t.to !== 'house') seatAt(state, t.to)!.stack += t.amount;
  emit(state, { t: 'transfer', kind: t.kind, from: t.from, to: t.to, amount: t.amount });
}

/** After the hand: a player chooses to show some or all of their cards. */
export function show(state: HandState, seat: SeatIndex, cardIndexes: number[]) {
  if (state.phase !== 'complete') throw new ActionError('you can show after the hand');
  const s = seatAt(state, seat);
  if (!s) throw new ActionError('not in this hand');
  // Folded draw hands may have been reshuffled and dealt to someone else.
  if (s.folded && state.input.game.family === 'draw') throw new ActionError('folded cards went back into the deck');
  const fresh = [...new Set(cardIndexes)].filter((i) => i >= 0 && i < s.cards.length && !s.shown.includes(i));
  if (!fresh.length) return;
  s.shown.push(...fresh);
  emit(state, { t: 'show', seat, cards: fresh.map((i) => s.cards[i].card) });
  for (const m of state.input.modifiers) {
    const mod = modifierRegistry.get(m.id);
    for (const t of mod?.afterShow?.(state, m.settings, seat) ?? []) applyTransfer(state, t);
  }
}

/** Odd-chip order helper re-exported for the runtime and tests. */
export { oddChipOrder };
