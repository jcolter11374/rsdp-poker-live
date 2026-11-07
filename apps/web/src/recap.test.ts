import { describe, expect, it } from 'vitest';
import type { HandEvent } from '@rsdp/engine/core';
import type { LedgerView } from '@rsdp/engine/wire';
import { chipFormat } from './format';
import { biggestPot, BREAK_MS, cashRecap, duration, playTime, recapOffered, type RecapHand, type RecapInput } from './recap';
import { settleUp } from './records';

// Thursday 5 November 2026, 8pm in UTC, which the tests read dates in.
const EIGHT_PM = Date.UTC(2026, 10, 5, 20, 0);
const MIN = 60_000;

/** A ledger row as the server builds it: net is the stack plus what was taken out, less every buy-in. */
function row(name: string, buyIn: number, cashOut: number, stack: number, extra: Partial<LedgerView> = {}): LedgerView {
  return { playerId: `id-${name}`, name, buyIn, cashOut, stack, net: stack + cashOut - buyIn, ...extra };
}

const SEATS = ['Ann', 'Bo', 'Cy', 'Dee'].map((name, seat) => ({ seat, playerId: `id-${name}`, name, stack: 2000 }));

/** A finished hand: who won how much of the pot. */
function hand(handNumber: number, startedAt: number, awards: [seat: number, amount: number][] = [[0, 100]], gameName = "No Limit Hold'em", minutes = 2): RecapHand {
  const events: HandEvent[] = awards.map(([seat, amount], seq) => ({ seq, t: 'award', pot: 0, run: 0, board: 0, half: 'scoop', seat, amount }));
  return { handNumber, startedAt, endedAt: startedAt + minutes * MIN, gameName, seats: SEATS, events };
}

/** Hands back to back, two minutes each, from 8pm. */
const evening = (count: number, gameName?: string) => Array.from({ length: count }, (_, i) => hand(i + 1, EIGHT_PM + i * 2 * MIN, [[i % 2, 100]], gameName));

function recap(over: Partial<RecapInput>): string {
  return cashRecap({ tableName: 'Thursday game', ledger: [], hands: [], running: false, centsMode: true, fmt: chipFormat(true), now: EIGHT_PM, locale: 'en-US', timeZone: 'UTC', ...over });
}

