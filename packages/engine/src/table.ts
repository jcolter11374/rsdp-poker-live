import { Card, Rng, cryptoRng, freshDeck, shuffle } from './cards';
import { evaluate } from './evaluator';

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'complete';

export interface TableConfig {
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
}

export interface Seat {
  playerId: string;
  name: string;
  stack: number;
  /** Sitting out players keep their seat but are not dealt in. */
  sittingOut: boolean;
  /** Set when the player asks to leave mid-hand; the seat frees at hand end. */
  leaving: boolean;
}

export interface HandPlayer {
  seat: number;
  playerId: string;
  cards: Card[];
  /** Chips put in on the current street. */
  bet: number;
  /** Chips put in over the whole hand. */
  total: number;
  folded: boolean;
  allIn: boolean;
  hasActed: boolean;
  /** False after an incomplete all-in raise that does not reopen betting for this player. */
  canRaise: boolean;
  /** Short label of the player's latest action on this street, for display. */
  lastAction: string | null;
}

export interface PotResult {
  amount: number;
  winners: { seat: number; playerId: string; amount: number; handName?: string; bestCards?: Card[] }[];
}

export interface Hand {
  number: number;
  button: number;
  sbSeat: number;
  bbSeat: number;
  deck: Card[];
  board: Card[];
  street: Street;
  players: HandPlayer[];
  /** Seat whose turn it is, or null when nobody can act. */
  toAct: number | null;
  currentBet: number;
  /** Size of the last full bet or raise on this street. */
  minRaise: number;
  /** True when the hand reached showdown and live hands are revealed. */
  showdown: boolean;
  results: PotResult[];
}

export type Action =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  /** Bet or raise to `amount` total chips on this street. */
  | { type: 'raise'; amount: number };

export interface LegalActions {
  canCheck: boolean;
  callAmount: number;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
}

export class ActionError extends Error {}

export class PokerTable {
  config: TableConfig;
  seats: (Seat | null)[];
  button: number | null = null;
  hand: Hand | null = null;
  handCount = 0;
  log: string[] = [];
  private rng: Rng;

  constructor(config: TableConfig, rng: Rng = cryptoRng) {
    this.config = { ...config };
    this.seats = Array.from({ length: config.maxSeats }, () => null);
    this.rng = rng;
  }

  // ---------------------------------------------------------------- seating

  sit(seat: number, playerId: string, name: string, stack: number): void {
    if (seat < 0 || seat >= this.seats.length) throw new ActionError('no such seat');
    if (this.seats[seat]) throw new ActionError('seat taken');
    if (this.seatOf(playerId) !== -1) throw new ActionError('already seated');
    if (stack <= 0) throw new ActionError('stack must be positive');
    this.seats[seat] = { playerId, name, stack, sittingOut: false, leaving: false };
    this.note(`${name} sat in seat ${seat + 1} with ${stack}`);
  }

  /** Leaves the table. A player in a live hand folds and frees the seat when it ends. */
  stand(playerId: string): void {
    const seat = this.seatOf(playerId);
    if (seat === -1) return;
    const hp = this.handPlayer(playerId);
    if (hp && this.hand && this.hand.street !== 'complete' && !hp.folded) {
      this.seats[seat]!.leaving = true;
      this.foldOutOfTurn(hp);
      return;
    }
    if (hp && this.hand && this.hand.street !== 'complete') {
      this.seats[seat]!.leaving = true;
      return;
    }
    this.note(`${this.seats[seat]!.name} left the table`);
    this.seats[seat] = null;
  }

  setSittingOut(playerId: string, sittingOut: boolean): void {
    const seat = this.seatOf(playerId);
    if (seat === -1) throw new ActionError('not seated');
    this.seats[seat]!.sittingOut = sittingOut;
  }

  /** Host-only: change a stack between hands, e.g. for a rebuy. */
  setStack(playerId: string, stack: number): void {
    if (this.inHand()) throw new ActionError('wait for the hand to finish');
    const seat = this.seatOf(playerId);
    if (seat === -1) throw new ActionError('not seated');
    if (stack < 0) throw new ActionError('stack cannot be negative');
    this.seats[seat]!.stack = stack;
  }

  seatOf(playerId: string): number {
    return this.seats.findIndex((s) => s?.playerId === playerId);
  }

  inHand(): boolean {
    return !!this.hand && this.hand.street !== 'complete';
  }

