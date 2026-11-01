#!/usr/bin/env node
// When a pull request is merged into develop or main: every issue it closes
// ("Closes #12") gets the "status: on develop" label and a note recording the
// merge commit. GitHub only closes issues by itself for merges into main, and
// then before the deploy; release.mjs uses the note to close the issue, or
// note that it went live, once a deploy contains that commit. Run by
// .github/workflows/issue-status.yml.

import { readFileSync } from 'node:fs';
import { gh, repo, summary } from './github.mjs';
import { closingRefs, onDevelopMarker } from './lib.mjs';

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const pr = event.pull_request;
const into = pr?.base.ref;
if (!pr?.merged || (into !== 'develop' && into !== 'main')) {
  console.log('Not a pull request merged into develop or main; nothing to do.');
  process.exit(0);
}

const done = [];
for (const n of closingRefs(pr.body ?? '', repo())) {
  const issue = await gh('GET', `/repos/{repo}/issues/${n}`, null, { allow404: true });
  // Into main, GitHub may already have closed the issue as part of the merge.
  if (!issue || issue.pull_request || (into === 'develop' && issue.state !== 'open')) {
    console.log(`#${n}: not an open issue; skipped.`);
    continue;
  }
  await gh('POST', `/repos/{repo}/issues/${n}/labels`, { labels: ['status: on develop'] });
  await gh('DELETE', `/repos/{repo}/issues/${n}/labels/${encodeURIComponent('status: in progress')}`, null, { allow404: true });
  const text =
    into === 'develop'
      ? `Merged into \`develop\` in #${pr.number}. It isn't on the live site yet: this issue closes by itself when a release puts it there.`
      : `Merged into \`main\` in #${pr.number}. It goes live with the deploy that follows, and the release notes will say so here.`;
  await gh('POST', `/repos/{repo}/issues/${n}/comments`, { body: `${text}\n\n${onDevelopMarker(pr.number, pr.merge_commit_sha)}` });
  done.push(n);
}
const line = done.length ? `Noted the merge on ${done.map((n) => `#${n}`).join(', ')}.` : 'No issues to note.';
console.log(line);
await summary(line);
