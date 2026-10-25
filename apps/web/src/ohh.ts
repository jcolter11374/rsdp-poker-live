import type { HandEvent } from '@rsdp/engine/core';
import type { HandRecordView } from '@rsdp/engine/wire';

/*
 * Open Hand History (https://hh-specs.handhistory.org), the JSON format
 * PokerTracker, Holdem Manager and other trackers import. Hold'em and Omaha
 * hands only, since trackers don't take stud or draw. Each hand is one JSON
 * object; a file is the objects separated by blank lines. Amounts are in
 * table units (dollars in cents mode). Only cards the downloader saw are in it.
 */

type Ev<T extends HandEvent['t']> = Extract<HandEvent, { t: T }>;

const SITE = 'RSDP Poker Live';

const GAME_TYPE: Record<string, string> = {
  nlhe: 'Holdem',
  plo4: 'Omaha',
  plo5: 'Omaha',
  plo6: 'Omaha',
  plo8: 'OmahaHiLo',
  'plo5-8': 'OmahaHiLo',
  'plo6-8': 'OmahaHiLo',
};
const BET_TYPE = { 'no-limit': 'NL', 'pot-limit': 'PL', 'fixed-limit': 'FL' } as const;
const POST_ACTION: Record<string, string> = { sb: 'Post SB', bb: 'Post BB', ante: 'Post Ante', straddle: 'Straddle' };

export interface OhhOptions {
  tableName: string;
  centsMode: boolean;
  seatCount: number;
  /** The downloader, who is the "hero" if they played the hand. */
  myId: string;
  tournamentId?: string | null;
}

/** One hand as an OHH object, or null for games trackers can't read. */
export function toOhh(h: HandRecordView, opts: OhhOptions): object | null {
  const start = h.events.find((e): e is Ev<'hand-start'> => e.t === 'hand-start');
  if (!start || !GAME_TYPE[start.gameId]) return null;
  const amt = (n: number) => (opts.centsMode ? n / 100 : n);
  // OHH seats and player ids start at 1.
  const pid = (seat: number) => seat + 1;
  const hero = h.seats.find((s) => s.playerId === opts.myId);

  const rounds: { id: number; street: string; cards?: string[]; actions: object[] }[] = [];
  let actionNumber = 0;
  const round = (street: string, cards?: string[]) => {
    rounds.push({ id: rounds.length, street, ...(cards ? { cards } : {}), actions: [] });
  };
  const act = (a: object) => rounds.at(-1)!.actions.push({ action_number: ++actionNumber, ...a });
  round('Preflop');
  const showdown: object[] = [];
  let boardCards = 0;
  for (const e of h.events) {
    switch (e.t) {
      case 'post':
        act({
          player_id: pid(e.seat),
          action: e.kind === 'ante' || !e.live ? (e.kind === 'ante' ? 'Post Ante' : 'Post Dead') : (POST_ACTION[e.kind] ?? 'Post Extra Blind'),
          amount: amt(e.amount),
          is_allin: e.allIn,
        });
        break;
      case 'deal':
        if (e.cards.some((c) => c.card !== '??')) act({ player_id: pid(e.seat), action: 'Dealt Cards', cards: e.cards.map((c) => c.card) });
        break;
      case 'board':
        // Second runs and second boards stay out: trackers expect one board.
        if (e.run !== 0 || e.board !== 0) break;
        // Named by how many cards are out, since a run-out deals with no street events.
        boardCards += e.cards.length;
        round(boardCards <= 3 ? 'Flop' : boardCards === 4 ? 'Turn' : 'River', e.cards);
        break;
      case 'action': {
        const action = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise', 'bring-in': 'Bet', complete: 'Raise' }[e.action];
        // OHH amounts for bets and raises are the chips put in by the action.
        act({ player_id: pid(e.seat), action, amount: amt(e.amount), is_allin: e.allIn });
        break;
      }
      // Hands turned over in an all-in run-out still belong in the showdown, after the board.
      case 'show':
        showdown.push({ player_id: pid(e.seat), action: 'Shows Cards', cards: e.cards });
        break;
      case 'muck':
        showdown.push({ player_id: pid(e.seat), action: 'Mucks Cards' });
        break;
    }
  }
  if (showdown.length) {
    round('Showdown');
    showdown.forEach(act);
  }

  const pots = new Map<number, Map<number, number>>();
  for (const e of h.events)
    if (e.t === 'award') {
      const p = pots.get(e.pot) ?? new Map<number, number>();
      p.set(e.seat, (p.get(e.seat) ?? 0) + e.amount);
      pots.set(e.pot, p);
    }
  const rake = h.events.filter((e): e is Ev<'transfer'> => e.t === 'transfer' && e.kind === 'rake').reduce((t, e) => t + e.amount, 0);

  return {
    ohh: {
      spec_version: '1.4.7',
      site_name: SITE,
      network_name: SITE,
      internal_version: '1',
      tournament: !!opts.tournamentId,
      ...(opts.tournamentId
        ? { tournament_info: { tournament_number: opts.tournamentId, name: opts.tableName, start_date_utc: new Date(h.startedAt).toISOString(), currency: 'T$', type: 'MTT' } }
        : {}),
      game_number: `${start.handId}`,
      start_date_utc: new Date(h.startedAt).toISOString(),
      table_name: opts.tableName,
      table_handle: opts.tableName,
      table_size: opts.seatCount,
      game_type: GAME_TYPE[start.gameId],
      bet_limit: { bet_type: BET_TYPE[h.betting] },
      dealer_seat: pid(h.button),
      small_blind_amount: amt(h.stakes.smallBlind),
      big_blind_amount: amt(h.stakes.bigBlind),
      ante_amount: amt(h.stakes.anteType === 'none' ? 0 : h.stakes.ante),
      currency: opts.centsMode ? 'USD' : 'Chips',
      ...(hero ? { hero_player_id: pid(hero.seat) } : {}),
      flags: [...(start.bombPot ? ['Bomb_Pot'] : []), ...(hero ? [] : ['Observed'])],
      players: h.seats.map((s) => ({ id: pid(s.seat), seat: pid(s.seat), name: s.name, display: s.name, starting_stack: amt(s.stack) })),
      rounds,
      pots: [...pots].map(([number, wins]) => ({
        number,
        amount: amt([...wins.values()].reduce((a, b) => a + b, 0)),
        rake: number === 0 ? amt(rake) : 0,
        player_wins: [...wins].map(([seat, win]) => ({ player_id: pid(seat), win_amount: amt(win), contributed_rake: 0 })),
      })),
    },
  };
}

/** A whole .ohh file: every hand trackers can read, one JSON object each, separated by blank lines. */
export function ohhFile(hands: HandRecordView[], opts: OhhOptions): { text: string; count: number } {
  const objects = hands.map((h) => toOhh(h, opts)).filter((x): x is object => !!x);
  return { text: objects.map((o) => JSON.stringify(o)).join('\n\n') + (objects.length ? '\n' : ''), count: objects.length };
}
