// Shared, side-effect-free helpers for how we track work and ship releases:
// issue links in pull requests, release versions, CHANGELOG.md and the notes
// on each GitHub release. CONTRIBUTING.md explains the process in words.
// The scripts next to this file use these from GitHub Actions; the tests in
// apps/server/test/release-scripts.test.ts check them.

/**
 * A release's version is the day it goes live, plus `.2`, `.3`, … for later
 * releases on the same day (calendar versioning). It is also the release's id in
 * changelog.json and whatsnew.json, and its git tag is `v` + the version.
 * Releases from before 1 November 2026 keep their old ids (2026-10-31-d)
 * and have no tag.
 */
export const VERSION_RE = /^(\d{4})\.(\d{2})\.(\d{2})(?:\.([2-9]|[1-9]\d+))?$/;

export const isVersion = (id) => VERSION_RE.test(id);

export const tagOf = (version) => `v${version}`;

/** The calendar day a version or an old-style id belongs to, as YYYY-MM-DD. */
export function dayOf(id) {
  const v = VERSION_RE.exec(id);
  if (v) return `${v[1]}-${v[2]}-${v[3]}`;
  const old = /^(\d{4}-\d{2}-\d{2})(?:-[a-z])?$/.exec(id);
  return old ? old[1] : null;
}

/**
 * Sorts releases: compare(a, b) < 0 when a is newer. Same day: versions after
 * old-style ids, then by the `.N` count or the letter.
 */
export function compareReleaseIds(a, b) {
  const key = (id) => {
    const v = VERSION_RE.exec(id);
    if (v) return [`${v[1]}-${v[2]}-${v[3]}`, 1, Number(v[4] ?? 1)];
    const old = /^(\d{4}-\d{2}-\d{2})(?:-([a-z]))?$/.exec(id);
    if (old) return [old[1], 0, old[2] ? old[2].charCodeAt(0) - 96 : 0];
    return ['', 0, 0];
  };
  const [x, y] = [key(a), key(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] < y[i]) return 1;
    if (x[i] > y[i]) return -1;
  }
  return 0;
}

// GitHub's own closing keywords: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
const CLOSING = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
// Words that point at an issue without closing it.
const MENTION = '(?:refs?|part\\s+of|related\\s+to|see|for)';

