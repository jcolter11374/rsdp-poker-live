import { describe, expect, it } from 'vitest';
import { cleanName } from '../src/names';

describe('display names', () => {
  it('cuts by whole characters, so an emoji at the limit is kept or dropped whole', () => {
    const name = 'a'.repeat(19) + '😀';
    expect(cleanName(name)).toBe(name);
    expect(cleanName('a'.repeat(20) + '😀')).toBe('a'.repeat(20));
    expect(/\p{Cs}/u.test(cleanName('a'.repeat(19) + '😀😀'))).toBe(false);
  });

  it('drops lone surrogates and control characters, which Postgres cannot store', () => {
    expect(cleanName('Bo\uD83D')).toBe('Bo');
    expect(cleanName('\uDE00Cy')).toBe('Cy');
    expect(cleanName('A\u0000n\u0007n\u2028')).toBe('Ann');
  });

  it('trims and returns empty when nothing is left', () => {
    expect(cleanName('   ')).toBe('');
    expect(cleanName(undefined)).toBe('');
    expect(cleanName('  Hana  ')).toBe('Hana');
  });
});
