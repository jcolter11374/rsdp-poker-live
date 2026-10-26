// The scripts that check the public record from outside the server
// (scripts/transparency/mirror.mjs, scripts/verify-audit.mjs), run as their own
// processes against a real server, and the database refusing edits.

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handDigest, playerRef, tableRef } from '@rsdp/engine';
import { createApp } from '../src/app';
import { AuditLog, dbAuditStore, memoryAuditStore } from '../src/audit';
import { closeDb, type Db } from '../src/db';
import { createTestDb } from '../src/db/testing';

const run = promisify(execFile);
const root = path.resolve(__dirname, '../../..');
const node = (script: string, ...args: string[]) => run(process.execPath, [path.join(root, script), ...args]).then(
  (r) => ({ code: 0, out: r.stdout + r.stderr }),
  (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
);

async function serve(audit: AuditLog) {
  const server = createApp({ audit, build: { commit: 'abc1234', image: null, machine: null }, log: () => {} });
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  return { server, url: `http://localhost:${(server.http.address() as AddressInfo).port}` };
}

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await closeDb(db);
});

describe('the hourly copy and the standalone checker', () => {
  it('copies the record, carries on next time, and catches a rewritten record', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rsdp-copy-'));
    const audit = AuditLog.after(memoryAuditStore(), null, { log: () => {} });
    const a = await serve(audit);
    audit.admin('first', null);
    expect((await node('scripts/transparency/mirror.mjs', a.url, dir)).code).toBe(0);
    audit.admin('second', null);
    audit.admin('third', null);
    expect((await node('scripts/transparency/mirror.mjs', a.url, dir)).out).toMatch(/copied 3 to 4/);
    expect((await node('scripts/transparency/mirror.mjs', a.url, dir)).out).toMatch(/nothing new/);
    const month = new Date().toISOString().slice(0, 7);
    expect(readFileSync(path.join(dir, 'audit', `${month}.jsonl`), 'utf8').trim().split('\n')).toHaveLength(4);
    const checked = await node('scripts/verify-audit.mjs', '--site', a.url, '--copy', dir);
    expect(checked.out).toMatch(/every entry GitHub copied is still on the site, unchanged/);
    expect(checked.code).toBe(0);
    await a.server.close();

    // Another record served from the same place: as if the database had been rewritten.
    const other = AuditLog.after(memoryAuditStore(), null, { log: () => {} });
    const b = await serve(other);
    for (const action of ['first', 'second', 'changed', 'fourth', 'fifth']) other.admin(action, null);
    const verified = await node('scripts/verify-audit.mjs', '--site', b.url, '--copy', dir);
    expect(verified.code).toBe(1);
    expect(verified.out).toMatch(/entries GitHub copied are different or missing on the site now, the first being entry 1/);
    const caught = await node('scripts/transparency/mirror.mjs', b.url, dir);
    expect(caught.code).toBe(1);
    expect(caught.out).toMatch(/Entry 1 on the site no longer matches the copy/);
    expect(existsSync(path.join(dir, 'PROBLEM.md'))).toBe(true);
    // The old copy is kept aside, and the next run copies the record as it is now.
    expect(readdirSync(dir).some((f) => f.startsWith('audit-replaced-'))).toBe(true);
    const fresh = await node('scripts/transparency/mirror.mjs', b.url, dir);
    expect(fresh.out).toMatch(/copied 1 to 6/);
    expect(existsSync(path.join(dir, 'PROBLEM.md'))).toBe(false);
    await b.server.close();
  });

  it('catches an old entry edited in place, and tells an unreachable site apart', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rsdp-copy-'));
    const audit = AuditLog.after(memoryAuditStore(), null, { log: () => {} });
    for (const action of ['one', 'two', 'three']) audit.admin(action, null);
    const real = await audit.after(0, 10);
    // A site that serves entry 1 with different contents but the hash it had.
    let served = real;
    const fake = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/api/audit/head')) return res.end(JSON.stringify({ seq: served.length, hash: served.at(-1)!.hash }));
      const after = Number(new URL(req.url!, 'http://x').searchParams.get('after') ?? 0);
      res.end(JSON.stringify({ entries: served.filter((e) => e.seq > after) }));
    });
    await new Promise<void>((resolve) => fake.listen(0, resolve));
    const url = `http://localhost:${(fake.address() as AddressInfo).port}`;
    expect((await node('scripts/transparency/mirror.mjs', url, dir)).code).toBe(0);
    served = [{ ...real[0], data: { action: 'edited', target: null } }, ...real.slice(1)];
    const caught = await node('scripts/transparency/mirror.mjs', url, dir);
    expect(caught.code).toBe(1);
    expect(caught.out).toMatch(/Entry 1 on the site no longer matches the copy: .* with different contents/);
    await new Promise((resolve) => fake.close(resolve));

    const gone = await run(process.execPath, [path.join(root, 'scripts/transparency/mirror.mjs'), url, dir], { env: { ...process.env, MIRROR_WAITS: '[]' } }).then(
      () => 0,
      (e: { code: number }) => e.code,
    );
    expect(gone).toBe(2);
  });
});

