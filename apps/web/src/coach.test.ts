import { describe, expect, it } from 'vitest';
import { engine, type BettingKind, type HandEvent, type HandState } from '@rsdp/engine/core';
import { BOT_NOTE_RULES, COACH_RULES, type BotNote, type CoachMove, type CoachRule, type CoachTip, type HandRecordView, type TableView } from '@rsdp/engine/wire';
import { STAKES, start } from '../../../packages/engine/test/core/harness';
import { BASIS_CAP, breakEvenWords, MARK_BASIS_CAP, chanceWords, coachFacts, explainNote, linesWithWhy, NOTES_FOOTNOTE, noteText, oftenWords, tipText, VERDICT_CAP, type FactCode } from './coach';
import { bbExactFormat, eventLines } from './format';
import { frameView, type Frame } from './replay';

const fmt = (n: number) => n.toLocaleString('en-GB');

interface Spot {
  game?: string;
  betting?: BettingKind;
  /** My cards (seat 0, Ann). */
  mine: string[];
  /** One board, or several (double board). */
  board?: string[] | string[][];
  /** Everyone else from seat 1: Bo, Cy... Cards are face down unless listed in `up`. */
  others?: { name: string; up?: string[]; folded?: boolean }[];
  potTotal?: number;
  events?: HandEvent[];
}

/** A table as Ann (seat 0) sees it at one decision. */
function viewOf(spot: Spot): TableView {
  const gameId = spot.game ?? 'nlhe';
  const others = spot.others ?? [{ name: 'Bo' }];
  const names = ['Ann', ...others.map((o) => o.name)];
  const startEvent = { seq: 0, t: 'hand-start', handId: 'h', handNumber: 1, gameId, betting: spot.betting ?? 'no-limit', stakes: STAKES, button: 0, buttonDead: false, seats: [], boards: 1, bombPot: false } as HandEvent;
  const record: HandRecordView = {
    handNumber: 1,
    startedAt: 0,
    endedAt: 0,
    gameName: gameId,
    betting: spot.betting ?? 'no-limit',
    stakes: STAKES,
    button: 0,
    seats: names.map((name, seat) => ({ seat, playerId: `p${seat}`, name, stack: 100 })),
    events: [startEvent],
  };
  const boards = !spot.board ? [[]] : Array.isArray(spot.board[0]) ? (spot.board as string[][]) : [spot.board as string[]];
  const frame: Frame = {
    seats: new Map(
      names.map((name, seat) => {
        const o = others[seat - 1];
        const cards = seat === 0 ? spot.mine.map((card) => ({ card, up: false, shown: true })) : (o.up ?? []).map((card) => ({ card, up: true, shown: true }));
        return [seat, { name, playerId: `p${seat}`, stack: 100, bet: 0, folded: !!o?.folded, allIn: false, cards, action: null }];
      }),
    ),
    boards: [boards],
    pot: 0,
    street: 1,
    toAct: 0,
    awards: [],
    done: false,
    caption: '',
    upTo: 1,
    why: [],
  };
  const view = frameView('Practice', 6, record, frame, 'p0');
  view.hand!.potTotal = spot.potTotal ?? 0;
  view.hand!.events = spot.events ?? [startEvent];
  return view;
}

function tipOf(t: Partial<CoachTip>): CoachTip {
  return {
    handNumber: 1,
    at: 10,
    kind: 'bet',
    share: 0.5,
    se: 0.015,
    split: false,
    scoop: null,
    vs: 1,
    opponents: 1,
    vsRandom: null,
    drawsLeft: 0,
    call: 10,
    pot: 30,
    cost: 0.25,
    need: 0.28,
    big: false,
    close: false,
    move: { type: 'call' },
    rule: 'call',
    options: [],
    reads: [],
    draws: [],
    ...t,
  };
}

const facing = (share: number, cost: number, more: Partial<CoachTip> = {}): Partial<CoachTip> => {
  const call = 10;
  return { share, cost, call, pot: Math.round(call / cost - call), need: cost + 0.03, ...more };
};
const checked: Partial<CoachTip> = { call: 0, cost: null, need: null };
const bet = (to: number, fraction: 0.5 | 0.75 | null = 0.5, allIn = false): CoachMove => ({ type: 'bet', to, fraction, allIn });
const codes = (view: TableView, tip: CoachTip) => coachFacts(view, tip, fmt).map((f) => f.code);
const textOf = (view: TableView, tip: CoachTip) => tipText(tip, view, fmt);

