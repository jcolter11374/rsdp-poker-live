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

// Saved tables and tournaments (scripts/upgrade/saved.mjs): a cash table, and a running tournament's and a finished one's.
const cash = { id: 'c4sh-tab1e', name: "Ann's table", mode: 'cash', createdAt: '2026-11-01T20:00:00.000Z', hands: 3, players: ['Ann', 'Bob'], realGame: true, live: true };
const running = { id: 'aaaaaaaaaaaaaaaa', status: 'running', title: 'Smoke Cup · RSDP Poker Live!', description: 'Running now · Level 1 · 3 of 3 left.' };
const finished = { id: 'bbbbbbbbbbbbbbbb', status: 'finished', title: 'Monday Cup · RSDP Poker Live!', description: 'Won by Ann · 3 players.' };
const runningTable = { ...cash, id: 'aaaaaaaaaaaaaaaa-t1', name: 'Smoke Cup · Table 1', mode: 'tournament', hands: 6, players: ['Hana', 'Bo'] };
const finishedTable = { ...runningTable, id: 'bbbbbbbbbbbbbbbb-t1', name: 'Monday Cup · Table 1' };
const saved = { ...before, tables: [cash, runningTable, finishedTable, { id: 'old-format', missing: true }], tournaments: [running, finished] };
// What saved.mjs asks again after the switch: the same ids, without the status before.
const again = (tournaments = [running, finished]) => tournaments.map(({ status: _status, ...t }) => t);

async function compare(after: unknown, from: unknown = before) {
  const b = path.join(dir, 'before.json');
  const a = path.join(dir, 'after.json');
  writeFileSync(b, JSON.stringify(from));
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

  it('passes saved tables read back the same, a running tournament that kept dealing, and players in another order', async () => {
    const tables = [{ ...cash, live: false, players: ['Bob', 'Ann'] }, { ...runningTable, hands: 9, players: ['Bo', 'Hana', 'Cy'] }, finishedTable, { id: 'old-format', missing: true }];
    const r = await compare({ ...before, tables, tournaments: again([{ ...running, description: 'Running now · Level 2 · 2 of 3 left.' }, finished]) }, saved);
    expect(r.out).toContain("all 3 read back the same (1 the server before couldn't read either)");
    expect(r.out).toContain('all 2 read back');
    expect(r.code).toBe(0);
  });

  it('fails a saved table the new server cannot read, or reads differently', async () => {
    const tables = [{ id: cash.id, missing: true }, runningTable, { ...finishedTable, hands: 7 }];
    const r = await compare({ ...before, tables, tournaments: again() }, saved);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`Ann's table (c4sh-tab1e) can't be read any more`);
    expect(r.out).toContain('Monday Cup · Table 1 (bbbbbbbbbbbbbbbb-t1): hands was 6, now 7');
  });

  it('fails a running tournament table that lost hands or players', async () => {
    const tables = [cash, { ...runningTable, hands: 5, players: ['Hana'] }, finishedTable];
    const r = await compare({ ...before, tables, tournaments: again() }, saved);
    expect(r.code).toBe(1);
    expect(r.out).toContain('hands was 6, now 5');
    expect(r.out).toContain('players was ["Hana","Bo"], now ["Hana"]');
  });

  it("fails a tournament whose page no longer shows it, or a finished one's changed result", async () => {
    const tournaments = again([{ ...running, title: 'RSDP Poker Live!' }, { ...finished, description: 'Won by Bob · 3 players.' }]);
    const r = await compare({ ...before, tables: saved.tables, tournaments }, saved);
    expect(r.code).toBe(1);
    expect(r.out).toContain('aaaaaaaaaaaaaaaa: its page showed "Smoke Cup · RSDP Poker Live!", now "RSDP Poker Live!"');
    expect(r.out).toContain('Monday Cup · RSDP Poker Live! (finished): its page said "Won by Ann · 3 players.", now "Won by Bob · 3 players."');
  });
});