describe('the deploy check', () => {
  // A stand-in for the gh CLI: GitHub has signed the image, and verifying it does whatever VERIFY says.
  const bin = mkdtempSync(path.join(tmpdir(), 'rsdp-gh-'));
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
case "$1" in
  api) case "$2" in
    */compare/*) echo '{"status":"ahead"}';;
    *) echo '{"attestations":[{}]}';;
  esac;;
  attestation) if [ "$VERIFY" = ok ]; then echo '[{"verificationResult":{"signature":{"certificate":{"sourceRepositoryDigest":"abc1234def","sourceRepositoryRef":"refs/heads/main"}}}}]'; else echo "$VERIFY" >&2; exit 1; fi;;
esac
`,
  );
  chmodSync(path.join(bin, 'gh'), 0o755);
  const machine = (env: Record<string, string> = {}) => ({
    id: 'm1',
    state: 'started',
    image_ref: { registry: 'registry.fly.io', repository: 'rsdp-poker-live', digest: 'sha256:aa' },
    config: { env: { NODE_ENV: 'production', PORT: '8080', PGLITE_DIR: '/data/pglite', PUBLIC_URL: 'https://rsdp-poker-live.fly.dev', FLY_PROCESS_GROUP: 'app', PRIMARY_REGION: 'iad', ...env }, init: {}, mounts: [{ path: '/data' }] },
    events: [{ type: 'start', status: 'started', timestamp: 1793000699376 }],
  });
  async function check(opts: { env?: Record<string, string>; verify?: string; version?: string; secrets?: string[] }) {
    const dir = mkdtempSync(path.join(tmpdir(), 'rsdp-deploys-'));
    mkdirSync(path.join(dir, 'copy'));
    writeFileSync(path.join(dir, 'machines.json'), JSON.stringify([machine(opts.env)]));
    writeFileSync(path.join(dir, 'version.json'), opts.version ?? '{"commit":"abc1234"}');
    writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify((opts.secrets ?? ['ADMIN_KEY']).map((name) => ({ name, digest: 'd' }))));
    const args = ['machines.json', 'version.json', 'secrets.json', path.join(root, 'fly.toml'), 'copy'].map((f) => (f.startsWith('/') ? f : path.join(dir, f)));
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, VERIFY: opts.verify ?? 'ok', WATCH_KEY: 'k', WATCH_RETRY_MS: '10' };
    return run(process.execPath, [path.join(root, 'scripts/transparency/deploys.mjs'), ...args], { env }).then(
      (r) => ({ code: 0, out: r.stdout + r.stderr, dir }),
      (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr, dir }),
    );
  }

  it('passes a signed image with the settings fly.toml gives', { timeout: 30_000 }, async () => {
    const r = await check({});
    expect(r.out).toMatch(/from abc1234def/);
    expect(r.code).toBe(0);
    // Secret fingerprints are keyed, never Fly's own.
    expect(readFileSync(path.join(r.dir, 'copy', 'deploys', 'current.json'), 'utf8')).not.toMatch(/"d"/);
  });

  it('flags settings that could run other code, and a site that won\'t say its commit', { timeout: 30_000 }, async () => {
    const r = await check({ env: { NODE_OPTIONS: '--require /tmp/x.js' }, secrets: ['ADMIN_KEY', 'DATABASE_URL'], version: '' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/sets NODE_OPTIONS/);
    expect(r.out).toMatch(/secret called DATABASE_URL/);
    expect(r.out).toMatch(/didn't say which commit/);
  });

  it('tells a failed signature from a hiccup', { timeout: 60_000 }, async () => {
    expect((await check({ verify: 'Error: verifying with issuer: failed to verify certificate identity' })).code).toBe(1);
    expect((await check({ verify: 'Error: failed to fetch manifest: connection reset' })).code).toBe(2);
  });
});

describe('the standalone rules', () => {
  it('agree with the app on every hash', async () => {
    const chain = (await import(path.join(root, 'scripts/transparency/chain.mjs'))) as Record<string, (...a: unknown[]) => unknown>;
    const audit = AuditLog.after(memoryAuditStore(), null, { log: () => {} });
    audit.admin('ünïcode "quoted" \\ action', 'x');
    audit.record('chips', { table: tableRef('t-1'), player: playerRef('t-1', 'p'), buyIn: 1_000_000, cashOut: 0 });
    const entries = await audit.after(0, 10);
    expect(chain.chainProblem(entries)).toBeNull();
    for (const e of entries) expect(chain.entryHash(e)).toBe(e.hash);
    expect(chain.tableRef('t-1')).toBe(tableRef('t-1'));
    expect(chain.playerRef('t-1', 'p')).toBe(playerRef('t-1', 'p'));
    const hand = { handId: 'h', commit: 'c', button: 2, seats: [{ seat: 3, playerId: 'b', stack: 5 }, { seat: 1, playerId: 'a', stack: 7 }], events: [{ t: 'deal', seat: 1, cards: [{ card: 'As', pos: 0 }], extra: undefined }] };
    expect(chain.handDigest(hand)).toBe(handDigest(hand));
  });
});

describe('the record in the database', () => {
  it('carries on from the last entry and refuses edits and deletes', async () => {
    const first = await AuditLog.open(dbAuditStore(db), { log: () => {} });
    first.admin('one', null);
    await first.flush();
    const second = await AuditLog.open(dbAuditStore(db), { log: () => {} });
    expect(second.latest()).toEqual(first.latest());
    second.admin('two', null);
    expect((await second.after(0, 10)).map((e) => e.seq)).toEqual([1, 2]);
    await expect(db.execute(sql`update audit_log set kind = 'admin' where seq = 1`)).rejects.toThrow(/append-only/);
    await expect(db.execute(sql`delete from audit_log where seq = 1`)).rejects.toThrow(/append-only/);
  });
});
