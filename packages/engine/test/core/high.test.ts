import { describe, expect, it } from 'vitest';
import { highAwardPortion, highRules } from '../../src/core/high';
import { cards, holes, nlh } from './fixtures';

const board = cards('2c 7s 9d Jc 3h');

describe('highAwardPortion', () => {
  it('gives the whole portion to the best hand, with its name and cards', () => {
    const awards = highAwardPortion(nlh, 300, [1, 2, 0], holes({ 0: 'Kh Kd', 1: 'Ah Ad', 2: 'Qs Qc' }), board);
    expect(awards).toEqual([
      { seat: 1, amount: 300, half: 'scoop', handName: 'Pair of Aces', cards: expect.any(Array) },
    ]);
    expect([...awards[0].cards!].sort()).toEqual(['9d', 'Ad', 'Ah', 'Jc', '7s'].sort());
  });

  it('uses the best five of hole plus board', () => {
    const awards = highAwardPortion(nlh, 10, [0, 1], holes({ 0: 'Ts 4h', 1: 'Jh Jd' }), board);
    expect(awards).toEqual([expect.objectContaining({ seat: 1, handName: 'Three Jacks' })]);
    const straight = highAwardPortion(nlh, 10, [0, 1], holes({ 0: 'Ts 8h', 1: 'Jh Jd' }), board);
    expect(straight).toEqual([expect.objectContaining({ seat: 0, handName: 'Straight, Jack high' })]);
  });

  it('splits a tie evenly', () => {
    const awards = highAwardPortion(nlh, 200, [0, 1], holes({ 0: 'Ah Kd', 1: 'As Kc' }), board);
    expect(awards.map((a) => [a.seat, a.amount])).toEqual([[0, 100], [1, 100]]);
    expect(awards.every((a) => a.half === 'scoop' && a.handName === 'Ace High')).toBe(true);
  });

  it('gives the odd chip to the first winner in eligible order', () => {
    const h = holes({ 1: 'Ah Kd', 3: 'As Kc', 5: '4h 5d' });
    expect(highAwardPortion(nlh, 101, [3, 5, 1], h, board).map((a) => [a.seat, a.amount])).toEqual([[3, 51], [1, 50]]);
    expect(highAwardPortion(nlh, 101, [1, 3, 5], h, board).map((a) => [a.seat, a.amount])).toEqual([[1, 51], [3, 50]]);
  });

  it('hands out several odd chips one at a time', () => {
    const playsBoard = cards('As Ks Qs Js Ts');
    const h = holes({ 0: '2c 3d', 1: '2d 3c', 2: '2h 3h', 3: '4c 4d' });
    const awards = highAwardPortion(nlh, 103, [2, 3, 0, 1], h, playsBoard);
    expect(awards.map((a) => [a.seat, a.amount])).toEqual([[2, 26], [3, 26], [0, 26], [1, 25]]);
    expect(awards[0].handName).toBe('Royal Flush');
  });

  it('leaves out winners whose share is zero', () => {
    const h = holes({ 0: 'Ah Kd', 1: 'As Kc' });
    expect(highAwardPortion(nlh, 1, [1, 0], h, board)).toEqual([expect.objectContaining({ seat: 1, amount: 1 })]);
    expect(highAwardPortion(nlh, 0, [1, 0], h, board)).toEqual([]);
  });

  it('evaluates seven hole cards with an empty board (stud)', () => {
    const h = holes({ 0: 'Ah Ad Ac 2s 3s 4d 9c', 1: 'Kh Kd Kc Ks 2c 3c 5h' });
    expect(highAwardPortion(nlh, 50, [0, 1], h, [])).toEqual([
      expect.objectContaining({ seat: 1, amount: 50, handName: 'Four Kings' }),
    ]);
  });

  it('rejects missing cards and bad amounts', () => {
    expect(() => highAwardPortion(nlh, 10, [0, 1], holes({ 0: 'Ah Kd' }), board)).toThrow(/seat 1/);
    expect(() => highAwardPortion(nlh, 10, [], {}, board)).toThrow();
    expect(() => highAwardPortion(nlh, 2.5, [0], holes({ 0: 'Ah Kd' }), board)).toThrow();
    expect(() => highAwardPortion(nlh, -1, [0], holes({ 0: 'Ah Kd' }), board)).toThrow();
  });

  it('is what highRules awards with', () => {
    expect(highRules.awardPortion).toBe(highAwardPortion);
    expect(highRules.bringInSeat).toBeUndefined();
  });
});
