#!/usr/bin/env node
// The deploy watcher's check, run every hour by .github/workflows/transparency.yml:
// which image Fly says the live machine runs, whether GitHub built and signed
// that exact image from the public code on main, and when the machine last
// started. It also checks the machine's settings and secret names, since those
// can change what runs without a new image: the start command, and environment
// variables such as NODE_OPTIONS. Writes deploys/current.json, adds a line to
// deploys/log.jsonl when anything changed (including every start Fly reports, and
// a fingerprint of the settings and each secret), and exits 1 (writing
// deploys/PROBLEM.md) when something is wrong, or 2 when GitHub couldn't be asked.
//   node scripts/transparency/deploys.mjs <machines.json> <version.json> <secrets.json> <fly.toml> <folder>
// machines.json is `flyctl machines list --json`; version.json is the site's
// /api/version; secrets.json is `flyctl secrets list --json` (names and
// fingerprints only, never the values); fly.toml is the one on main.
// Needs `gh` signed in, and `flyctl auth docker` so gh can read the image's manifest.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = 'jcolter11374/rsdp-poker-live';
const SIGNER = `${REPO}/.github/workflows/deploy.yml`;
/** The secrets the code reads. Any other one is an environment variable nobody can see the value of. */
const SECRETS = ['ADMIN_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
const [machinesFile, versionFile, secretsFile, flyToml, dir] = process.argv.slice(2);
if (!machinesFile || !versionFile || !secretsFile || !flyToml || !dir) {
  console.error('usage: node scripts/transparency/deploys.mjs <machines.json> <version.json> <secrets.json> <fly.toml> <folder>');
  process.exit(3);
}
const folder = path.join(dir, 'deploys');
mkdirSync(folder, { recursive: true });
const machines = JSON.parse(readFileSync(machinesFile, 'utf8'));
let version = null;
try {
  version = JSON.parse(readFileSync(versionFile, 'utf8'));
} catch {}

let secrets = [];
try {
  secrets = JSON.parse(readFileSync(secretsFile, 'utf8'));
} catch {}
const sha = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);

/** fly.toml's [env]: the environment variables the public code sets. */
function tomlEnv(file) {
  const env = {};
  let inEnv = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith('[')) inEnv = t === '[env]';
    const m = inEnv && /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/.exec(t);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const expectedEnv = tomlEnv(flyToml);

class Unreachable extends Error {}
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tries = async (fn, n = 3) => {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= n) throw e;
      await new Promise((r) => setTimeout(r, 5_000 * i));
    }
  }
};

/**
 * Who built this image, by GitHub's signed record of it; null when GitHub has
 * no record that it built it from main with deploy.yml. Throws Unreachable when
 * GitHub couldn't be asked, which isn't a problem with the deploy.
 */
async function attestation(image, digest) {
  let listed;
  try {
    listed = await tries(() => JSON.parse(gh(['api', `repos/${REPO}/attestations/${digest}`])).attestations ?? []);
  } catch (e) {
    // GitHub answers 404 for an image it never signed.
    if (/HTTP 404/.test(String(e.stderr ?? e.message))) return null;
    throw new Unreachable(`GitHub's list of signed images: ${String(e.stderr ?? e.message).trim()}`);
  }
  if (!listed.length) return null;
  try {
    const out = await tries(() => gh(['attestation', 'verify', `oci://${image}`, '--repo', REPO, '--signer-workflow', SIGNER, '--source-ref', 'refs/heads/main', '--format', 'json']));
    const cert = JSON.parse(out)[0]?.verificationResult?.signature?.certificate ?? {};
    return { commit: cert.sourceRepositoryDigest ?? null, ref: cert.sourceRepositoryRef ?? null, run: cert.runInvocationURI ?? null };
  } catch {
    // Signed by something, but not by deploy.yml from main (or the signature doesn't hold).
    return null;
  }
}

