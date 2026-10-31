import type { HandEvent } from '@rsdp/engine/core';
import { getVariant, type VariantSpec } from '@rsdp/engine/variants';
import type { BotNote, CoachTip, HandRecordView, TableView } from '@rsdp/engine/wire';
import { eventLines, type Fmt } from './format';

/**
 * Every sentence of a coach tip and of the bots' reasons. The server sends
 * numbers only (CoachTip, BotNote); this file turns them into words, and works
 * out the facts worth knowing from what the player can already see. Plain
 * English, British spelling, and never the word "equity".
 */

/** Longest a name gets in a tip, and the tip's two lines (the panel is one bar high). */
export const NAME_CAP = 12;
export const VERDICT_CAP = 64;
export const BASIS_CAP = 110;
/** Line 2 shares its line with [Mark ...] on a draw turn, which takes about 30 characters' room: so it stays one line. */
export const MARK_BASIS_CAP = 80;

/** Under every set of bot reasons, once. */
export const NOTES_FOOTNOTE = 'Bots guess quickly, so their numbers can be 5 to 10% off. They never see your cards.';

const shortName = (name: string) => (name.length > NAME_CAP ? `${name.slice(0, NAME_CAP - 1)}…` : name);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : n === 3 ? 'three times' : `${n} times`);
const others = (n: number) => (n === 1 ? 'one other' : `${n} others`);
/** "[Kd]", "[Kd] and [9s]", "[Kd], [9s] and [8h]". */
const cardList = (cards: string[]) => {
  const c = cards.map((x) => `[${x}]`);
  return c.length < 2 ? c.join('') : `${c.slice(0, -1).join(', ')} and ${c.at(-1)}`;
};

function variant(gameId: string | undefined): VariantSpec | null {
  try {
    return gameId ? getVariant(gameId) : null;
  } catch {
    return null;
  }
}

/**
 * A chance in words, as roughly as the tip knows it: to the nearest 5% when
 * its standard error is 0.025 or less, else to the nearest 10%.
 */
export function chanceWords(share: number, se: number): string {
  if (share < 0.05) return 'under 5%';
  if (share > 0.95) return 'over 95%';
  if (se <= 0.025) return `about ${clamp(Math.round(share * 20) * 5, 5, 95)}%`;
  return `roughly ${clamp(Math.round(share * 10) * 10, 10, 90)}%`;
}

/** How often, for a chance: "4 times in 5", "3 times in 4", "about 1 time in 14", "2 times in 5". */
export function oftenWords(p: number): string {
  if (!(p > 0)) return 'never';
  if (p >= 0.995) return 'every time';
  // Small chances read best as 1 time in d, when that is close; the rest as halves to tenths.
  if (p < 0.5) {
    const d = Math.round(1 / p);
    if (Math.abs(1 / d - p) <= 0.05 * p) return `${Math.abs(1 / d - p) < 0.001 ? '' : 'about '}${timesIn(1, d)}`;
  }
  const ways = (p < 0.5 ? [2, 3, 4, 5, 6, 7, 8, 9, 10] : [2, 3, 4, 5, 10]).map((d) => ({ n: Math.max(1, Math.round(p * d)), d })).map((w) => ({ ...w, off: Math.abs(w.n / w.d - p) }));
  const exact = ways.find((w) => w.off < 0.001);
  if (exact) return timesIn(exact.n, exact.d);
  const near = ways.reduce((a, b) => (b.off < a.off ? b : a));
  return `about ${timesIn(near.n, near.d)}`;
}

/**
 * How often a call has to win to pay, for "pays off if you win more than
 * ...": never rounded down, so a call never looks cheaper than it is. "2 times
 * in 5", "about 3 times in 10" (for 29%), "1 time in 14".
 */
export function breakEvenWords(p: number): string {
  if (!(p > 0)) return 'never';
  if (p >= 0.995) return 'every time';
  // At or just above p: n/d with n rounded up for small denominators, and 1 time in d for small chances.
  const ways = [2, 3, 4, 5, 6, 7, 8, 9, 10].map((d) => ({ n: Math.ceil(p * d - 1e-9), d }));
  if (Math.floor(1 / p) > 10) ways.push({ n: 1, d: Math.floor(1 / p) });
  const usable = ways.filter((w) => w.n < w.d);
  if (!usable.length) return `${Math.ceil(p * 100)}% of the time`;
  const best = usable.reduce((a, b) => (b.n / b.d - p < a.n / a.d - p - 1e-9 ? b : a));
  return `${best.n / best.d - p < 0.001 ? '' : 'about '}${timesIn(best.n, best.d)}`;
}

