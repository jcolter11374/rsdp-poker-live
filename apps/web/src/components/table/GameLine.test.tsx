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
    expect(rotationChip({ rotation: razz(), hand: handOf('razz'), upcoming: null })).toEqual({ full: '3 more hands, then Seven Card Stud', short: 'Stud after 3 more' });
    expect(rotationChip({ rotation: razz({ handsLeft: 1 }), hand: handOf('razz'), upcoming: null })).toEqual({ full: '1 more hand, then Seven Card Stud', short: 'Stud after 1 more' });
    expect(rotationChip({ rotation: razz({ handsLeft: 0 }), hand: handOf('razz'), upcoming: null })).toEqual({ full: 'Last hand, then Seven Card Stud', short: 'Stud next hand' });
  });

  it("before the game's first hand: how many hands it will have", () => {
    // A new table: no hand yet, the next one starts Razz.
    expect(rotationChip({ rotation: razz({ dealt: 0, handsLeft: 6 }), hand: null, upcoming: upcoming('razz') })).toEqual({ full: '6 hands, then Seven Card Stud', short: 'Stud after 6 hands' });
    expect(rotationChip({ rotation: razz({ dealt: 0, handsLeft: 1 }), hand: null, upcoming: upcoming('razz') })).toEqual({ full: '1 hand, then Seven Card Stud', short: 'Stud after 1 hand' });
  });

  it('says which game the count is for when another is on the table (a bomb pot)', () => {
    expect(rotationChip({ rotation: razz(), hand: handOf('nlhe', 'no-limit'), upcoming: null })).toEqual({ full: 'Razz: 3 more hands, then Seven Card Stud', short: 'Stud after 3 more' });
    // The bomb pot is one of Razz's hands, so on the last one the next hand is Stud.
    expect(rotationChip({ rotation: razz({ handsLeft: 0 }), hand: handOf('nlhe', 'no-limit'), upcoming: null })).toEqual({ full: 'Razz: last hand, then Seven Card Stud', short: 'Stud next hand' });
  });

  it("names Limit and No-Limit Hold'em apart, as 8-Game plays both", () => {
    const lhe = razz({ gameId: 'nlhe', betting: L, gameName: "Limit Hold'em", next: { gameId: 'nlhe', betting: 'no-limit', gameName: "No-Limit Hold'em" } });
    expect(rotationChip({ rotation: lhe, hand: handOf('nlhe', L), upcoming: null })).toEqual({ full: "3 more hands, then No-Limit Hold'em", short: 'NLH after 3 more' });
    // The hand on the table is No-Limit, so the count names Limit Hold'em.
    expect(rotationChip({ rotation: lhe, hand: handOf('nlhe', 'no-limit'), upcoming: null })?.full).toBe("Limit Hold'em: 3 more hands, then No-Limit Hold'em");
  });

  it("names the game after this one, without a count, when there aren't two players to deal to", () => {
    // The game carries on when someone sits down, so the bar doesn't say the next game is next.
    expect(rotationChip({ rotation: razz({ handsLeft: null }), hand: handOf('razz'), upcoming: null })).toEqual({ full: 'Then Seven Card Stud', short: 'Then Stud' });
    expect(rotationChip({ rotation: razz({ handsLeft: null }), hand: handOf('nlhe', 'no-limit'), upcoming: null })).toEqual({ full: 'Razz, then Seven Card Stud', short: 'Razz, then Stud' });
  });

  it('says nothing without a rotation, or once the game is played out with nothing on the table', () => {
    expect(rotationChip({ rotation: null, hand: handOf('razz'), upcoming: null })).toBeNull();
    expect(rotationChip({ hand: handOf('razz'), upcoming: null })).toBeNull();
    // All its hands played and none on the table: the bar already shows the next game.
    expect(rotationChip({ rotation: razz({ handsLeft: 0 }), hand: null, upcoming: upcoming('stud') })).toBeNull();
  });

  it("keeps the short wording to what a 360px phone's bar fits, for HORSE and 8-Game's usual games", () => {
    const games: [string, BettingKind][] = [['nlhe', L], ['plo8', L], ['razz', L], ['stud', L], ['nlhe', 'no-limit'], ['plo4', 'pot-limit']];
    for (const [gameId, betting] of games) {
      for (const handsLeft of [0, 1, 3, 9]) {
        const words = rotationChip({ rotation: razz({ handsLeft, next: { gameId, betting, gameName: '' } }), hand: handOf('razz'), upcoming: null })!;
        // Measured in the real bar: "LHE after 3 more" fits at 360px, "Stud 8 after 12 more" doesn't.
        expect(words.short.length).toBeLessThanOrEqual(17);
      }
    }
  });
});

describe('the game line', () => {
  const game = { full: 'Razz', short: 'Razz' };
  const chip = { full: '3 more hands, then Seven Card Stud', short: 'Stud after 3 more' };

  it('on a computer: the game, the count, then the stakes and the table, on one line', () => {
    const { container } = render(<GameLine portrait={false} game={game} chip={chip} more={['ante 1 · bring-in 2', '', "John's table"]} />);
    const line = container.querySelector('.game-line')!;
    expect([...line.children].map((c) => [c.className, c.textContent])).toEqual([
      ['game-now', 'Razz'],
      ['game-chip', '3 more hands, then Seven Card Stud'],
      ['game-more', "ante 1 · bring-in 2 · John's table"],
    ]);
  });

  it('on a narrow computer window: the short count', () => {
    const { container } = render(<GameLine portrait={false} narrow game={game} chip={chip} more={["John's table"]} />);
    expect(container.querySelector('.game-chip')!.textContent).toBe('Stud after 3 more');
  });

  it('on a phone: the game and the table, then the count and the stakes', () => {
    const { container } = render(<GameLine portrait game={game} chip={chip} more={['ante 1 · bring-in 2', "John's table"]} />);
    const rows = [...container.querySelectorAll('.game-row')].map((r) => r.textContent);
    expect(rows).toEqual(["Razz John's table", 'Stud after 3 more ante 1 · bring-in 2']);
  });
});
