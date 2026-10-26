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
    for (const f of FEATURES) {
      if (!f.link) continue;
      const route = f.link.href.replace(/^\//, '').replace(/\//g, '\\/');
      expect(app, f.link.href).toMatch(new RegExp(route));
    }
  });
});
