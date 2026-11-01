#!/usr/bin/env node
// When a pull request is merged into develop: every issue it closes ("Closes
// #12") gets the "status: on develop" label and a comment, because GitHub
// only closes issues by itself for merges into main. release.mjs closes them
// once a release puts them on the live site. Run by
// .github/workflows/issue-status.yml.

import { readFileSync } from 'node:fs';
import { gh, repo, summary } from './github.mjs';
import { closingRefs, onDevelopMarker } from './lib.mjs';

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const pr = event.pull_request;
if (!pr?.merged || pr.base.ref !== 'develop') {
  console.log('Not a pull request merged into develop; nothing to do.');
  process.exit(0);
}

const done = [];
for (const n of closingRefs(pr.body ?? '', repo())) {
  const issue = await gh('GET', `/repos/{repo}/issues/${n}`, null, { allow404: true });
  if (!issue || issue.pull_request || issue.state !== 'open') {
    console.log(`#${n}: not an open issue; skipped.`);
    continue;
  }
  await gh('POST', `/repos/{repo}/issues/${n}/labels`, { labels: ['status: on develop'] });
  await gh('DELETE', `/repos/{repo}/issues/${n}/labels/${encodeURIComponent('status: in progress')}`, null, { allow404: true });
  await gh('POST', `/repos/{repo}/issues/${n}/comments`, {
    body:
      `Merged into \`develop\` in #${pr.number}. It isn't on the live site yet: this issue closes by itself when a release puts it there.\n\n` +
      onDevelopMarker(pr.number, pr.merge_commit_sha),
  });
  done.push(n);
}
const line = done.length ? `Marked ${done.map((n) => `#${n}`).join(', ')} as on develop.` : 'No open issues to mark.';
console.log(line);
await summary(line);