const timesIn = (n: number, d: number) => `${n} ${n === 1 ? 'time' : 'times'} in ${d}`;

// ---------------------------------------------------------------- tips

export interface TipText {
  /** Line 1, bold: the chance, the cost and what to do. Cards are written [Kd]. */
  verdict: string;
  /** Line 2, muted: what the chance is based on. */
  basis: string;
  /** The Why sheet, a section at a time; empty sections are left out. */
  why: { title: string; lines: string[] }[];
  /** [Set N]: puts the suggested amount in the bet box (no-limit and pot-limit). */
  set: { to: number; label: string } | null;
  /** [Mark [Kd]]: picks the suggested cards to throw. */
  mark: { discard: number[]; label: string } | null;
}

/** What the player sees: names, their own cards, everyone's up cards. */
function seen(view: TableView) {
  const hand = view.hand;
  const mySeat = view.me.seat;
  const me = mySeat !== null ? view.seats[mySeat] : null;
  const name = (seat: number) => shortName(hand?.names?.[seat] ?? view.seats[seat]?.name ?? `Seat ${seat + 1}`);
  return { hand, mySeat, mine: (me?.cards ?? []).map((c) => c.card), name };
}

const randomHands = (n: number) => (n === 1 ? 'a random hand' : `${n} random hands`);

/** "About 50% to win" or "About 45% of the pot". */
const chanceTo = (tip: CoachTip, share = tip.share) => `${capital(chanceWords(share, tip.se))} ${tip.split ? 'of the pot' : 'to win'}`;

function verb(tip: CoachTip, view: TableView, fmt: Fmt): string {
  const m = tip.move;
  const facing = tip.call > 0 && tip.rule !== 'bring-in' && tip.rule !== 'complete';
  if (tip.close && facing && (m.type === 'call' || m.type === 'fold')) return 'close, call or fold';
  switch (m.type) {
    case 'fold':
    case 'check':
    case 'call':
      return m.type;
    case 'bring-in':
      return `bring it in for ${fmt(view.hand?.stakes.bringIn ?? 0)}`;
    case 'bet':
    case 'raise':
    case 'complete':
      if (m.allIn) return `go all in (${fmt(m.to)})`;
      if (m.type === 'complete') return `complete to ${fmt(m.to)}`;
      if (m.type === 'raise') return `raise to ${fmt(m.to)}`;
      return m.fraction ? `bet ${m.fraction === 0.5 ? '½' : '¾'} pot (${fmt(m.to)})` : `bet ${fmt(m.to)}`;
    case 'draw':
      return m.discard.length ? `draw ${m.discard.length}` : 'stand pat';
  }
}

function verdictOf(tip: CoachTip, view: TableView, fmt: Fmt, mine: string[]): { verdict: string; movedDraws: string } {
  if (tip.move.type === 'draw') {
    const d = tip.move.discard;
    const from = `${chanceTo(tip)} from here.`;
    if (!d.length) return { verdict: `Stand pat. ${from}`, movedDraws: '' };
    const cards = (keep: boolean) => cardList(mine.filter((c, i) => isCard(c) && d.includes(i) !== keep));
    // Throwing most of a hand is shorter told by what stays.
    const forms = [
      `Draw ${d.length}: throw the ${cards(false)}. ${from}`,
      d.length < mine.length ? `Draw ${d.length}: keep the ${cards(true)}. ${from}` : `Draw ${d.length}: throw them all. ${from}`,
      `Draw ${d.length}. ${from}`,
    ];
    return { verdict: forms.find((f) => f.length <= VERDICT_CAP) ?? forms.at(-1)!, movedDraws: '' };
  }
  const v = verb(tip, view, fmt);
  const bringIn = tip.rule === 'bring-in' || tip.rule === 'complete';
  const draws = tip.drawsLeft > 0 && !bringIn ? `with ${tip.drawsLeft} ${tip.drawsLeft === 1 ? 'draw' : 'draws'} to come` : '';
  const cost = bringIn ? ` against ${others(tip.opponents)}` : tip.call > 0 && tip.cost !== null ? `, the call costs ${pct(tip.cost)}` : ', nothing to call';
  // The longest form first; one that doesn't fit the panel moves the draws to line 2, then drops the cost (the Why sheet has it).
  const forms = [`${chanceTo(tip)}${draws && ` ${draws}`}${cost}: ${v}.`, `${chanceTo(tip)}${cost}: ${v}.`, `${chanceTo(tip)}: ${v}.`, `${capital(v)}.`];
  const verdict = forms.find((f) => f.length <= VERDICT_CAP) ?? forms.at(-1)!;
  return { verdict, movedDraws: draws && !verdict.includes(draws) ? `${capital(draws)}.` : '' };
}

