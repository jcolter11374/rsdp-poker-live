#!/usr/bin/env node
// The deploy watcher's check, run every hour by .github/workflows/transparency.yml:
// which image Fly says the live machine runs, whether GitHub built and signed
// that exact image from the public code on main, and when the machine last
// started. Writes deploys/current.json, adds a line to deploys/log.jsonl when
// anything changed, and exits 1 (writing deploys/PROBLEM.md) when something is wrong.
//   node scripts/transparency/deploys.mjs <machines.json> <version.json> <folder>
// machines.json is `flyctl machines list --json`; version.json is the site's /api/version.
// Needs `gh` signed in, and `flyctl auth docker` so gh can read the image's manifest.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = 'jcolter11374/rsdp-poker-live';
const SIGNER = `${REPO}/.github/workflows/deploy.yml`;
const [machinesFile, versionFile, dir] = process.argv.slice(2);
if (!machinesFile || !versionFile || !dir) {
  console.error('usage: node scripts/transparency/deploys.mjs <machines.json> <version.json> <folder>');
  process.exit(2);
}
const folder = path.join(dir, 'deploys');
mkdirSync(folder, { recursive: true });
const machines = JSON.parse(readFileSync(machinesFile, 'utf8'));
let version = null;
try {
  version = JSON.parse(readFileSync(versionFile, 'utf8'));
} catch {}

/** Who built this image, by GitHub's signed record of it; null when GitHub has no such record. */
function attestation(image) {
  try {
    const out = execFileSync('gh', ['attestation', 'verify', `oci://${image}`, '--repo', REPO, '--signer-workflow', SIGNER, '--source-ref', 'refs/heads/main', '--format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const cert = JSON.parse(out)[0]?.verificationResult?.signature?.certificate ?? {};
    return { commit: cert.sourceRepositoryDigest ?? null, ref: cert.sourceRepositoryRef ?? null, run: cert.runInvocationURI ?? null };
  } catch {
    return null;
  }
}

const lastStart = (m) =>
  Math.max(0, ...(m.events ?? []).filter((e) => ['start', 'launch', 'restart'].includes(e.type) && e.status !== 'failed').map((e) => Number(e.timestamp) || 0));

const problems = [];
const seen = machines.map((m) => {
  const ref = m.image_ref ?? {};
  const digest = ref.digest ?? null;
  const image = digest ? `${ref.registry}/${ref.repository}@${digest}` : (m.config?.image ?? null);
  const signed = digest ? attestation(image) : null;
  if (m.state === 'started' && !signed) problems.push(`Machine ${m.id} runs ${image ?? 'an unknown image'}, which GitHub did not build and sign from main.`);
  return { id: m.id, state: m.state, image, digest, lastStart: lastStart(m) ? new Date(lastStart(m)).toISOString() : null, signed };
});
const running = seen.filter((m) => m.state === 'started');
if (running.length > 1) problems.push(`${running.length} machines are running; the site only ever runs one.`);
if (!version) problems.push('The site did not answer /api/version.');
else if (running[0]?.signed?.commit && version.commit && !running[0].signed.commit.startsWith(version.commit))
  problems.push(`The site says it runs commit ${version.commit}, but its image was built from ${running[0].signed.commit}.`);

const now = new Date().toISOString();
const current = { checked: now, machines: seen, site: version, problems };
let before = null;
try {
  before = JSON.parse(readFileSync(path.join(folder, 'current.json'), 'utf8'));
} catch {}
const key = (c) => JSON.stringify([c.machines.map((m) => [m.id, m.state, m.digest, m.lastStart]), c.site?.commit, c.site?.startedAt, c.problems]);
if (!before || key(before) !== key(current)) appendFileSync(path.join(folder, 'log.jsonl'), `${JSON.stringify(current)}\n`);
writeFileSync(path.join(folder, 'current.json'), `${JSON.stringify(current, null, 2)}\n`);

if (problems.length) {
  writeFileSync(path.join(folder, 'PROBLEM.md'), `# The deploy watcher found a problem\n\nChecked ${now}.\n\n${problems.map((p) => `- ${p}`).join('\n')}\n`);
  console.error(problems.join('\n'));
  process.exit(1);
}
rmSync(path.join(folder, 'PROBLEM.md'), { force: true });
console.log(running.map((m) => `${m.id}: ${m.digest} from ${m.signed?.commit}, started ${m.lastStart}`).join('\n') || 'no machine running');