describe('chance words', () => {
  it('rounds to 5 when the tip is sure enough, else to 10', () => {
    expect(chanceWords(0.48, 0.025)).toBe('about 50%');
    expect(chanceWords(0.474, 0.02)).toBe('about 45%');
    expect(chanceWords(0.476, 0.02)).toBe('about 50%');
    expect(chanceWords(0.34, 0.0251)).toBe('roughly 30%');
    expect(chanceWords(0.35, 0.03)).toBe('roughly 40%');
  });

  it('says under 5% and over 95% at the ends, and never 0% or 100%', () => {
    expect(chanceWords(0.049, 0.01)).toBe('under 5%');
    expect(chanceWords(0.05, 0.01)).toBe('about 5%');
    expect(chanceWords(0.951, 0.01)).toBe('over 95%');
    expect(chanceWords(0.95, 0.01)).toBe('about 95%');
    expect(chanceWords(0.05, 0.05)).toBe('roughly 10%');
    expect(chanceWords(0.95, 0.05)).toBe('roughly 90%');
  });

  it('says how often in small whole numbers', () => {
    expect(oftenWords(0.8)).toBe('4 times in 5');
    expect(oftenWords(0.75)).toBe('3 times in 4');
    expect(oftenWords(0.6)).toBe('3 times in 5');
    expect(oftenWords(0.7)).toBe('7 times in 10');
    expect(oftenWords(0.25)).toBe('1 time in 4');
    expect(oftenWords(0.5)).toBe('1 time in 2');
    expect(oftenWords(0.07)).toBe('about 1 time in 14');
    expect(oftenWords(0.66)).toBe('about 2 times in 3');
    // Not 1 time in 3: that would be a third, well short of 40%.
    expect(oftenWords(0.4)).toBe('2 times in 5');
    expect(oftenWords(0.3)).toBe('3 times in 10');
  });

  it('never makes a call look cheaper than it is', () => {
    expect(breakEvenWords(0.4)).toBe('2 times in 5');
    expect(breakEvenWords(0.25)).toBe('1 time in 4');
    expect(breakEvenWords(2 / 7)).toBe('2 times in 7');
    expect(breakEvenWords(0.29)).toBe('about 3 times in 10');
    expect(breakEvenWords(0.07)).toBe('about 1 time in 14');
    expect(breakEvenWords(0.45)).toBe('about 1 time in 2');
    for (let c = 0.02; c < 0.5; c += 0.003) {
      const [, n, d] = breakEvenWords(c).match(/(\d+) times? in (\d+)/)!.map(Number);
      expect(n / d, `${c}`).toBeGreaterThanOrEqual(c - 1e-9);
      expect(n / d - c, `${c}`).toBeLessThan(0.06);
    }
  });
});

