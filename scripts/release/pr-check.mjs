#!/usr/bin/env node
// Checks a pull request follows CONTRIBUTING.md before it merges: it names
// the issue it works on, and a release into main carries exactly one new
// changelog entry with a version. Run by .github/workflows/pr-checks.yml;
// reads the pull request from the GitHub event and changelog.json from git,
// so it needs a full checkout (fetch-depth: 0). No API calls.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { prProblems } from './lib.mjs';

const DIR = 'apps/web/src/roadmap';
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const pr = event.pull_request;
if (!pr) {
  console.log('Not a pull request; nothing to check.');
  process.exit(0);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** A notes file's releases at a commit, or [] when the file isn't there. */
function releasesAt(ref, file) {
  try {
    return JSON.parse(git('show', `${ref}:${DIR}/${file}`)).releases;
  } catch {
    return [];
  }
}

// actions/checkout checks out the merge of the pull request into its base as it is now; that
// merge's first parent is the base branch. (The event's base.sha is where the base was when the
// pull request was opened, which can be days old.)
let base = pr.base.sha;
try {
  git('rev-parse', 'HEAD^2'); // only a merge commit has a second parent
  base = git('rev-parse', 'HEAD^1');
} catch {}
const read = (file) => ({
  pr: JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8')).releases,
  base: releasesAt(base, file),
  main: releasesAt('origin/main', file),
});
const problems = prProblems({
  pr: { base: pr.base.ref, head: pr.head.ref, body: pr.body ?? '', labels: (pr.labels ?? []).map((l) => l.name) },
  repo: process.env.GITHUB_REPOSITORY,
  logs: read('changelog.json'),
  features: read('whatsnew.json'),
  today: new Date().toISOString().slice(0, 10),
});
for (const p of problems) console.log(`::error::${p}`);
if (problems.length) process.exit(1);
console.log('The pull request names its issue and its release notes are in order.');
