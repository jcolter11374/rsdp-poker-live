import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { commitmentOf, deckFromSeed, handSeedOf, verifyHand } from '@rsdp/engine';
import { engine, variants } from '@rsdp/engine/core';
import { defaultSettings, type TableSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { FAIR_REVEAL_AFTER_MS, TableRuntime } from '../src/runtime/table';
import { handRecordView, tableView } from '../src/runtime/view';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

const IDS = ['host', 'a', 'b'];

/** Three seated players, not started yet. */
function table(patch: (s: TableSettings) => void = () => {}) {
  const clock = new FakeClock();
  const settings = defaultSettings('cash');
  settings.seating.requireApproval = false;
  settings.timing.autoStartNextHand = false;
  patch(settings);
  const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded() });
  for (const p of [...IDS, 'watcher']) rt.connect(p);
  IDS.forEach((id, seat) => rt.requestSeat(id, { seat, name: id.toUpperCase(), stack: 200 }));
  return { rt, clock };
}

const hand = (rt: TableRuntime) => rt.state.hand!;
const toActId = (rt: TableRuntime) => rt.state.seats[hand(rt).toAct!]!.playerId;

function checkDown(rt: TableRuntime) {
  for (let i = 0; i < 50 && hand(rt).phase !== 'complete'; i++) {
    const legal = engine.legalActions(hand(rt), hand(rt).toAct!)!;
    rt.act(toActId(rt), legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
}

describe('provably fair dealing', () => {
  it('deals the hand from the commitment published before it, mixed with the players’ seeds', () => {
    const { rt } = table();
    const commit = tableView(rt, 'a', 0).fair.nextCommit;
    rt.addClientSeed('a', { commit, seed: 'aaaaaaaaaaaaaaaa' });
    rt.addClientSeed('b', { commit, seed: 'bbbbbbbbbbbbbbbb' });
    rt.start('host');
    const h = hand(rt);
    const fair = h.input.fair!;
    expect(fair.commit).toBe(commit);
    expect(commitmentOf(fair.serverSeed)).toBe(commit);
    expect(fair.clientSeeds.map((c) => c.playerId).sort()).toEqual(['a', 'b']);
    expect(fair.handSeed).toBe(handSeedOf(fair.serverSeed, ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']));
    // Everyone at the table sees which seeds went in, so a browser can tell if its own was left out.
    expect(tableView(rt, 'b', 0).hand!.fair).toEqual({ commit, clientSeeds: fair.clientSeeds });
    expect(h.input.deck).toEqual(deckFromSeed(fair.handSeed));
    // The next hand already has a different commitment, and the seeds sent so far are spent.
    const view = tableView(rt, 'a', 0);
    expect(view.fair.handCommit).toBe(commit);
    expect(view.fair.nextCommit).not.toBe(commit);
    expect(rt.state.fair!.clientSeeds).toEqual({});
  });

  it('only takes a seat’s seed, in the right shape, for the hand not yet dealt', () => {
    const { rt } = table();
    const commit = rt.nextCommit();
    expect(() => rt.addClientSeed('watcher', { commit, seed: 'aaaaaaaaaaaaaaaa' })).toThrow(/seated/);
    expect(() => rt.addClientSeed('a', { commit, seed: 'short' })).toThrow(/hex/);
    expect(() => rt.addClientSeed('a', { commit, seed: 'AAAAAAAAAAAAAAAA' })).toThrow(/hex/);
    expect(() => rt.addClientSeed('a', { commit: 'old', seed: 'aaaaaaaaaaaaaaaa' })).toThrow(/already been dealt/);
    rt.start('host');
    expect(() => rt.addClientSeed('a', { commit, seed: 'aaaaaaaaaaaaaaaa' })).toThrow(/already been dealt/);
  });

  it('never sends a server seed, hand seed or the deck to anyone during play', () => {
    const { rt } = table((s) => (s.spectators.seeAllCards = true));
    rt.start('host');
    const fair = hand(rt).input.fair!;
    const secrets = [fair.serverSeed, fair.handSeed, rt.state.fair!.next.serverSeed];
    for (const who of [...IDS, 'watcher']) {
      const json = JSON.stringify(tableView(rt, who, 0));
      for (const s of secrets) expect(json, who).not.toContain(s);
    }
    checkDown(rt);
    const record = rt.state.history.at(-1)!;
    for (const who of [...IDS, 'watcher']) {
      const view = handRecordView(rt, record, who);
      expect(view.fair!.serverSeed).toBeNull();
      expect(view.fair!.handSeed).toBeNull();
      expect(view.fair!.revealsAt).toBe(record.endedAt + FAIR_REVEAL_AFTER_MS);
      const json = JSON.stringify([view, tableView(rt, who, 0)]);
      for (const s of secrets) expect(json, who).not.toContain(s);
    }
  });

  it('reveals hands when the host stops the game, and they check out', () => {
    const { rt } = table();
    const commit = rt.nextCommit();
    rt.addClientSeed('a', { commit, seed: '0123456789abcdef' });
    rt.start('host');
    checkDown(rt);
    expect(handRecordView(rt, rt.state.history.at(-1)!, 'b').fair!.serverSeed).toBeNull();
    rt.stop('host');
    const view = handRecordView(rt, rt.state.history.at(-1)!, 'b');
    const fair = view.fair!;
    expect(fair.serverSeed).toBe(hand(rt).input.fair!.serverSeed);
    expect(fair.revealsAt).toBeNull();
    expect(fair.clientSeeds).toEqual([{ playerId: 'a', name: 'A', seed: '0123456789abcdef' }]);
    expect(fair.events).not.toBeNull();
    const proof = { commit: fair.commit, serverSeed: fair.serverSeed!, clientSeeds: fair.clientSeeds.map((c) => c.seed), handSeed: fair.handSeed, button: view.button, events: fair.events! };
    const check = verifyHand(proof);
    expect(check.checks.filter((c) => !c.ok)).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.matched).toBeGreaterThanOrEqual(11);
    // Hiding my cards in a shared hand also hides the seeds that would rebuild them.
    expect(handRecordView(rt, rt.state.history.at(-1)!, 'b', { hideMine: true }).fair).toBeNull();

    // The standalone checker (Node's own SHA-256, no app code) agrees, and catches a swapped card.
    const dir = mkdtempSync(path.join(tmpdir(), 'proof-'));
    const script = path.resolve(__dirname, '../../../scripts/verify-hand.mjs');
    const run = (p: object) => {
      const file = path.join(dir, `${Math.random()}.json`);
      writeFileSync(file, JSON.stringify(p));
      return spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    };
    const good = run(proof);
    expect(good.stdout).toContain('This hand checks out.');
    expect(good.status).toBe(0);
    const events = proof.events.map((e) => (e.t === 'board' ? { ...e, cards: e.cards.map((c) => (c === '2c' ? '3c' : '2c')) } : e));
    expect(run({ ...proof, events }).status).toBe(1);
  });

  it('reveals a hand 12 hours after it ends even if the game goes on', () => {
    const { rt, clock } = table();
    rt.start('host');
    rt.act(toActId(rt), { type: 'fold' });
    rt.act(toActId(rt), { type: 'fold' });
    const record = rt.state.history.at(-1)!;
    clock.t += FAIR_REVEAL_AFTER_MS - 1;
    expect(handRecordView(rt, record, 'a').fair!.serverSeed).toBeNull();
    clock.t += 1;
    expect(handRecordView(rt, record, 'a').fair!.serverSeed).toBe(record.hand.input.fair!.serverSeed);
  });

  it('never deals sooner than the lead time after the commitment appeared', () => {
    const clock = new FakeClock();
    const settings = defaultSettings('cash');
    settings.seating.requireApproval = false;
    settings.timing.nextHandDelaySeconds = 0;
    const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded(), fairLeadMs: 2500 });
    for (const p of IDS) rt.connect(p);
    const first = rt.nextCommit();
    IDS.forEach((id, seat) => rt.requestSeat(id, { seat, name: id.toUpperCase(), stack: 200 }));
    rt.start('host');
    expect(rt.state.hand).toBeNull();
    clock.advance(2500);
    expect(hand(rt).input.fair!.commit).toBe(first);
    // A hand over at once: the next one still waits for its own commitment to age.
    const dealtAt = clock.t;
    rt.act(toActId(rt), { type: 'fold' });
    rt.act(toActId(rt), { type: 'fold' });
    clock.advance(100);
    expect(hand(rt).phase).toBe('complete');
    clock.advance(2500 - (clock.t - dealtAt) - 1);
    expect(hand(rt).input.handNumber).toBe(1);
    clock.advance(1);
    expect(hand(rt).input.handNumber).toBe(2);
  });

  it('commits to a fresh seed after a restart, so a deal lost in a crash is never dealt again', () => {
    const { rt, clock } = table();
    const commit = rt.nextCommit();
    rt.addClientSeed('a', { commit, seed: 'aaaaaaaaaaaaaaaa' });
    const restored = new TableRuntime(JSON.parse(JSON.stringify(rt.state)), { clock, rng: seeded(3) });
    restored.resume();
    expect(restored.nextCommit()).not.toBe(commit);
    expect(restored.state.fair!.clientSeeds).toEqual({});
    expect(JSON.stringify(restored.state)).not.toContain(rt.state.fair!.next.serverSeed);
  });
});
