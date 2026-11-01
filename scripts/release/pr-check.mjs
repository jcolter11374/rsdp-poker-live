#!/usr/bin/env node
// Checks a pull request follows CONTRIBUTING.md before it merges: it names
// the issue it works on, and a release into main carries exactly one new
// changelog entry with a version. Run by .github/workflows/pr-checks.yml;
// reads the pull request from the GitHub event and changelog.json from git,
// so it needs a full checkout (fetch-depth: 0). No API calls.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { prProblems } from './lib.mjs';

const FILE = 'apps/web/src/roadmap/changelog.json';
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const pr = event.pull_request;
if (!pr) {
  console.log('Not a pull request; nothing to check.');
  process.exit(0);
}

/** changelog.json's releases at a commit, or [] when the file isn't there. */
function releasesAt(ref) {
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:${FILE}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).releases;
  } catch {
    return [];
  }
}

const logs = {
  pr: JSON.parse(readFileSync(FILE, 'utf8')).releases,
  base: releasesAt(pr.base.sha),
  main: releasesAt('origin/main'),
};
const problems = prProblems({
  pr: { base: pr.base.ref, head: pr.head.ref, body: pr.body ?? '', labels: (pr.labels ?? []).map((l) => l.name) },
  repo: process.env.GITHUB_REPOSITORY,
  logs,
});
for (const p of problems) console.log(`::error::${p}`);
if (problems.length) process.exit(1);
console.log('The pull request names its issue and its release notes are in order.');
