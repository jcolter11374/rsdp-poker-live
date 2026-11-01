#!/usr/bin/env node
// Upgrade rehearsal (.github/workflows/upgrade.yml): the saved tables and
// tournaments, as the server running now reads them back. The leaderboard and
// the public record don't show this: a server that can't read a table's saved
// snapshot (a new RUNTIME_VERSION, a changed layout) drops the table at deploy,
// yet the leaderboard still adds up the same. compare.mjs compares two outputs
// (the workflow joins each with expect.sh's answers first).
//
//   ADMIN_KEY=... node scripts/upgrade/saved.mjs <site> > saved.json
//       finds every saved table and tournament in the server's own backup
//   ADMIN_KEY=... node scripts/upgrade/saved.mjs <site> saved.json > after.json
//       asks for the same ones again (after the upgrade, or the rollback)
//
// Each table is read with the admin page's lookup (GET /api/admin/tables/<id>:
// name, mode, hands, players), which reads its saved snapshot unless the
// table is open. Each tournament is read from its page's link preview
// (GET /tn/<id>), which reads its saved state and shows its name, or the
// site's own title when it can't. Neither wakes a table up or loads a
// tournament to play; the backup download goes in the server's public record,
// like any other.

import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

const [site, beforeFile] = process.argv.slice(2);
if (!site) {
  console.error('usage: ADMIN_KEY=... node scripts/upgrade/saved.mjs <site> [before.json]');
  process.exit(2);
}
// It downloads a whole backup with the admin key: a local copy only, never the live site.
if (/fly\.dev/.test(site)) {
  console.error('refused: this is for a local copy, never the live site');
  process.exit(2);
}
const key = process.env.ADMIN_KEY;
if (!key) {
  console.error('ADMIN_KEY must be set (the key the server was started with)');
  process.exit(2);
}
const admin = { 'X-Admin-Key': key };

const get = (path, headers) => fetch(`${site}${path}`, { headers, signal: AbortSignal.timeout(30_000) });

/** Ids of every saved table and tournament, and each tournament's status, from the server's backup. */
async function fromBackup() {
  const res = await get('/api/admin/backup', admin);
  if (!res.ok) throw new Error(`the backup download answered ${res.status}: ${await res.text()}`);
  const lines = createInterface({ input: Readable.fromWeb(res.body).pipe(createGunzip()), crlfDelay: Infinity });
  const tables = [];
  const tournaments = [];
  let ended = false;
  for await (const line of lines) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (row.end) ended = true;
    else if (row.t === 'table_snapshots') tables.push(row.r.table_id);
    else if (row.t === 'tournaments') tournaments.push({ id: row.r.id, status: row.r.status });
  }
  // A backup without its end line was cut short, and could be missing tables.
  if (!ended) throw new Error('the backup download stopped before its end');
  return { tables, tournaments };
}

async function table(id) {
  const res = await get(`/api/admin/tables/${encodeURIComponent(id)}`, admin);
  if (res.status === 404) return { id, missing: true };
  if (!res.ok) throw new Error(`table ${id}: the server answered ${res.status}: ${await res.text()}`);
  return { ...(await res.json()), id };
}

const fromHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

async function tournament({ id, status }) {
  const res = await get(`/tn/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`tournament ${id}: its page answered ${res.status}`);
  const html = await res.text();
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  const description = /<meta property="og:description" content="([^"]*)"/.exec(html)?.[1];
  return { id, ...(status && { status }), title: title && fromHtml(title), description: description && fromHtml(description) };
}

try {
  const ids = beforeFile ? JSON.parse(readFileSync(beforeFile, 'utf8')) : await fromBackup();
  const tableIds = ids.tables.map((t) => (typeof t === 'string' ? t : t.id));
  // In turn, not all at once: the server is small, and so is the made-up data.
  const out = { tables: [], tournaments: [] };
  for (const id of tableIds) out.tables.push(await table(id));
  // After the switch only the ids are asked again; the status before stays in the before file.
  for (const t of ids.tournaments) out.tournaments.push(await tournament(beforeFile ? { id: t.id } : t));
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(`Couldn't read the saved tables and tournaments: ${e.message}`);
  process.exit(1);
}
