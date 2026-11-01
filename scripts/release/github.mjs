// A tiny GitHub REST client for the scripts in this folder, run from GitHub
// Actions with the job's own token (GITHUB_TOKEN). No packages needed.

const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';

export const repo = () => {
  const r = process.env.GITHUB_REPOSITORY;
  if (!r) throw new Error('GITHUB_REPOSITORY is not set; run this from GitHub Actions.');
  return r;
};

/** Calls the API. `path` may start with "/repos/{repo}"; returns the parsed body, or null for 404 when allow404. */
export async function gh(method, path, body, { allow404 = false } = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set.');
  const res = await fetch(`${API}${path.replace('{repo}', repo())}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && allow404) return null;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** Every item of a list endpoint, following pages. `key` picks the array out of an object reply. */
export async function ghAll(path, key) {
  const out = [];
  let first = null;
  for (let page = 1; page <= 100; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const reply = await gh('GET', `${path}${sep}per_page=100&page=${page}`);
    const items = key ? reply[key] : reply;
    // An endpoint that ignores paging sends the same page again: stop rather than loop.
    if (!items.length || (page > 1 && JSON.stringify(items[0]) === first)) return out;
    first = JSON.stringify(items[0]);
    out.push(...items);
    if (items.length < 100) return out;
  }
  throw new Error(`${path}: more than 100 pages`);
}

/** Writes Markdown to the job's summary page, when there is one. */
export async function summary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const { appendFileSync } = await import('node:fs');
  appendFileSync(file, `${markdown}\n`);
}