describe('the cash game recap', () => {
  it('names the table, the date, the game, the hands and how long, then everyone biggest winner first', () => {
    const ledger = [row('Cy', 2000, 0, 1500), row('Ann', 2000, 0, 4550), row('Bo', 2000, 0, 1950)];
    expect(recap({ ledger, hands: evening(90) })).toBe(
      [
        "Thursday game · Thu, Nov 5",
        "No Limit Hold'em",
        '90 hands in 3h',
        '',
        'Ann +$25.50',
        'Bo -$0.50',
        'Cy -$5',
        '',
        'Biggest pot: $1 to Ann (hand 1)',
      ].join('\n'),
    );
  });

  it('shows dollars and cents from the ledger rows settle-up pays from', () => {
    const ledger = [row('Ann', 5000, 0, 6234), row('Bo', 5000, 0, 3766)];
    const text = recap({ ledger, hands: evening(3) });
    expect(text).toContain('Ann +$12.34');
    expect(text).toContain('Bo -$12.34');
    // Each person's line is what settle-up pays them, or has them pay.
    const { transfers } = settleUp(ledger);
    expect(transfers).toEqual([{ from: 'Bo', to: 'Ann', amount: 1234 }]);
    // Thousands keep their separator, as in the ledger.
    expect(recap({ ledger: [row('Ann', 0, 0, 123456), row('Bo', 123456, 0, 0)] })).toContain('Ann +$1,234.56');
  });

  it('counts a player who left early from what they took out', () => {
    // Dee bought in for $20 and left with $32.50 before the end: no stack, only the cash-out.
    const ledger = [row('Ann', 2000, 0, 1000), row('Dee', 2000, 3250, 0), row('Bo', 2000, 0, 1750)];
    const text = recap({ ledger, hands: evening(4) });
    expect(text.split('\n').slice(4, 7)).toEqual(['Dee +$12.50', 'Bo -$2.50', 'Ann -$10']);
  });

  it('takes every rebuy and top-up off the result', () => {
    // Bo bought in for $20, rebought $20 and topped up $10, and ends with $45; Ann bought in once and ends with $25.
    const ledger = [row('Bo', 5000, 0, 4500), row('Ann', 2000, 0, 2500)];
    const text = recap({ ledger, hands: evening(2) });
    expect(text).toContain('Ann +$5');
    expect(text).toContain('Bo -$5');
    expect(text.indexOf('Ann')).toBeLessThan(text.indexOf('Bo -'));
  });

  it('puts players on the same result in name order, and says even for nothing won or lost', () => {
    const ledger = [row('Cy', 2000, 0, 2500), row('Ann', 2000, 0, 2500), row('Bo', 2000, 0, 1000), row('Dee', 2000, 0, 2000)];
    expect(recap({ ledger, hands: evening(2) }).split('\n').slice(4, 8)).toEqual(['Ann +$5', 'Cy +$5', 'Dee even', 'Bo -$10']);
  });

  it('says when nothing has been played yet', () => {
    const ledger = [row('Ann', 2000, 0, 2000), row('Bo', 2000, 0, 2000)];
    expect(recap({ ledger, hands: [] })).toBe(['Thursday game · Thu, Nov 5', 'No hands played yet.', '', 'Ann even', 'Bo even'].join('\n'));
  });

  it('leaves out what comes from the hands when they could not be loaded', () => {
    const ledger = [row('Ann', 2000, 0, 2500), row('Bo', 2000, 0, 1500)];
    expect(recap({ ledger, hands: null })).toBe(['Thursday game · Thu, Nov 5', '', 'Ann +$5', 'Bo -$5'].join('\n'));
  });

  it('says the game is still going when it is', () => {
    expect(recap({ ledger: [row('Ann', 2000, 0, 2000)], hands: evening(1), running: true }).split('\n')[0]).toBe('Thursday game · Thu, Nov 5 (still playing)');
  });

  it('keeps practice bots out of the results and gives what they won one line', () => {
    const ledger = [row('Ann', 2000, 0, 1000), row('Bo', 2000, 0, 2550), row('Ace', 2000, 0, 2450, { bot: true })];
    const text = recap({ ledger, hands: evening(2) });
    expect(text).not.toContain('Ace');
    expect(text).toContain('Practice bots won $4.50 (play money, so nobody pays it)');
    expect(recap({ ledger: [row('Ann', 2000, 0, 2100), row('Ace', 2000, 0, 1900, { bot: true })] })).toContain('Practice bots lost $1 (play money');
  });

  it('counts plain chips at a table made before dollars and cents', () => {
    const ledger = [row('Ann', 1000, 0, 2200), row('Bo', 1000, 0, 0)];
    const text = recap({ ledger, hands: evening(1), centsMode: false, fmt: chipFormat(false) });
    expect(text).toContain('Ann +1,200');
    expect(text).toContain('Bo -1,000');
    expect(text).not.toContain('$');
  });

  it('names the games in the order they were dealt, and counts the rest past three', () => {
    const mix = (names: string[]) => names.map((g, i) => hand(i + 1, EIGHT_PM + i * 2 * MIN, [[0, 100]], g));
    expect(recap({ hands: mix(["No Limit Hold'em", 'Pot Limit Omaha', "No Limit Hold'em"]) }).split('\n')[1]).toBe("No Limit Hold'em and Pot Limit Omaha");
    expect(recap({ hands: mix(['A', 'B', 'C', 'D']) }).split('\n')[1]).toBe('A, B, C and D');
    expect(recap({ hands: mix(['A', 'B', 'C', 'D', 'E', 'F']) }).split('\n')[1]).toBe('A, B, C and 3 more');
  });

  it('gives both dates when the hands ran past midnight or over more than one night', () => {
    const late = [hand(1, Date.UTC(2026, 10, 5, 23, 50)), hand(2, Date.UTC(2026, 10, 6, 0, 10))];
    expect(recap({ hands: late }).split('\n')[0]).toBe('Thursday game · Thu, Nov 5 to Fri, Nov 6');
  });

  it('dates the recap by the hand list when the hands could not be loaded, and today only when there is nothing to date it by', () => {
    const now = Date.UTC(2026, 10, 7, 12);
    const dates = { from: Date.UTC(2026, 10, 5, 23, 50), to: Date.UTC(2026, 10, 6, 0, 30) };
    expect(recap({ hands: null, dates, now }).split('\n')[0]).toBe('Thursday game · Thu, Nov 5 to Fri, Nov 6');
    expect(recap({ hands: null, dates: { from: EIGHT_PM, to: EIGHT_PM + 30 * MIN }, now }).split('\n')[0]).toBe('Thursday game · Thu, Nov 5');
    // The hands themselves come first when there are any.
    expect(recap({ hands: evening(2), dates, now }).split('\n')[0]).toBe('Thursday game · Thu, Nov 5');
    expect(recap({ hands: null, now }).split('\n')[0]).toBe('Thursday game · Sat, Nov 7');
  });

  it('has no links and no cards', () => {
    const shown: HandEvent = { seq: 0, t: 'show', seat: 0, cards: ['As', 'Kd'], handName: 'Pair of Aces' };
    const h = { ...hand(1, EIGHT_PM, [[0, 500]]), events: [shown, ...hand(1, EIGHT_PM, [[0, 500]]).events] };
    const text = recap({ tableName: 'Thursday game', ledger: [row('Ann', 2000, 0, 2500), row('Bo', 2000, 0, 1500)], hands: [h] });
    expect(text).not.toMatch(/https?:|\/t\/|As|Kd|Aces/);
  });
});