  // ---------------------------------------------------------------- hand flow

  private eligibleSeats(): number[] {
    return this.seats
      .map((s, i) => (s && !s.sittingOut && !s.leaving && s.stack > 0 ? i : -1))
      .filter((i) => i !== -1);
  }

  eligibleCount(): number {
    return this.eligibleSeats().length;
  }

  canStartHand(): boolean {
    return !this.inHand() && this.eligibleSeats().length >= 2;
  }

  startHand(): Hand {
    if (this.inHand()) throw new ActionError('hand in progress');
    const seats = this.eligibleSeats();
    if (seats.length < 2) throw new ActionError('need at least two players');

    const nextOf = (from: number) => seats.find((s) => s > from) ?? seats[0];
    const button = this.button === null ? seats[0] : nextOf(this.button);
    this.button = button;

    // Heads-up, the button posts the small blind and acts first preflop.
    const headsUp = seats.length === 2;
    const sbSeat = headsUp ? button : nextOf(button);
    const bbSeat = nextOf(sbSeat);

    const deck = shuffle(freshDeck(), this.rng);
    const order = this.orderFrom(seats, nextOf(button));
    const players: HandPlayer[] = order.map((seat) => ({
      seat,
      playerId: this.seats[seat]!.playerId,
      cards: [],
      bet: 0,
      total: 0,
      folded: false,
      allIn: false,
      hasActed: false,
      canRaise: true,
      lastAction: null,
    }));
    for (let round = 0; round < 2; round++) for (const p of players) p.cards.push(deck.pop()!);

    this.handCount++;
    const hand: Hand = {
      number: this.handCount,
      button,
      sbSeat,
      bbSeat,
      deck,
      board: [],
      street: 'preflop',
      players,
      toAct: null,
      currentBet: 0,
      minRaise: this.config.bigBlind,
      showdown: false,
      results: [],
    };
    this.hand = hand;
    this.note(`--- Hand #${hand.number} (button: ${this.nameAt(button)}) ---`);

    this.post(this.playerAt(sbSeat)!, this.config.smallBlind, 'small blind');
    this.post(this.playerAt(bbSeat)!, this.config.bigBlind, 'big blind');
    hand.currentBet = Math.max(...players.map((p) => p.bet));

    hand.toAct = this.nextToAct(bbSeat);
    if (hand.toAct === null) this.advance();
    return hand;
  }

  legalActions(playerId: string): LegalActions | null {
    const hand = this.hand;
    const p = this.handPlayer(playerId);
    if (!hand || !p || hand.toAct !== p.seat) return null;
    const stack = this.seats[p.seat]!.stack;
    const toCall = hand.currentBet - p.bet;
    const maxRaiseTo = p.bet + stack;
    const minRaiseTo = Math.min(maxRaiseTo, hand.currentBet + hand.minRaise);
    return {
      canCheck: toCall === 0,
      callAmount: Math.min(toCall, stack),
      canRaise: p.canRaise && stack > toCall,
      minRaiseTo,
      maxRaiseTo,
    };
  }

  act(playerId: string, action: Action): void {
    const hand = this.hand;
    if (!hand || hand.street === 'complete') throw new ActionError('no hand in progress');
    const p = this.handPlayer(playerId);
    if (!p || hand.toAct !== p.seat) throw new ActionError('not your turn');
    const legal = this.legalActions(playerId)!;
    const seat = this.seats[p.seat]!;

    switch (action.type) {
      case 'fold':
        p.folded = true;
        p.lastAction = 'Fold';
        this.note(`${seat.name} folds`);
        break;
      case 'check':
        if (!legal.canCheck) throw new ActionError('cannot check');
        p.lastAction = 'Check';
        this.note(`${seat.name} checks`);
        break;
      case 'call': {
        if (legal.canCheck) throw new ActionError('nothing to call');
        this.commit(p, legal.callAmount);
        p.lastAction = p.allIn ? 'All in' : 'Call';
        this.note(`${seat.name} calls ${legal.callAmount}${p.allIn ? ' (all in)' : ''}`);
        break;
      }
      case 'raise': {
        const to = Math.floor(action.amount);
        if (!Number.isFinite(to)) throw new ActionError('invalid amount');
        if (!legal.canRaise) throw new ActionError('cannot raise');
        if (to > legal.maxRaiseTo) throw new ActionError('not enough chips');
        if (to < legal.minRaiseTo) throw new ActionError(`minimum raise is to ${legal.minRaiseTo}`);
        const raiseSize = to - hand.currentBet;
        const verb = hand.currentBet === 0 ? 'bets' : 'raises to';
        this.commit(p, to - p.bet);
        if (raiseSize >= hand.minRaise) {
          // A full raise reopens the betting for everyone.
          hand.minRaise = raiseSize;
          for (const o of hand.players) if (o !== p) { o.hasActed = false; o.canRaise = true; }
        } else {
          // An incomplete all-in raise: players who already acted may only call or fold.
          for (const o of hand.players) if (o !== p) { if (o.hasActed) o.canRaise = false; o.hasActed = false; }
        }
        hand.currentBet = to;
        p.lastAction = p.allIn ? 'All in' : verb === 'bets' ? 'Bet' : 'Raise';
        this.note(`${seat.name} ${verb} ${to}${p.allIn ? ' (all in)' : ''}`);
        break;
      }
      default:
        throw new ActionError('unknown action');
    }
    p.hasActed = true;
    hand.toAct = this.nextToAct(p.seat);
    if (hand.toAct === null) this.advance();
  }

