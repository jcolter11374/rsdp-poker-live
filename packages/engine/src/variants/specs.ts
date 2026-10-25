import type { StreetSpec } from '../core/types';
import type { VariantId, VariantSpec } from './types';

function flopStreets(holeCards: number): StreetSpec[] {
  return [
    { name: 'Preflop', dealDown: holeCards, dealUp: 0, dealBoard: 0, betSize: 'small' },
    { name: 'Flop', dealDown: 0, dealUp: 0, dealBoard: 3, betSize: 'small' },
    { name: 'Turn', dealDown: 0, dealUp: 0, dealBoard: 1, betSize: 'big' },
    { name: 'River', dealDown: 0, dealUp: 0, dealBoard: 1, betSize: 'big' },
  ];
}

const STUD_STREETS: StreetSpec[] = [
  { name: 'Third Street', dealDown: 2, dealUp: 1, dealBoard: 0, betSize: 'small' },
  { name: 'Fourth Street', dealDown: 0, dealUp: 1, dealBoard: 0, betSize: 'small' },
  { name: 'Fifth Street', dealDown: 0, dealUp: 1, dealBoard: 0, betSize: 'big' },
  { name: 'Sixth Street', dealDown: 0, dealUp: 1, dealBoard: 0, betSize: 'big' },
  { name: 'Seventh Street', dealDown: 1, dealUp: 0, dealBoard: 0, betSize: 'big' },
];

/** The draw happens before the betting on each street after the first. */
function drawStreets(cards: number): StreetSpec[] {
  return [
    { name: 'Before the Draw', dealDown: cards, dealUp: 0, dealBoard: 0, betSize: 'small' },
    { name: 'First Draw', dealDown: 0, dealUp: 0, dealBoard: 0, drawMaxDiscard: cards, betSize: 'small' },
    { name: 'Second Draw', dealDown: 0, dealUp: 0, dealBoard: 0, drawMaxDiscard: cards, betSize: 'big' },
    { name: 'Third Draw', dealDown: 0, dealUp: 0, dealBoard: 0, drawMaxDiscard: cards, betSize: 'big' },
  ];
}

/** 52 cards, 5 on the board, the rest shared out; capped at 10 seats. */
const flopMax = (holeCards: number) => Math.min(10, Math.floor(47 / holeCards));

const OMAHA_RULES =
  'Each player gets {n} private cards. Your hand must use exactly two of them and exactly three of the five board cards.';
const HI_LO_RULES =
  ' The pot is split between the best high hand and the best low hand. A low needs five different ranks of 8 or lower (aces are low; straights and flushes do not hurt it), and you may use different hole cards for each half. If nobody has a low, the high hand takes it all; an odd chip goes to the high half.';
const STUD_DEAL =
  'Each player gets two cards down and one up, then three more up cards one at a time, then a last card down. There are no blinds: everyone antes and the bring-in starts the betting. Make your best five-card hand from your seven cards.';

function omaha(id: VariantId, holeCards: number, hiLo: boolean): VariantSpec {
  const name = `${hiLo ? 'Pot-Limit Omaha Hi-Lo' : 'Pot-Limit Omaha'}${holeCards === 4 ? '' : ` (${holeCards}-card)`}`;
  return {
    id,
    name,
    shortName: `PLO${holeCards === 4 ? '' : holeCards}${hiLo ? (holeCards === 4 ? '8' : ' Hi-Lo') : ''}`,
    family: 'flop',
    streets: flopStreets(holeCards),
    maxPlayers: flopMax(holeCards),
    defaultBetting: 'pot-limit',
    split: hiLo ? 'hi-lo' : 'high',
    forcedBets: 'blinds',
    cardsPerPlayer: holeCards,
    showdown: hiLo ? { high: 'omaha', low: 'omaha-eight-or-better' } : { high: 'omaha' },
    rules: OMAHA_RULES.replace('{n}', String(holeCards)) + (hiLo ? HI_LO_RULES : ' Best high hand wins.'),
  };
}

