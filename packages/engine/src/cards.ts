export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

/** A card is a two-character string: rank then suit, e.g. "As", "Td", "2c". */
export type Card = string;

export function rankOf(card: Card): number {
  return RANKS.indexOf(card[0]) + 2;
}

export function suitOf(card: Card): string {
  return card[1];
}

export function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

/** Returns a random integer in [0, n). */
export type Rng = (n: number) => number;

export const cryptoRng: Rng = (n) => {
  // Rejection sampling avoids modulo bias.
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
};

export function shuffle<T>(items: T[], rng: Rng = cryptoRng): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