  /** Folds a player regardless of turn order (leaving, timing out, kicked). */
  foldOutOfTurn(p: HandPlayer): void {
    const hand = this.hand!;
    if (hand.toAct === p.seat) {
      this.act(p.playerId, { type: 'fold' });
      return;
    }
    p.folded = true;
    p.lastAction = 'Fold';
    this.note(`${this.nameAt(p.seat)} folds`);
    if (this.live().length === 1) this.advance();
  }

  // ---------------------------------------------------------------- internals

  private note(line: string) {
    this.log.push(line);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
  }

  private nameAt(seat: number) {
    return this.seats[seat]?.name ?? `seat ${seat + 1}`;
  }

  private orderFrom(seats: number[], first: number): number[] {
    const i = seats.indexOf(first);
    return [...seats.slice(i), ...seats.slice(0, i)];
  }

  private playerAt(seat: number): HandPlayer | undefined {
    return this.hand?.players.find((p) => p.seat === seat);
  }

  handPlayer(playerId: string): HandPlayer | undefined {
    return this.hand?.players.find((p) => p.playerId === playerId);
  }

  private live(): HandPlayer[] {
    return this.hand!.players.filter((p) => !p.folded);
  }

  private commit(p: HandPlayer, amount: number) {
    const seat = this.seats[p.seat]!;
    const chips = Math.min(amount, seat.stack);
    seat.stack -= chips;
    p.bet += chips;
    p.total += chips;
    if (seat.stack === 0) p.allIn = true;
  }

  private post(p: HandPlayer, amount: number, label: string) {
    this.commit(p, amount);
    this.note(`${this.nameAt(p.seat)} posts ${label} ${p.bet}`);
  }

  /** Next seat after `from` that still needs to act on this street. */
  private nextToAct(from: number): number | null {
    const hand = this.hand!;
    if (this.live().length < 2) return null;
    const ps = [...hand.players].sort((a, b) => a.seat - b.seat);
    const start = ps.findIndex((p) => p.seat > from);
    const ordered = start === -1 ? ps : [...ps.slice(start), ...ps.slice(0, start)];
    const canAct = ps.filter((p) => !p.folded && !p.allIn);
    for (const p of ordered) {
      if (p.folded || p.allIn) continue;
      const facingBet = p.bet < hand.currentBet;
      // A lone player with chips who isn't facing a bet has nobody to play against.
      if (canAct.length === 1 && !facingBet) continue;
      if (!p.hasActed || facingBet) return p.seat;
    }
    return null;
  }

  /** Called when nobody is left to act on the current street. */
  private advance() {
    const hand = this.hand!;
    this.returnUncalled();

    if (this.live().length === 1) {
      this.finish(false);
      return;
    }

    for (const p of hand.players) {
      p.bet = 0;
      p.hasActed = false;
      p.canRaise = true;
      if (!p.folded && !p.allIn) p.lastAction = null;
    }
    hand.currentBet = 0;
    hand.minRaise = this.config.bigBlind;

    if (hand.street === 'river') {
      this.finish(true);
      return;
    }

    this.dealNextStreet();
    hand.toAct = this.nextToAct(hand.button);
    if (hand.toAct === null) this.advance(); // everyone is all in: run it out
  }

