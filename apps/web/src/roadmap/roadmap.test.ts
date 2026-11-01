import { describe, expect, it } from 'vitest';
import roadmap from './roadmap.json';
import { formatDay, type Roadmap } from './RoadmapPage';
import { logOrder, type Suggestion } from './suggestions';
import { compareReleaseIds, isVersion as libIsVersion } from '../../../../scripts/release/lib.mjs';
import { changelog, isVersion, releases } from './whatsNew';

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
      // The page uses each title as a React key.
      expect(new Set(s.items.map((it) => it.title)).size).toBe(s.items.length);
      for (const it of s.items) {
        expect(it.title).toBeTruthy();
        expect(it.detail).toBeTruthy();
      }
    }
  });

  it('was updated within a week of the newest release', () => {
    // Dates from the files only, never today's, so the answer is the same on any day.
    const newest = changelog.reduce((max, r) => (r.date > max ? r.date : max), '');
    const daysBehind = (Date.parse(newest) - Date.parse(data.lastUpdated)) / 86_400_000;
    expect(
      daysBehind,
      `roadmap.json was last updated ${data.lastUpdated}, more than a week before the newest release in changelog.json (${newest}). ` +
        'Update apps/web/src/roadmap/roadmap.json before releasing: move what shipped into "Live now", check "Coming in the next release" and "Later", and set lastUpdated.',
    ).toBeLessThanOrEqual(7);
  });
});

describe('formatDay', () => {
  it('keeps the calendar day in every time zone', () => {
    expect(formatDay('2026-10-25')).toBe('October 25, 2026');
  });
});

describe('suggestion log order', () => {
  const s = (id: number, status: Suggestion['status']) => ({ id, status }) as Suggestion;
  it('puts open ideas first, newest first, then shipped and declined', () => {
    expect(logOrder([s(1, 'shipped'), s(2, 'new'), s(3, 'declined'), s(4, 'approved')]).map((x) => x.id)).toEqual([4, 2, 3, 1]);
  });
});

describe('whatsnew.json', () => {
  it('lists releases newest first with unique ids, real dates and filled-in items', () => {
    expect(releases.length).toBeGreaterThan(0);
    expect(new Set(releases.map((r) => r.id)).size).toBe(releases.length);
    for (const r of releases) {
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(formatDay(r.date)).not.toContain('Invalid');
      expect(r.items.length).toBeGreaterThan(0);
      for (const it of r.items) expect(it.title && it.detail).toBeTruthy();
    }
    const ids = releases.map((r) => r.id);
    expect([...ids].sort(compareReleaseIds)).toEqual(ids);
  });
});

describe('changelog.json', () => {
  it('lists every release on What\'s new, newest first, with real dates', () => {
    const ids = changelog.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of releases) expect(ids).toContain(r.id);
    for (const r of changelog) {
      expect(formatDay(r.date)).not.toContain('Invalid');
      for (const fix of r.fixes) expect(fix).toBeTruthy();
    }
    expect([...ids].sort(compareReleaseIds)).toEqual(ids);
  });

  it('gives every release since versions began a version as its id, on its own date', () => {
    // The oldest versioned release (the list is newest first).
    const first = changelog.map((r) => isVersion(r.id)).lastIndexOf(true);
    expect(first).toBeGreaterThanOrEqual(0);
    for (const r of changelog.slice(0, first + 1)) {
      expect(isVersion(r.id), `${r.id} should be a version like 2026.11.01 (see CONTRIBUTING.md)`).toBe(true);
      expect(r.id.slice(0, 10).replaceAll('.', '-')).toBe(r.date);
    }
    for (const r of changelog.slice(first + 1)) expect(r.commit).toBeUndefined();
    for (const r of changelog) if (r.commit !== undefined) expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('agrees with the release scripts on what a version is', () => {
    for (const id of [...changelog.map((r) => r.id), '2026.11.01.10', '2026.11.01.1', '2026.11.1', 'v2026.11.01']) {
      expect(isVersion(id), id).toBe(libIsVersion(id));
    }
  });

  it('keeps small fixes off What\'s new', () => {
    for (const r of releases) for (const it of r.items) expect(it.title).not.toMatch(/fixes/i);
  });
});
