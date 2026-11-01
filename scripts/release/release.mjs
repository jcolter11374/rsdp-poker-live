#!/usr/bin/env node
// After a deploy to the live site: tags the release (v + its version from
// changelog.json), publishes a GitHub release with its notes, and closes the
// issues it put live (the ones labelled "status: on develop" whose pull
// request is in the deployed commit). Never moves or deletes a tag, and is
// safe to run again: it only does what is still missing.
// Run by .github/workflows/release.yml after Deploy, or by hand from there.
// Needs a full checkout (fetch-depth: 0) to read changelog.json at the deployed commit.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gh, ghAll, summary } from './github.mjs';
import { compareReleaseIds, isVersion, parseOnDevelopMarkers, renderRelease, tagOf } from './lib.mjs';

const DEPLOY_JOB = 'Deploy to Fly.io';
// Who our workflows comment as.
const BOT = 'github-actions[bot]';
const ON_DEVELOP = 'status: on develop';
const report = [];
const say = (line) => {
  console.log(line);
  report.push(`- ${line}`);
};

/** True when the Deploy run really deployed: the run also "succeeds" when its deploy job was skipped. */
async function deployed(run) {
  const { jobs } = await gh('GET', `/repos/{repo}/actions/runs/${run.id}/jobs`);
  return jobs.some((j) => j.name === DEPLOY_JOB && j.conclusion === 'success');
}

/** The Deploy run this release is for: the one that triggered us, or (run by hand) the newest that deployed. */
async function findDeploy() {
  if (process.env.GITHUB_EVENT_NAME === 'workflow_run') {
    const run = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).workflow_run;
    if (run.conclusion !== 'success' || run.head_branch !== 'main') return null;
    return (await deployed(run)) ? run : null;
  }
  const { workflow_runs: runs } = await gh('GET', '/repos/{repo}/actions/workflows/deploy.yml/runs?branch=main&status=success&per_page=20');
  for (const run of runs) if (await deployed(run)) return run;
  return null;
}

/** Whether commit `sha` is part of `head` (the same commit, or an ancestor of it). */
async function contains(head, sha) {
  if (head.startsWith(sha) || sha.startsWith(head)) return true;
  const cmp = await gh('GET', `/repos/{repo}/compare/${sha}...${head}`, null, { allow404: true });
  return cmp?.status === 'ahead' || cmp?.status === 'identical';
}

const json = (sha, file) => JSON.parse(execFileSync('git', ['show', `${sha}:apps/web/src/roadmap/${file}`], { encoding: 'utf8' })).releases;

const run = await findDeploy();
if (!run) {
  console.log('No deploy to release: the Deploy run failed, was skipped, or was not for main.');
  process.exit(0);
}
const sha = run.head_sha;
const liveAt = `${run.updated_at.replace('T', ' ').slice(0, 16)} UTC`;
say(`Deploy run ${run.html_url} put ${sha.slice(0, 7)} live at ${liveAt}.`);

// The issues this deploy put live: labelled "status: on develop" (still open, or already closed
// by GitHub because a "Closes #n" reached main), with a merge note that is part of the deployed commit.
const shipped = [];
const labelled = await ghAll(`/repos/{repo}/issues?state=all&labels=${encodeURIComponent(ON_DEVELOP)}`);
for (const issue of labelled.filter((i) => !i.pull_request)) {
  const comments = await ghAll(`/repos/{repo}/issues/${issue.number}/comments`);
  // Only the notes our own workflow left count: anyone can comment on a public repository.
  const marks = comments.filter((c) => c.user?.login === BOT).flatMap((c) => parseOnDevelopMarkers(c.body));
  if (!marks.length) {
    if (issue.state === 'open') say(`#${issue.number} is labelled "${ON_DEVELOP}" but has no merge note; left open for a person to check.`);
    continue;
  }
  let live = false;
  for (const m of marks) if (!live && (await contains(sha, m.sha))) live = true;
  if (live) shipped.push(issue);
}

/** The commit on main that first put release `id` live: the oldest in an unbroken run of main's own commits, up to the deployed one, whose changelog.json has it. */
function firstCommitWith(id) {
  const commits = execFileSync('git', ['log', '--first-parent', '--format=%H', sha, '--', 'apps/web/src/roadmap/changelog.json'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  let found = null;
  for (const c of commits) {
    let has = false;
    try {
      has = json(c, 'changelog.json').some((r) => r.id === id);
    } catch {}
    if (!has) break;
    found = c;
  }
  return found;
}

// A GitHub release for every versioned entry that has none yet, oldest first. Creating the release
// creates its tag, or uses the tag if it's already there: a tag is never moved or deleted, and a
// failure leaves nothing a re-run can't finish.
const changelog = json(sha, 'changelog.json');
const features = new Map(json(sha, 'whatsnew.json').map((r) => [r.id, r]));
const versions = changelog.filter((r) => isVersion(r.id)).sort((a, b) => compareReleaseIds(b.id, a.id));
let current = null;
for (const [i, entry] of versions.entries()) {
  const tag = tagOf(entry.id);
  const target = entry.commit ?? firstCommitWith(entry.id);
  const isThisDeploy = !entry.commit && target === sha;
  const existing = await gh('GET', `/repos/{repo}/releases/tags/${encodeURIComponent(tag)}`, null, { allow404: true });
  if (existing) {
    if (isThisDeploy) current = existing;
    continue;
  }
  if (!target || (entry.commit && !(await contains(sha, entry.commit)))) {
    say(`::warning::Couldn't find the commit that put ${entry.id} live${entry.commit ? ` (${entry.commit} isn't part of the deployed commit)` : ''}; no release made for it.`);
    continue;
  }
  const feature = features.get(entry.id);
  const release = await gh('POST', '/repos/{repo}/releases', {
    tag_name: tag,
    target_commitish: target,
    name: feature ? `${tag} · ${feature.title}` : tag,
    body: renderRelease({
      entry,
      feature,
      closed: isThisDeploy ? shipped.map((x) => ({ number: x.number, title: x.title })) : [],
      previous: i > 0 ? versions[i - 1].id : null,
      liveAt: isThisDeploy ? liveAt : null,
    }),
    make_latest: isThisDeploy ? 'true' : 'false',
  });
  say(`Published ${release.html_url} (${tag} at ${target.slice(0, 7)}).`);
  if (isThisDeploy) current = release;
}
if (!current && shipped.length) {
  say('::warning::This deploy has no new versioned changelog entry, so it has no release of its own. Every release to main should add one (see CONTRIBUTING.md).');
}

for (const issue of shipped) {
  const where = current ? `[${current.tag_name}](${current.html_url})` : `the deploy of ${sha.slice(0, 7)} (${run.html_url})`;
  const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name)).filter((n) => n !== ON_DEVELOP);
  // Close it and drop the label in one step, so if this fails a re-run still finds it.
  await gh('PATCH', `/repos/{repo}/issues/${issue.number}`, issue.state === 'open' ? { state: 'closed', state_reason: 'completed', labels } : { labels });
  await gh('POST', `/repos/{repo}/issues/${issue.number}/comments`, { body: `Live on the site since ${liveAt}, in ${where}.` });
  say(`${issue.state === 'open' ? 'Closed' : 'Noted'} #${issue.number} (${issue.title}) as live.`);
}
if (!shipped.length) say('No issues waiting on this release.');
await summary(`### Release\n\n${report.join('\n')}`);
