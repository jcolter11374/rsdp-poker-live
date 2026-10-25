import { HIGH_EVALUATORS, LOW_EVALUATORS, VARIANT_LIST, compareHands, type HandRank } from '@rsdp/engine/variants';
import { describe, expect, it } from 'vitest';
import { GUIDES, cardsOf, guideFor, type Guide, type Showdown } from './guides';

const CARD = /^[2-9TJQKA][cdhs]$/;

function rank(rule: { high: string } | { low: string }, cards: string[], board: string[]): HandRank | null {
  return 'high' in rule ? HIGH_EVALUATORS[rule.high as keyof typeof HIGH_EVALUATORS](cards, board) : LOW_EVALUATORS[rule.low as keyof typeof LOW_EVALUATORS](cards, board);
}

function halfRule(guide: Guide, s: Showdown) {
  const { high, low } = guide.scoring;
  if (s.half === 'low' || (!s.half && !high)) return { low: low! };
  return { high: high! };
}

describe('rules guides', () => {
  it('cover every game the table can deal', () => {
    for (const spec of VARIANT_LIST) expect(guideFor(spec.id), spec.id).not.toBeNull();
  });

  it('use real, distinct cards in every example', () => {
    for (const g of GUIDES) {
      const hands = [...g.ladder.hands.map((h) => [h.cards]), ...g.showdowns.map((s) => [s.a.cards, s.b.cards, s.board ?? ''])];
      for (const lists of hands) {
        const all = lists.flatMap(cardsOf);
        for (const c of all) expect(c, `${g.id}: ${c}`).toMatch(CARD);
        expect(new Set(all).size, `${g.id}: repeated card in ${lists.join(' | ')}`).toBe(all.length);
      }
    }
  });

  it('rank each ladder from best to worst, as the table scores it', () => {
    for (const g of GUIDES) {
      const ranks = g.ladder.hands.map((h) => rank(g.ladder.rule, cardsOf(h.cards), []));
      for (const [i, r] of ranks.entries()) expect(r, `${g.id}: ${g.ladder.hands[i].cards}`).not.toBeNull();
      for (let i = 1; i < ranks.length; i++) {
        expect(compareHands(ranks[i - 1], ranks[i]), `${g.id}: ${g.ladder.hands[i - 1].cards} should beat ${g.ladder.hands[i].cards}`).toBeGreaterThan(0);
      }
    }
  });

  it('name the right winner in every showdown example', () => {
    for (const g of GUIDES) {
      for (const s of g.showdowns) {
        const board = cardsOf(s.board ?? '');
        const rule = halfRule(g, s);
        const diff = compareHands(rank(rule, cardsOf(s.a.cards), board), rank(rule, cardsOf(s.b.cards), board));
        const got = diff > 0 ? 'a' : diff < 0 ? 'b' : 'tie';
        expect(got, `${g.id}: ${s.a.cards} vs ${s.b.cards} on ${s.board ?? '-'}`).toBe(s.winner);
      }
    }
  });

  it('agree with the table when an example says nobody has a low', () => {
    const omaha8 = GUIDES.find((g) => g.id === 'omaha8')!;
    const noLow = omaha8.showdowns.find((s) => s.board === 'Kd Qh 9c 7s 3d')!;
    for (const hand of [noLow.a, noLow.b]) expect(LOW_EVALUATORS['omaha-eight-or-better'](cardsOf(hand.cards), cardsOf(noLow.board!))).toBeNull();
    const stud8 = GUIDES.find((g) => g.id === 'stud8')!;
    expect(LOW_EVALUATORS['eight-or-better'](cardsOf(stud8.showdowns[1].a.cards), [])).toBeNull();
  });
});
