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
// Release notes already published, the decision that records the rename, and the
// upgrade rehearsal's rule for pages titled before it, which name the old one on purpose.
const ALLOWED = new Set([
  'apps/web/src/roadmap/changelog.json',
  'apps/web/src/roadmap/whatsnew.json',
  'docs/DECISIONS.md',
  'scripts/upgrade/compare.mjs',
]);
const TEXT = /\.(tsx?|mjs|cjs|js|json|md|html|css|svg|webmanifest|ya?ml|toml|txt)$|^(Dockerfile)$/;

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
        if (ALLOWED.has(f) || !TEXT.test(path.basename(f))) continue;
        readFileSync(path.join(root, f), 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (/RSDP\s+Poker/i.test(line)) found.push(`${f}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(found, 'Say "RSDP Live!" (D35) instead of the old name in these lines').toEqual([]);
  });
});