/** What a lowball opponent's draws say about their hand: "Bo stood pat twice, so Bo probably has a made hand." */
function drawsSentence(name: string, done: (number | null)[], badugi: boolean): string | null {
  const known = done.filter((n): n is number => n !== null);
  if (!known.length) return null;
  const made = `${badugi ? ':' : ', so'} ${name} probably ${badugi ? 'holds a badugi' : 'has a made hand'}.`;
  // Stood pat at the last draw (and maybe the ones before): a made hand.
  let pats = 0;
  while (pats < known.length && known[known.length - 1 - pats] === 0) pats++;
  const drew = known.slice(0, known.length - pats).filter((n) => n > 0);
  const patted = `stood pat${pats > 1 ? ` ${times(pats)}` : ''}`;
  if (pats && !drew.length) return `${name} ${patted}${made}`;
  if (pats) return `${name} drew ${drew.join(', ')}, then ${patted}${made}`;
  const list = drew.length < 2 ? `${drew[0]}` : `${drew.slice(0, -1).join(', ')}, then ${drew.at(-1)}`;
  return `${name} drew ${list}: still looking for a hand.`;
}

/** Up to `cap` characters of the sentences, whole sentences only, in order. */
const fit = (sentences: string[], cap: number) =>
  sentences.filter(Boolean).reduce((out, s) => (!out ? (s.length <= cap ? s : out) : `${out} ${s}`.length <= cap ? `${out} ${s}` : out), '');

function basisOf(tip: CoachTip, view: TableView, name: (seat: number) => string, movedDraws: string, cap = BASIS_CAP): string {
  const chance = (x: number) => chanceWords(x, tip.se);
  const scoop = tip.scoop !== null && tip.kind === 'bet' ? `The whole pot ${chance(tip.scoop)} of the time.` : '';
  const lead: string[] = [movedDraws];
  // The rules that change the verdict explain it first.
  if (tip.rule === 'fold-big' && tip.need !== null) return fit([...lead, `This call is half your chips or more, so the tip wants a margin: about ${pct(tip.need)}.`], cap);
  if (tip.rule === 'call-capped') return fit([...lead, 'After 3 raises the tip raises again only with a very strong hand.'], cap);
  if (tip.rule === 'raise-field') {
    const n = tip.opponents;
    return fit([...lead, `Against ${others(n)} an even share is ${pct(1 / (n + 1))}, and you have more than twice that.`, scoop], cap);
  }
  const badugi = view.hand?.gameId === 'badugi';
  // Someone who stood pat says most, then whoever drew fewest last time.
  const drawn = tip.draws
    .map((d) => ({ d, known: d.done.filter((n): n is number => n !== null) }))
    .filter((x) => x.known.length)
    .sort((a, b) => a.known.at(-1)! - b.known.at(-1)!)
    .map((x) => drawsSentence(name(x.d.seat), x.d.done, badugi))
    .filter((s): s is string => !!s);
  const readers = tip.reads.filter((r) => r.bets > 0).map((r) => name(r.seat));
  if (readers.length) {
    const who = readers.length === 1 ? `${readers[0]} has` : readers.length === 2 ? `${readers[0]} and ${readers[1]} have` : `${readers.length} players have`;
    const random = tip.vsRandom !== null && Math.abs(tip.vsRandom - tip.share) >= 0.05 ? `Against ${randomHands(tip.vs)} you'd have ${chance(tip.vsRandom)}.` : '';
    // In lowball the draws count too, so the gap to random hands isn't all down to the betting.
    return fit([...lead, `Counting how ${who} bet this hand.`, drawn[0] ?? '', random, scoop], cap);
  }
  if (drawn.length) return fit([...lead, ...drawn.slice(0, 2)], cap);
  return fit([...lead, `Against ${randomHands(tip.vs)}: nobody still in has bet or raised.`, scoop], cap);
}

