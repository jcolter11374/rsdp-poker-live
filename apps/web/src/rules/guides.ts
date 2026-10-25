import type { HighRule, LowRule } from '@rsdp/engine/variants';

/*
 * Plain-language guides for each game, for players still learning them. The
 * example hands are real cards: rules.test.ts checks every ranking and
 * "which hand wins" example against the engine's evaluators, so a guide can
 * never teach something the table would score differently.
 */

/** Cards as space-separated codes, e.g. 'As Kd'. */
export type CardList = string;

export interface ExampleHand {
  cards: CardList;
  /** Flop games: the board the hand plays with. */
  board?: CardList;
  label: string;
}

export interface Showdown {
  a: { name: string; cards: CardList };
  b: { name: string; cards: CardList };
  /** Shared by both hands in flop games. */
  board?: CardList;
  /** Which half of a split pot this example is about. */
  half?: 'high' | 'low';
  winner: 'a' | 'b' | 'tie';
  why: string;
}

export interface Guide {
  id: string;
  name: string;
  /** Variant ids this guide covers. */
  games: string[];
  /** The whole game in one or two sentences. */
  idea: string;
  /** How one hand goes, start to finish. */
  steps: string[];
  /** What wins at showdown. */
  goal: string;
  /** How the evaluators score this game's hands (one or both halves). */
  scoring: { high?: HighRule; low?: LowRule };
  /** Hands from best to worst, scored with `ladderRule`. */
  ladder: { title: string; rule: { high: HighRule } | { low: LowRule }; hands: ExampleHand[]; note?: string };
  showdowns: Showdown[];
  tips: string[];
  mistakes: string[];
}

const HIGH_LADDER: ExampleHand[] = [
  { cards: '9h 8h 7h 6h 5h', label: 'Straight flush: five in a row, all one suit' },
  { cards: 'Qs Qh Qd Qc 4s', label: 'Four of a kind' },
  { cards: 'Ks Kd Kc 7h 7d', label: 'Full house: three of a kind plus a pair' },
  { cards: 'Ad Jd 8d 6d 2d', label: 'Flush: five of one suit' },
  { cards: 'Tc 9d 8s 7h 6c', label: 'Straight: five in a row' },
  { cards: '8s 8h 8d Kc 3s', label: 'Three of a kind' },
  { cards: 'Js Jd 5c 5h Ad', label: 'Two pair' },
  { cards: 'As Ah Qd 9c 4s', label: 'One pair' },
  { cards: 'Ac Qd 9h 6s 3c', label: 'High card: nothing at all' },
];

const HIGH_NOTE = 'An ace can be high (A-K-Q-J-10) or low (5-4-3-2-A) in a straight. Suits never break a tie.';

const STUD_STEPS = (bringIn: string, firstToAct: string) => [
  'Everyone puts in an ante. There are no blinds and no dealer button.',
  `Third street: you get two cards face down and one face up. ${bringIn} They can bring it in for the small forced amount, or complete it to a full small bet. Betting then goes round to the left.`,
  `Fourth street: one more card face up, then a round of betting at the small bet. From here on, ${firstToAct} acts first.`,
  'Fifth street: another up card. Bets double to the big bet from here to the end.',
  'Sixth street: one more up card and another round at the big bet.',
  'Seventh street (the river): your last card comes face down, then the last round of betting and the showdown.',
];

const STUD_NOTE_DECK =
  'Up to eight players. If eight players all reach seventh street the deck runs short, so one card is dealt face up in the middle and everyone shares it.';

const DRAW_STEPS = (cards: number) => [
  'The two players left of the button post the small and big blinds.',
  `Everyone gets ${cards} cards face down. A round of betting starts with the player left of the big blind.`,
  `First draw: starting left of the button, each player throws away any number of cards (0 to ${cards}) and gets that many new ones. Keeping all your cards is called standing pat.`,
  'A round of betting, starting with the first player still in on the left of the button.',
  'Second draw, then a round of betting at the big bet.',
  'Third draw, then the last round of betting at the big bet, then the showdown.',
];

