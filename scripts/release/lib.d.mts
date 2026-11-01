// Types for lib.mjs, so the TypeScript tests can import it.

export interface ChangelogEntry {
  id: string;
  date: string;
  fixes: string[];
  commit?: string;
}
export interface WhatsNewEntry {
  id: string;
  date: string;
  title: string;
  items: { title: string; detail: string; suggestedBy?: string }[];
}

export const VERSION_RE: RegExp;
export function isVersion(id: string): boolean;
export function tagOf(version: string): string;
export function dayOf(id: string): string | null;
export function compareReleaseIds(a: string, b: string): number;
export function closingRefs(text: string | null | undefined, repo: string): number[];
export function issueRefs(text: string | null | undefined, repo: string): number[];
export function onDevelopMarker(pr: number, sha: string): string;
export function parseOnDevelopMarkers(text: string | null | undefined): { pr: number; sha: string }[];
export function prProblems(input: {
  pr: { base: string; head: string; body: string; labels: string[] };
  repo: string;
  logs: { pr: ChangelogEntry[]; base: ChangelogEntry[]; main: ChangelogEntry[]; develop?: ChangelogEntry[] };
  features?: { pr: WhatsNewEntry[]; base: WhatsNewEntry[]; main: WhatsNewEntry[]; develop?: WhatsNewEntry[] };
  /** The UTC date, YYYY-MM-DD; without it a release's version date isn't checked. */
  today?: string;
}): string[];
export function versionFor(date: string, used?: string[]): string;
export function renderChangelog(input: { changelog: ChangelogEntry[]; whatsnew: WhatsNewEntry[] }): string;
export function renderRelease(input: {
  entry: ChangelogEntry;
  feature?: WhatsNewEntry;
  closed?: { number: number; title: string }[];
  previous?: string | null;
  liveAt?: string | null;
}): string;