/** Roughly how many finishes the tip dealt out, from its standard error (se = sqrt(max(p(1-p), .01) / n)). */
function dealsOf(tip: CoachTip): number | null {
  if (!(tip.se > 0)) return null;
  const n = Math.max(tip.share * (1 - tip.share), 0.01) / tip.se ** 2;
  const digits = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / digits) * digits;
}

function whyOf(tip: CoachTip, view: TableView, fmt: Fmt, name: (seat: number) => string, facts: Fact[]): TipText['why'] {
  const chance = (x: number) => chanceWords(x, tip.se);
  const sections: TipText['why'] = [];
  const legal = view.legal;

  const maths: string[] = [];
  if (tip.kind === 'bet' && (tip.rule === 'bring-in' || tip.rule === 'complete')) {
    const complete = legal?.canBringIn && legal.canRaise ? `, or complete to ${fmt(legal.minTo)}` : '';
    const bringIn = fmt(view.hand?.stakes.bringIn ?? 0);
    // Only the card that has to bring in can't fold; when it's all in from the ante, the next player opens and may fold.
    maths.push(
      legal?.canFold
        ? `You start the betting because the player who had to bring in is all in: bring it in for ${bringIn}${complete}, or fold. The tip completes only with a strong start.`
        : `You must start the betting: bring it in for ${bringIn}${complete}. The tip completes only with a strong start.`,
    );
  } else if (tip.kind === 'bet' && tip.call > 0 && tip.cost !== null) {
    const after = tip.pot + tip.call;
    maths.push(`The pot will be ${fmt(after)} once you call ${fmt(tip.call)}. ${fmt(tip.call)} is ${pct(tip.cost)} of ${fmt(after)}, so calling pays off over time if you win more than ${breakEvenWords(tip.cost)}.`);
    if (tip.need !== null && tip.big) maths.push(`This call is half your chips or more, so the tip wants a margin: about ${pct(tip.need)}.`);
    else if (tip.need !== null) maths.push(`The tip calls from about ${pct(tip.need)}, a little over the cost, because its chance is only a guess.`);
    if (tip.rule === 'raise' || tip.rule === 'raise-field') maths.push('The tip raises from about 70%, or with more than twice an even share against several players.');
    if (tip.rule === 'call-capped') maths.push('After 3 raises the tip raises again only with a very strong hand.');
  } else if (tip.kind === 'bet') {
    maths.push(`Nothing to call, so checking is free. The pot is ${fmt(tip.pot)}.`);
    maths.push('The tip bets from about 60% to win, or with about 1.5 times an even share against more players, so worse hands can pay you.');
  }
  if (maths.length) sections.push({ title: 'The maths', lines: maths });

  const readers = tip.reads.filter((r) => r.bets > 0).map((r) => name(r.seat));
  const lowball = tip.draws.some((d) => d.done.some((n) => n !== null));
  const giving = readers.length
    ? readers.length === 1
      ? `giving ${readers[0]} hands that fit how ${readers[0]} has bet${lowball ? ' and drawn' : ''}`
      : `giving the players still in hands that fit how they have bet${lowball ? ' and drawn' : ''}`
    : lowball
      ? 'giving the others hands that fit how many cards they drew'
      : 'giving everyone else random hands';
  const deals = dealsOf(tip);
  const dealt = deals ? `${deals.toLocaleString('en-GB')} times` : 'many times';
  const chanceLines = [
    tip.kind === 'draw'
      ? `${chanceTo(tip)} from here. The tip compared the best ways to draw, dealing out the cards you can't see ${dealt} for each and ${giving}.`
      : `${chanceTo(tip)}. The tip dealt out the cards you can't see ${dealt}, ${giving}.`,
  ];
  if (tip.vsRandom !== null && Math.abs(tip.vsRandom - tip.share) >= 0.05) chanceLines.push(`Against ${randomHands(tip.vs)} you'd have ${chance(tip.vsRandom)}.`);
  if (tip.scoop !== null) chanceLines.push(`That counts the times you'd split it: you'd win the whole pot ${chance(tip.scoop)} of the time.`);
  sections.push({ title: 'Your chance', lines: chanceLines });

  if (tip.kind === 'draw' && tip.options.length) {
    const { mine } = seen(view);
    const counts = tip.options.map((o) => o.discard.length);
    const label = (d: number[]) => {
      const base = d.length ? `Draw ${d.length}` : 'Stand pat';
      // Two ways that throw as many cards are told apart by the cards.
      return d.length && counts.filter((n) => n === d.length).length > 1 ? `${base} ${d.map((i) => `[${mine[i]}]`).join('')}` : base;
    };
    sections.push({ title: 'Ways to draw', lines: [tip.options.map((o) => `${label(o.discard)}: ${chance(o.share)}`).join(' · ')] });
  }
  if (facts.length) sections.push({ title: 'Worth knowing', lines: facts.map((f) => f.text) });
  sections.push({
    title: 'What the tip can’t know',
    lines: [
      "It never sees anyone else's cards or the deck. It doesn't count bets still to come, or that a bet might be a bluff. It plays like a Normal bot that never bluffs. Use it as a guide, not a rule.",
    ],
  });
  return sections;
}

