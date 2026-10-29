import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectLicenses, licenseSummary, licenseText } from './licenses.mjs';
import { parseBlocks } from './src/fairness/markdown';
import { licenseCounts, whereText } from './src/fairness/CreditsPage';

// Licenses that only ask for the notice to go along with the code, which
// /third-party-licenses.txt does. Anything else needs a look before it ships.
const PERMISSIVE = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'OFL-1.1', '0BSD', 'BlueOak-1.0.0']);

describe('the /credits package list', () => {
  const list = collectLicenses();
  const named = (name: string) => list.find((p) => p.name === name);

  it('lists what the browser and the server run on, and not our own packages', () => {
    for (const name of ['react', 'react-dom', 'socket.io-client', '@fontsource-variable/inter', '@fontsource/barlow-condensed']) expect(named(name)?.parts, name).toContain('browser');
    for (const name of ['express', 'socket.io', '@electric-sql/pglite', 'zod']) expect(named(name)?.parts, name).toContain('server');
    expect(named('zod')?.parts).toEqual(['browser', 'server']);
    expect(list.some((p) => p.name.startsWith('@rsdp/'))).toBe(false);
  });

  it('leaves out tools only used to build and test', () => {
    for (const name of ['vite', 'vitest', 'typescript', 'playwright', 'pokersolver', 'drizzle-kit']) expect(named(name), name).toBeUndefined();
  });

  it('only ships permissive licenses', () => {
    for (const p of list) expect(PERMISSIVE.has(p.license), `${p.name} is ${p.license}`).toBe(true);
  });

  it('carries the license text of everything that reaches your browser', () => {
    for (const p of list.filter((x) => x.parts.includes('browser'))) expect(p.notices.length, p.name).toBeGreaterThan(0);
    const text = licenseText(list);
    expect(text).toContain('Copyright (c) Facebook, Inc. and its affiliates.');
    expect(text).toContain('SIL OPEN FONT LICENSE');
    expect(text).toContain('The Inter Project Authors');
  });

  it('gives the page a short list without the license texts', () => {
    const summary = licenseSummary(list);
    expect(summary).toHaveLength(list.length);
    expect(Object.keys(summary[0]).sort()).toEqual(['homepage', 'license', 'name', 'noticeFile', 'parts', 'version']);
    for (const p of summary) expect(p.homepage, p.name).toMatch(/^https?:\/\/[\w.-]+(\/|$)/);
  });
});

describe('/credits', () => {
  const credits = readFileSync(new URL('../../docs/CREDITS.md', import.meta.url), 'utf8');
  const blocks = parseBlocks(credits);

  it('renders docs/CREDITS.md with every table row the width of its header', () => {
    expect(blocks[0]).toMatchObject({ t: 'h', level: 1 });
    const tables = blocks.filter((b) => b.t === 'table');
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) for (const r of t.rows) expect(r.length, r.join(' | ')).toBe(t.head.length);
  });

  it('names every main building block the app depends on directly', () => {
    const direct = ['apps/web', 'apps/server', 'packages/engine'].flatMap((d) => Object.keys(JSON.parse(readFileSync(new URL(`../../${d}/package.json`, import.meta.url), 'utf8')).dependencies));
    const names: Record<string, string> = { react: 'React', 'react-dom': 'React', 'socket.io': 'Socket.IO', 'socket.io-client': 'Socket.IO', express: 'Express', '@electric-sql/pglite': 'PGlite', pg: 'node-postgres', 'drizzle-orm': 'Drizzle', zod: 'Zod', nanoid: 'nanoid', tsx: 'tsx', '@fontsource-variable/inter': 'Inter', '@fontsource/barlow-condensed': 'Barlow Condensed' };
    for (const dep of direct.filter((d) => !d.startsWith('@rsdp/'))) {
      expect(names[dep], `${dep} needs a line in docs/CREDITS.md`).toBeDefined();
      expect(credits).toContain(names[dep]);
    }
  });

  it('counts licenses and says where each package runs', () => {
    const p = (license: string) => ({ name: license, version: '1', license, homepage: '', parts: ['browser'], noticeFile: true });
    expect(licenseCounts([p('MIT'), p('ISC'), p('MIT')])).toEqual([['MIT', 2], ['ISC', 1]]);
    expect(whereText(['browser', 'server'])).toBe('your browser and the server');
  });
});
