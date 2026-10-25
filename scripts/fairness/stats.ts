// Statistical checks of the shuffle (docs/FAIRNESS.md has the latest results).
//   npx tsx scripts/fairness/stats.ts [decks=1000000]
// Runs every test against the live shuffle (Fisher-Yates over the CSPRNG) and
// against the provably fair deck (Fisher-Yates over SHA-256 of a per-hand seed).

import { randomBytes } from 'node:crypto';
import { cryptoRng, freshDeck, shuffle } from '../../packages/engine/src/cards';
import { deckFromSeed, reshuffleRng } from '../../packages/engine/src/fairness';

const DECKS = Number(process.argv[2] ?? 1_000_000);
const DECK = freshDeck();
const INDEX = new Map(DECK.map((c, i) => [c, i]));

// ---------------------------------------------------------------- statistics

/** Upper tail of chi-square with df degrees of freedom (regularized gamma Q). */
function chiSquareP(x: number, df: number): number {
  const a = df / 2;
  const z = x / 2;
  if (z <= 0) return 1;
  const lnGammaA = lnGamma(a);
  if (z < a + 1) {
    // Series for P, then Q = 1 - P.
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 100000; n++) {
      term *= z / (a + n);
      sum += term;
      if (term < sum * 1e-15) break;
    }
    return Math.max(0, 1 - Math.exp(-z + a * Math.log(z) - lnGammaA) * sum);
  }
  // Continued fraction for Q (Lentz).
  let b = z + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 100000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-z + a * Math.log(z) - lnGammaA) * h;
}

function lnGamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function chiSquare(observed: number[], expected: number[]) {
  let x = 0;
  for (let i = 0; i < observed.length; i++) x += (observed[i] - expected[i]) ** 2 / expected[i];
  return x;
}

type Result = { test: string; detail: string; stat: string; p: number };

// ---------------------------------------------------------------- five-card categories

const CATEGORIES = ['high card', 'one pair', 'two pair', 'three of a kind', 'straight', 'flush', 'full house', 'four of a kind', 'straight flush'];
/** Exact counts out of C(52,5) = 2,598,960. */
const CATEGORY_COUNTS = [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40];

function category(cards: string[]): number {
  const ranks = cards.map((c) => '23456789TJQKA'.indexOf(c[0])).sort((a, b) => a - b);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const shape = [...counts.values()].sort((a, b) => b - a).join('');
  const distinct = counts.size === 5;
  const straight = distinct && (ranks[4] - ranks[0] === 4 || ranks.join() === '0,1,2,3,12');
  if (straight && flush) return 8;
  if (shape === '41') return 7;
  if (shape === '32') return 6;
  if (flush) return 5;
  if (straight) return 4;
  if (shape === '311') return 3;
  if (shape === '221') return 2;
  if (shape === '2111') return 1;
  return 0;
}

// ---------------------------------------------------------------- the tests

