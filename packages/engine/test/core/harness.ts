import { freshDeck, type Card } from '../../src/cards';
import { engine, planForcedBets, variants, type HandInput, type HandOptions, type HandState, type PlannerSeat, type Stakes } from '../../src/core';
import { registerAllVariants } from '../../src/variants';

registerAllVariants(variants);

export const STAKES: Stakes = { smallBlind: 1, bigBlind: 2, ante: 0, anteType: 'none', bringIn: 1, smallBet: 2, bigBet: 4 };

export interface Setup {
  game?: string;
  /** Betting structure from the start of the hand; the game's own when left out. */
  betting?: HandInput['betting'];
  /** Stack per seat; seats are 0..n-1 unless `seatNumbers` says otherwise. */
  stacks: number[];
  seatNumbers?: number[];
  button?: number;
  stakes?: Partial<Stakes>;
  options?: Partial<HandOptions>;
  straddles?: 'off' | 'utg' | 'utg-and-button';
  straddlers?: number[];
  bombPot?: number;
  away?: number[];
  /** Cards dealt in order from the top of the deck; the rest follow in a fixed order. */
  top?: Card[];
  modifiers?: HandInput['modifiers'];
  maxSeats?: number;
}

/** Builds a deck that deals `top` first, then every other card in a fixed order. */
export function deckWith(top: Card[]): Card[] {
  const used = new Set(top);
  if (used.size !== top.length) throw new Error('duplicate card in test deck');
  return [...top, ...freshDeck().filter((c) => !used.has(c))];
}

export function start(setup: Setup): HandState {
  const spec = variants.get(setup.game ?? 'nlhe').spec;
  const stakes = { ...STAKES, ...setup.stakes };
  const seatNumbers = setup.seatNumbers ?? setup.stacks.map((_, i) => i);
  const maxSeats = setup.maxSeats ?? 10;
  const planner: PlannerSeat[] = seatNumbers.map((seat, i) => ({
    seat,
    playerId: `p${seat}`,
    stack: setup.stacks[i],
    isNew: false,
    missedSmallBlind: false,
    missedBigBlind: false,
    waitForBigBlind: false,
    straddle: !!setup.straddlers?.includes(seat),
  }));
  const plan = planForcedBets({
    game: spec,
    stakes,
    maxSeats,
    seats: planner,
    lastBigBlindSeat: null,
    // The first hand puts the button on the first seat at or after lastButton (+1 handled by the planner).
    lastButton: setup.button ?? seatNumbers[0],
    mode: 'cash',
    straddles: setup.straddles ?? 'off',
    bombPot: setup.bombPot ? { amount: setup.bombPot } : null,
  });
  const input: HandInput = {
    handId: 'h1',
    handNumber: 1,
    game: spec,
    betting: setup.betting ?? spec.defaultBetting,
    stakes,
    maxSeats,
    seats: planner.map((p) => ({ seat: p.seat, playerId: p.playerId, stack: p.stack, away: !!setup.away?.includes(p.seat) })),
    button: plan.button,
    buttonDead: plan.buttonDead,
    posts: plan.posts,
    deck: deckWith(setup.top ?? []),
    reshuffleSeed: 12345,
    options: { boards: 1, bombPot: !!setup.bombPot, runItTwice: 'off', fixedLimitCap: 4, uncappedHeadsUp: true, ...setup.options },
    modifiers: setup.modifiers ?? [],
  };
  return engine.startHand(input);
}

/**
 * Hold'em top-of-deck for the given hole cards (by seat, in seat order) and
 * board. Cards go one at a time clockwise from the seat after the button.
 */
export function holdemTop(holes: Record<number, [Card, Card]>, board: Card[], button: number): Card[] {
  const seats = Object.keys(holes).map(Number).sort((a, b) => a - b);
  const order = [...seats.filter((s) => s > button), ...seats.filter((s) => s <= button)];
  const top: Card[] = [];
  for (let round = 0; round < 2; round++) for (const s of order) top.push(holes[s][round]);
  return [...top, ...board];
}

export const stacks = (state: HandState) => Object.fromEntries(state.seats.map((s) => [s.seat, s.stack]));
export const chipsInPlay = (state: HandState) => state.seats.reduce((sum, s) => sum + s.stack + s.total, 0);
export const startTotal = (state: HandState) => state.seats.reduce((sum, s) => sum + s.startStack, 0);
export const eventsOf = <T extends HandState['events'][number]['t']>(state: HandState, t: T) =>
  state.events.filter((e): e is Extract<HandState['events'][number], { t: T }> => e.t === t);