export const GUIDES: Guide[] = [
  {
    id: 'stud',
    name: 'Seven Card Stud',
    games: ['stud'],
    idea: 'No community cards: everyone gets their own seven cards, some face down and some face up for the table to see. Best five-card poker hand wins.',
    steps: [
      ...STUD_STEPS(
        'The player with the lowest up card must bring in (aces count high; on a tie, clubs are lowest, then diamonds, hearts, spades).',
        'whoever has the best poker hand showing on their up cards',
      ),
      STUD_NOTE_DECK,
    ],
    goal: 'The best five-card poker hand out of your seven cards wins the whole pot.',
    scoring: { high: 'any-five' },
    ladder: { title: 'Poker hands, best first', rule: { high: 'any-five' }, hands: HIGH_LADDER, note: HIGH_NOTE },
    showdowns: [
      {
        a: { name: 'Ana', cards: 'As Ad 7c 7h 3s Kd 2c' },
        b: { name: 'Ben', cards: 'Qh Qs Qd 4c 9s 8d 2h' },
        winner: 'b',
        why: 'Ben makes three queens. Ana has two pair (aces and sevens), which is lower.',
      },
      {
        a: { name: 'Ana', cards: '9h 9c Kd Ks 4s 4c 2d' },
        b: { name: 'Ben', cards: 'Kc Kh 8s 8d 6c 5h Jd' },
        winner: 'a',
        why: 'Both have a pair of kings. Ana has three pairs but only her best two count: kings and nines, which beats Ben\'s kings and eights.',
      },
    ],
    tips: [
      'Your starting three cards matter most. Good starts: three of a kind, a big pair, or three cards of one suit.',
      'Watch the up cards. If you need hearts and four hearts are showing in other hands, your flush is unlikely.',
      'Check who is still in when you are deciding: a pair of kings is weaker when someone shows an ace and keeps betting.',
      'Bets double on fifth street, so that is the usual time to fold a hand that has not improved.',
    ],
    mistakes: [
      'Forgetting that folded players\' up cards are gone from the deck. They are dead cards for your draws too.',
      'Playing every hand to see more cards. Stud is long: weak starts lose chips on every street.',
    ],
  },
  {
    id: 'razz',
    name: 'Razz',
    games: ['razz'],
    idea: 'Seven Card Stud played for the lowest hand. Pairs hurt you, aces are always low, and straights and flushes do not count.',
    steps: [
      ...STUD_STEPS(
        'The player with the highest up card must bring in (a king is the worst card, an ace the best; on a tie, the higher suit brings in: spades, then hearts, diamonds, clubs).',
        'whoever has the lowest hand showing',
      ),
      STUD_NOTE_DECK,
    ],
    goal: 'The lowest five different cards out of your seven win. Compare the highest card first: an 8-low beats a 9-low. If that ties, compare the next card, and so on.',
    scoring: { low: 'ace-to-five' },
    ladder: {
      title: 'Low hands, best first',
      rule: { low: 'ace-to-five' },
      hands: [
        { cards: '5d 4c 3h 2s Ac', label: 'The wheel, 5-4-3-2-A: the best hand. It is not a straight here' },
        { cards: '6c 4d 3s 2h Ad', label: 'Six-four low' },
        { cards: '7s 6d 4c 3h 2s', label: 'Seven-six low' },
        { cards: '8d 5c 4h 3s Ac', label: 'Eight-five low' },
        { cards: '9s 8c 7d 4h 2c', label: 'Nine low' },
        { cards: 'Kd Qs 7h 5c 2d', label: 'King low: bad, but still no pair' },
        { cards: '6d 6s 4c 3h Ad', label: 'A pair: worse than any hand with five different ranks' },
      ],
      note: 'Suits never matter: 7-5-4-3-2 all in hearts is just a seven low.',
    },
    showdowns: [
      {
        a: { name: 'Ana', cards: '8c 6d 4h 3s 2c' },
        b: { name: 'Ben', cards: '8d 7s 3c 2d Ah' },
        winner: 'a',
        why: 'Both are eight lows. Compare the next card: Ana\'s six is lower than Ben\'s seven, so Ana wins even though Ben has the ace.',
      },
      {
        a: { name: 'Ana', cards: 'Kc 9d 7h 4s 3c 2d Ad' },
        b: { name: 'Ben', cards: '8s 6c 5d 4h 3s Ts Td' },
        winner: 'a',
        why: 'Ana keeps her five lowest different cards, 7-4-3-2-A, and throws away the king and nine. A seven low beats Ben\'s eight low.',
      },
    ],
    tips: [
      'Start with three different cards of 8 or lower. Three cards of 5 or lower with an ace is a great start.',
      'When an opponent pairs one of their up cards, their hand just got worse. That is often a good time to bet.',
      'A face card (J, Q, K) on your board is a big setback. Be ready to fold when you catch one and your opponent did not.',
    ],
    mistakes: [
      'Thinking a straight or flush hurts you. In Razz they do not: 5-4-3-2-A is the best hand.',
      'Counting the ace as high. In Razz it is always the lowest card.',
    ],
  },
  {
    id: 'stud8',
    name: 'Seven Card Stud Hi-Lo',
    games: ['stud8'],
    idea: 'Seven Card Stud where the pot is split: half for the best high hand and half for the best low hand, if anyone has a low.',
    steps: [
      ...STUD_STEPS(
        'The player with the lowest up card must bring in (aces count high; on a tie, clubs are lowest, then diamonds, hearts, spades).',
        'whoever has the best high hand showing',
      ),
      STUD_NOTE_DECK,
    ],
    goal: 'Half the pot goes to the best high hand. The other half goes to the best low: five different cards all 8 or lower, aces low, compared highest card first. If nobody has a qualifying low, the high hand takes it all. You pick any five of your seven cards for each half, and the same cards can count for both.',
    scoring: { high: 'any-five', low: 'eight-or-better' },
    ladder: {
      title: 'Low hands, best first',
      rule: { low: 'eight-or-better' },
      hands: [
        { cards: '5c 4d 3h 2s Ac', label: '5-4-3-2-A: the best low, and a straight for high too' },
        { cards: '6d 4s 3c 2h Ac', label: 'Six-four low' },
        { cards: '7c 5d 4s 3h 2c', label: 'Seven-five low' },
        { cards: '8s 7d 6c 5h 4d', label: 'Eight-seven: the worst low that still counts' },
      ],
      note: 'A hand with a 9 or higher among its five lowest different cards has no low at all. High hands rank as in normal poker.',
    },
    showdowns: [
      {
        a: { name: 'Ana', cards: 'As Ad Ks Kd 7c 9h Qh' },
        b: { name: 'Ben', cards: '2c 3d 4h 7s 8c Jd Js' },
        half: 'high',
        winner: 'a',
        why: 'High half: Ana\'s aces and kings beat Ben\'s pair of jacks.',
      },
      {
        a: { name: 'Ana', cards: 'As Ad Ks Kd 7c 9h Qh' },
        b: { name: 'Ben', cards: '2c 3d 4h 7s 8c Jd Js' },
        half: 'low',
        winner: 'b',
        why: 'Low half: Ben has 8-7-4-3-2. Ana has no low (she only has two different cards of 8 or lower), so they split the pot.',
      },
      {
        a: { name: 'Ana', cards: 'Ah 2d 3c 4s 5h Kc Kd' },
        b: { name: 'Ben', cards: 'Ks Kh Qd Qc 9s 9h 8c' },
        half: 'high',
        winner: 'a',
        why: 'Ana\'s 5-4-3-2-A is a straight, beating Ben\'s two pair. It is also the best possible low, so Ana scoops the whole pot.',
      },
    ],
    tips: [
      'Aim for hands that can win both halves (a scoop). Three low cards that also work toward a straight or flush are ideal.',
      'Aces are gold: they are the best card for high and for low.',
      'A big pair with no low cards often wins only half the pot. Be careful putting in lots of chips for half.',
    ],
    mistakes: [
      'Expecting a low with a 9 or higher in it. It does not qualify.',
      'Forgetting the same cards can play both ways: a low straight can win high and low.',
    ],
  },
  {
    id: 'td27',
    name: '2-7 Triple Draw',
    games: ['td27'],
    idea: 'Five private cards, three chances to swap any of them, and the lowest hand wins. Aces are high, and straights and flushes count against you.',
    steps: DRAW_STEPS(5),
    goal: 'The lowest five-card hand wins. Compare the highest card first, then the next. Aces are always high, pairs are bad, and a straight or flush makes your hand worse, so the best hand is 7-5-4-3-2 in mixed suits.',
    scoring: { low: 'deuce-to-seven' },
    ladder: {
      title: 'Hands, best first',
      rule: { low: 'deuce-to-seven' },
      hands: [
        { cards: '7d 5c 4h 3s 2d', label: '7-5-4-3-2, mixed suits: the best hand' },
        { cards: '7s 6d 4c 3h 2s', label: 'Seven-six' },
        { cards: '8c 5d 4s 3h 2c', label: 'Eight-five' },
        { cards: '9d 8s 6c 4h 3d', label: 'Nine-eight' },
        { cards: 'Kh 9c 6d 4s 3h', label: 'King high' },
        { cards: 'Ac 5d 4h 3s 2c', label: 'Ace high: an ace is the worst high card, and this is not a straight' },
        { cards: '2c 2d 7h 5s 3c', label: 'A pair' },
        { cards: '8h 7c 6d 5s 4c', label: 'A straight: worse than a pair' },
        { cards: '9h 7h 5h 4h 2h', label: 'A flush: worse still' },
      ],
    },
    showdowns: [
      {
        a: { name: 'Ana', cards: '8c 6d 5h 4s 2c' },
        b: { name: 'Ben', cards: '8d 7s 3c 2d 4h' },
        winner: 'a',
        why: 'Both have an eight on top. Next card: Ana\'s six beats Ben\'s seven.',
      },
      {
        a: { name: 'Ana', cards: '7h 6h 5h 4h 2h' },
        b: { name: 'Ben', cards: 'Kc Jd 9s 5d 3c' },
        winner: 'b',
        why: 'Ana\'s cards look great but they are all hearts: that is a flush, and Ben\'s king high beats it.',
      },
    ],
    tips: [
      'A great start holds a 2 and a 7 or lower with no pairs, such as 2-3-7 or 2-4-5-7.',
      'Throw away aces, face cards and pairs first.',
      'Watch how many cards each player draws. Someone drawing three is far behind someone drawing one or standing pat.',
      'Careful with 3-4-5-6: one more card often makes a straight.',
    ],
    mistakes: [
      'Treating the ace as low. In 2-7 it is the highest card.',
      'Keeping a smooth-looking straight or a flush. They count against you.',
    ],
  },
  {
    id: 'badugi',
    name: 'Badugi',
    games: ['badugi'],
    idea: 'Four private cards and three draws. You want four cards that are all different suits and all different ranks, as low as possible.',
    steps: DRAW_STEPS(4),
    goal: 'A badugi is four cards with no two the same suit and no two the same rank. Any four-card badugi beats any three-card hand, a three-card hand beats any two-card hand, and so on. Hands with the same number of cards are compared highest card first, and aces are low.',
    scoring: { low: 'badugi' },
    ladder: {
      title: 'Hands, best first',
      rule: { low: 'badugi' },
      hands: [
        { cards: '4h 3s 2d Ac', label: '4-3-2-A in four suits: the best hand' },
        { cards: '8c 6d 3h 2s', label: 'An eight-six badugi' },
        { cards: 'Kc Qd 9h 4s', label: 'A king badugi: still beats every three-card hand' },
        { cards: '3c 2d Ah Kh', label: 'Three cards (3-2-A): the two hearts clash, so the king does not count' },
        { cards: '5c 4d 3h 3s', label: 'Three cards (5-4-3): the two threes clash' },
        { cards: 'Ac 2c 3c 4d', label: 'Two cards (4-A): three clubs, so only the ace of them counts' },
      ],
      note: 'When cards clash, keep the lowest set of cards that are all different. The others do not count.',
    },
    showdowns: [
      {
        a: { name: 'Ana', cards: 'Kc Qd 9h 4s' },
        b: { name: 'Ben', cards: '3c 2d Ah Kh' },
        winner: 'a',
        why: 'Ana has four cards that all differ, so she has a badugi. Ben only has three working cards. Any badugi wins.',
      },
      {
        a: { name: 'Ana', cards: '7c 5d 4h 2s' },
        b: { name: 'Ben', cards: '7s 6d 3c Ah' },
        winner: 'a',
        why: 'Both have seven badugis. Next card: Ana\'s five beats Ben\'s six.',
      },
    ],
    tips: [
      'A strong start is three low cards of different suits, like A-2-4 in three suits. Draw one card each round.',
      'Draw one card if you have three good ones. Draw two or more only when the cards you keep are very low.',
      'A player standing pat early probably has a badugi already. A high badugi may still be worth calling, but be careful.',
    ],
    mistakes: [
      'Counting a pair or two cards of the same suit as part of your hand. Only cards that differ in both rank and suit count.',
      'Treating the ace as high. In Badugi the ace is the lowest card.',
    ],
  },
  {
    id: 'omaha',
    name: 'Pot-Limit Omaha',
    games: ['plo4', 'plo5', 'plo6'],
    idea: "Like Hold'em with more private cards (four, or five or six in the bigger versions), but your hand must use exactly two of them and exactly three cards from the board.",
    steps: [
      'The two players left of the button post the small and big blinds.',
      'Everyone gets their private cards (four, five or six). Betting starts with the player left of the big blind.',
      'The flop: three cards face up in the middle, then a round of betting starting left of the button.',
      'The turn: a fourth board card, then betting.',
      'The river: a fifth board card, then the last round of betting and the showdown.',
      'Betting is usually pot limit: the most you can bet or raise is the size of the pot after you call.',
    ],
    goal: 'The best five-card poker hand wins, made from exactly two of your cards and exactly three board cards. Never one, never three.',
    scoring: { high: 'omaha' },
    ladder: { title: 'Poker hands, best first', rule: { high: 'any-five' }, hands: HIGH_LADDER, note: HIGH_NOTE },
    showdowns: [
      {
        board: 'Ah Kh 7h 2c 3d',
        a: { name: 'Ana', cards: '8h 6h 5c 4d' },
        b: { name: 'Ben', cards: 'Qh Qc Jd Js' },
        winner: 'a',
        why: 'Ana has two hearts, which with the three on the board makes a flush. Ben has only one heart, so no flush for him: he plays a pair of queens.',
      },
      {
        board: 'As Ks Qd Jc 7h',
        a: { name: 'Ana', cards: 'Tc 3d 3h 3s' },
        b: { name: 'Ben', cards: 'Td 9c 4d 4s' },
        winner: 'b',
        why: 'Ana\'s ten alone cannot make A-K-Q-J-10: that needs four board cards. Ben uses his 10 and 9 with K-Q-J for a straight.',
      },
    ],
    tips: [
      'Hands with cards that work together (pairs, connected ranks, two cards of a suit) are much stronger than four random cards.',
      'With four or more cards each, someone often has a strong hand. A straight or flush wins far less often than in Hold\'em.',
      'Draw to the best possible hand. A small flush often loses to a bigger one.',
    ],
    mistakes: [
      'Using one card from your hand and four from the board. You must use exactly two.',
      'Thinking four cards of a suit on the board give you a flush with one of your own. You need two of that suit in your hand.',
    ],
  },
  {
    id: 'omaha8',
    name: 'Pot-Limit Omaha Hi-Lo',
    games: ['plo8', 'plo5-8', 'plo6-8'],
    idea: 'Omaha with the pot split: half to the best high hand and half to the best low hand. Each half uses exactly two of your cards and three board cards.',
    steps: [
      'The deal and betting are exactly like Pot-Limit Omaha: blinds, your private cards, then the flop, turn and river with a round of betting after each.',
      'At the showdown the high half and the low half are worked out separately. You can use different cards from your hand for each.',
    ],
    goal: 'High half: best poker hand. Low half: five different cards all 8 or lower (aces low, straights and flushes do not matter), compared highest card first. A low needs two different low cards from your hand and three from the board, so it is only possible when the board shows at least three different cards of 8 or lower. If nobody has a low, the high hand wins it all.',
    scoring: { high: 'omaha', low: 'omaha-eight-or-better' },
    ladder: {
      title: 'Low hands, best first',
      rule: { low: 'eight-or-better' },
      hands: [
        { cards: '5c 4d 3h 2s Ac', label: '5-4-3-2-A: the best low' },
        { cards: '6d 4s 3c 2h Ac', label: 'Six-four low' },
        { cards: '7c 5d 4s 3h 2c', label: 'Seven-five low' },
        { cards: '8s 7d 6c 5h 4d', label: 'Eight-seven: the worst low that still counts' },
      ],
    },
    showdowns: [
      {
        board: 'Ah 7d 5c Kc Qs',
        a: { name: 'Ana', cards: '2s 3d Kd Ks' },
        b: { name: 'Ben', cards: 'Qh Qd 4c 4h' },
        half: 'low',
        winner: 'a',
        why: 'Ana uses 3-2 with A-7-5 for a seven low. Ben\'s low cards are both fours, and a low needs two different ones, so he has no low.',
      },
      {
        board: 'Ah 7d 5c Kc Qs',
        a: { name: 'Ana', cards: '2s 3d Kd Ks' },
        b: { name: 'Ben', cards: 'Qh Qd 4c 4h' },
        half: 'high',
        winner: 'a',
        why: 'High half: Ana\'s kings with the board king make three kings, beating Ben\'s three queens. Ana scoops both halves.',
      },
      {
        board: 'Kd Qh 9c 7s 3d',
        a: { name: 'Ana', cards: 'Ac 2d 4h 5s' },
        b: { name: 'Ben', cards: 'Kc Ks 8h 8d' },
        half: 'high',
        winner: 'b',
        why: 'Only two board cards (7 and 3) are 8 or lower, so nobody can make a low. Ben\'s three kings take the whole pot.',
      },
    ],
    tips: [
      'A-2 with other low cards is the strongest start for low. A-2-3 with a suited ace is even better.',
      'Play hands that can scoop. Winning only the low half when two players tie it can leave you with a quarter of the pot.',
      'When the board has two or fewer low cards, the hand is high only.',
    ],
    mistakes: [
      'Using a pair in your hand as two low cards. They must be two different ranks.',
      'Forgetting the exactly-two rule applies to both halves.',
    ],
  },
  {
    id: 'holdem',
    name: "Texas Hold'em",
    games: ['nlhe'],
    idea: 'Two private cards each and five shared cards in the middle. Make the best five-card hand from any mix of the seven.',
    steps: [
      'The two players left of the button post the small and big blinds.',
      'Everyone gets two private cards. Betting starts left of the big blind.',
      'The flop (three board cards), the turn (one more) and the river (one more), each followed by a round of betting starting left of the button.',
      'At the showdown, the best five-card hand wins. You may use both, one or none of your own cards.',
    ],
    goal: 'The best five-card poker hand from your two cards and the five board cards wins.',
    scoring: { high: 'any-five' },
    ladder: { title: 'Poker hands, best first', rule: { high: 'any-five' }, hands: HIGH_LADDER, note: HIGH_NOTE },
    showdowns: [
      {
        board: 'Ks 9d 5c 3h 2s',
        a: { name: 'Ana', cards: 'Kh Qc' },
        b: { name: 'Ben', cards: 'Kd Jd' },
        winner: 'a',
        why: 'Both have a pair of kings. The next best card decides it: Ana\'s queen beats Ben\'s jack.',
      },
      {
        board: 'Ah Kh Qh Jh Th',
        a: { name: 'Ana', cards: '2c 3d' },
        b: { name: 'Ben', cards: 'As Ad' },
        winner: 'tie',
        why: 'The board is a royal flush. Nobody can beat it, so everyone still in plays the board and splits the pot.',
      },
    ],
    tips: [
      'Fold most hands. Pairs, two high cards, and suited cards next to each other are the usual starting hands.',
      'Acting last is an advantage: you see what others do first.',
    ],
    mistakes: ['Forgetting the kicker: with the same pair, the next highest card decides who wins.'],
  },
];

const BY_GAME = new Map(GUIDES.flatMap((g) => g.games.map((id) => [id, g] as const)));

export function guideFor(gameId: string): Guide | null {
  return BY_GAME.get(gameId) ?? null;
}

export const cardsOf = (list: CardList) => list.split(/\s+/).filter(Boolean);