/** A coach tip in words: the verdict, its basis, the Why sheet, and the Set and Mark helpers. */
export function tipText(tip: CoachTip, view: TableView, fmt: Fmt): TipText {
  const { mine, name } = seen(view);
  const { verdict, movedDraws } = verdictOf(tip, view, fmt, mine);
  const m = tip.move;
  const sized = view.hand?.betting !== 'fixed-limit';
  const mark =
    m.type === 'draw' && m.discard.length && m.discard.every((i) => mine[i] && mine[i] !== '??')
      ? { discard: m.discard, label: `Mark ${m.discard.map((i) => `[${mine[i]}]`).join(' ')}` }
      : null;
  return {
    verdict,
    basis: basisOf(tip, view, name, movedDraws, mark ? MARK_BASIS_CAP : BASIS_CAP),
    why: whyOf(tip, view, fmt, name, coachFacts(view, tip, fmt)),
    set: (m.type === 'bet' || m.type === 'raise' || m.type === 'complete') && sized ? { to: m.to, label: `Set ${fmt(m.to)}` } : null,
    mark,
  };
}

// ---------------------------------------------------------------- facts

export type FactCode = 'throw' | 'omaha-two' | 'high-only' | 'no-low' | 'live-cards' | 'flush-draw' | 'two-boards' | 'crowded' | 'side-pot';
export interface Fact {
  code: FactCode;
  text: string;
}

const RANKS = '23456789TJQKA';
const RANK_WORD: Record<string, string> = { A: 'ace', K: 'king', Q: 'queen', J: 'jack', T: 'ten' };
const RANK_PLURAL: Record<string, string> = { A: 'aces', K: 'kings', Q: 'queens', J: 'jacks', T: '10s' };
const SUIT_PLURAL: Record<string, string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const NUMBER_WORD = ['No', 'One', 'Two', 'Three', 'Four', 'Five'];
const plural = (rank: string) => RANK_PLURAL[rank] ?? `${rank}s`;
const article = (rank: string) => (rank === 'A' || rank === '8' ? 'An' : 'A');
const isCard = (c: string | undefined): c is string => !!c && /^[2-9TJQKA][cdhs]$/.test(c);
/** Aces count as low in 8 or better. */
const lowRank = (c: string) => 'A2345678'.includes(c[0]);

/** Why the tip throws each card it throws, in 2-7 and Badugi. */
function throwFacts(game: 'td27' | 'badugi', mine: string[], discard: number[]): string[] {
  const out: string[] = [];
  const kept = mine.filter((_, i) => !discard.includes(i));
  const where = game === 'td27' ? '2-7' : 'Badugi';
  for (const i of discard.slice(0, 3)) {
    const c = mine[i];
    if (!isCard(c)) continue;
    // A kept card first: that's the one the thrown card clashes with.
    const rest = [...kept, ...mine.filter((_, j) => j !== i && discard.includes(j))].filter(isCard);
    const pair = rest.find((k) => k[0] === c[0]);
    const suited = rest.find((k) => k[1] === c[1]);
    if (pair) out.push(game === 'td27' ? `Your [${c}] pairs your [${pair}], and in 2-7 a pair loses to five different cards that aren't a straight or flush.` : `Your [${c}] pairs your [${pair}]; only one can count.`);
    else if (game === 'td27' && c[0] === 'A') out.push('Aces are high in 2-7, not low.');
    else if (game === 'badugi' && suited) {
      const lower = kept.includes(suited) && 'A23456789TJQK'.indexOf(suited[0]) < 'A23456789TJQK'.indexOf(c[0]);
      out.push(`Your [${c}] shares ${SUIT_PLURAL[c[1]]} with your [${suited}]; only one can count${lower ? ', so keep the lower one' : ''}.`);
    } else if ('JQK'.includes(c[0])) out.push(`${article(c[0])} ${RANK_WORD[c[0]]} is far too high in ${where}.`);
    else if (c[0] === 'T') out.push(`A ten is too high in ${where}.`);
  }
  // A straight or flush counts against a 2-7 hand, whichever card breaks it.
  if (game === 'td27' && mine.length === 5 && mine.every(isCard) && discard.length) {
    const values = [...new Set(mine.map((c) => RANKS.indexOf(c[0])))];
    if (values.length === 5 && Math.max(...values) - Math.min(...values) === 4) out.push('Your five cards make a straight, and in 2-7 straights count against you.');
    if (new Set(mine.map((c) => c[1])).size === 1) out.push('Your five cards are all one suit, and in 2-7 a flush counts against you.');
  }
  return out;
}

