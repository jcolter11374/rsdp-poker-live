// The site is called "RSDP Live!" (D35): the P in RSDP already stands for poker.
// This keeps the old name, "RSDP Poker Live!", from coming back in anything the
// site shows or the repo's docs say. Old release notes keep the name they had
// at the time, and the web address and repo name (rsdp-poker-live) stay.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');

const PLACES = [
  'apps/web/src',
  'apps/web/public',
  'apps/web/index.html',
  'apps/web/licenses.mjs',
  'apps/server/src',
  'packages',
  'scripts',
  'docs',
  'README.md',
  'CONTRIBUTING.md',
  'CLAUDE.md',
  '.github',
  'Dockerfile',
  'fly.toml',
];
const TEXT = /\.(tsx?|mts|mjs|cjs|js|json|md|html|css|svg|webmanifest|ya?ml|toml|txt|sh)$|^Dockerfile$/;
const OLD = /RSDP\s+Poker/i;

// The few places that name the old name on purpose, as narrowly as each allows.
// The upgrade rehearsal's rule matches page titles made before the rename.
const WHOLE_FILES = new Set(['scripts/upgrade/compare.mjs']);
/** Lines of a file that may name the old name. */
function allowed(file: string, lines: string[]): Set<number> {
  const ok = new Set<number>();
  // The first release's What's new title, already published on 2026-10-25 under the old name.
  if (file === 'apps/web/src/roadmap/whatsnew.json') lines.forEach((l, i) => l.includes('"title": "RSDP Poker Live! is live"') && ok.add(i));
  // D35, the decision that renamed the site, quotes John.
  if (file === 'docs/DECISIONS.md') {
    const start = lines.findIndex((l) => l.startsWith('## D35.'));
    if (start >= 0) for (let i = start; i < lines.length && (i === start || !lines[i].startsWith('## ')); i++) ok.add(i);
  }
  return ok;
}

function files(rel: string): string[] {
  const abs = path.join(root, rel);
  if (!statSync(abs).isDirectory()) return [rel];
  return readdirSync(abs, { recursive: true, encoding: 'utf8' })
    .filter((f) => !f.split(path.sep).includes('node_modules') && !f.split(path.sep).includes('dist'))
    .map((f) => path.join(rel, f).split(path.sep).join('/'))
    .filter((f) => statSync(path.join(root, f)).isFile());
}

describe('the site name', () => {
  it('is "RSDP Live!" everywhere: the old name "RSDP Poker Live!" is gone', () => {
    const found: string[] = [];
    for (const place of PLACES) {
      for (const f of files(place)) {
        if (WHOLE_FILES.has(f) || !TEXT.test(path.basename(f))) continue;
        const lines = readFileSync(path.join(root, f), 'utf8').split('\n');
        const ok = allowed(f, lines);
        lines.forEach((line, i) => {
          if (OLD.test(line) && !ok.has(i)) found.push(`${f}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(found, 'Say "RSDP Live!" (D35) instead of the old name in these lines').toEqual([]);
  });

  it('still allows the published first release title and D35, and nothing else in those files', () => {
    const whatsnew = ['    {', '      "title": "RSDP Poker Live! is live",', '      "title": "RSDP Poker Live! is back"'];
    expect([...allowed('apps/web/src/roadmap/whatsnew.json', whatsnew)]).toEqual([1]);
    const decisions = ['## D34. x', 'RSDP Poker Live!', '## D35. The site is called RSDP Live!', 'RSDP Poker Live!', '## D36. y', 'RSDP Poker Live!'];
    expect([...allowed('docs/DECISIONS.md', decisions)]).toEqual([2, 3]);
  });
});
