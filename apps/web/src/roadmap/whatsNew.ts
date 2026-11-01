import data from './whatsnew.json';
import log from './changelog.json';

export interface Release {
  /** Unique, e.g. "2026-10-25-b"; the newest release's id decides whether the banner shows. */
  id: string;
  /** YYYY-MM-DD */
  date: string;
  title: string;
  items: { title: string; detail: string; suggestedBy?: string }[];
}

/** Newest first, as listed in whatsnew.json. */
export const releases = (data as { releases: Release[] }).releases;

/**
 * A release's small fixes. The same id as its What's new entry, when it has one.
 * Since 1 Nov 2026 the id is the release's version (2026.11.01, then 2026.11.01.2 for a
 * second release that day) and GitHub has a release tagged v + the version; older ids
 * (2026-10-31-d) have no tag. CONTRIBUTING.md explains how to add one.
 */
export interface ChangelogEntry {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  fixes: string[];
  /** Only for the first versioned release, which went live before tags existed: the commit to tag. */
  commit?: string;
}

/** Whether a release id is a version (see scripts/release/lib.mjs, whose VERSION_RE this must match). */
export const isVersion = (id: string) => /^\d{4}\.\d{2}\.\d{2}(?:\.([2-9]|[1-9]\d+))?$/.test(id);

/** The release's page on GitHub, for a versioned release. */
export const releaseUrl = (version: string) => `https://github.com/jcolter11374/rsdp-poker-live/releases/tag/v${version}`;

/** Every release, newest first, as listed in changelog.json. */
export const changelog = (log as { releases: ChangelogEntry[] }).releases;

const SEEN_KEY = 'rsdp.seenRelease';

/** The newest release, when this browser hasn't seen or dismissed it yet. */
export function unseenRelease(list: Release[] = releases): Release | null {
  const latest = list[0];
  if (!latest) return null;
  try {
    return localStorage.getItem(SEEN_KEY) === latest.id ? null : latest;
  } catch {
    return null;
  }
}

export function markSeen(list: Release[] = releases) {
  try {
    if (list[0]) localStorage.setItem(SEEN_KEY, list[0].id);
  } catch {
    // Only a convenience.
  }
}