/**
 * Facts worth knowing about this decision, worked out from what the player can
 * already see: their own cards, the boards and the up cards (folded players'
 * too), plus the cards the tip throws and its own numbers.
 */
export function coachFacts(view: TableView, tip: CoachTip, fmt: Fmt = String): Fact[] {
  const { hand, mySeat, mine: all } = seen(view);
  if (!hand || mySeat === null) return [];
  const spec = variant(hand.gameId);
  const mine = all.filter(isCard);
  const boards = hand.boards[0] ?? [];
  const board = (boards[0] ?? []).filter(isCard);
  const facts: Fact[] = [];
  const add = (code: FactCode, text: string) => facts.push({ code, text });

  if (tip.move.type === 'draw' && (hand.gameId === 'td27' || hand.gameId === 'badugi')) for (const t of throwFacts(hand.gameId, all, tip.move.discard)) add('throw', t);

  const suits = (cards: string[], s: string) => cards.filter((c) => c[1] === s).length;
  if (spec?.showdown.high === 'omaha' && boards.length === 1) {
    for (const s of 'cdhs') {
      const onBoard = suits(board, s);
      if (onBoard >= 3 && suits(mine, s) === 1) add('omaha-two', `${NUMBER_WORD[onBoard]} ${SUIT_PLURAL[s]} on the board, but you hold only one: in Omaha you need two from your hand.`);
    }
  }

  const hiLo = spec?.split === 'hi-lo';
  if (hiLo && mine.length && !mine.some(lowRank)) add('high-only', "You have no cards 8 or lower, so you're playing for high: if someone makes a low you win half at best.");
  if (hiLo && spec.family === 'flop' && boards.length === 1) {
    const toCome = spec.streets.reduce((n, st) => n + st.dealBoard, 0) - board.length;
    if (new Set(board.filter(lowRank).map((c) => c[0])).size + toCome < 3) add('no-low', "No low this hand: the board can't make three different cards 8 or lower.");
  }

  if (spec?.family === 'stud' && spec.split !== 'low') {
    // Every card dealt face up to someone else, folded players' too.
    const elsewhere = new Set<string>();
    for (const e of hand.events) if (e.t === 'deal' && e.seat !== mySeat) for (const c of e.cards) if (isCard(c.card)) elsewhere.add(c.card);
    view.seats.forEach((s, i) => i !== mySeat && s?.cards.forEach((c) => isCard(c.card) && elsewhere.add(c.card)));
    const counts = new Map<string, number>();
    for (const c of mine) counts.set(c[0], (counts.get(c[0]) ?? 0) + 1);
    const pair = [...RANKS].reverse().find((r) => counts.get(r) === 2);
    if (pair) {
      const out = [...elsewhere].filter((c) => c[0] === pair).length;
      const name = plural(pair);
      add(
        'live-cards',
        out === 0
          ? `Neither of the other two ${name} is showing, so both are still live.`
          : out === 1
            ? `One of the other two ${name} is showing, so only one is still live.`
            : `Two ${name} are showing elsewhere, so you can't get a third.`,
      );
    }
  }

  if (spec?.family === 'flop' && spec.split === 'high' && boards.length === 1 && board.length >= 3 && board.length < 5) {
    for (const s of 'cdhs') {
      const inHand = suits(mine, s);
      const onBoard = suits(board, s);
      const draw = spec.showdown.high === 'omaha' ? inHand >= 2 && onBoard === 2 : inHand >= 1 && inHand + onBoard === 4;
      if (draw) add('flush-draw', `Flush draw: ${13 - inHand - onBoard} ${SUIT_PLURAL[s]} are still unseen.`);
    }
  }

  if (boards.length > 1) add('two-boards', 'Two boards: each is worth half the pot.');
  if (tip.vs < tip.opponents) add('crowded', `The deck can only deal out ${tip.vs} of the ${tip.opponents} hands, so your real chance is a little lower.`);
  // The tip leaves out chips the player can't match, so it can't win them.
  if (tip.kind === 'bet' && tip.pot < hand.potTotal) add('side-pot', `Your chips don't cover every bet, so you can win only ${fmt(tip.pot)} of the ${fmt(hand.potTotal)} in the middle.`);
  return facts;
}

