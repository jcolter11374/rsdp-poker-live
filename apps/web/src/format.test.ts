import { describe, expect, it } from 'vitest';
import { bbFormat } from './format';

describe('bbFormat', () => {
  it('shows amounts in big blinds, to one decimal when it is not whole', () => {
    const fmt = bbFormat(20);
    expect(fmt(200)).toBe('10 BB');
    expect(fmt(250)).toBe('12.5 BB');
    expect(fmt(10)).toBe('0.5 BB');
    expect(fmt(7)).toBe('0.35 BB');
    expect(bbFormat(100)(1)).toBe('0.01 BB');
    expect(bbFormat(50)(25)).toBe('0.5 BB');
  });
});
