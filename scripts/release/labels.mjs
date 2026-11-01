#!/usr/bin/env node
// Makes the repository's issue labels match .github/labels.json: creates
// missing ones and fixes colours and descriptions. It never deletes a label.
// Run by .github/workflows/labels.yml when that file changes.

import { readFileSync } from 'node:fs';
import { gh, ghAll, summary } from './github.mjs';

const wanted = JSON.parse(readFileSync('.github/labels.json', 'utf8'));
const have = new Map((await ghAll('/repos/{repo}/labels')).map((l) => [l.name.toLowerCase(), l]));
const changes = [];
for (const label of wanted) {
  const now = have.get(label.name.toLowerCase());
  if (!now) {
    await gh('POST', '/repos/{repo}/labels', label);
    changes.push(`created "${label.name}"`);
  } else if (now.name !== label.name || now.color.toLowerCase() !== label.color.toLowerCase() || (now.description ?? '') !== label.description) {
    await gh('PATCH', `/repos/{repo}/labels/${encodeURIComponent(now.name)}`, { new_name: label.name, color: label.color, description: label.description });
    changes.push(`updated "${label.name}"`);
  }
}
const line = changes.length ? `Labels: ${changes.join(', ')}.` : 'Labels already match .github/labels.json.';
console.log(line);
await summary(line);
