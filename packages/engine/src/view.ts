import type { Card } from './cards';
import type { PotResult, Street, LegalActions, PokerTable } from './table';

/** What one viewer is allowed to see. Hole cards are hidden unless they're yours or shown down. */
export interface TableView {
  config: PokerTable['config'];
  seats: ({
    seat: number;
    playerId: string;
    name: string;
    stack: number;
    sittingOut: boolean;
    inHand: boolean;
    folded: boolean;
    allIn: boolean;
    bet: number;
    cards: (Card | null)[];
  } | null)[];
  button: number | null;
  hand: {
    number: number;
    street: Street;
    board: Card[];
    pot: number;
    toAct: number | null;
    currentBet: number;
    sbSeat: number;
    bbSeat: number;
    results: PotResult[];
  } | null;
  you: { playerId: string; seat: number; legal: LegalActions | null };
  log: string[];
}

export function viewFor(table: PokerTable, playerId: string): TableView {
  const hand = table.hand;
  return {
    config: table.config,
    button: table.button,
    seats: table.seats.map((s, seat) => {
      if (!s) return null;
      const hp = hand?.players.find((p) => p.seat === seat);
      const reveal = hp && (hp.playerId === playerId || (hand!.showdown && !hp.folded));
      return {
        seat,
        playerId: s.playerId,
        name: s.name,
        stack: s.stack,
        sittingOut: s.sittingOut,
        inHand: !!hp,
        folded: hp?.folded ?? false,
        allIn: hp?.allIn ?? false,
        bet: hp?.bet ?? 0,
        cards: hp ? (reveal ? hp.cards : [null, null]) : [],
      };
    }),
    hand: hand && {
      number: hand.number,
      street: hand.street,
      board: hand.board,
      pot: hand.players.reduce((sum, p) => sum + p.total - p.bet, 0),
      toAct: hand.toAct,
      currentBet: hand.currentBet,
      sbSeat: hand.sbSeat,
      bbSeat: hand.bbSeat,
      results: hand.results,
    },
    you: { playerId, seat: table.seatOf(playerId), legal: table.legalActions(playerId) },
    log: table.log.slice(-100),
  };
}
