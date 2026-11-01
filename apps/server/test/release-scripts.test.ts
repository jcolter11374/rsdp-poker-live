// The helpers behind our issue and release process (scripts/release/lib.mjs,
// see CONTRIBUTING.md): issue links in pull requests, release versions,
// CHANGELOG.md and the notes on each GitHub release.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  closingRefs,
  compareReleaseIds,
  dayOf,
  isVersion,
  issueRefs,
  onDevelopMarker,
  parseOnDevelopMarkers,
  prProblems,
  renderChangelog,
  renderRelease,
  tagOf,
  versionFor,
  type ChangelogEntry,
} from '../../../scripts/release/lib.mjs';

const root = path.resolve(__dirname, '../../..');
const REPO = 'jcolter11374/rsdp-poker-live';
const run = promisify(execFile);

describe('issue links in a pull request', () => {
  it('finds GitHub\'s closing keywords, in any case, with or without a colon', () => {
    expect(closingRefs('Closes #12', REPO)).toEqual([12]);
    expect(closingRefs('fixes: #3 and Resolved #4, close #3', REPO)).toEqual([3, 4]);
    expect(closingRefs(`Fixes ${REPO}#7 and closes https://github.com/${REPO}/issues/8`, REPO)).toEqual([7, 8]);
  });

  it('ignores other repositories, hints in HTML comments and words that only contain a keyword', () => {
    expect(closingRefs('Closes other/repo#5', REPO)).toEqual([]);
    expect(closingRefs('<!-- Closes #1 -->', REPO)).toEqual([]);
    expect(closingRefs('prefixes #9, enclose #10', REPO)).toEqual([]);
    expect(closingRefs('Closes #12abc', REPO)).toEqual([]);
    expect(closingRefs(null, REPO)).toEqual([]);
  });

  it('counts "Part of" and "Refs" as working on an issue without closing it', () => {
    expect(issueRefs('Part of #20. Refs #21', REPO)).toEqual([20, 21]);
    expect(closingRefs('Part of #20', REPO)).toEqual([]);
    expect(issueRefs('Closes #2, part of #1', REPO)).toEqual([2, 1]);
  });

  it('reads back the note left on an issue when its fix reaches develop', () => {
    const note = `Merged into develop in #9.\n\n${onDevelopMarker(9, 'abc1234def')}`;
    expect(parseOnDevelopMarkers(note)).toEqual([{ pr: 9, sha: 'abc1234def' }]);
    expect(parseOnDevelopMarkers('no note')).toEqual([]);
  });
});

describe('release versions', () => {
  it('are the date, then .2, .3 and so on for later releases that day', () => {
    for (const v of ['2026.11.01', '2026.11.01.2', '2026.11.01.10']) expect(isVersion(v)).toBe(true);
    for (const v of ['2026.11.1', '2026.11.01.1', '2026.11.01.0', '2026.11.01.02', '2026-11-01', 'v2026.11.01']) expect(isVersion(v)).toBe(false);
    expect(tagOf('2026.11.01.2')).toBe('v2026.11.01.2');
    expect(versionFor('2026-11-02')).toBe('2026.11.02');
    expect(versionFor('2026-11-02', ['2026.11.02', '2026.11.02.2'])).toBe('2026.11.02.3');
    expect(dayOf('2026.11.01.3')).toBe('2026-11-01');
    expect(dayOf('2026-10-31-d')).toBe('2026-10-31');
  });

  it('sort newest first, with versions after the old ids of the same day and .10 after .9', () => {
    const ids = ['2026-10-31', '2026.11.01.9', '2026-10-31-d', '2026.11.01', '2026.11.01.10', '2026.11.02', '2026-10-31-b'];
    expect([...ids].sort(compareReleaseIds)).toEqual(['2026.11.02', '2026.11.01.10', '2026.11.01.9', '2026.11.01', '2026-10-31-d', '2026-10-31-b', '2026-10-31']);
  });
});

