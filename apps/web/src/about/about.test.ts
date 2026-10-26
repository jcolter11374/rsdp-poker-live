import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FEATURES } from './features';

describe('about page', () => {
  it('has a title and detail for every feature', () => {
    for (const f of FEATURES) {
      expect(f.title.trim()).not.toBe('');
      expect(f.detail.trim()).not.toBe('');
    }
  });

  it('never names the site it was inspired by', () => {
    const text = JSON.stringify(FEATURES) + readFileSync(new URL('./AboutPage.tsx', import.meta.url), 'utf8');
    expect(text.toLowerCase()).not.toMatch(/poker\s*now/);
  });

  it('links only to pages that exist', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    const page = readFileSync(new URL('./AboutPage.tsx', import.meta.url), 'utf8');
    const hrefs = [...FEATURES.flatMap((f) => (f.link ? [f.link.href] : [])), ...[...page.matchAll(/href="([^"]+)"/g)].map((m) => m[1])];
    for (const href of hrefs) {
      const path = href.split('#')[0];
      if (path === '/') continue;
      // A route test in App.tsx looks like /^\/rules or path === '/tn/new'.
      const escaped = path.replace(/\//g, '\\/');
      expect(app.includes(`/^${escaped}`) || app.includes(`'${path}'`), href).toBe(true);
    }
  });
});
