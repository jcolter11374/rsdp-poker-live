// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BettingKind, Stakes } from '@rsdp/engine/core';
import type { HandView, RotationView, TableView } from '@rsdp/engine/wire';
import { GameLine, rotationChip } from './GameLine';

const L: BettingKind = 'fixed-limit';
const STAKES: Stakes = { smallBlind: 1, bigBlind: 2, ante: 0, anteType: 'none', bringIn: 1, smallBet: 2, bigBet: 4 };

/** Razz in an 8-Game rotation, Seven Card Stud next. */
const razz = (over: Partial<RotationView> = {}): RotationView => ({
  gameId: 'razz',
  betting: L,
  gameName: 'Razz',
  dealt: 2,
  handsLeft: 3,
  next: { gameId: 'stud', betting: L, gameName: 'Seven Card Stud' },
  ...over,
});
const handOf = (gameId: string, betting: BettingKind = L) => ({ gameId, betting }) as HandView;
const upcoming = (gameId: string, betting: BettingKind = L): TableView['upcoming'] => ({ gameId, betting, gameName: gameId, stakes: STAKES });

describe("the rotation's count in the top bar (#373)", () => {
  it('counts the hands after the one on the table, and names the next game', () => {
    expect(rotationChip({ rotation: razz(), hand: handOf('razz'), upcoming: null })).toEqual({ full: '3 more hands, then Seven Card Stud', short: '3 more, then Stud' });
    expect(rotationChip({ rotation: razz({ handsLeft: 1 }), hand: handOf('razz'), upcoming: null })?.full).toBe('1 more hand, then Seven Card Stud');
    expect(rotationChip({ rotation: razz({ handsLeft: 0 }), hand: handOf('razz'), upcoming: null })).toEqual({ full: 'Last hand, then Seven Card Stud', short: 'Last hand, then Stud' });
  });

  it("before the game's first hand: how many hands it will have", () => {
    // A new table: no hand yet, the next one starts Razz.
    expect(rotationChip({ rotation: razz({ dealt: 0, handsLeft: 6 }), hand: null, upcoming: upcoming('razz') })?.full).toBe('6 hands, then Seven Card Stud');
    expect(rotationChip({ rotation: razz({ dealt: 0, handsLeft: 1 }), hand: null, upcoming: upcoming('razz') })?.full).toBe('1 hand, then Seven Card Stud');
  });

  it('says which game the count is for when another is on the table (a bomb pot)', () => {
    expect(rotationChip({ rotation: razz(), hand: handOf('nlhe', 'no-limit'), upcoming: null })).toEqual({ full: 'Razz: 3 more hands, then Seven Card Stud', short: 'Razz: 3 more, then Stud' });
    expect(rotationChip({ rotation: razz({ handsLeft: 0 }), hand: handOf('nlhe', 'no-limit'), upcoming: null })?.full).toBe('Razz: last hand, then Seven Card Stud');
  });

  it("names Limit and No-Limit Hold'em apart, as 8-Game plays both", () => {
    const lhe = razz({ gameId: 'nlhe', betting: L, gameName: "Limit Hold'em", next: { gameId: 'nlhe', betting: 'no-limit', gameName: "No-Limit Hold'em" } });
    expect(rotationChip({ rotation: lhe, hand: handOf('nlhe', L), upcoming: null })).toEqual({ full: "3 more hands, then No-Limit Hold'em", short: '3 more, then NLH' });
    // The hand on the table is No-Limit, so the count names Limit Hold'em.
    expect(rotationChip({ rotation: lhe, hand: handOf('nlhe', 'no-limit'), upcoming: null })?.short).toBe('LHE: 3 more, then NLH');
  });

  it("only names the next game when the count can't be worked out, and says nothing without a rotation", () => {
    expect(rotationChip({ rotation: razz({ handsLeft: null }), hand: handOf('razz'), upcoming: null })).toEqual({ full: 'Seven Card Stud next', short: 'Stud next' });
    expect(rotationChip({ rotation: null, hand: handOf('razz'), upcoming: null })).toBeNull();
    expect(rotationChip({ hand: handOf('razz'), upcoming: null })).toBeNull();
    // All its hands played and none on the table: the bar already shows the next game.
    expect(rotationChip({ rotation: razz({ handsLeft: 0 }), hand: null, upcoming: upcoming('stud') })).toBeNull();
  });
});

describe('the game line', () => {
  const game = { full: 'Razz', short: 'Razz' };
  const chip = { full: '3 more hands, then Seven Card Stud', short: '3 more, then Stud' };

  it('on a computer: the game, the count, then the stakes and the table, on one line', () => {
    const { container } = render(<GameLine portrait={false} game={game} chip={chip} more={['ante 1 · bring-in 2', '', "John's table"]} />);
    const line = container.querySelector('.game-line')!;
    expect([...line.children].map((c) => [c.className, c.textContent])).toEqual([
      ['game-now', 'Razz'],
      ['game-chip', '3 more hands, then Seven Card Stud'],
      ['game-more', "ante 1 · bring-in 2 · John's table"],
    ]);
  });

  it('on a phone: the game and the table, then the count and the stakes', () => {
    const { container } = render(<GameLine portrait game={game} chip={chip} more={['ante 1 · bring-in 2', "John's table"]} />);
    const rows = [...container.querySelectorAll('.game-row')].map((r) => r.textContent);
    expect(rows).toEqual(["Razz John's table", '3 more, then Stud ante 1 · bring-in 2']);
  });
});
