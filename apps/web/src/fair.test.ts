import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./socket', () => ({ socket: {} }));
const { seedProblem, watchCommitments } = await import('./fair');

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
});

const C = 'commit';
const sent = (s: object) => store.set('rsdp.fairSent', JSON.stringify({ [C]: JSON.stringify(s) }));
const accepted = (seed: string) => store.set('rsdp.fairSeeds', JSON.stringify({ [C]: seed }));
const listed = (seed?: string) => (seed ? [{ playerId: 'me', seed }] : []);

describe('the seed under my name', () => {
  it('is fine when it is the one the server accepted', () => {
    sent({ seed: 'aa', at: 0 });
    accepted('aa');
    expect(seedProblem(C, listed('aa'), 'me', true, 10_000)).toBeNull();
  });

  it('warns about a seed this browser never sent', () => {
    sent({ seed: 'aa', at: 0 });
    accepted('aa');
    expect(seedProblem(C, listed('bb'), 'me', true, 10_000)).toMatch(/didn't send/);
    expect(seedProblem(C, listed('bb'), 'me', false, 10_000)).toMatch(/didn't send/);
  });

  it('warns when an accepted seed, or one sent in good time, is left out', () => {
    sent({ seed: 'aa', at: 0 });
    accepted('aa');
    expect(seedProblem(C, listed(), 'me', true, 10_000)).toMatch(/dealt without it/);
    store.delete('rsdp.fairSeeds');
    // No answer at all, then dealt 10 s later.
    expect(seedProblem(C, listed(), 'me', true, 10_000)).toMatch(/dealt without it/);
    // Sent just before the deal: it could honestly miss.
    store.set('rsdp.fairNextSeen', JSON.stringify({ [C]: '-5000' }));
    expect(seedProblem(C, listed(), 'me', true, 1_000)).toBeNull();
    // Not dealt in: nothing to say.
    expect(seedProblem(C, listed(), 'me', false, 10_000)).toBeNull();
  });

  it('catches a server that turns seeds down and then picks which to use', () => {
    sent({ seed: 'aa', at: 0, rejected: { after: 50 } });
    expect(seedProblem(C, listed('aa'), 'me', true, 10_000)).toMatch(/turned down .* but used it/);
    // Refused at once, whatever the reason given, yet the hand came seconds later: the seed was there in time.
    expect(seedProblem(C, listed(), 'me', true, 10_000)).toMatch(/dealt without it/);
    // Refused because the hand had just been dealt: this browser sees that hand right away.
    store.set('rsdp.fairNextSeen', JSON.stringify({ [C]: '-5000' }));
    expect(seedProblem(C, listed(), 'me', true, 400)).toBeNull();
    expect(seedProblem(C, listed(), 'me', true, -200)).toBeNull();
  });

  it('catches a commitment shown only at the last moment, so every seed is late', () => {
    store.set('rsdp.fairNextSeen', JSON.stringify({ [C]: '0' }));
    sent({ seed: 'aa', at: 0, rejected: { after: 50 } });
    expect(seedProblem(C, listed(), 'me', true, 1_000)).toMatch(/too soon/);
    expect(seedProblem(C, listed('aa'), 'me', true, 1_000)).toMatch(/but used it/);
  });
});

describe('a commitment swapped before the deal', () => {
  const view = (next: string, hand: string | null, o: { table?: string; seat?: number | null } = {}) =>
    ({ id: o.table ?? 't1', me: { seat: o.seat === undefined ? 2 : o.seat }, fair: { nextCommit: next, handCommit: hand } }) as unknown as Parameters<ReturnType<typeof watchCommitments>>[0];
  let sock: string | undefined = 's1';
  beforeEach(() => {
    sock = 's1';
  });

  it('is quiet when every commitment is dealt from', () => {
    const watch = watchCommitments(() => sock);
    watch(view('A', null));
    watch(view('A', null));
    watch(view('B', 'A'));
    watch(view('B', null));
    watch(view('C', 'B'));
    for (const c of ['A', 'B', 'C']) expect(seedProblem(c, listed(), 'me', false, 10_000)).toBeNull();
  });

  it('warns about the hand dealt from a commitment that replaced one never dealt', () => {
    const watch = watchCommitments(() => sock);
    watch(view('A', null));
    watch(view('A2', null));
    watch(view('B', 'A2'));
    expect(seedProblem('A2', listed('x'), 'me', true, 10_000)).toMatch(/replaced it .* without dealing/);
    // Even when I sat this hand out: everyone at the table is owed a fair deck.
    expect(seedProblem('A2', listed(), 'me', false, 10_000)).toMatch(/without dealing/);
    expect(seedProblem('B', listed(), 'me', false, 10_000)).toBeNull();
    // Swapped while a hand was on (the next one is published a hand ahead).
    watch(view('B2', 'A2'));
    expect(seedProblem('B2', listed('x'), 'me', true, 10_000)).toMatch(/without dealing/);
  });

  it('starts over after a reconnect, a new page, a stand-up or another table', () => {
    let watch = watchCommitments(() => sock);
    watch(view('A', null));
    sock = 's2'; // the server restarted: a fresh commitment is honest
    watch(view('A2', null));
    watch = watchCommitments(() => sock); // page left and opened again
    watch(view('A3', null));
    watch(view('A4', null, { seat: null }));
    watch(view('A5', null));
    watch(view('X', null, { table: 't2' }));
    watch(view('A6', null, { table: 't1' }));
    sock = undefined; // offline: nothing to compare
    watch(view('A7', null));
    watch(view('A8', null));
    for (const c of ['A2', 'A3', 'A4', 'A5', 'X', 'A6', 'A7', 'A8']) expect(seedProblem(c, listed(), 'me', false, 10_000)).toBeNull();
    // Still watching across those: a plain swap is caught again.
    sock = 's3';
    watch(view('A9', null));
    watch(view('A10', null));
    expect(seedProblem('A10', listed('x'), 'me', true, 10_000)).toMatch(/without dealing/);
  });
});