  private dealNextStreet() {
    const hand = this.hand!;
    hand.deck.pop(); // burn
    if (hand.street === 'preflop') {
      hand.board.push(hand.deck.pop()!, hand.deck.pop()!, hand.deck.pop()!);
      hand.street = 'flop';
    } else if (hand.street === 'flop') {
      hand.board.push(hand.deck.pop()!);
      hand.street = 'turn';
    } else {
      hand.board.push(hand.deck.pop()!);
      hand.street = 'river';
    }
    this.note(`${hand.street[0].toUpperCase() + hand.street.slice(1)}: ${hand.board.join(' ')}`);
  }

  /** Gives back the part of the biggest bet that nobody matched. */
  private returnUncalled() {
    const ps = this.hand!.players;
    const sorted = [...ps].sort((a, b) => b.bet - a.bet);
    const [top, second] = sorted;
    const excess = top.bet - (second?.bet ?? 0);
    if (excess > 0) {
      top.bet -= excess;
      top.total -= excess;
      this.seats[top.seat]!.stack += excess;
      if (top.allIn && this.seats[top.seat]!.stack > 0) top.allIn = false;
      this.note(`Uncalled ${excess} returned to ${this.nameAt(top.seat)}`);
    }
  }

  /** Splits the chips into a main pot and side pots by all-in levels. */
  pots(): { amount: number; eligible: number[] }[] {
    const ps = this.hand!.players;
    const levels = [...new Set(ps.filter((p) => !p.folded).map((p) => p.total))].sort((a, b) => a - b);
    const pots: { amount: number; eligible: number[] }[] = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      for (const p of ps) amount += Math.max(0, Math.min(p.total, level) - prev);
      const eligible = ps.filter((p) => !p.folded && p.total >= level).map((p) => p.seat);
      const last = pots[pots.length - 1];
      if (last && last.eligible.length === eligible.length) last.amount += amount;
      else if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    }
    // Chips from folded players above the top live level belong to the last pot.
    const counted = pots.reduce((s, p) => s + p.amount, 0);
    const all = ps.reduce((s, p) => s + p.total, 0);
    if (pots.length && all > counted) pots[pots.length - 1].amount += all - counted;
    return pots;
  }

  private finish(showdown: boolean) {
    const hand = this.hand!;
    hand.toAct = null;
    hand.showdown = showdown;
    const pots = this.pots();

    if (!showdown) {
      const winner = this.live()[0];
      const amount = pots.reduce((s, p) => s + p.amount, 0);
      this.seats[winner.seat]!.stack += amount;
      hand.results = [{ amount, winners: [{ seat: winner.seat, playerId: winner.playerId, amount }] }];
      this.note(`${this.nameAt(winner.seat)} wins ${amount}`);
    } else {
      const values = new Map(
        this.live().map((p) => [p.seat, evaluate([...p.cards, ...hand.board])]),
      );
      for (const p of this.live()) {
        this.note(`${this.nameAt(p.seat)} shows ${p.cards.join(' ')} (${values.get(p.seat)!.description})`);
      }
      // Odd chips go to the first winner clockwise from the button.
      const clockwise = (seat: number) => (seat - hand.button - 1 + this.seats.length) % this.seats.length;
      hand.results = pots.map((pot) => {
        const best = Math.max(...pot.eligible.map((s) => values.get(s)!.score));
        const winners = pot.eligible
          .filter((s) => values.get(s)!.score === best)
          .sort((a, b) => clockwise(a) - clockwise(b));
        const share = Math.floor(pot.amount / winners.length);
        let odd = pot.amount - share * winners.length;
        return {
          amount: pot.amount,
          winners: winners.map((seat) => {
            const amount = share + (odd-- > 0 ? 1 : 0);
            this.seats[seat]!.stack += amount;
            this.note(`${this.nameAt(seat)} wins ${amount} with ${values.get(seat)!.description}`);
            const v = values.get(seat)!;
            return { seat, playerId: this.seats[seat]!.playerId, amount, handName: v.description, bestCards: v.cards };
          }),
        };
      });
    }

    hand.street = 'complete';
    for (const p of hand.players) p.bet = 0;
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if (s?.leaving) {
        this.note(`${s.name} left the table`);
        this.seats[i] = null;
      }
    }
  }
}