/** Issue numbers this PR's text points at, in order, without repeats. `repo` is "owner/name". */
function refs(text, repo, words) {
  if (!text) return [];
  const escaped = repo.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const target = `(?:#|${escaped}#|https://github\\.com/${escaped}/issues/)(\\d+)\\b`;
  const re = new RegExp(`\\b${words}\\s*:?\\s+${target}`, 'gi');
  // HTML comments (like the PR template's hints) don't count.
  const plain = text.replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  for (const m of plain.matchAll(re)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Issues the PR says it finishes ("Closes #12", "fixes #3", a full issue link). */
export const closingRefs = (text, repo) => refs(text, repo, CLOSING);

/** Every issue the PR says it works on, finishing it or not ("Part of #12" too). */
export const issueRefs = (text, repo) => {
  const out = closingRefs(text, repo);
  for (const n of refs(text, repo, MENTION)) if (!out.includes(n)) out.push(n);
  return out;
};

/** The hidden note left on an issue when a PR that closes it is merged into develop. */
export const onDevelopMarker = (pr, sha) => `<!-- on-develop pr=${pr} sha=${sha} -->`;

/** Every {pr, sha} from those notes in a comment's text. */
export function parseOnDevelopMarkers(text) {
  return [...(text ?? '').matchAll(/<!-- on-develop pr=(\d+) sha=([0-9a-f]{7,40}) -->/g)].map((m) => ({ pr: Number(m[1]), sha: m[2] }));
}

/** The hidden note on the "live on the site" comment: the deployed commit. */
export const liveMarker = (sha) => `<!-- live sha=${sha} -->`;

/** The deployed commit from a "live" comment, or null. */
export function parseLiveMarker(text) {
  return /<!-- live sha=([0-9a-f]{7,40}) -->/.exec(text ?? '')?.[1] ?? null;
}

/**
 * What a pull request is missing before it can merge. `pr` is {base, head,
 * body, labels}; `logs` holds changelog.json's release lists and `features`
 * whatsnew.json's (optional), each as they are in the PR, on its base branch,
 * on main and (optional) on develop; `today` is the UTC date, YYYY-MM-DD.
 * Returns plain-English problems, each saying what to do.
 */
export function prProblems({ pr, repo, logs, features = { pr: [], base: [], main: [] }, today }) {
  const problems = [];
  const isRelease = pr.base === 'main' && pr.head === 'develop';
  const isHotfix = pr.base === 'main' && !isRelease;
  if (!isRelease && !pr.labels.includes('no issue needed') && issueRefs(pr.body, repo).length === 0) {
    problems.push(
      'Link the issue this pull request works on: put "Closes #123" in its description (or "Part of #123" if it only does some of it). ' +
        'For a tiny change that needs no issue, add the "no issue needed" label instead.',
    );
  }
  const develop = logs.develop ?? [];
  const ids = (list) => new Set(list.map((r) => r.id));
  const onMain = ids(logs.main);
  const onBase = ids(logs.base);
  const prIds = ids(logs.pr);
  const used = [...new Set([...logs.pr, ...logs.base, ...logs.main, ...develop].map((r) => r.id))];
  for (const id of prIds) {
    if (logs.pr.filter((r) => r.id === id).length > 1) problems.push(`The changelog has two entries called "${id}"; ids must be unique.`);
  }
  // An entry with a `commit` records a release that is already live (one from before tags existed).
  const pending = logs.pr.filter((r) => !onMain.has(r.id) && !r.commit);
  const added = logs.pr.filter((r) => !onBase.has(r.id) && !r.commit);
  // Entries new to the base branch that are live already (merging main back into develop brings these).
  const addedPending = added.filter((r) => !onMain.has(r.id));
  const waiting = pending.filter((r) => !addedPending.includes(r));
  const live = [...logs.main, ...logs.pr.filter((r) => r.commit)].map((r) => r.id).filter(isVersion);
  const newestLive = [...live].sort(compareReleaseIds)[0];
  for (const r of addedPending) {
    if (isVersion(r.id)) {
      if (today && daysBefore(today, dayOf(r.id)) > 1) problems.push(`The changelog entry ${r.id} is dated in the future. ${renameTo(today, used.filter((id) => id !== r.id), newestLive)}`);
      continue;
    }
    problems.push(
      pr.base !== 'main' && waiting.length
        ? `"${r.id}" shouldn't be a new changelog entry: add its lines to ${waiting[0].id}, the next release's entry.`
        : `The new changelog entry "${r.id}" needs a version as its id, like ${versionFor(r.date, used)}: see CONTRIBUTING.md.`,
    );
  }

  // A release that is live already keeps its notes and its name: new lines go in the next release's entry.
  const notes = (list, featureList, id) =>
    JSON.stringify([list.find((r) => r.id === id)?.fixes ?? null, featureList.find((r) => r.id === id) ?? null]);
  const nextEntry = waiting[0] ? ` (${waiting[0].id})` : '';
  for (const r of logs.pr) {
    if (!onMain.has(r.id)) continue;
    const mine = notes(logs.pr, features.pr, r.id);
    // Main's copy is the truth. Into develop, a copy develop already has passes too, so a pull request
    // that doesn't touch the entry isn't blocked by an earlier slip, and one that restores main's copy passes.
    const asMain = mine === notes(logs.main, features.main, r.id);
    const asBase = pr.base !== 'main' && onBase.has(r.id) && mine === notes(logs.base, features.base, r.id);
    if (!asMain && !asBase) {
      problems.push(`"${r.id}" is already live, so its notes can't change: make it match main, and put new lines in the next release's entry${nextEntry} or start one at the top.`);
    }
  }
  // The one-time move to versions: each live old-style id may become one version of the same day
  // that names its `commit` and keeps the same notes. Nothing else live may be renamed or removed.
  const content = (list, featureList, id) => {
    const twin = featureList.find((r) => r.id === id);
    return JSON.stringify([list.find((r) => r.id === id)?.fixes ?? null, twin ? { ...twin, id: null } : null]);
  };
  const movedTo = new Set();
  for (const r of pr.base === 'main' ? logs.main : logs.base) {
    if (!onMain.has(r.id) || prIds.has(r.id)) continue;
    if (!isVersion(r.id)) {
      const was = content(logs.main, features.main, r.id);
      const to = logs.pr.find(
        (x) => x.commit && isVersion(x.id) && !onMain.has(x.id) && !movedTo.has(x.id) && dayOf(x.id) === r.date && content(logs.pr, features.pr, x.id) === was,
      );
      if (to) {
        movedTo.add(to.id);
        continue;
      }
    }
    problems.push(`"${r.id}" is already live, so it can't be renamed or removed. Put new lines in the next release's entry${nextEntry}, or start one at the top.`);
  }

  if (pr.base === 'main') {
    if (pending.length === 0) {
      problems.push('A release needs release notes: add an entry at the top of apps/web/src/roadmap/changelog.json (see CONTRIBUTING.md).');
    } else if (pending.length > 1) {
      problems.push(`One release, one changelog entry: ${pending.map((r) => r.id).join(', ')} would all ship together. Put their lines into one entry.`);
    } else if (isVersion(pending[0].id)) {
      // The version is the day the release goes live, and newer than every release before it.
      const p = pending[0];
      const others = used.filter((id) => id !== p.id);
      const away = today ? daysBefore(dayOf(p.id), today) : 0;
      if (isHotfix && develop.some((r) => r.id === p.id)) {
        problems.push(`${p.id} is already the version of the release waiting on develop. ${renameTo(today, used, newestLive)}`);
      } else if (newestLive && compareReleaseIds(p.id, newestLive) >= 0) {
        problems.push(`This release's version ${p.id} isn't newer than ${newestLive}, which is already live. ${renameTo(today, others, newestLive)}`);
      } else if (away > 1 || away < -1) {
        problems.push(`This release's version ${p.id} is for ${dayOf(p.id)}, but a version is the day the release goes live. ${renameTo(today, others, newestLive)}`);
      }
    }
  } else if (addedPending.length > 1 || (addedPending.length > 0 && waiting.length > 0)) {
    if (!problems.some((x) => x.includes('the next release\'s entry.'))) {
      problems.push(
        waiting.length
          ? `The next release already has a changelog entry, ${waiting[0].id}. Add your lines to it instead of starting a new one.`
          : 'Add one changelog entry at most; put all of its lines into it.',
      );
    }
  }
  return problems;
}

/** What to rename a release's entry to: today's next free version, if that is newer than every live one. */
function renameTo(today, used, newestLive) {
  if (!today) return 'See CONTRIBUTING.md.';
  const taken = [...used];
  let v = versionFor(today, taken);
  while (newestLive && compareReleaseIds(v, newestLive) >= 0 && taken.length < used.length + 100) {
    taken.push(v);
    v = versionFor(today, taken);
  }
  if (newestLive && compareReleaseIds(v, newestLive) >= 0) {
    return `The newest live release, ${newestLive}, seems to be dated after today; a person needs to look at it.`;
  }
  return `Rename it to ${v} (and its date to ${today}, in whatsnew.json too), then run npm run changelog.`;
}

/** Whole days from `a` to `b` (both YYYY-MM-DD); 0 when either is missing. */
function daysBefore(a, b) {
  if (!a || !b) return 0;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** A version for a new release on `date` (YYYY-MM-DD), given the versions already used. */
export function versionFor(date, used = []) {
  const base = (date ?? '').replaceAll('-', '.');
  if (!used.includes(base)) return base;
  let n = 2;
  while (used.includes(`${base}.${n}`)) n++;
  return `${base}.${n}`;
}

const GITHUB = 'https://github.com/jcolter11374/rsdp-poker-live';
const SITE = 'https://rsdp-poker-live.fly.dev';

function sections(entry, feature) {
  const out = [];
  if (feature?.items.length) {
    out.push('### New', '');
    for (const it of feature.items) out.push(`- **${it.title}.** ${it.detail}${it.suggestedBy ? ` (Suggested by ${it.suggestedBy}.)` : ''}`);
    out.push('');
  }
  if (entry.fixes.length) {
    out.push('### Fixed and changed', '');
    for (const fix of entry.fixes) out.push(`- ${fix}`);
    out.push('');
  }
  if (!out.length) out.push('No notes for this release.', '');
  return out;
}

/** The old-style heading for a release from before versions: "2026-10-31 (d)". */
function oldHeading(id) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:-([a-z]))?$/.exec(id);
  return m ? (m[2] ? `${m[1]} (${m[2]})` : m[1]) : id;
}

/**
 * CHANGELOG.md, made from changelog.json (`changelog`, every release with its
 * fixes) and whatsnew.json (`whatsnew`, the releases with new features).
 */
export function renderChangelog({ changelog, whatsnew }) {
  const features = new Map(whatsnew.map((r) => [r.id, r]));
  const lines = [
    '# Changelog',
    '',
    'Every release of RSDP Poker Live!, newest first.',
    '',
    '<!-- Made by `npm run changelog` from apps/web/src/roadmap/changelog.json and whatsnew.json. Edit those, not this file. -->',
    'This file is made from [`changelog.json`](apps/web/src/roadmap/changelog.json) and',
    '[`whatsnew.json`](apps/web/src/roadmap/whatsnew.json), the same data as the site\'s',
    `[Changelog](${SITE}/changelog) and [What's new](${SITE}/whats-new) pages, so they can't`,
    'say different things. Don\'t edit it by hand: change the JSON and run `npm run changelog`.',
    'The layout follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).',
    '',
    'Versions are dates ([calendar versioning](https://calver.org/)): `2026.11.01` is the first',
    'release on 1 November 2026 and `2026.11.01.2` the second that day. Each version has a git',
    `tag (\`v2026.11.01\`) and a [GitHub release](${GITHUB}/releases) that also lists the issues it`,
    'closed. Releases before 1 November 2026 weren\'t tagged, so they are listed by date.',
    '',
    'On `main`, every entry here is live. On `develop`, the top entry may be the next release,',
    'still being filled in: its tag and GitHub release only exist once it goes live. Work that is',
    `merged but not live yet is also on the issues labelled [status: on develop](${GITHUB}/issues?q=is%3Aissue+is%3Aopen+label%3A%22status%3A+on+develop%22).`,
    '',
  ];
  const links = [];
  for (const entry of changelog) {
    const feature = features.get(entry.id);
    if (isVersion(entry.id)) {
      lines.push(`## [${entry.id}] - ${entry.date}`, '');
      links.push(`[${entry.id}]: ${GITHUB}/releases/tag/${tagOf(entry.id)}`);
    } else {
      lines.push(`## ${oldHeading(entry.id)}`, '');
    }
    if (feature) lines.push(`_${feature.title}_`, '');
    lines.push(...sections(entry, feature));
  }
  if (links.length) lines.push(...links, '');
  return lines.join('\n');
}

/**
 * The notes on one GitHub release. `closed` lists the issues it closes
 * ({number, title}); `previous` is the version before it, if any.
 */
export function renderRelease({ entry, feature, closed = [], previous = null, liveAt = null }) {
  const lines = [];
  if (feature) lines.push(`**${feature.title}**`, '');
  lines.push(`Live on ${SITE}${liveAt ? ` since ${liveAt}` : ''}. The same notes are on the site's [Changelog](${SITE}/changelog).`, '');
  lines.push(...sections(entry, feature));
  if (closed.length) {
    lines.push('### Issues closed', '');
    for (const i of closed) lines.push(`- #${i.number} ${i.title}`);
    lines.push('');
  }
  lines.push(
    previous
      ? `**Every change since ${tagOf(previous)}:** ${GITHUB}/compare/${tagOf(previous)}...${tagOf(entry.id)}`
      : `First tagged release. Earlier releases are listed by date in [CHANGELOG.md](${GITHUB}/blob/main/CHANGELOG.md).`,
    '',
  );
  return lines.join('\n');
}