const LIST: VariantSpec[] = [
  {
    id: 'nlhe',
    name: "No-Limit Texas Hold'em",
    shortName: 'NLH',
    family: 'flop',
    streets: flopStreets(2),
    maxPlayers: 10,
    defaultBetting: 'no-limit',
    split: 'high',
    forcedBets: 'blinds',
    cardsPerPlayer: 2,
    showdown: { high: 'any-five' },
    rules: 'Each player gets two private cards. Make your best five-card hand from any mix of your cards and the five board cards.',
  },
  omaha('plo4', 4, false),
  omaha('plo5', 5, false),
  omaha('plo6', 6, false),
  omaha('plo8', 4, true),
  omaha('plo5-8', 5, true),
  omaha('plo6-8', 6, true),
  {
    id: 'stud',
    name: 'Seven Card Stud',
    shortName: 'Stud',
    family: 'stud',
    streets: STUD_STREETS,
    maxPlayers: 8,
    defaultBetting: 'fixed-limit',
    split: 'high',
    forcedBets: 'ante-bring-in',
    cardsPerPlayer: 7,
    showdown: { high: 'any-five' },
    rules:
      STUD_DEAL +
      ' The lowest up card brings in (ties go to the lower suit: clubs, diamonds, hearts, spades). After that, the best hand showing acts first. Best high hand wins.',
  },
  {
    id: 'razz',
    name: 'Razz',
    shortName: 'Razz',
    family: 'stud',
    streets: STUD_STREETS,
    maxPlayers: 8,
    defaultBetting: 'fixed-limit',
    split: 'low',
    forcedBets: 'ante-bring-in',
    cardsPerPlayer: 7,
    showdown: { low: 'ace-to-five' },
    rules:
      'Stud, but the lowest hand wins. ' +
      STUD_DEAL +
      ' Aces are low and straights and flushes do not count, so 5-4-3-2-A is the best hand; pairs are bad. The highest up card brings in, and after that the lowest hand showing acts first.',
  },
  {
    id: 'stud8',
    name: 'Seven Card Stud Hi-Lo',
    shortName: 'Stud 8',
    family: 'stud',
    streets: STUD_STREETS,
    maxPlayers: 8,
    defaultBetting: 'fixed-limit',
    split: 'hi-lo',
    forcedBets: 'ante-bring-in',
    cardsPerPlayer: 7,
    showdown: { high: 'any-five', low: 'eight-or-better' },
    rules:
      STUD_DEAL +
      ' The pot is split between the best high hand and the best low hand. A low needs five different ranks of 8 or lower (aces are low; straights and flushes do not hurt it), and each half can use any five of your seven cards. If nobody has a low, the high hand takes it all. The lowest up card brings in; after that, the best high hand showing acts first.',
  },
  {
    id: 'td27',
    name: '2-7 Triple Draw',
    shortName: '2-7 TD',
    family: 'draw',
    streets: drawStreets(5),
    maxPlayers: 6,
    defaultBetting: 'fixed-limit',
    split: 'low',
    forcedBets: 'blinds',
    cardsPerPlayer: 5,
    showdown: { low: 'deuce-to-seven' },
    rules:
      'Each player gets five private cards, and there are three draws: each time, throw away any number of cards and get new ones. The lowest hand wins. Aces are high, and straights and flushes count against you, so the best hand is 7-5-4-3-2 in mixed suits.',
  },
  {
    id: 'badugi',
    name: 'Badugi',
    shortName: 'Badugi',
    family: 'draw',
    streets: drawStreets(4),
    maxPlayers: 6,
    defaultBetting: 'fixed-limit',
    split: 'low',
    forcedBets: 'blinds',
    cardsPerPlayer: 4,
    showdown: { low: 'badugi' },
    rules:
      'Each player gets four private cards, and there are three draws. You want four cards of different suits and different ranks (a badugi), as low as possible; aces are low, so 4-3-2-A in four suits is the best hand. Any four-card badugi beats any three-card hand. Repeated suits or ranks drop cards from your hand: count only the lowest cards that are all different.',
  },
];

export const VARIANTS: Record<VariantId, VariantSpec> = Object.fromEntries(LIST.map((s) => [s.id, s])) as Record<
  VariantId,
  VariantSpec
>;

export const VARIANT_LIST: readonly VariantSpec[] = LIST;

export function getVariant(id: string): VariantSpec {
  const spec = (VARIANTS as Record<string, VariantSpec>)[id];
  if (!spec) throw new Error(`unknown game: ${id}`);
  return spec;
}