describe('pull request checks', () => {
  const entry = (id: string, more: Partial<ChangelogEntry> = {}): ChangelogEntry => ({ id, date: dayOf(id) ?? '2026-11-01', fixes: ['x'], ...more });
  const live = [entry('2026.11.01', { commit: 'a'.repeat(40) }), entry('2026-10-31-d')];
  type Logs = { pr: ChangelogEntry[]; base?: ChangelogEntry[]; main?: ChangelogEntry[] };
  const check = (pr: { base?: string; head?: string; body?: string; labels?: string[] }, logs: Logs, today?: string) =>
    prProblems({
      pr: { base: 'develop', head: 'claude/x', body: '', labels: [], ...pr },
      repo: REPO,
      logs: { base: live, main: live, ...logs },
      today,
    });

  it('wants a pull request into develop to name its issue, unless it is labelled "no issue needed"', () => {
    expect(check({ body: 'Closes #4' }, { pr: live })).toEqual([]);
    expect(check({ body: 'Part of #4' }, { pr: live })).toEqual([]);
    expect(check({ labels: ['no issue needed'] }, { pr: live })).toEqual([]);
    expect(check({ body: 'Tidy up' }, { pr: live })[0]).toMatch(/Closes #123/);
  });

  it('lets one changelog entry wait on develop, with a free version as its id', () => {
    expect(check({ body: 'Closes #4' }, { pr: [entry('2026.11.01.2'), ...live] })).toEqual([]);
    expect(check({ body: 'Closes #4' }, { pr: [entry('2026-11-01-b'), ...live] })).toEqual([
      'The new changelog entry "2026-11-01-b" needs a version as its id, like 2026.11.01.2: see CONTRIBUTING.md.',
    ]);
    const pending = [entry('2026.11.01.2'), ...live];
    expect(check({ body: 'Closes #4' }, { base: pending, pr: [entry('2026.11.01.3'), ...pending] })).toEqual([
      'The next release already has a changelog entry, 2026.11.01.2. Add your lines to it instead of starting a new one.',
    ]);
    expect(check({ body: 'Closes #4' }, { base: pending, pr: [entry('2026-11-01-b'), ...pending] })).toEqual([
      '"2026-11-01-b" shouldn\'t be a new changelog entry: add its lines to 2026.11.01.2, the next release\'s entry.',
    ]);
    expect(check({ body: 'Closes #4' }, { pr: [entry('2026.11.02'), entry('2026.11.01.2'), ...live] })[0]).toMatch(/at most/);
    expect(check({ body: 'Closes #4' }, { pr: [entry('2026.11.01.2'), entry('2026.11.01.2'), ...live] })[0]).toMatch(/two entries called "2026\.11\.01\.2"/);
  });

  it('lets a pull request add lines to the waiting entry, but not to one that is already live', () => {
    const waiting = [entry('2026.11.02'), ...live];
    expect(check({ body: 'Closes #4' }, { base: waiting, pr: [entry('2026.11.02', { fixes: ['x', 'y'] }), ...live] })).toEqual([]);
    // 2026.11.02 shipped while this pull request was open.
    expect(check({ body: 'Closes #4' }, { base: waiting, main: waiting, pr: [entry('2026.11.02', { fixes: ['x', 'y'] }), ...live] })[0]).toMatch(
      /"2026\.11\.02" is already live/,
    );
    expect(check({ base: 'main', head: 'develop' }, { main: waiting, pr: [entry('2026.11.03'), entry('2026.11.02', { fixes: ['changed'] }), ...live] }, '2026-11-03')[0]).toMatch(
      /"2026\.11\.02" is already live/,
    );
  });

  it('lets main be merged back into develop after a fix went straight to main', () => {
    const fixes = [entry('2026.11.03.2'), entry('2026.11.03'), ...live];
    expect(check({ head: 'main', body: 'Part of #9' }, { main: fixes, pr: fixes })).toEqual([]);
    const waiting = [entry('2026.11.02'), ...live];
    expect(check({ head: 'main', body: 'Part of #9' }, { base: waiting, main: fixes, pr: [entry('2026.11.03.2'), entry('2026.11.03'), entry('2026.11.02'), ...live] })).toEqual([]);
  });

  it('wants a release into main to carry exactly one new entry, and needs no issue of its own', () => {
    const release = { base: 'main', head: 'develop', body: 'Release' };
    expect(check(release, { pr: [entry('2026.11.01.2'), ...live] }, '2026-11-01')).toEqual([]);
    expect(check(release, { pr: live })[0]).toMatch(/needs release notes/);
    expect(check(release, { pr: [entry('2026.11.02'), entry('2026.11.01.2'), ...live] })[0]).toMatch(/One release, one changelog entry/);
  });

  it('wants a release\'s version to be the day it goes live, and newer than every release already live', () => {
    const release = { base: 'main', head: 'develop' };
    expect(check(release, { pr: [entry('2026.11.01.2'), ...live] }, '2026-11-02')).toEqual([]);
    expect(check(release, { pr: [entry('2026.11.01.2'), ...live] }, '2026-11-04')).toEqual([
      "This release's version 2026.11.01.2 is from 2026-11-01, but a version is the day the release goes live. Rename it to 2026.11.04 (and its date to 2026-11-04, in whatsnew.json too), then run npm run changelog.",
    ]);
    const hotfix = [entry('2026.11.03'), ...live];
    expect(check(release, { main: hotfix, pr: [entry('2026.11.03'), entry('2026.11.02'), ...live] }, '2026-11-03')).toEqual([
      "This release's version 2026.11.02 isn't newer than 2026.11.03, which is already live. Rename it to 2026.11.03.2 (and its date to 2026-11-03, in whatsnew.json too), then run npm run changelog.",
    ]);
  });

  it('treats a fix straight into main as a release that also names its issue', () => {
    const problems = check({ base: 'main', head: 'claude/hotfix', body: 'Quick fix' }, { pr: live });
    expect(problems).toHaveLength(2);
    expect(check({ base: 'main', head: 'claude/hotfix', body: 'Fixes #9' }, { pr: [entry('2026.11.01.2'), ...live] }, '2026-11-01')).toEqual([]);
  });

  it('never counts the entry for a release that is already live as waiting', () => {
    const renamed = [entry('2026.11.01', { commit: 'a'.repeat(40) }), entry('2026-10-31-d')];
    const oldMain = [entry('2026-11-01'), entry('2026-10-31-d')];
    expect(check({ body: 'Closes #1' }, { base: oldMain, main: oldMain, pr: renamed })).toEqual([]);
    expect(check({ base: 'main', head: 'develop' }, { base: oldMain, main: oldMain, pr: [entry('2026.11.01.2'), ...renamed] }, '2026-11-01')).toEqual([]);
    expect(check({ base: 'main', head: 'develop' }, { base: oldMain, main: oldMain, pr: [entry('2026.11.01'), ...renamed.slice(1)] }, '2026-11-01')).toEqual([]);
  });
});

describe('release notes', () => {
  const changelog: ChangelogEntry[] = [
    { id: '2026.11.01.2', date: '2026-11-01', fixes: ['A fix.'] },
    { id: '2026.11.01', date: '2026-11-01', fixes: [], commit: 'a'.repeat(40) },
    { id: '2026-10-31-d', date: '2026-10-31', fixes: ['Old fix.'] },
  ];
  const whatsnew = [{ id: '2026.11.01', date: '2026-11-01', title: 'Big day', items: [{ title: 'Thing', detail: 'It works.', suggestedBy: 'Alon' }] }];

  it('lists versioned releases with links to their GitHub release, and older ones by date', () => {
    const md = renderChangelog({ changelog, whatsnew });
    expect(md).toContain('## [2026.11.01.2] - 2026-11-01\n\n### Fixed and changed\n\n- A fix.');
    expect(md).toContain('## [2026.11.01] - 2026-11-01\n\n_Big day_\n\n### New\n\n- **Thing.** It works. (Suggested by Alon.)');
    expect(md).toContain('## 2026-10-31 (d)\n\n### Fixed and changed\n\n- Old fix.');
    expect(md).toContain(`[2026.11.01]: https://github.com/${REPO}/releases/tag/v2026.11.01`);
    expect(md).not.toContain('[2026-10-31-d]');
  });

  it('give a GitHub release its notes, the issues it closed and a link to every change since the last one', () => {
    const body = renderRelease({ entry: changelog[0], closed: [{ number: 173, title: 'Rules' }], previous: '2026.11.01', liveAt: '2026-11-01 18:00 UTC' });
    expect(body).toContain('since 2026-11-01 18:00 UTC');
    expect(body).toContain('### Issues closed\n\n- #173 Rules');
    expect(body).toContain(`/compare/v2026.11.01...v2026.11.01.2`);
    expect(renderRelease({ entry: changelog[1], feature: whatsnew[0] })).toContain('First tagged release');
  });

  it('keeps CHANGELOG.md in step with changelog.json and whatsnew.json (run npm run changelog)', async () => {
    const r = await run(process.execPath, [path.join(root, 'scripts/changelog.mjs'), '--check']).then(
      () => 0,
      (e: { code: number }) => e.code,
    );
    expect(r).toBe(0);
    expect(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')).toContain('# Changelog');
  });
});

describe('labels', () => {
  it('has every label the process and scripts rely on, each with a colour and a description', () => {
    const labels: { name: string; color: string; description: string }[] = JSON.parse(readFileSync(path.join(root, '.github/labels.json'), 'utf8'));
    const names = labels.map((l) => l.name);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    for (const n of ['bug', 'enhancement', 'status: in progress', 'status: on develop', 'status: waiting on John', 'status: waiting on others', 'no issue needed']) {
      expect(names).toContain(n);
    }
    for (const l of labels) {
      expect(l.color).toMatch(/^[0-9a-f]{6}$/);
      expect(l.description.length).toBeGreaterThan(0);
      expect(l.description.length).toBeLessThanOrEqual(100);
    }
  });
});
