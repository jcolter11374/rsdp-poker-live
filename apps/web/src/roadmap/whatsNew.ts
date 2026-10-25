import data from './whatsnew.json';

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
