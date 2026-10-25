import { describe, expect, it } from 'vitest';
import { equity } from './equity';

describe('all-in equity', () => {
  it('counts the river exactly: a made hand against a flush draw', () => {
    // Nine hearts and three more tens: 12 outs of 44.
    const e = equity({
      gameId: 'nlhe',
      hands: [
        { seat: 0, cards: ['As', 'Ad'] },
        { seat: 3, cards: ['Kh', 'Qh'] },
      ],
      boards: [['2h', '7h', '9c', 'Jd']],
      dead: [],
    })!;
    expect(e[3]).toBeCloseTo(12 / 44, 5);
    expect(e[0]).toBeCloseTo(32 / 44, 5);
  });

  it('splits a chopped board and adds up to one', () => {
    // Rainbow board, same ranks in hand: every river is a chop.
    const e = equity({
      gameId: 'nlhe',
      hands: [
        { seat: 1, cards: ['2c', '3d'] },
        { seat: 2, cards: ['2s', '3h'] },
      ],
      boards: [['As', 'Kd', 'Qc', 'Jh']],
      dead: [],
    })!;
    expect(e[1]).toBeCloseTo(0.5, 5);
    expect(e[2]).toBeCloseTo(0.5, 5);
  });

  it('samples pre-flop and lands near the known numbers', () => {
    // Aces against kings: about 82%.
    const e = equity({
      gameId: 'nlhe',
      hands: [
        { seat: 0, cards: ['As', 'Ah'] },
        { seat: 1, cards: ['Kd', 'Kc'] },
      ],
      boards: [[]],
      dead: [],
      samples: 4000,
    })!;
    expect(e[0]).toBeGreaterThan(0.78);
    expect(e[0]).toBeLessThan(0.86);
    expect(e[0] + e[1]).toBeCloseTo(1, 5);
  });

  it('counts both halves of a hi-lo pot and both boards', () => {
    const hilo = equity({
      gameId: 'plo8',
      hands: [
        { seat: 0, cards: ['Ac', '2c', 'Kd', 'Kh'] },
        { seat: 1, cards: ['Qs', 'Qd', 'Js', 'Td'] },
      ],
      boards: [['3h', '4s', 'Kc', '9d']],
      dead: [],
    })!;
    expect(hilo[0]).toBeGreaterThan(0.75);
    expect(hilo[0] + hilo[1]).toBeCloseTo(1, 5);
    const two = equity({
      gameId: 'nlhe',
      hands: [
        { seat: 0, cards: ['As', 'Ad'] },
        { seat: 1, cards: ['Ks', 'Kd'] },
      ],
      boards: [
        ['Ah', '2c', '3d', '8s'],
        ['Kh', '2s', '3h', '8c'],
      ],
      dead: [],
    })!;
    // Aces win the first board, kings the second (barring the one card each).
    expect(two[0]).toBeGreaterThan(0.45);
    expect(two[0]).toBeLessThan(0.55);
  });

  it('works for stud and skips what it cannot know', () => {
    const stud = equity({
      gameId: 'stud',
      hands: [
        { seat: 0, cards: ['As', 'Ad', 'Ah', 'Kc', '7d', '2s'] },
        { seat: 1, cards: ['9s', 'Ts', 'Js', 'Qs', '2d', '3c'] },
      ],
      boards: [],
      dead: [],
    })!;
    expect(stud[1]).toBeGreaterThan(0.1);
    expect(stud[0] + stud[1]).toBeCloseTo(1, 5);
    expect(
      equity({
        gameId: 'td27',
        hands: [
          { seat: 0, cards: ['2c', '3d', '4h', '5s', '7c'] },
          { seat: 1, cards: ['2d', '3h', '4s', '6c', '8d'] },
        ],
        boards: [],
        dead: [],
      }),
    ).toBeNull();
    expect(
      equity({
        gameId: 'nlhe',
        hands: [
          { seat: 0, cards: ['??', 'Ad'] },
          { seat: 1, cards: ['Ks', 'Kd'] },
        ],
        boards: [[]],
        dead: [],
      }),
    ).toBeNull();
    expect(
      equity({
        gameId: 'nlhe',
        hands: [
          { seat: 0, cards: ['As', 'Ad'] },
          { seat: 1, cards: ['Ks', 'Kd'] },
        ],
        boards: [['2c', '3c', '4c', '5d', '9h']],
        dead: [],
      }),
    ).toBeNull();
  });
});
