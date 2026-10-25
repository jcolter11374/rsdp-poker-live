import { describe, expect, it } from 'vitest';
import roadmap from './roadmap.json';
import { formatDay, type Roadmap } from './RoadmapPage';

describe('roadmap.json', () => {
  const data = roadmap as Roadmap;

  it('has a real last-updated date', () => {
    expect(data.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatDay(data.lastUpdated)).not.toContain('Invalid');
  });

  it('has sections with unique ids and filled-in items', () => {
    expect(new Set(data.sections.map((s) => s.id)).size).toBe(data.sections.length);
    for (const s of data.sections) {
      expect(s.title).toBeTruthy();
      expect(s.items.length).toBeGreaterThan(0);
      for (const it of s.items) {
        expect(it.title).toBeTruthy();
        expect(it.detail).toBeTruthy();
      }
    }
  });
});

describe('formatDay', () => {
  it('keeps the calendar day in every time zone', () => {
    expect(formatDay('2026-10-25')).toBe('October 25, 2026');
  });
});
