import { getVariant, HIGH_EVALUATORS, LOW_EVALUATORS } from '@rsdp/engine/variants';

/**
 * What your cards make right now, for the hint under the action buttons:
 * "Two Pair, Kings and Fives", "Eight-Six low", or both halves in hi-lo.
 * Null until there are enough cards to make a hand.
 */
export function handStrength(gameId: string, hole: string[], board: string[]): string | null {
  let spec;
  try {
    spec = getVariant(gameId);
  } catch {
    return null;
  }
  const mine = hole.filter((c) => c !== '??');
  if (mine.length !== hole.length || !mine.length) return null;
  const total = mine.length + board.length;
  const { high, low } = spec.showdown;
  const parts: string[] = [];
  try {
    if (high) {
      const enough = high === 'omaha' ? board.length >= 3 : total >= 5;
      const rank = enough ? HIGH_EVALUATORS[high](mine, board) : null;
      if (rank) parts.push(rank.name);
    }
    if (low) {
      const enough = low === 'badugi' ? total >= 4 : low === 'omaha-eight-or-better' ? board.length >= 3 : total >= 5;
      const rank = enough ? LOW_EVALUATORS[low](mine, board) : null;
      if (rank) parts.push(rank.name);
      else if (enough && high) parts.push('no low');
    }
  } catch {
    return null;
  }
  return parts.length ? parts.join(' · ') : null;
}

const FIGURE: Record<string, string> = { Ace: 'A', Two: '2', Three: '3', Four: '4', Five: '5', Six: '6', Seven: '7', Eight: '8', Nine: '9', Ten: '10', Jack: 'J', Queen: 'Q', King: 'K' };
const figures = (low: string) => low.replace(/^(\w+)(?:-(\w+))? low$/, (all, a: string, b?: string) => (FIGURE[a] && (!b || FIGURE[b]) ? `${FIGURE[a]}${b ? '-' + FIGURE[b] : ''} low` : all));

/**
 * A shown hand's name the short way, for the tab over a phone nameplate (#455): what it made (the part before the first
 * comma: "Full House", "Two Pair"), a low in figures ("8-6 low"). In hi-lo both halves go on one line, the low without
 * the word ("Two Pair · 8-7"), and "no low" is left out. The winner line and the hand log keep the full name.
 */
export function handKind(name: string): string {
  const halves = name
    .split(' · ')
    .filter((half) => half !== 'no low')
    .map((half) => figures(half.split(', ')[0]));
  return halves.length > 1 ? halves.map((half) => half.replace(/ low$/, '')).join(' · ') : (halves[0] ?? '');
}

const EARLY_RANKS = '23456789TJQKA';
const EARLY_NAMES = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const earlyPlural = (r: number) => (EARLY_NAMES[r] === 'Six' ? 'Sixes' : EARLY_NAMES[r] + 's');

/**
 * What your cards make before there are five of them, for the tag on your cards on a phone: "Pair of Kings",
 * "Ace High". Only where every card you hold plays (Hold'em before the flop, stud's first streets): Omaha, draw
 * and low-only games have no early name, and `handStrength` names the hand once it can.
 */
export function earlyHand(gameId: string, hole: string[], board: string[]): string | null {
  let spec;
  try {
    spec = getVariant(gameId);
  } catch {
    return null;
  }
  const { high, low } = spec.showdown;
  if (!high || high === 'omaha' || low) return null;
  const cards = [...hole, ...board];
  if (!cards.length || cards.length >= 5 || cards.some((c) => c === '??')) return null;
  const ranks = cards.map((c) => EARLY_RANKS.indexOf(c[0].toUpperCase()));
  if (ranks.some((r) => r < 0)) return null;
  const count = new Map<number, number>();
  for (const r of ranks) count.set(r, (count.get(r) ?? 0) + 1);
  const groups = [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const [top, second] = groups;
  if (top[1] === 4) return `Four ${earlyPlural(top[0])}`;
  if (top[1] === 3) return `Three ${earlyPlural(top[0])}`;
  if (top[1] === 2 && second?.[1] === 2) return `Two Pair, ${earlyPlural(top[0])} and ${earlyPlural(second[0])}`;
  if (top[1] === 2) return `Pair of ${earlyPlural(top[0])}`;
  return `${EARLY_NAMES[Math.max(...ranks)]} High`;
}