describe('the biggest pot', () => {
  it('is the hand that paid out the most, all its pots and runs together', () => {
    const hands = [hand(1, EIGHT_PM, [[0, 300]]), hand(2, EIGHT_PM + 5 * MIN, [[1, 250], [1, 250], [2, 100]]), hand(3, EIGHT_PM + 10 * MIN, [[3, 400]])];
    expect(biggestPot(hands)).toEqual({ handNumber: 2, amount: 600, winners: ['Bo', 'Cy'] });
  });

  it('says split for a chopped pot, and keeps the earlier hand on a tie', () => {
    const hands = [hand(4, EIGHT_PM, [[0, 250], [3, 250]]), hand(9, EIGHT_PM + 5 * MIN, [[1, 500]])];
    expect(biggestPot(hands)).toEqual({ handNumber: 4, amount: 500, winners: ['Ann', 'Dee'] });
    expect(recap({ hands }).split('\n').at(-1)).toBe('Biggest pot: $5 split by Ann and Dee (hand 4)');
  });

  it('marks a practice bot, and is left out when no pot was won', () => {
    const botSeats = [{ seat: 0, playerId: 'bot-1', name: 'Ace', stack: 2000, bot: { ownerName: 'Ann', look: 0 } }];
    expect(biggestPot([{ ...hand(1, EIGHT_PM, [[0, 100]]), seats: botSeats }])?.winners).toEqual(['Ace (bot)']);
    expect(biggestPot([hand(1, EIGHT_PM, [])])).toBeNull();
    expect(recap({ hands: [hand(1, EIGHT_PM, [])] })).not.toContain('Biggest pot');
  });
});

describe('how long the game ran', () => {
  it('runs from the first hand to the last, but leaves out a long break', () => {
    const hands = [hand(1, EIGHT_PM, [], '', 2), hand(2, EIGHT_PM + 5 * MIN, [], '', 3), hand(3, EIGHT_PM + 8 * MIN + BREAK_MS + MIN, [], '', 4)];
    // 2 minutes, a 3-minute wait, 3 minutes, then over an hour's break that isn't counted, then 4 minutes.
    expect(playTime(hands)).toBe(12 * MIN);
  });

  it('reads as hours and minutes', () => {
    expect(duration(0)).toBe('under a minute');
    expect(duration(45 * MIN)).toBe('45m');
    expect(duration(3 * 60 * MIN)).toBe('3h');
    expect(duration(155 * MIN + 20_000)).toBe('2h 35m');
  });
});

describe('who is offered the recap', () => {
  const view = { mode: 'cash' as const, realGame: true, ledger: [row('Ann', 2000, 0, 2000)], spectator: null };
  const anHourAgo = EIGHT_PM - 60 * MIN;

  it('everyone at a cash table where people have played, once anyone has bought in', () => {
    expect(recapOffered(view, undefined, EIGHT_PM)).toBe(true);
    // Watching live, or with the host's watching turned off: they see the ledger as it is now.
    expect(recapOffered({ ...view, spectator: { delaySeconds: 0, seeAll: false, blocked: false } }, undefined, EIGHT_PM)).toBe(true);
    expect(recapOffered({ ...view, spectator: { delaySeconds: 0, seeAll: false, blocked: true } }, undefined, EIGHT_PM)).toBe(true);
  });

  it('nobody at a practice table, a tournament or a table nobody has bought in at', () => {
    expect(recapOffered({ ...view, realGame: false }, anHourAgo, EIGHT_PM)).toBe(false);
    expect(recapOffered({ ...view, mode: 'tournament' }, anHourAgo, EIGHT_PM)).toBe(false);
    expect(recapOffered({ ...view, ledger: [] }, anHourAgo, EIGHT_PM)).toBe(false);
  });

  it('a spectator on a delay only once the delay has passed since this browser saw people play', () => {
    const watching = { ...view, spectator: { delaySeconds: 120, seeAll: false, blocked: false } };
    expect(recapOffered(watching, undefined, EIGHT_PM)).toBe(false);
    expect(recapOffered(watching, EIGHT_PM - MIN, EIGHT_PM)).toBe(false);
    expect(recapOffered(watching, EIGHT_PM - 2 * MIN, EIGHT_PM)).toBe(true);
  });
});