describe('tip text: the examples', () => {
  it("Hold'em, no limit: a flush draw facing a bet", () => {
    const view = viewOf({ mine: ['Jh', 'Th'], board: ['9h', '4h', '2c'], potTotal: 30 });
    const tip = tipOf({ ...facing(0.48, 0.25), vsRandom: 0.6, reads: [{ seat: 1, bets: 1 }] });
    const t = textOf(view, tip);
    expect(t.verdict).toBe('About 50% to win, the call costs 25%: call.');
    expect(t.basis).toBe("Counting how Bo has bet this hand. Against a random hand you'd have about 60%.");
    expect(coachFacts(view, tip).map((f) => f.text)).toEqual(['Flush draw: 9 hearts are still unseen.']);
    expect(t.set).toBeNull();
    const why = Object.fromEntries(t.why.map((s) => [s.title, s.lines]));
    expect(why['The maths'][0]).toBe('The pot will be 40 once you call 10. 10 is 25% of 40, so calling pays off over time if you win more than 1 time in 4.');
    expect(why['Your chance']).toContain("Against a random hand you'd have about 60%.");
    expect(why['Your chance'][0]).toMatch(/^About 50% to win\. The tip dealt out the cards you can't see [\d,]+ times, giving Bo hands that fit how Bo has bet\.$/);
    expect(why['Worth knowing']).toEqual(['Flush draw: 9 hearts are still unseen.']);
    expect(why['What the tip can’t know'][0]).toMatch(/^It never sees anyone else's cards or the deck\..*Use it as a guide, not a rule\.$/);

    // A pot-sized bet costs 40% to call: that is 2 times in 5, never "1 time in 3".
    const big = textOf(view, tipOf(facing(0.35, 0.4)));
    expect(big.why[0].lines[0]).toBe('The pot will be 25 once you call 10. 10 is 40% of 25, so calling pays off over time if you win more than 2 times in 5.');
  });

  it('works out how many times it dealt from the standard error', () => {
    const t = textOf(viewOf({ mine: ['Jh', 'Th'] }), tipOf({ share: 0.48, se: Math.sqrt((0.48 * 0.52) / 1000) }));
    expect(t.why.find((s) => s.title === 'Your chance')!.lines[0]).toContain('1,000 times');
  });

  it("Hold'em: river bet, fold, close and raise", () => {
    const view = viewOf({ mine: ['As', 'Ks'], board: ['Ad', '7c', '2h', '9s', 'Kd'], potTotal: 40 });
    const river = textOf(view, tipOf({ ...checked, share: 0.9, pot: 40, move: bet(20), rule: 'bet' }));
    expect(river.verdict).toBe('About 90% to win, nothing to call: bet ½ pot (20).');
    expect(river.set).toEqual({ to: 20, label: 'Set 20' });
    expect(textOf(view, tipOf({ ...facing(0.15, 0.33), move: { type: 'fold' }, rule: 'fold' })).verdict).toBe('About 15% to win, the call costs 33%: fold.');
    expect(textOf(view, tipOf({ ...facing(0.3, 0.28), close: true, move: { type: 'fold' }, rule: 'fold' })).verdict).toBe('About 30% to win, the call costs 28%: close, call or fold.');
    expect(textOf(view, tipOf({ ...facing(0.3, 0.28), close: true, move: { type: 'call' }, rule: 'call' })).verdict).toBe('About 30% to win, the call costs 28%: close, call or fold.');
    const raise = textOf(view, tipOf({ ...facing(0.85, 0.25), move: { type: 'raise', to: 40, fraction: 0.75, allIn: false }, rule: 'raise' }));
    expect(raise.verdict).toBe('About 85% to win, the call costs 25%: raise to 40.');
    expect(raise.set).toEqual({ to: 40, label: 'Set 40' });
    expect(textOf(view, tipOf({ ...facing(0.85, 0.25), move: { type: 'raise', to: 120, fraction: 0.75, allIn: true }, rule: 'raise' })).verdict).toBe(
      'About 85% to win, the call costs 25%: go all in (120).',
    );
  });

  it('Omaha, pot limit, with the two-card rule', () => {
    const view = viewOf({ game: 'plo4', betting: 'pot-limit', mine: ['Ah', 'Ks', 'Qd', 'Jc'], board: ['2h', '7h', '9h', '3h'], potTotal: 30 });
    const tip = tipOf(facing(0.6, 0.25));
    expect(textOf(view, tip).verdict).toBe('About 60% to win, the call costs 25%: call.');
    expect(coachFacts(view, tip)).toEqual([{ code: 'omaha-two', text: 'Four hearts on the board, but you hold only one: in Omaha you need two from your hand.' }]);
  });

  it('Omaha 8 or better: of the pot, the whole pot, and playing for high', () => {
    const view = viewOf({ game: 'plo8', betting: 'pot-limit', mine: ['Ks', 'Kd', 'Qc', 'Jh'], board: ['4c', '7d', '2h'], potTotal: 30 });
    const tip = tipOf({ ...facing(0.35, 0.25), split: true, scoop: 0.15, vs: 1 });
    const t = textOf(view, tip);
    expect(t.verdict).toBe('About 35% of the pot, the call costs 25%: call.');
    expect(t.basis).toBe('Against a random hand: nobody still in has bet or raised. The whole pot about 15% of the time.');
    expect(coachFacts(view, tip).map((f) => f.text)).toEqual(["You have no cards 8 or lower, so you're playing for high: if someone makes a low you win half at best."]);
    expect(t.why.find((s) => s.title === 'Your chance')!.lines).toContain("That counts the times you'd split it: you'd win the whole pot about 15% of the time.");
  });

  it('Seven card stud: live cards, bring-in and complete', () => {
    const view = viewOf({ game: 'stud', betting: 'fixed-limit', mine: ['Kc', 'Kd', '5s'], others: [{ name: 'Bo', up: ['9h'] }, { name: 'Cy', up: ['2c'] }], potTotal: 40 });
    const tip = tipOf(facing(0.35, 0.2));
    expect(textOf(view, tip).verdict).toBe('About 35% to win, the call costs 20%: call.');
    expect(coachFacts(view, tip).map((f) => f.text)).toEqual(['Neither of the other two kings is showing, so both are still live.']);
    const bringIn = tipOf({ ...checked, share: 0.1, opponents: 5, vs: 5, move: { type: 'bring-in' }, rule: 'bring-in' });
    expect(textOf(view, bringIn).verdict).toBe('About 10% to win against 5 others: bring it in for 1.');
    // The low card has to bring in; the player who opens because the low card is all in from the ante may fold.
    const maths = (canFold: boolean) => {
      const at = { ...view, legal: { canFold, canCheck: false, callAmount: 0, canRaise: true, minTo: 4, maxTo: 4, canBringIn: true } as TableView['legal'] };
      return textOf(at, bringIn).why.flatMap((s) => s.lines).find((l) => /start the betting/.test(l));
    };
    expect(maths(false)).toBe('You must start the betting: bring it in for 1, or complete to 4. The tip completes only with a strong start.');
    expect(maths(true)).toBe('You start the betting because the player who had to bring in is all in: bring it in for 1, or complete to 4, or fold. The tip completes only with a strong start.');
    const complete = tipOf({ ...checked, share: 0.6, opponents: 5, vs: 5, move: { type: 'complete', to: 4, fraction: null, allIn: false }, rule: 'complete' });
    expect(textOf(view, complete).verdict).toBe('About 60% to win against 5 others: complete to 4.');
    expect(textOf(view, complete).set).toBeNull();
  });

  it('Razz: fixed-limit bets have no size words', () => {
    const view = viewOf({ game: 'razz', betting: 'fixed-limit', mine: ['Ac', '2d', '3h', '4s'] });
    expect(textOf(view, tipOf({ ...checked, share: 0.9, move: bet(2, null), rule: 'bet' })).verdict).toBe('About 90% to win, nothing to call: bet 2.');
    expect(textOf(view, tipOf({ ...checked, share: 0.75, move: bet(2, null), rule: 'bet' })).verdict).toBe('About 75% to win, nothing to call: bet 2.');
    expect(textOf(view, tipOf({ ...facing(0.8, 0.2), move: { type: 'raise', to: 8, fraction: null, allIn: false }, rule: 'raise' })).verdict).toBe('About 80% to win, the call costs 20%: raise to 8.');
  });

  it('Stud 8 or better', () => {
    const view = viewOf({ game: 'stud8', betting: 'fixed-limit', mine: ['Kc', 'Qd', '9s'], potTotal: 40 });
    const tip = tipOf({ ...facing(0.4, 0.2), split: true, scoop: 0.2, vs: 2, opponents: 2 });
    const t = textOf(view, tip);
    expect(t.verdict).toBe('About 40% of the pot, the call costs 20%: call.');
    expect(t.basis).toBe('Against 2 random hands: nobody still in has bet or raised. The whole pot about 20% of the time.');
    expect(codes(view, tip)).toEqual(['high-only']);
  });

  it('2-7 triple draw: what to throw, and what the other draws say', () => {
    const view = viewOf({ game: 'td27', betting: 'fixed-limit', mine: ['2c', '3d', '4h', '8s', 'Kd'] });
    const first = tipOf({
      kind: 'draw',
      ...checked,
      share: 0.8,
      drawsLeft: 3,
      vs: 2,
      opponents: 2,
      move: { type: 'draw', discard: [4] },
      rule: 'draw',
      options: [
        { discard: [4], share: 0.8 },
        { discard: [3, 4], share: 0.7 },
        { discard: [], share: 0.35 },
      ],
    });
    const t = textOf(view, first);
    expect(t.verdict).toBe('Draw 1: throw the [Kd]. About 80% to win from here.');
    expect(coachFacts(view, first).map((f) => f.text)).toEqual(['A king is far too high in 2-7.']);
    expect(t.why.find((s) => s.title === 'Ways to draw')!.lines).toEqual(['Draw 1: about 80% · Draw 2: about 70% · Stand pat: about 35%']);
    expect(t.mark).toEqual({ discard: [4], label: 'Mark [Kd]' });
    expect(t.why.some((s) => s.title === 'The maths')).toBe(false);

    const third = tipOf({ ...first, share: 0.3, se: 0.03, drawsLeft: 1, vs: 1, opponents: 1, draws: [{ seat: 1, done: [0, 0] }] });
    expect(textOf(view, third).verdict).toBe('Draw 1: throw the [Kd]. Roughly 30% to win from here.');
    expect(textOf(view, third).basis).toBe('Bo stood pat twice, so Bo probably has a made hand.');
    expect(textOf(view, tipOf({ ...third, draws: [{ seat: 1, done: [3, 2] }] })).basis).toBe('Bo drew 3, then 2: still looking for a hand.');
    expect(textOf(view, tipOf({ ...third, draws: [{ seat: 1, done: [3, 0] }] })).basis).toBe('Bo drew 3, then stood pat, so Bo probably has a made hand.');
    expect(textOf(view, tipOf({ ...third, draws: [{ seat: 1, done: [null] }] })).basis).toBe('Against a random hand: nobody still in has bet or raised.');
    // A bet and the draws both count: the draws are said too, not put down to the bet.
    const pats = tipOf({ ...facing(0.3, 0.17), drawsLeft: 0, reads: [{ seat: 1, bets: 1 }], vsRandom: 0.95, draws: [{ seat: 1, done: [0, 0, 0] }] });
    expect(textOf(view, pats).basis).toBe('Counting how Bo has bet this hand. Bo stood pat three times, so Bo probably has a made hand.');
    expect(textOf(view, pats).why.find((x) => x.title === 'Your chance')!.lines[0]).toMatch(/giving Bo hands that fit how Bo has bet and drawn\.$/);

    expect(textOf(view, tipOf(facing(0.3, 0.17))).verdict).toBe('About 30% to win, the call costs 17%: call.');
    expect(textOf(view, tipOf({ ...facing(0.4, 0.2), drawsLeft: 2 })).verdict).toBe('About 40% to win with 2 draws to come, the call costs 20%: call.');
    expect(textOf(view, tipOf({ ...facing(0.4, 0.2), drawsLeft: 1 })).verdict).toBe('About 40% to win with 1 draw to come, the call costs 20%: call.');
  });

  it('Badugi: one card per suit', () => {
    const view = viewOf({ game: 'badugi', betting: 'fixed-limit', mine: ['Ac', '2d', '5h', '3h'] });
    const tip = tipOf({ kind: 'draw', ...checked, share: 0.45, drawsLeft: 3, move: { type: 'draw', discard: [2] }, rule: 'draw' });
    expect(textOf(view, tip).verdict).toBe('Draw 1: throw the [5h]. About 45% to win from here.');
    expect(coachFacts(view, tip).map((f) => f.text)).toEqual(['Your [5h] shares hearts with your [3h]; only one can count, so keep the lower one.']);
    expect(textOf(view, tipOf({ ...tip, draws: [{ seat: 1, done: [0] }] })).basis).toBe('Bo stood pat: Bo probably holds a badugi.');
  });

  it('Double board: of the pot, each board half', () => {
    const view = viewOf({ mine: ['As', 'Kd'], board: [['2c', '7d', '9h'], ['Qs', 'Jd', '4c']], potTotal: 30 });
    const tip = tipOf({ ...facing(0.45, 0.25), split: true });
    expect(textOf(view, tip).verdict).toBe('About 45% of the pot, the call costs 25%: call.');
    expect(codes(view, tip)).toEqual(['two-boards']);
  });

  it('stand pat, and draws of more than one card', () => {
    const view = viewOf({ game: 'td27', betting: 'fixed-limit', mine: ['2c', '3d', '4h', '7s', 'Kd'] });
    expect(textOf(view, tipOf({ kind: 'draw', ...checked, share: 0.75, move: { type: 'draw', discard: [] }, rule: 'pat' })).verdict).toBe('Stand pat. About 75% to win from here.');
    const two = textOf(view, tipOf({ kind: 'draw', ...checked, share: 0.2, se: 0.03, move: { type: 'draw', discard: [3, 4] }, rule: 'draw' }));
    expect(two.verdict).toBe('Draw 2: throw the [7s] and [Kd]. Roughly 20% to win from here.');
    const three = textOf(view, tipOf({ kind: 'draw', ...checked, share: 0.2, move: { type: 'draw', discard: [2, 3, 4] }, rule: 'draw' }));
    expect(three.verdict).toBe('Draw 3: keep the [2c] and [3d]. About 20% to win from here.');
    expect(three.mark!.label).toBe('Mark [4h] [7s] [Kd]');
    // Told by what stays when the cards thrown don't fit the panel.
    expect(textOf(view, tipOf({ kind: 'draw', ...checked, share: 0.2, se: 0.03, move: { type: 'draw', discard: [1, 2, 3, 4] }, rule: 'draw' })).verdict).toBe('Draw 4: keep the [2c]. Roughly 20% to win from here.');
    expect(textOf(view, tipOf({ kind: 'draw', ...checked, share: 0.2, se: 0.03, move: { type: 'draw', discard: [0, 1, 2, 3, 4] }, rule: 'draw' })).verdict).toBe('Draw 5: throw them all. Roughly 20% to win from here.');
  });
});

describe('tip text: the basis line', () => {
  const view = viewOf({ mine: ['As', 'Kd'], others: [{ name: 'Bo' }, { name: 'Cy' }, { name: 'Dee' }, { name: 'Bartholomew the Bold' }], potTotal: 30 });

  it('names the players whose bets it counted, cut short', () => {
    const tip = (seats: number[], vsRandom: number | null = null) => tipOf({ reads: seats.map((seat) => ({ seat, bets: 1 })), vsRandom, vs: 4, opponents: 4 });
    expect(textOf(view, tip([1, 2])).basis).toBe('Counting how Bo and Cy have bet this hand.');
    expect(textOf(view, tip([1, 2, 3])).basis).toBe('Counting how 3 players have bet this hand.');
    expect(textOf(view, tip([4])).basis).toBe('Counting how Bartholomew… has bet this hand.');
    // Against random hands only when that's a different answer.
    expect(textOf(view, tip([1], 0.54)).basis).toBe('Counting how Bo has bet this hand.');
    expect(textOf(view, tip([1], 0.55)).basis).toBe("Counting how Bo has bet this hand. Against 4 random hands you'd have about 55%.");
    expect(textOf(view, tipOf({ reads: [{ seat: 1, bets: 0 }] })).basis).toBe('Against a random hand: nobody still in has bet or raised.');
  });

  it('explains the verdicts that need a margin, the raise bar or the field', () => {
    expect(textOf(view, tipOf({ ...facing(0.38, 0.33), need: 0.41, big: true, move: { type: 'fold' }, rule: 'fold-big' })).basis).toBe(
      'This call is half your chips or more, so the tip wants a margin: about 41%.',
    );
    expect(textOf(view, tipOf({ ...facing(0.8, 0.2), rule: 'call-capped' })).basis).toBe('After 3 raises the tip raises again only with a very strong hand.');
    const field = tipOf({ ...facing(0.45, 0.2), opponents: 4, vs: 4, move: { type: 'raise', to: 40, fraction: 0.75, allIn: false }, rule: 'raise-field' });
    expect(textOf(view, field).basis).toBe('Against 4 others an even share is 20%, and you have more than twice that.');
  });

  it('moves the draws to line 2 when the verdict would be too long', () => {
    const t = textOf(viewOf({ game: 'td27', mine: ['2c', '3d', '4h', '8s', 'Kd'] }), tipOf({ ...facing(0.4, 0.2), se: 0.03, drawsLeft: 3, close: true, rule: 'call' }));
    expect(t.verdict).toBe('Roughly 40% to win, the call costs 20%: close, call or fold.');
    expect(t.basis).toBe('With 3 draws to come. Against a random hand: nobody still in has bet or raised.');
  });
});

describe('tip text: limits', () => {
  const longName = 'Maximilian Featherstonehaugh';
  const view = viewOf({ game: 'td27', mine: ['2c', '3d', '4h', '8s', 'Kd'], others: [{ name: longName }, { name: longName + '2' }, { name: longName + '3' }], potTotal: 999_999 });
  const moves: CoachMove[] = [
    { type: 'fold' },
    { type: 'check' },
    { type: 'call' },
    { type: 'bring-in' },
    bet(123_456),
    bet(123_456, 0.75, true),
    { type: 'raise', to: 1_234_567, fraction: 0.75, allIn: false },
    { type: 'complete', to: 99_999, fraction: null, allIn: false },
    { type: 'draw', discard: [0, 1, 2, 3, 4] },
  ];

  it('keeps every verdict and basis within the panel, whatever the numbers', () => {
    const all: string[] = [];
    for (const rule of COACH_RULES)
      for (const move of moves)
        for (const fmtUsed of [fmt, bbExactFormat(3)])
          for (const drawsLeft of [0, 1, 3])
            for (const split of [false, true])
              for (const call of [0, 12_345]) {
                const tip = tipOf({
                  kind: move.type === 'draw' ? 'draw' : 'bet',
                  rule,
                  move,
                  drawsLeft,
                  split,
                  call,
                  cost: call ? 0.28 : null,
                  need: call ? 0.31 : null,
                  close: true,
                  se: 0.04,
                  share: 0.333,
                  scoop: split ? 0.123 : null,
                  vsRandom: 0.777,
                  vs: 3,
                  opponents: 3,
                  reads: [1, 2, 3].map((seat) => ({ seat, bets: 2 })),
                  draws: [1, 2, 3].map((seat) => ({ seat, done: [3, 2, 1] })),
                });
                const t = tipText(tip, view, fmtUsed);
                expect(t.verdict.length, t.verdict).toBeLessThanOrEqual(VERDICT_CAP);
                expect(t.basis.length, t.basis).toBeLessThanOrEqual(t.mark ? MARK_BASIS_CAP : BASIS_CAP);
                expect(t.verdict).not.toBe('');
                all.push(t.verdict, t.basis, ...t.why.flatMap((s) => [s.title, ...s.lines]));
              }
    for (const text of all) {
      expect(text).not.toMatch(/equity/i);
      expect(text).not.toMatch(/poker\s*now/i);
      expect(text).not.toMatch(/undefined|NaN|null/);
    }
  });

  it('cuts long names to 12 characters', () => {
    const t = tipText(tipOf({ reads: [{ seat: 1, bets: 1 }] }), view, fmt);
    expect(t.basis).toBe('Counting how Maximilian … has bet this hand.');
  });
});

describe('facts', () => {
  const draw = (discard: number[]) => tipOf({ kind: 'draw', ...checked, move: { type: 'draw', discard }, rule: 'draw' });
  const throws = (game: string, mine: string[], discard: number[]) => coachFacts(viewOf({ game, mine }), draw(discard)).map((f) => f.text);

  it('says why each card goes in 2-7', () => {
    expect(throws('td27', ['2c', '4d', '4h', '7s', '8c'], [2])).toEqual(["Your [4h] pairs your [4d], and in 2-7 a pair loses to five different cards that aren't a straight or flush."]);
    expect(throws('td27', ['2c', '3d', '4h', '7s', 'Ac'], [4])).toEqual(['Aces are high in 2-7, not low.']);
    expect(throws('td27', ['2c', '3d', '4h', '7s', 'Qc'], [4])).toEqual(['A queen is far too high in 2-7.']);
    expect(throws('td27', ['2c', '3d', '4h', '7s', 'Tc'], [4])).toEqual(['A ten is too high in 2-7.']);
    expect(throws('td27', ['3c', '4d', '5h', '6s', '7c'], [4])).toEqual(['Your five cards make a straight, and in 2-7 straights count against you.']);
    expect(throws('td27', ['2h', '3h', '4h', '7h', '8h'], [4])).toEqual(['Your five cards are all one suit, and in 2-7 a flush counts against you.']);
    // An 8 thrown to draw smoother is a judgement, not a fact.
    expect(throws('td27', ['2c', '3d', '4h', '7s', '8c'], [4])).toEqual([]);
    expect(throws('td27', ['2c', '3d', '4h', '7s', '8c'], [])).toEqual([]);
  });

  it('says why each card goes in Badugi', () => {
    expect(throws('badugi', ['Ac', '2d', '5h', '3h'], [2])).toEqual(['Your [5h] shares hearts with your [3h]; only one can count, so keep the lower one.']);
    // Keeping the higher card is the tip's call; the fact doesn't say otherwise.
    expect(throws('badugi', ['Ac', '2d', '3h', '5h'], [2])).toEqual(['Your [3h] shares hearts with your [5h]; only one can count.']);
    expect(throws('badugi', ['Ac', '2d', '2h', '3s'], [2])).toEqual(['Your [2h] pairs your [2d]; only one can count.']);
    expect(throws('badugi', ['Ac', '2d', '3h', 'Ks'], [3])).toEqual(['A king is far too high in Badugi.']);
  });

  it('warns about one suited card in Omaha only', () => {
    const tip = tipOf({});
    expect(codes(viewOf({ game: 'plo4', mine: ['Ah', 'Ks', 'Qd', 'Jc'], board: ['2h', '7h', '9h'] }), tip)).toEqual(['omaha-two']);
    expect(coachFacts(viewOf({ game: 'plo4', mine: ['Ah', 'Ks', 'Qd', 'Jc'], board: ['2h', '7h', '9h'] }), tip)[0].text).toBe('Three hearts on the board, but you hold only one: in Omaha you need two from your hand.');
    expect(codes(viewOf({ game: 'plo4', mine: ['Ah', 'Kh', 'Qd', 'Jc'], board: ['2h', '7h', '9h'] }), tip)).toEqual([]);
    expect(codes(viewOf({ game: 'nlhe', mine: ['Ah', 'Ks'], board: ['2h', '7h', '9h', '3h'] }), tip)).toEqual([]);
  });

  it('knows when no low can come, and when you have no low cards', () => {
    const tip = tipOf({});
    expect(codes(viewOf({ game: 'plo8', mine: ['Ah', '2s', 'Qd', 'Jc'], board: ['Kh', 'Qs', '9h'] }), tip)).toEqual(['no-low']);
    expect(codes(viewOf({ game: 'plo8', mine: ['Ah', '2s', 'Qd', 'Jc'], board: ['Kh', 'Qs', '8h'] }), tip)).toEqual([]);
    expect(codes(viewOf({ game: 'plo8', mine: ['Ah', '2s', 'Qd', 'Jc'], board: ['Kh', '3s', '8h', '2d', 'Jd'] }), tip)).toEqual([]);
    expect(codes(viewOf({ game: 'plo8', mine: ['Ah', '2s', 'Qd', 'Jc'], board: ['Kh', '3s', 'Th', 'Td', 'Jd'] }), tip)).toEqual(['no-low']);
    // Aces count as low.
    expect(codes(viewOf({ game: 'stud8', mine: ['Ah', 'Ks', 'Qd'] }), tip)).toEqual([]);
    expect(codes(viewOf({ game: 'nlhe', mine: ['Kh', 'Ks'], board: ['Kd', 'Qs', '9h'] }), tip)).toEqual([]);
  });

  it('counts live cards in stud from every up card, folded players too', () => {
    const tip = tipOf({});
    const fold: HandEvent[] = [{ seq: 1, t: 'deal', seat: 2, cards: [{ card: '??', up: false }, { card: 'Ks', up: true }] }];
    const one = viewOf({ game: 'stud', mine: ['Kc', 'Kd', '5s'], others: [{ name: 'Bo', up: ['9h'] }, { name: 'Cy', folded: true }], events: fold });
    expect(coachFacts(one, tip).map((f) => f.text)).toEqual(['One of the other two kings is showing, so only one is still live.']);
    const two = viewOf({ game: 'stud', mine: ['9c', '9d', '5s'], others: [{ name: 'Bo', up: ['9h'] }, { name: 'Cy', up: ['9s'] }] });
    expect(coachFacts(two, tip).map((f) => f.text)).toEqual(["Two 9s are showing elsewhere, so you can't get a third."]);
    expect(codes(viewOf({ game: 'stud', mine: ['Kc', 'Qd', '5s'] }), tip)).toEqual([]);
    expect(codes(viewOf({ game: 'razz', mine: ['Kc', 'Kd', '5s'] }), tip)).toEqual([]);
  });

  it('finds flush draws in high flop games with cards to come', () => {
    const tip = tipOf({});
    expect(coachFacts(viewOf({ game: 'plo4', mine: ['Ah', 'Kh', 'Qh', 'Jc'], board: ['2h', '7h', '9c'] }), tip).map((f) => f.text)).toEqual(['Flush draw: 8 hearts are still unseen.']);
    expect(codes(viewOf({ mine: ['Jh', 'Th'], board: ['9h', '4h', '2c', 'Kd', '3s'] }), tip)).toEqual([]);
    expect(codes(viewOf({ mine: ['Jh', 'Th'], board: ['9h', '4h', '2h'] }), tip)).toEqual([]);
    expect(codes(viewOf({ mine: ['Jc', 'Tc'], board: ['9h', '4h', '2h', '3h'] }), tip)).toEqual([]);
    expect(codes(viewOf({ game: 'plo8', mine: ['Ah', 'Kh', 'Qh', 'Jc'], board: ['2h', '7h', '9c'] }), tip)).toEqual([]);
  });

  it('says when the deck is crowded, and when your chips cover only part of the pot', () => {
    const view = viewOf({ game: 'stud', mine: ['Kc', 'Qd', '5s'], potTotal: 90 });
    expect(coachFacts(view, tipOf({ vs: 5, opponents: 7, pot: 90 })).map((f) => f.text)).toEqual(['The deck can only deal out 5 of the 7 hands, so your real chance is a little lower.']);
    expect(coachFacts(view, tipOf({ pot: 60 }), fmt).map((f) => f.text)).toEqual(["Your chips don't cover every bet, so you can win only 60 of the 90 in the middle."]);
    expect(codes(view, tipOf({ pot: 90 }))).toEqual([]);
  });
});

describe('bot reasons', () => {
  const note = (n: Partial<BotNote>): BotNote => ({ seq: 3, seat: 1, level: 'normal', rule: 'call', ...n });
  const say = (n: Partial<BotNote>, name = 'Ace', ctx = {}) => noteText(note(n), name, ctx);

  it('writes each example', () => {
    expect(say({ rule: 'call', share: 0.4, cost: 0.25 })).toBe('Ace called: it guessed about 40% to win, and the call cost 25%.');
    expect(say({ rule: 'call', share: 0.4, cost: 0.25, split: true })).toBe('Ace called: it guessed about 40% of the pot, and the call cost 25%.');
    expect(say({ rule: 'fold', share: 0.1, cost: 0.33 })).toBe('Ace folded: it guessed about 10% to win, and the call cost 33%.');
    expect(say({ rule: 'fold', share: 0.35, cost: 0.33, big: true })).toBe('Ace folded: it guessed about 35% to win, and the call cost 33%. The call was half its chips, so it wanted more.');
    expect(say({ rule: 'fold', share: 0.3, cost: 0.3 })).toBe('Ace folded: it guessed about 30% to win, and the call cost 30%. Bots want a little more than the call costs.');
    expect(say({ rule: 'check', share: 0.35 })).toBe("Ace checked: about 35% to win isn't enough to bet. Normal bots bet from about 60%, or with about 1.5 times an even share against more players.");
    expect(say({ rule: 'value', share: 0.7 })).toBe('Ace bet: about 70% to win, so it bet to get paid by worse hands.');
    expect(say({ rule: 'value', share: 0.7 }, 'Ace', { action: 'raise' })).toBe('Ace raised: about 70% to win, so it raised to get paid by worse hands.');
    expect(say({ rule: 'raise', share: 0.85 })).toBe('Ace raised: it guessed about 85% to win.');
    expect(say({ rule: 'raise', share: 0.7, often: 0.8 })).toBe('Ace raised: it guessed about 70% to win (it raises hands like this 4 times in 5).');
    expect(say({ rule: 'bluff', share: 0.15, often: 0.07 })).toBe(
      "Ace bet with about 15% to win: a bluff. Normal bots bluff about 1 time in 14 when one player is left after the first round, so a bet doesn't always mean a strong hand.",
    );
    expect(say({ rule: 'call', share: 0.8, cost: 0.2, capped: true })).toBe('Ace just called: after 3 raises it raises again only with a very strong hand.');
    expect(say({ rule: 'call-loose', level: 'easy', share: 0.2, cost: 0.25 }, 'Beth')).toBe('Beth (Easy) called with about 20% though the call cost 25%: Easy bots call small bets a little too often.');
    expect(say({ rule: 'bluff', level: 'hard', share: 0.15, you: 'folds-often' }, 'Chip')).toBe("Chip (Hard) bluffed: you've folded to a lot of bets lately, so bluffs pay against you.");
    expect(say({ rule: 'fold', level: 'hard', share: 0.2, cost: 0.3, yourBets: 2 }, 'Chip', { yourVerb: 'raised' })).toBe(
      'Chip (Hard) folded: you raised twice this hand, so it played you for a strong hand. About 20% to win, and the call cost 30%.',
    );
    expect(say({ rule: 'call', level: 'hard', share: 0.3, cost: 0.25, last: true }, 'Chip')).toBe(
      'Chip (Hard) called: it guessed about 30% to win, and the call cost 25%. It acts last, so it calls a little wider while cards are still to come.',
    );
    expect(say({ rule: 'steal', level: 'hard', share: 0.3 }, 'Chip')).toBe('Chip (Hard) completed to steal the antes: few players were left, and they fold a lot.');
    expect(say({ rule: 'bring-in' }, 'Ace', { gameId: 'stud' })).toBe('Ace brought it in: lowest card showing and nothing worth completing.');
    expect(say({ rule: 'bring-in' }, 'Ace', { gameId: 'razz' })).toBe('Ace brought it in: highest card showing and nothing worth completing.');
    expect(say({ rule: 'complete', share: 0.35, vs: 4 })).toBe('Ace completed: a strong start, about 35% to win against 4 others.');
    expect(say({ rule: 'draw', share: 0.3, thrown: 2, alt: { thrown: 1, share: 0.25 } })).toBe('Ace drew 2: drawing 2 came out at about 30%, drawing 1 at about 25%.');
    expect(say({ rule: 'pat', share: 0.75 })).toBe('Ace stood pat: about 75% to win as it is.');
    expect(say({ rule: 'rit-yes' })).toBe('Bots always say yes to running it twice.');
    expect(say({ rule: 'fallback' })).toBe("Ace couldn't decide, so the table checked or folded for it.");
    expect(NOTES_FOOTNOTE).toBe('Bots guess quickly, so their numbers can be 5 to 10% off. They never see your cards.');
  });

  it('has words for every rule and level, with no forbidden ones', () => {
    for (const rule of BOT_NOTE_RULES)
      for (const level of ['easy', 'normal', 'hard'] as const)
        for (const you of [undefined, 'folds-often', 'calls-often'] as const) {
          const text = say({ rule, level, share: 0.42, vs: 3, cost: 0.2, need: 0.23, often: 0.8, thrown: 2, alt: { thrown: 0, share: 0.3 }, you, yourBets: 1, last: true, big: true, capped: true });
          expect(text, `${rule} ${level}`).not.toBe('');
          expect(text).not.toMatch(/equity|poker\s*now|undefined|NaN/i);
        }
  });

  it('says nothing for a rule it does not know, or numbers it lacks', () => {
    expect(say({ rule: 'gamble' as BotNote['rule'], share: 0.5 })).toBe('');
    expect(say({ rule: 'call' })).toBe('');
    expect(say({ rule: 'draw', share: 0.3 })).toBe('');
  });
});

describe('reasons in the hand log', () => {
  /** A finished three-handed hand where the seats listed in `bots` are bots, everyone checking or calling down. */
  function played(): HandState {
    const s = start({ stacks: [100, 100, 100] });
    for (let i = 0; i < 100 && s.phase !== 'complete'; i++) {
      const seat = s.toAct!;
      const legal = engine.legalActions(s, seat)!;
      engine.act(s, seat, legal.canCheck ? { type: 'check' } : { type: 'call' });
    }
    return s;
  }
  const record = (s: HandState, botNotes: BotNote[]): HandRecordView => ({
    handNumber: 1,
    startedAt: 0,
    endedAt: 0,
    gameName: s.input.game.name,
    betting: s.input.betting,
    stakes: s.input.stakes,
    button: s.input.button,
    seats: s.seats.map((x) => ({ seat: x.seat, playerId: x.playerId, name: ['Ann', 'Ace', 'Beth'][x.seat], stack: x.startStack })),
    events: engine.visibleEvents(s, { seat: 0, seeAll: false }),
    botNotes,
  });
  const name = (seat: number) => ['Ann', 'Ace', 'Beth'][seat];

  it('puts each reason under the line its move wrote', () => {
    const s = played();
    const events = engine.visibleEvents(s, { seat: 0, seeAll: false });
    const acts = events.filter((e) => e.t === 'action' && e.seat !== 0);
    const [first, second] = [acts[0], acts.at(-1)!];
    const h = record(s, [
      { seq: second.seq, seat: (second as { seat: number }).seat, level: 'normal', rule: 'check', share: 0.3 },
      { seq: first.seq, seat: (first as { seat: number }).seat, level: 'easy', rule: 'call', share: 0.5, cost: 0.2 },
    ]);
    const lines = linesWithWhy(h, name, fmt, 0);
    expect(lines.map((l) => l.text)).toEqual(eventLines(h.events, name, fmt, 0));
    const withWhy = lines.map((l, i) => ({ ...l, i })).filter((l) => l.why.length);
    expect(withWhy).toHaveLength(2);
    expect(withWhy[0].text).toBe(eventLines(h.events.slice(0, first.seq + 1), name, fmt, 0).at(-1));
    expect(withWhy[0].text).toMatch(/^(Ace|Beth) calls/);
    expect(withWhy[0].why[0]).toMatch(/\(Easy\) called: it guessed about 50% to win/);
    expect(withWhy[1].text).toMatch(/checks$/);
    expect(withWhy[1].i).toBe(eventLines(h.events.slice(0, second.seq + 1), name, fmt, 0).length - 1);
  });

  it('skips notes that point nowhere, and hands without notes', () => {
    const s = played();
    const h = record(s, [{ seq: 9999, seat: 1, level: 'normal', rule: 'fold', share: 0.1, cost: 0.3 }]);
    expect(linesWithWhy(h, name, fmt, 0).every((l) => !l.why.length)).toBe(true);
    expect(linesWithWhy({ ...h, botNotes: undefined }, name, fmt, 0).every((l) => !l.why.length)).toBe(true);
  });

  it('says how you bet before a Hard bot read you, from the hand itself', () => {
    const s = start({ stacks: [100, 100] });
    // Heads up the button (seat 0) acts first before the flop.
    engine.act(s, 0, { type: 'raise', to: 6 });
    engine.act(s, 1, { type: 'fold' });
    const h = record(s, []);
    const fold = h.events.find((e) => e.t === 'action' && e.seat === 1)!;
    const text = explainNote(h, { seq: fold.seq, seat: 1, level: 'hard', rule: 'fold', share: 0.2, cost: 0.4, yourBets: 1 }, name, 0);
    expect(text).toBe('Ace (Hard) folded: you raised once this hand, so it played you for a strong hand. About 20% to win, and the call cost 40%.');
  });
});

it('has a verdict for every tip rule', () => {
  const view = viewOf({ mine: ['As', 'Kd'], potTotal: 30 });
  for (const rule of COACH_RULES as readonly CoachRule[]) {
    const move: CoachMove = rule === 'draw' || rule === 'pat' ? { type: 'draw', discard: rule === 'draw' ? [1] : [] } : rule === 'bring-in' ? { type: 'bring-in' } : { type: 'call' };
    expect(tipText(tipOf({ rule, move, kind: move.type === 'draw' ? 'draw' : 'bet' }), view, fmt).verdict).not.toBe('');
  }
});