const starts = (m) =>
  (m.events ?? [])
    .filter((e) => ['start', 'launch', 'restart', 'exit'].includes(e.type))
    .map((e) => ({ type: e.type, status: e.status ?? null, at: e.timestamp ? new Date(Number(e.timestamp)).toISOString() : null }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
const lastStart = (m) => starts(m).filter((e) => e.type !== 'exit' && e.status !== 'failed').at(-1)?.at ?? null;

/** What in a machine's settings can change what runs, beyond the image. */
function settingsProblems(m) {
  const out = [];
  const init = m.config?.init ?? {};
  for (const k of ['exec', 'entrypoint', 'cmd']) if (Array.isArray(init[k]) ? init[k].length : init[k]) out.push(`Machine ${m.id} has its start command replaced (init.${k}), so it may not run the code in its image.`);
  const env = m.config?.env ?? {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('FLY_') || k === 'PRIMARY_REGION') continue;
    if (!(k in expectedEnv)) out.push(`Machine ${m.id} sets ${k}, which fly.toml on main doesn't.`);
    else if (expectedEnv[k] !== v) out.push(`Machine ${m.id} sets ${k} to "${v}", but fly.toml on main says "${expectedEnv[k]}".`);
  }
  if ((m.config?.files ?? []).length) out.push(`Machine ${m.id} has files added on top of its image.`);
  return out;
}

const problems = [];
const seen = [];
try {
  for (const m of machines) {
    const ref = m.image_ref ?? {};
    const digest = ref.digest ?? null;
    const image = digest ? `${ref.registry}/${ref.repository}@${digest}` : (m.config?.image ?? null);
    const signed = digest ? await attestation(image, digest) : null;
    if (m.state === 'started' && !signed) problems.push(`Machine ${m.id} runs ${image ?? 'an unknown image'}, which GitHub did not build and sign from main.`);
    if (m.state === 'started') problems.push(...settingsProblems(m));
    // Fingerprints, not the settings themselves: a change shows in the log without publishing anything private.
    const settings = sha({ ...m.config, image: undefined });
    seen.push({ id: m.id, state: m.state, image, digest, lastStart: lastStart(m), starts: starts(m), settings, signed });
  }
} catch (e) {
  if (!(e instanceof Unreachable)) throw e;
  console.error(`Couldn't ask GitHub: ${e.message}`);
  process.exit(2);
}
const secretList = secrets.map((x) => ({ name: x.Name ?? x.name, digest: x.Digest ?? x.digest ?? null })).sort((a, b) => a.name.localeCompare(b.name));
for (const x of secretList) if (!SECRETS.includes(x.name)) problems.push(`The app has a secret called ${x.name}, which the code doesn't use. Secrets become environment variables, and some (like NODE_OPTIONS) change what runs.`);
const running = seen.filter((m) => m.state === 'started');
if (running.length > 1) problems.push(`${running.length} machines are running; the site only ever runs one.`);
if (!version) problems.push('The site did not answer /api/version.');
else if (running[0]?.signed?.commit && version.commit && !running[0].signed.commit.startsWith(version.commit))
  problems.push(`The site says it runs commit ${version.commit}, but its image was built from ${running[0].signed.commit}.`);

const now = new Date().toISOString();
const current = { checked: now, machines: seen, secrets: secretList, site: version, problems };
let before = null;
try {
  before = JSON.parse(readFileSync(path.join(folder, 'current.json'), 'utf8'));
} catch {}
// Worth a look, though not wrong on their own: settings or secrets that changed while the image stayed the same.
const notes = [];
for (const m of seen) {
  const was = before?.machines?.find((b) => b.id === m.id);
  if (was && was.digest === m.digest && was.settings && was.settings !== m.settings) notes.push(`Machine ${m.id}'s settings changed without a new image.`);
}
if (before?.secrets && JSON.stringify(before.secrets) !== JSON.stringify(secretList)) notes.push("The app's secrets changed.");
if (notes.length) current.notes = notes;
const key = (c) => JSON.stringify([c.machines.map((m) => [m.id, m.state, m.digest, m.starts, m.settings]), c.secrets, c.site?.commit, c.site?.startedAt, c.problems]);
if (!before || key(before) !== key(current)) appendFileSync(path.join(folder, 'log.jsonl'), `${JSON.stringify(current)}\n`);
writeFileSync(path.join(folder, 'current.json'), `${JSON.stringify(current, null, 2)}\n`);

if (problems.length) {
  writeFileSync(path.join(folder, 'PROBLEM.md'), `# The deploy watcher found a problem\n\nChecked ${now}.\n\n${problems.map((p) => `- ${p}`).join('\n')}\n`);
  console.error(problems.join('\n'));
  process.exit(1);
}
rmSync(path.join(folder, 'PROBLEM.md'), { force: true });
console.log(running.map((m) => `${m.id}: ${m.digest} from ${m.signed?.commit}, started ${m.lastStart}`).join('\n') || 'no machine running');
