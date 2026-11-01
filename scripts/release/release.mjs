#!/usr/bin/env node
// After a deploy to the live site: tags the release (v + its version from
// changelog.json), publishes a GitHub release with its notes, and closes the
// issues it put live (the ones labelled "status: on develop" whose pull
// request is in the deployed commit). Never moves or deletes a tag.
// Run by .github/workflows/release.yml after Deploy, or by hand from there.
// Needs a full checkout (fetch-depth: 0) to read changelog.json at the deployed commit.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gh, ghAll, summary } from './github.mjs';
import { compareReleaseIds, isVersion, parseOnDevelopMarkers, renderRelease, tagOf } from './lib.mjs';

const DEPLOY_JOB = 'Deploy to Fly.io';
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

// The issues this deploy put live.
const shipped = [];
const onDevelop = await ghAll(`/repos/{repo}/issues?state=open&labels=${encodeURIComponent(ON_DEVELOP)}`);
for (const issue of onDevelop.filter((i) => !i.pull_request)) {
  const comments = await ghAll(`/repos/{repo}/issues/${issue.number}/comments`);
  const marks = comments.flatMap((c) => parseOnDevelopMarkers(c.body));
  if (!marks.length) {
    say(`#${issue.number} is labelled "${ON_DEVELOP}" but has no merge note; left open for a person to check.`);
    continue;
  }
  let live = false;
  for (const m of marks) if (await contains(sha, m.sha)) live = true;
  if (live) shipped.push(issue);
}

// Tag and publish every versioned release that has no tag yet, oldest first.
const changelog = json(sha, 'changelog.json');
const features = new Map(json(sha, 'whatsnew.json').map((r) => [r.id, r]));
const tags = new Set((await ghAll('/repos/{repo}/git/matching-refs/tags/v')).map((t) => t.ref.replace('refs/tags/', '')));
const versions = changelog.filter((r) => isVersion(r.id)).sort((a, b) => compareReleaseIds(b.id, a.id));
const newest = versions.at(-1)?.id;
let current = null;
for (const [i, entry] of versions.entries()) {
  const tag = tagOf(entry.id);
  if (tags.has(tag)) continue;
  const target = entry.commit ?? sha;
  if (entry.commit && !(await contains(sha, entry.commit))) {
    say(`::warning::${entry.id} names commit ${entry.commit}, which isn't part of the deployed commit; not tagged.`);
    continue;
  }
  const isThisDeploy = !entry.commit;
  await gh('POST', '/repos/{repo}/git/refs', { ref: `refs/tags/${tag}`, sha: target });
  const feature = features.get(entry.id);
  const release = await gh('POST', '/repos/{repo}/releases', {
    tag_name: tag,
    name: feature ? `${tag} · ${feature.title}` : tag,
    body: renderRelease({
      entry,
      feature,
      closed: isThisDeploy ? shipped.map((s) => ({ number: s.number, title: s.title })) : [],
      previous: i > 0 ? versions[i - 1].id : null,
      liveAt: isThisDeploy ? liveAt : null,
    }),
    make_latest: entry.id === newest ? 'true' : 'false',
  });
  say(`Tagged ${tag} at ${target.slice(0, 7)} and published ${release.html_url}`);
  if (isThisDeploy) current = release;
}
if (!current && shipped.length) {
  say('::warning::This deploy has no new versioned changelog entry, so it has no release of its own. Every release to main should add one (see CONTRIBUTING.md).');
}

for (const issue of shipped) {
  const where = current ? `[${current.tag_name}](${current.html_url})` : `the deploy of ${sha.slice(0, 7)} (${run.html_url})`;
  await gh('POST', `/repos/{repo}/issues/${issue.number}/comments`, { body: `Live on the site since ${liveAt}, in ${where}.` });
  await gh('DELETE', `/repos/{repo}/issues/${issue.number}/labels/${encodeURIComponent(ON_DEVELOP)}`, null, { allow404: true });
  await gh('PATCH', `/repos/{repo}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
  say(`Closed #${issue.number} (${issue.title}).`);
}
if (!shipped.length) say('No issues waiting on this release.');
await summary(`### Release\n\n${report.join('\n')}`);
