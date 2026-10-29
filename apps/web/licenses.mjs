// The open-source packages the site ships, with their licenses, for /credits.
// Walks the installed dependency tree from the web app (what goes to your
// browser) and the server (what runs on the machine), skipping our own
// workspace packages and anything only used for building and testing.

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Where each part of the site starts its dependency tree. */
export const PARTS = { browser: 'apps/web', server: 'apps/server' };

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The installed copy of `name` that `fromDir` would load, as Node finds it. */
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dir === path.dirname(dir)) return null;
  }
}

/** The license field, whichever of the shapes npm has allowed over the years. */
function licenseOf(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x.type)).join(' OR ');
  if (l && typeof l === 'object') return l.type ?? 'UNKNOWN';
  return 'UNKNOWN';
}

/** A web page for the package: its homepage, else its repository, else its npm page. Never a non-web link. */
function homepageOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const fromRepo = !repo
    ? null
    : /^[\w-]+\/[\w.-]+$/.test(repo)
      ? `https://github.com/${repo}`
      : repo
          .replace(/^git\+/, '')
          .replace(/^(git|ssh):\/\/(git@)?/, 'https://')
          .replace(/^git@([^:]+):/, 'https://$1/')
          .replace(/^github:/, 'https://github.com/')
          .replace(/\.git$/, '');
  for (const url of [pkg.homepage, fromRepo]) if (typeof url === 'string' && /^https?:\/\//.test(url)) return url;
  return `https://www.npmjs.com/package/${pkg.name}`;
}

/** The license and notice files the authors ship with the package, in full. */
function noticeFiles(dir) {
  return readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice)(\b|[-_.]|$)/i.test(f))
    .sort()
    .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), 'utf8').trim() }));
}

/**
 * Every third-party package each part depends on at run time, sorted by name.
 * `parts` maps a label to a workspace folder; a package used by both is listed once with both labels.
 */
export function collectLicenses(root = ROOT, parts = PARTS) {
  const found = new Map();
  for (const [part, start] of Object.entries(parts)) {
    const seen = new Set();
    const visit = (dir) => {
      if (seen.has(dir)) return;
      seen.add(dir);
      const pkg = readJson(path.join(dir, 'package.json'));
      const ours = !dir.split(path.sep).includes('node_modules');
      if (!ours) {
        const key = `${pkg.name}@${pkg.version}`;
        const entry = found.get(key) ?? {
          name: pkg.name,
          version: pkg.version,
          license: licenseOf(pkg),
          homepage: homepageOf(pkg),
          parts: [],
          notices: noticeFiles(dir),
        };
        if (!entry.parts.includes(part)) entry.parts.push(part);
        found.set(key, entry);
      }
      const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
      for (const name of Object.keys(deps)) {
        const child = resolvePackage(name, dir);
        // A missing optional dependency (another platform's binary, say) isn't installed, so it isn't shipped.
        if (child) visit(child);
        else if (!pkg.optionalDependencies?.[name]) throw new Error(`${pkg.name} needs ${name}, which isn't installed`);
      }
    };
    visit(path.join(root, start));
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The short list the /credits page shows: no license texts, which are in the text file. */
export function licenseSummary(list) {
  return list.map(({ notices, ...rest }) => ({ ...rest, noticeFile: notices.length > 0 }));
}

/** One plain-text file with every package's license and notice files in full. */
export function licenseText(list) {
  const rule = '='.repeat(72);
  const head = [
    'RSDP Poker Live! uses the open-source packages below. Each is the work of its',
    'own authors and comes under its own license, reproduced here in full as the',
    'authors ship it. The plain-English credits are at /credits.',
    '',
  ];
  const body = list.map((p) => {
    const lines = [rule, `${p.name} ${p.version}`, `License: ${p.license}`, `Home: ${p.homepage}`, `Used in: ${p.parts.join(' and ')}`, rule, ''];
    if (p.notices.length === 0) lines.push(`(This package ships no license file; its package.json says "${p.license}".)`, '');
    for (const n of p.notices) lines.push(`--- ${n.file} ---`, '', n.text, '');
    return lines.join('\n');
  });
  return [...head, ...body].join('\n');
}

/**
 * Vite plugin: writes /licenses.json and /third-party-licenses.txt into the build,
 * and serves the same two files from the dev server, so they always match what's installed.
 */
export function licensesPlugin() {
  const files = () => {
    const list = collectLicenses();
    return { 'licenses.json': JSON.stringify(licenseSummary(list), null, 1), 'third-party-licenses.txt': licenseText(list) };
  };
  return {
    name: 'rsdp-licenses',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0].slice(1);
        if (name !== 'licenses.json' && name !== 'third-party-licenses.txt') return next();
        res.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8');
        res.end(files()[name]);
      });
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(files())) this.emitFile({ type: 'asset', fileName, source });
    },
  };
}
