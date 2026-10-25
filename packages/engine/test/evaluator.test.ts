import { describe, expect, it } from 'vitest';
import { evaluate } from '../src';

const v = (s: string) => evaluate(s.split(' '));

describe('evaluate', () => {
  it('names categories', () => {
    expect(v('As Ks Qs Js Ts 2c 3d').name).toBe('Straight Flush');
    expect(v('9c 9d 9h 9s 2c 3d 4h').name).toBe('Four of a Kind');
    expect(v('9c 9d 9h 2s 2c 3d 4h').name).toBe('Full House');
    expect(v('Ah 9h 7h 4h 2h Kc Qd').name).toBe('Flush');
    expect(v('5c 4d 3h 2s Ac Kd Qh').name).toBe('Straight');
    expect(v('7c 7d 7h Ks 2c 3d 9h').name).toBe('Three of a Kind');
    expect(v('7c 7d Kh Ks 2c 3d 9h').name).toBe('Two Pair');
    expect(v('7c 7d Kh Qs 2c 3d 9h').name).toBe('Pair');
    expect(v('7c 8d Kh Qs 2c 3d Th').name).toBe('High Card');
  });

  it('orders hands correctly', () => {
    expect(v('Ac 2d 3h 4s 5c 9d Jh').score).toBeLessThan(v('2c 3d 4h 5s 6c 9d Jh').score);
    expect(v('Ac Ad Kh Ks 2c 3d 4h').score).toBeGreaterThan(v('Ac Ad Qh Qs Jc Td 9h').score);
    expect(v('Ac Ad Kh Qs Jc 3d 2h').score).toBeGreaterThan(v('Ac Ad Kh Qs Tc 3d 2h').score);
    expect(v('2c 2d 2h Ks Kd 3s 4s').score).toBeLessThan(v('3c 3d 3h 2s 2d 9s 8s').score);
  });

  it('plays the board', () => {
    expect(v('2c 3d As Ks Qs Js Ts').score).toBe(v('4c 5d As Ks Qs Js Ts').score);
  });
});