function run(name: string, nextDeck: () => string[], smallShuffle: (k: number) => number[]): Result[] {
  const results: Result[] = [];
  const pos = new Float64Array(52 * 52);
  const cats = new Array(9).fill(0);
  let pocketPairs = 0;
  let suited = 0;
  let adjacentSameSuit = 0;
  let adjacentSameRank = 0;
  const firstPairs = new Float64Array(52 * 52);
  let prevFirst = -1;
  const t0 = Date.now();
  for (let n = 0; n < DECKS; n++) {
    const deck = nextDeck();
    for (let i = 0; i < 52; i++) pos[INDEX.get(deck[i])! * 52 + i]++;
    cats[category(deck.slice(0, 5))]++;
    if (deck[0][0] === deck[1][0]) pocketPairs++;
    if (deck[0][1] === deck[1][1]) suited++;
    for (let i = 0; i < 51; i++) {
      if (deck[i][1] === deck[i + 1][1]) adjacentSameSuit++;
      if (deck[i][0] === deck[i + 1][0]) adjacentSameRank++;
    }
    const first = INDEX.get(deck[0])!;
    if (prevFirst >= 0) firstPairs[prevFirst * 52 + first]++;
    prevFirst = first;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  const e = DECKS / 52;
  // Every row and column of the count table sums to DECKS, so the raw Pearson sum
  // runs 52/51 high; scaled, it follows chi-square with 51 x 51 degrees of freedom.
  const posX = (chiSquare([...pos], new Array(52 * 52).fill(e)) * 51) / 52;
  results.push({ test: 'Card x position', detail: `Each of 52 cards at each of 52 positions, ${DECKS.toLocaleString()} decks (${secs}s)`, stat: `chi2=${posX.toFixed(1)} df=2601`, p: chiSquareP(posX, 2601) });

  const catX = chiSquare(cats, CATEGORY_COUNTS.map((c) => (c / 2598960) * DECKS));
  results.push({
    test: 'Five-card hands',
    detail: CATEGORIES.map((c, i) => `${c} ${((cats[i] / DECKS) * 100).toFixed(4)}% (theory ${((CATEGORY_COUNTS[i] / 2598960) * 100).toFixed(4)}%)`).join('; '),
    stat: `chi2=${catX.toFixed(2)} df=8`,
    p: chiSquareP(catX, 8),
  });

  const binom = (hits: number, trials: number, p: number, label: string, what: string) => {
    const x = (hits - trials * p) ** 2 / (trials * p) + (trials - hits - trials * (1 - p)) ** 2 / (trials * (1 - p));
    results.push({ test: label, detail: `${((hits / trials) * 100).toFixed(4)}% vs theory ${(p * 100).toFixed(4)}% (${what})`, stat: `chi2=${x.toFixed(2)} df=1`, p: chiSquareP(x, 1) });
  };
  binom(pocketPairs, DECKS, 3 / 51, 'Pocket pairs', 'first two cards');
  binom(suited, DECKS, 12 / 51, 'Suited starting hands', 'first two cards');
  binom(adjacentSameSuit, DECKS * 51, 12 / 51, 'Neighbours same suit', 'every adjacent pair of cards');
  binom(adjacentSameRank, DECKS * 51, 3 / 51, 'Neighbours same rank', 'every adjacent pair of cards');

  const fpX = chiSquare([...firstPairs], new Array(52 * 52).fill((DECKS - 1) / 2704));
  results.push({ test: 'Deck to next deck', detail: 'Top card of one deck against the top card of the next', stat: `chi2=${fpX.toFixed(1)} df=2703`, p: chiSquareP(fpX, 2703) });

  for (const k of [4, 5]) {
    const perms = new Map<string, number>();
    const trials = DECKS;
    for (let n = 0; n < trials; n++) {
      const key = smallShuffle(k).join('');
      perms.set(key, (perms.get(key) ?? 0) + 1);
    }
    const f = k === 4 ? 24 : 120;
    const observed = [...perms.values()];
    while (observed.length < f) observed.push(0);
    const x = chiSquare(observed, new Array(f).fill(trials / f));
    results.push({ test: `All ${f} orders of ${k} cards`, detail: `${perms.size} of ${f} orders seen, ${trials.toLocaleString()} shuffles`, stat: `chi2=${x.toFixed(1)} df=${f - 1}`, p: chiSquareP(x, f - 1) });
  }
  return results.map((r) => ({ ...r, test: `${name}: ${r.test}` }));
}

const range = (k: number) => Array.from({ length: k }, (_, i) => i);
const seed = () => randomBytes(32).toString('hex');

const all = [
  ...run('Live shuffle (CSPRNG)', () => shuffle(DECK, cryptoRng), (k) => shuffle(range(k), cryptoRng)),
  ...run('Provably fair deck (SHA-256 seed)', () => deckFromSeed(seed()), (k) => shuffle(range(k), reshuffleRng(seed(), 0))),
];

console.log(`| Test | What was measured | Statistic | p-value |\n|---|---|---|---|`);
for (const r of all) console.log(`| ${r.test} | ${r.detail} | ${r.stat} | ${r.p.toFixed(4)} |`);
const bad = all.filter((r) => r.p < 0.0001);
console.log(`\n${all.length} tests; ${bad.length} with p < 0.0001${bad.length ? ': ' + bad.map((b) => b.test).join(', ') : ''}`);
