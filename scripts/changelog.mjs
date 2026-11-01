#!/usr/bin/env node
// Writes CHANGELOG.md from the site's release notes (changelog.json and
// whatsnew.json in apps/web/src/roadmap). With --check, only says whether
// CHANGELOG.md is up to date (exit 1 if not); the tests run that check.
//   npm run changelog            write CHANGELOG.md
//   node scripts/changelog.mjs --check

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderChangelog } from './release/lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => JSON.parse(readFileSync(path.join(root, 'apps/web/src/roadmap', file), 'utf8')).releases;
const text = renderChangelog({ changelog: read('changelog.json'), whatsnew: read('whatsnew.json') });
const target = path.join(root, 'CHANGELOG.md');

if (process.argv.includes('--check')) {
  let now = '';
  try {
    now = readFileSync(target, 'utf8');
  } catch {}
  if (now !== text) {
    console.error('CHANGELOG.md is out of date with changelog.json and whatsnew.json. Run: npm run changelog');
    process.exit(1);
  }
  console.log('CHANGELOG.md is up to date.');
} else {
  writeFileSync(target, text);
  console.log('Wrote CHANGELOG.md.');
}
