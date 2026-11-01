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
import { compareReleaseIds, dayOf, isVersion, liveMarker, parseLiveMarker, parseOnDevelopMarkers, renderRelease, tagOf } from './lib.mjs';

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

const LIVE_NOTE = 'Live on the site since';

// The issues this deploy put live: labelled "status: on develop" (still open, or already closed
// by GitHub because a "Closes #n" reached main), whose newest merge note is part of the deployed commit.
const shipped = [];
const labelled = await ghAll(`/repos/{repo}/issues?state=all&labels=${encodeURIComponent(ON_DEVELOP)}`);
for (const issue of labelled.filter((i) => !i.pull_request)) {
  // Only what our own workflows wrote counts: anyone can comment on a public repository.
  const ours = (await ghAll(`/repos/{repo}/issues/${issue.number}/comments`)).filter((c) => c.user?.login === BOT);
  const noted = ours.filter((c) => parseOnDevelopMarkers(c.body).length);
  if (!noted.length) {
    if (issue.state === 'open') say(`#${issue.number} is labelled "${ON_DEVELOP}" but has no merge note; left open for a person to check.`);
    continue;
  }
  // The newest note decides: an issue reopened and fixed again waits for its new fix.
  const last = noted.at(-1);
  const mark = parseOnDevelopMarkers(last.body).at(-1);
  if (!(await contains(sha, mark.sha))) continue;
  const lives = ours.filter((c) => c.body.startsWith(LIVE_NOTE));
  // A run that failed after commenting shouldn't comment twice.
  const commented = lives.some((c) => c.id > last.id);
  // A late or repeated merge note for a fix an earlier deploy already put live: only tidy the label.
  let already = false;
  for (const c of lives.filter((c) => c.id < last.id)) {
    const was = parseLiveMarker(c.body);
    if (was && (await contains(was, mark.sha))) already = true;
  }
  shipped.push({ issue, mark, commented, already, release: null });
}

const changelog = json(sha, 'changelog.json');
const features = new Map(json(sha, 'whatsnew.json').map((r) => [r.id, r]));
const versions = changelog.filter((r) => isVersion(r.id)).sort((a, b) => compareReleaseIds(b.id, a.id));
const releases = new Map((await ghAll('/repos/{repo}/releases')).map((r) => [r.tag_name, r]));
const missing = versions.filter((e) => !releases.has(tagOf(e.id)));

// Where each version without a release first went live: one walk back through main's changes to
// changelog.json, stopping once every such version has dropped out of the file.
const firstSeen = new Map();
const tracking = new Set(missing.filter((e) => !e.commit).map((e) => e.id));
if (tracking.size) {
  const commits = execFileSync('git', ['log', '--first-parent', '--format=%H', sha, '--', 'apps/web/src/roadmap/changelog.json'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  for (const c of commits) {
    if (!tracking.size) break;
    let here = new Set();
    try {
      here = new Set(json(c, 'changelog.json').map((r) => r.id));
    } catch {}
    for (const id of [...tracking]) {
      if (here.has(id)) firstSeen.set(id, c);
      else tracking.delete(id);
    }
  }
}

// A GitHub release for every version that has none yet, oldest first, at the commit that added its
// entry (or, for the first, back-filled release, the `commit` it names). Creating the release creates
// its tag, or uses the tag if it's already there: a tag is never moved or deleted.
const newest = versions.at(-1) ?? null;
const fresh = [];
for (const entry of missing) {
  const target = entry.commit ?? firstSeen.get(entry.id);
  if (!target || (entry.commit && !(await contains(sha, entry.commit)))) {
    say(`::warning::Couldn't find the commit that put ${entry.id} live; no release made for it.`);
    continue;
  }
  // This deploy's own release is the one whose entry this deployed commit added. An older entry
  // whose release is missing (say its Release run failed) gets one at its own commit instead.
  fresh.push({ entry, target, isOwn: !entry.commit && target === sha });
}
// Run again for the same deploy, the release it made already exists.
let current = null;
const made = newest && releases.get(tagOf(newest.id));
if (!fresh.some((f) => f.isOwn) && made?.target_commitish === sha) current = made;
// Each shipped issue belongs to the oldest new release that contains its fix (several can go live
// in one deploy); the rest belong to this deploy's own release.
const live = shipped.filter((s) => !s.already);
for (const s of live) {
  for (const f of fresh) if (!s.release && !f.isOwn && (await contains(f.target, s.mark.sha))) s.release = f;
}
for (const f of fresh) {
  const { entry, target, isOwn } = f;
  const i = versions.indexOf(entry);
  const feature = features.get(entry.id);
  const closed = live.filter((s) => s.release === f || (isOwn && !s.release)).map((s) => ({ number: s.issue.number, title: s.issue.title }));
  const release = await gh('POST', '/repos/{repo}/releases', {
    tag_name: tagOf(entry.id),
    target_commitish: target,
    name: feature ? `${tagOf(entry.id)} · ${feature.title}` : tagOf(entry.id),
    body: renderRelease({ entry, feature, closed, previous: i > 0 ? versions[i - 1].id : null, liveAt: isOwn ? liveAt : null }),
    make_latest: entry === newest ? 'true' : 'false',
  });
  say(`Published ${release.html_url} (${release.tag_name} at ${target.slice(0, 7)}).`);
  f.made = release;
  if (isOwn) current = release;
}
const own = current ? newest : null;
if (own && dayOf(own.id) && Math.abs(Date.parse(dayOf(own.id)) - Date.parse(run.updated_at.slice(0, 10))) > 86_400_000) {
  say(`::warning::${own.id} is dated ${dayOf(own.id)} but went live on ${run.updated_at.slice(0, 10)}. Next time, rename the entry on the day the release merges (see CONTRIBUTING.md).`);
}
if (!current && live.length) {
  say('::warning::This deploy has no new versioned changelog entry, so it has no release of its own. Every release to main should add one (see CONTRIBUTING.md).');
}

for (const { issue, commented, already, release } of shipped) {
  const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name)).filter((n) => n !== ON_DEVELOP);
  if (already) {
    await gh('PATCH', `/repos/{repo}/issues/${issue.number}`, { labels });
    say(`#${issue.number} (${issue.title}) was already live; took its "${ON_DEVELOP}" label off.`);
    continue;
  }
  const rel = release?.made ?? current;
  const where = rel ? `[${rel.tag_name}](${rel.html_url})` : `the deploy of ${sha.slice(0, 7)} (${run.html_url})`;
  // Comment first, then close and drop the label in one step: if either fails, the issue still has
  // its label, so a re-run finds it again (and doesn't comment twice).
  if (!commented) await gh('POST', `/repos/{repo}/issues/${issue.number}/comments`, { body: `${LIVE_NOTE} ${liveAt}, in ${where}.\n\n${liveMarker(sha)}` });
  await gh('PATCH', `/repos/{repo}/issues/${issue.number}`, issue.state === 'open' ? { state: 'closed', state_reason: 'completed', labels } : { labels });
  say(`${issue.state === 'open' ? 'Closed' : 'Noted'} #${issue.number} (${issue.title}) as live.`);
}
if (!shipped.length) say('No issues waiting on this release.');
await summary(`### Release\n\n${report.join('\n')}`);