// ---------------------------------------------------------------- bot reasons

/** What the reason can't tell from the note alone. */
export interface NoteContext {
  /** The game, for which card brings it in. */
  gameId?: string;
  /** The move it explains (the action event), for "bet" or "raised". */
  action?: string;
  /** Hard's read of you: how you bet or raised this hand ("raised", "bet or raised"). */
  yourVerb?: string;
}

const PAST: Record<string, string> = { bet: 'bet', raise: 'raised', complete: 'completed' };

/** One practice bot's move in words, from its own rough numbers. Empty for a rule it doesn't know. */
export function noteText(note: BotNote, name: string, ctx: NoteContext = {}): string {
  const who = `${name}${note.level === 'easy' ? ' (Easy)' : note.level === 'hard' ? ' (Hard)' : ''}`;
  const share = note.share;
  const about = share === undefined ? '' : share < 0.05 ? 'under 5%' : share > 0.95 ? 'over 95%' : `about ${Math.round(share * 100)}%`;
  const chance = about && `${about} ${note.split ? 'of the pot' : 'to win'}`;
  const cost = note.cost === undefined ? '' : pct(note.cost);
  // What it did, from the move itself: checked to, it bets (or raises a big blind's option); facing a bet, it raises.
  const did = PAST[ctx.action ?? ''] ?? 'bet';
  const raised = PAST[ctx.action ?? ''] ?? 'raised';
  const read = note.yourBets ? `you ${ctx.yourVerb ?? 'bet or raised'} ${times(note.yourBets)} this hand, so it played you for a strong hand. ` : '';
  const foldsOften = note.you === 'folds-often';
  switch (note.rule) {
    case 'call': {
      if (!chance || !cost) return '';
      if (note.capped && share! >= 0.7) return note.level === 'easy' ? `${who} just called: Easy bots stop raising after 3 raises.` : `${who} just called: after 3 raises it raises again only with a very strong hand.`;
      const last = note.last ? ' It acts last, so it calls a little wider while cards are still to come.' : '';
      return read ? `${who} called: ${read}${capital(chance)}, and the call cost ${cost}.${last}` : `${who} called: it guessed ${chance}, and the call cost ${cost}.${last}`;
    }
    case 'call-loose':
      if (!about || !cost) return '';
      return `${who} called with ${about} though the call cost ${cost}: Easy bots call small bets a little too often.`;
    case 'fold': {
      if (!chance || !cost) return '';
      const big = note.big ? ' The call was half its chips, so it wanted more.' : share! >= note.cost! ? ' Bots want a little more than the call costs.' : '';
      return read ? `${who} folded: ${read}${capital(chance)}, and the call cost ${cost}.${big}` : `${who} folded: it guessed ${chance}, and the call cost ${cost}.${big}`;
    }
    case 'check':
      if (!chance) return '';
      if (note.level === 'easy') return `${who} checked with ${chance}: Easy bots bet only good hands, and not every time.`;
      if (note.level === 'hard') return `${who} checked: ${chance} isn't enough to bet for value.`;
      return `${who} checked: ${chance} isn't enough to bet. Normal bots bet from about 60%, or with about 1.5 times an even share against more players.`;
    case 'value': {
      if (!chance) return '';
      if (note.you === 'calls-often') return `${who} ${did}: ${chance}, and you call a lot of bets, so it bets slightly weaker hands against you.`;
      const often = note.often ? ` (it bets hands like this ${oftenWords(note.often)})` : '';
      return `${who} ${did}: ${chance}, so it ${did} to get paid by worse hands${often}.`;
    }
    case 'bluff': {
      if (note.level === 'hard' && foldsOften) return `${who} bluffed: you've folded to a lot of bets lately, so bluffs pay against you.`;
      if (!chance) return '';
      const lead = `${who} ${did} with ${chance}: a bluff.`;
      if (note.level === 'hard') {
        const often = note.often ? ` It bluffs here ${oftenWords(note.often)}.` : '';
        return `${lead} Hard bots bluff more against players who fold a lot${note.last ? ', and more when they act last' : ''}.${often}`;
      }
      const often = note.often ? ` ${oftenWords(note.often)} when one player is left after the first round` : ' now and then';
      return `${lead} Normal bots bluff${often}, so a bet doesn't always mean a strong hand.`;
    }
    case 'semi-bluff':
      if (!chance) return '';
      return foldsOften
        ? `${who} ${raised} with ${chance}: a semi-bluff. You've folded to a lot of bets lately, and its hand can still improve if you call.`
        : `${who} ${raised} with ${chance}: a semi-bluff. It wins the pot now if its opponent folds, and its hand can still improve.`;
    case 'raise': {
      if (!chance) return '';
      const often = note.often ? ` (it ${raised === 'completed' ? 'completes' : 'raises'} hands like this ${oftenWords(note.often)})` : '';
      return `${who} ${raised}: it guessed ${chance}${often}.`;
    }
    case 'steal':
      return foldsOften
        ? `${who} completed to steal the antes: few players were left, and you've folded to a lot of bets lately.`
        : `${who} completed to steal the antes: few players were left, and they fold a lot.`;
    case 'bring-in':
      return `${who} brought it in: ${ctx.gameId === 'razz' ? 'highest' : 'lowest'} card showing and nothing worth completing.`;
    case 'complete':
      if (!chance) return '';
      return `${who} completed: a strong start, ${chance}${note.vs ? ` against ${others(note.vs)}` : ''}.`;
    case 'draw': {
      if (!about || !note.thrown) return '';
      const alt = note.alt;
      const other = !alt
        ? ''
        : alt.thrown === 0
          ? `, standing pat at about ${Math.round(alt.share * 100)}%`
          : `, ${alt.thrown === note.thrown ? `a different ${alt.thrown}` : `drawing ${alt.thrown}`} at about ${Math.round(alt.share * 100)}%`;
      return `${who} drew ${note.thrown}: drawing ${note.thrown} came out at ${about}${other}.`;
    }
    case 'pat':
      if (!chance) return '';
      return `${who} stood pat: ${chance} as it is.`;
    case 'rit-yes':
      return 'Bots always say yes to running it twice.';
    case 'fallback':
      return `${who} couldn't decide, so the table checked or folded for it.`;
    default:
      return '';
  }
}

