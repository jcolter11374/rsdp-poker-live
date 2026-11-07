import { describe, expect, it } from 'vitest';
import type { BettingKind, Stakes } from '@rsdp/engine/core';
import { bannerText, gameHeading, gameName, levelChange, sameGame } from './gameChange';

const L: BettingKind = 'fixed-limit';

describe('naming games for the top bar (#305, #373)', () => {
  it('names a game for big type without "(8 or better)"', () => {
    expect(gameHeading('plo8', L)).toBe('Limit Omaha Hi-Lo');
    expect(gameHeading('stud8')).toBe('Stud Hi-Lo');
    expect(gameHeading('plo4', 'pot-limit')).toBe('Pot-Limit Omaha');
    expect(gameHeading('razz')).toBe('Razz');
    expect(gameName('td27', L)).toEqual({ full: '2-7 Triple Draw', short: '2-7 TD' });
    expect(gameName('nlhe', L)).toEqual({ full: "Limit Hold'em", short: 'LHE' });
  });
});

describe('the new-game banner', () => {
  const stakes = (bb: number, ante = 0): Stakes => ({ smallBlind: bb / 2, bigBlind: bb, ante, anteType: ante ? 'per-player' : 'none', bringIn: 0, smallBet: bb, bigBet: bb * 2 });

  it('reads level, game and stakes', () => {
    expect(bannerText('game', 6, { gameId: 'plo4', betting: 'pot-limit' }, '400/800')).toEqual({ kicker: 'New game · Level 6', title: 'Pot-Limit Omaha', stakes: '400/800' });
    expect(bannerText('stakes', 7, { gameId: 'plo4', betting: 'pot-limit' }, '500/1,000')).toEqual({ kicker: 'New level · Level 7', title: 'Pot-Limit Omaha', stakes: '500/1,000' });
    // A cash table, or a tournament whose clock hasn't arrived yet: the rest still says what changed.
    expect(bannerText('game', null, { gameId: 'stud8', betting: 'fixed-limit' }, 'ante 25 · bring-in 30')).toEqual({ kicker: 'New game', title: 'Stud Hi-Lo', stakes: 'ante 25 · bring-in 30' });
  });

  it('shows for a new game or new stakes, not for another hand of the same', () => {
    const lhe = { gameId: 'nlhe', betting: L, stakes: stakes(200) };
    expect(levelChange(lhe, { ...lhe })).toBeNull();
    expect(levelChange(lhe, { ...lhe, stakes: stakes(300) })).toBe('stakes');
    expect(levelChange(lhe, { ...lhe, stakes: stakes(200, 25) })).toBe('stakes');
    expect(levelChange(lhe, { gameId: 'plo8', betting: L, stakes: stakes(300) })).toBe('game');
    expect(levelChange(lhe, { ...lhe, betting: 'no-limit' })).toBe('game');
    expect(sameGame({ gameId: 'nlhe' }, { gameId: 'nlhe', betting: 'no-limit' })).toBe(true);
  });
});
