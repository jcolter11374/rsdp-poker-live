// scripts/upgrade/compare.mjs, run as its own process: the upgrade rehearsal's
// check that a server started on existing data gives the same answers.

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = path.resolve(__dirname, '../../..');
const dir = mkdtempSync(path.join(tmpdir(), 'rsdp-upgrade-'));

const ann = { key: 'a1', name: 'Ann', profit: 50, sessions: 1, hands: 3, biggestPot: 100, games: [{ at: 1000, net: 50 }] };
const bob = { key: 'b2', name: 'Bob', profit: -50, sessions: 1, hands: 3, biggestPot: 0, games: [{ at: 1000, net: -50 }] };
const before = { leaderboard: [ann, bob], record: { seq: 12, hash: 'x'.repeat(64) } };

async function compare(after: unknown) {
  const b = path.join(dir, 'before.json');
  const a = path.join(dir, 'after.json');
  writeFileSync(b, JSON.stringify(before));
  writeFileSync(a, JSON.stringify(after));
  return run(process.execPath, [path.join(root, 'scripts/upgrade/compare.mjs'), b, a]).then(
    (r) => ({ code: 0, out: r.stdout }),
    (e: { code: number; stdout: string }) => ({ code: e.code, out: e.stdout }),
  );
}

describe('upgrade rehearsal compare', () => {
  it('passes the same answers, in any order, with new fields and a later record', async () => {
    const r = await compare({ leaderboard: [{ ...bob, streak: 2 }, { ...ann, streak: 0 }], record: { seq: 14, hash: 'y'.repeat(64) } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('the same for all 2 players');
    expect(r.out).toContain('up to entry 12 before, 14 now');
  });

  it('fails a changed hand count or game result, naming the player and field', async () => {
    const r = await compare({ leaderboard: [{ ...ann, hands: 2 }, { ...bob, games: [{ at: 1000, net: -40 }] }], record: before.record });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Ann: hands was 3, now 2');
    expect(r.out).toContain('Bob: games was');
  });

  it('fails a field that disappeared, a missing player and a new one', async () => {
    const { biggestPot: _gone, ...annLess } = ann;
    const r = await compare({ leaderboard: [annLess, { ...bob, key: 'c3', name: 'Cy' }], record: before.record });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Ann: biggestPot was 100, now undefined');
    expect(r.out).toContain('Bob (b2) is no longer on it');
    expect(r.out).toContain('Cy (c3) is new on it');
  });

  it('fails a public record that went back', async () => {
    const r = await compare({ leaderboard: [ann, bob], record: { seq: 9, hash: 'z'.repeat(64) } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('ends at entry 9, but went up to 12 before');
  });
});
