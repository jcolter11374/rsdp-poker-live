import type { HandEvent } from '@rsdp/engine/core';
import type { HandRecordView } from '@rsdp/engine/wire';
import { equity } from './equity';
import { finalStacks } from './replay';
import { handStrength } from './strength';
import type { Fmt } from './format';

/*
 * The table's most memorable hands, picked from the history and given a
 * headline: big pots, monsters, underdogs who got there, short stacks
 * coming back, knockouts, bluffs shown, both boards scooped, the 7-2.
 * Worked out from what this viewer could see, in the browser.
 */

export type HighlightKind = 'big-pot' | 'monster' | 'underdog' | 'comeback' | 'knockout' | 'bluff' | 'scoop' | 'seven-deuce';

export interface Highlight {
  /** Index into the hands list given. */
  index: number;
  handNumber: number;
  kind: HighlightKind;
  playerId: string;
  headline: string;
  score: number;
}

export const HIGHLIGHT_ICON: Record<HighlightKind, string> = {
  'big-pot': '💰',
  monster: '💪',
  underdog: '🍀',
  comeback: '📈',
  knockout: '🥊',
  bluff: '🎭',
  scoop: '🧹',
  'seven-deuce': '7️⃣',
};

type Ev<T extends HandEvent['t']> = Extract<HandEvent, { t: T }>;

