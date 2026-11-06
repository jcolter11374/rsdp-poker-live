import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CHECKED, GROUPS, MARKS } from './compare';

describe('compare page', () => {
  it('has groups with unique, filled-in rows and a known mark in every cell', () => {
    const features = GROUPS.flatMap((g) => g.rows.map((r) => r.feature));
    expect(new Set(features).size).toBe(features.length);
    for (const g of GROUPS) {
      expect(g.rows.length).toBeGreaterThan(0);
      for (const r of g.rows) for (const cell of [r.us, r.free, r.plus]) expect(MARKS[cell.mark]).toBeTruthy();
    }
  });

  it('keeps the rows where PokerNow is ahead (D28: the comparison stays honest)', () => {
    const row = (f: string) => GROUPS.flatMap((g) => g.rows).find((r) => r.feature === f);
    expect(row('Voice and video chat')?.us.mark).toBe('no');
    expect(row('Alerts on a locked phone')?.us.mark).toBe('partly');
    expect(row('Track record')?.us.mark).toBe('partly');
  });

  it('says when it was checked, and has no budget figures', () => {
    expect(CHECKED).toMatch(/^\d{1,2} \w+ \d{4}$/);
    const text = JSON.stringify(GROUPS) + readFileSync(new URL('./ComparePage.tsx', import.meta.url), 'utf8');
    expect(text).not.toMatch(/hosting|\$7\b/i);
  });

  it('has a route', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('/^\\/compare');
  });
});