/** A note in words, with what the hand around it says (the game, the move, how you bet before it). */
export function explainNote(hand: HandRecordView, note: BotNote, name: (seat: number) => string, mySeat: number | null): string {
  const start = hand.events.find((e): e is Extract<HandEvent, { t: 'hand-start' }> => e.t === 'hand-start');
  const event = hand.events[note.seq];
  const mine =
    mySeat === null
      ? []
      : hand.events
          .slice(0, note.seq)
          .filter((e): e is Extract<HandEvent, { t: 'action' }> => e.t === 'action' && e.seat === mySeat && !e.auto && (e.action === 'bet' || e.action === 'raise' || e.action === 'complete'));
  const kinds = new Set(mine.map((e) => e.action));
  const yourVerb = kinds.size === 1 ? PAST[[...kinds][0]] : undefined;
  return noteText(note, name(note.seat), { gameId: start?.gameId, action: event?.t === 'action' ? event.action : undefined, yourVerb });
}

/**
 * A finished hand's log lines, each with the reasons for the bot moves on it.
 * A note goes under the line its event wrote (the last line written by the
 * events up to it).
 */
export function linesWithWhy(hand: HandRecordView, name: (seat: number) => string, fmt: Fmt, mySeat: number | null): { text: string; why: string[] }[] {
  const lines = eventLines(hand.events, name, fmt, mySeat).map((text) => ({ text, why: [] as string[] }));
  const notes = [...(hand.botNotes ?? [])].sort((a, b) => a.seq - b.seq);
  for (const note of notes) {
    if (!Number.isInteger(note.seq) || note.seq < 0 || note.seq >= hand.events.length) continue;
    const at = eventLines(hand.events.slice(0, note.seq + 1), name, fmt, mySeat).length - 1;
    const text = at >= 0 ? explainNote(hand, note, name, mySeat) : '';
    if (text) lines[at].why.push(text);
  }
  return lines;
}