/** Every hand worth remembering in one hand, best first. */
function candidates(h: HandRecordView, index: number, fmt: Fmt): Highlight[] {
  const start = h.events.find((e): e is Ev<'hand-start'> => e.t === 'hand-start');
  if (!start) return [];
  const bb = h.stakes.bigBlind || h.stakes.smallBet || h.stakes.bringIn || 1;
  const name = (seat: number) => h.seats.find((s) => s.seat === seat)?.name ?? `Seat ${seat + 1}`;
  const player = (seat: number) => h.seats.find((s) => s.seat === seat)?.playerId ?? '';
  const startStack = (seat: number) => h.seats.find((s) => s.seat === seat)?.stack ?? 0;

  const awards = h.events.filter((e): e is Ev<'award'> => e.t === 'award');
  if (!awards.length) return [];
  const wonBy = new Map<number, number>();
  for (const a of awards) wonBy.set(a.seat, (wonBy.get(a.seat) ?? 0) + a.amount);
  const pot = awards.reduce((t, a) => t + a.amount, 0);
  const [winner] = [...wonBy].sort((a, b) => b[1] - a[1])[0];
  const who = name(winner);
  const out: Highlight[] = [];
  const add = (kind: HighlightKind, seat: number, score: number, headline: string) => out.push({ index, handNumber: h.handNumber, kind, playerId: player(seat), headline, score });

  // Cards each seat ended with, as far as this viewer saw them.
  const cards = new Map<number, string[]>();
  for (const e of h.events) {
    if (e.t === 'deal') cards.set(e.seat, [...(cards.get(e.seat) ?? []), ...e.cards.map((c) => c.card)]);
    if (e.t === 'show') {
      const have = (cards.get(e.seat) ?? []).filter((c) => c !== '??');
      cards.set(e.seat, [...have, ...e.cards.filter((c) => !have.includes(c))]);
    }
  }
  const known = (seat: number) => {
    const c = cards.get(seat);
    return c && c.length && !c.includes('??') ? c : null;
  };
  const showdown = awards.some((a) => a.handName);
  const boardOf = (upTo: number) =>
    h.events
      .slice(0, upTo)
      .filter((e): e is Ev<'board'> => e.t === 'board' && e.run === 0)
      .reduce<string[][]>((boards, e) => ((boards[e.board] = [...(boards[e.board] ?? []), ...e.cards]), boards), []);

  if (pot / bb >= 40) add('big-pot', winner, pot / bb / 2, `${who} won a ${Math.round(pot / bb)} BB pot (${fmt(pot)})`);

  const best = awards.find((a) => a.seat === winner && a.handName)?.handName ?? '';
  if (showdown) {
    if (/^Royal Flush/.test(best)) add('monster', winner, 120, `${who} made a Royal Flush`);
    else if (/^Straight Flush/.test(best)) add('monster', winner, 90, `${who} made a ${best.split(',')[0]}`);
    else if (/^Four of a Kind/.test(best)) add('monster', winner, 60, `${who} won with ${best}`);
  }

  // Both boards (or both halves of every board) to one player, against someone.
  const boards = new Set(awards.map((a) => `${a.run}-${a.board}`));
  if (boards.size > 1 && wonBy.size === 1 && showdown) add('scoop', winner, 30, `${who} scooped ${start.boards > 1 ? 'both boards' : 'both runs'}`);

  if (h.events.some((e) => e.t === 'transfer' && e.kind === 'bounty-72' && e.to === winner)) add('seven-deuce', winner, 40, `${who} won with the 7-2 and collected the bounty`);
  else {
    const hole = known(winner);
    if (
      start.gameId === 'nlhe' &&
      hole?.length === 2 &&
      hole
        .map((c) => c[0])
        .sort()
        .join('') === '27' &&
      hole[0][1] !== hole[1][1]
    )
      add('seven-deuce', winner, 30, `${who} won with the 7-2 offsuit`);
  }

  // Short-stack comeback: all in for ten big blinds or less, and won.
  const allIn = (seat: number) => h.events.some((e) => (e.t === 'action' || e.t === 'post') && e.seat === seat && e.allIn);
  const short = startStack(winner);
  if (allIn(winner) && short <= bb * 10 && wonBy.get(winner)! > short) add('comeback', winner, 20 + (10 - short / bb), `${who} was down to ${Math.max(1, Math.round(short / bb))} BB and doubled up`);

  // Knockouts: players who ended with nothing.
  const end = finalStacks(h);
  if (end) {
    const out = h.seats.filter((s) => s.stack > 0 && end[s.seat] === 0 && s.seat !== winner);
    if (out.length) add('knockout', winner, 25 + 5 * out.length, `${who} knocked out ${out.map((s) => s.name).join(' and ')}`);
  }

  // The underdog who got there: equity when the hands went face up, before the rest of the board.
  const firstShow = h.events.findIndex((e) => e.t === 'show');
  if (firstShow >= 0 && h.events.slice(firstShow).some((e) => e.t === 'board' || e.t === 'deal')) {
    const live = new Set(h.seats.map((s) => s.seat));
    for (const e of h.events.slice(0, firstShow)) if (e.t === 'action' && e.action === 'fold') live.delete(e.seat);
    const shownBefore = (seat: number) => {
      const dealt = h.events
        .slice(0, firstShow)
        .filter((e): e is Ev<'deal'> => e.t === 'deal' && e.seat === seat)
        .flatMap((e) => e.cards.map((c) => c.card));
      const shown = h.events
        .slice(firstShow)
        .filter((e): e is Ev<'show'> => e.t === 'show' && e.seat === seat)
        .flatMap((e) => e.cards);
      return dealtWithShown(dealt, shown);
    };
    const hands = [...live].map((seat) => ({ seat, cards: shownBefore(seat) }));
    if (hands.length >= 2 && hands.every((x) => x.cards.length && !x.cards.includes('??'))) {
      const e = equity({ gameId: start.gameId, hands, boards: boardOf(firstShow).length ? boardOf(firstShow) : [[]], dead: [] });
      const share = e?.[winner];
      if (share !== undefined && share < 0.4 && wonBy.size === 1) add('underdog', winner, 30 + (40 - share * 100), `${who} came from behind as a ${Math.max(1, Math.round(share * 100))}% underdog`);
    }
  }

  // A bluff shown: won without a showdown and turned over nothing.
  if (!showdown) {
    const shown = h.events.filter((e): e is Ev<'show'> => e.t === 'show' && e.seat === winner);
    const hole = known(winner);
    if (shown.length && hole && start.gameId !== 'td27' && start.gameId !== 'badugi') {
      const board = boardOf(h.events.length)[0] ?? [];
      const made = handStrength(start.gameId, hole, board);
      if (made && /^\w+ high$/.test(made.split(' · ')[0]) && pot / bb >= 10) add('bluff', winner, 20 + pot / bb / 10, `${who} showed the bluff: ${made.split(' · ')[0]}`);
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Hidden cards filled in from the show that turned them over (shows list the cards that were hidden, in order). */
function dealtWithShown(dealt: string[], shown: string[]): string[] {
  const fresh = shown.filter((c) => !dealt.includes(c));
  let k = 0;
  return dealt.map((c) => (c === '??' ? (fresh[k++] ?? '??') : c));
}

/** Up to `max` highlights, one per hand, the best first. */
export function findHighlights(hands: HandRecordView[], fmt: Fmt, max = 5): Highlight[] {
  const picks: Highlight[] = [];
  hands.forEach((h, i) => {
    try {
      const best = candidates(h, i, fmt)[0];
      if (best) picks.push(best);
    } catch {
      /* a hand we can't read just isn't a highlight */
    }
  });
  return picks.sort((a, b) => b.score - a.score || b.handNumber - a.handNumber).slice(0, max);
}
