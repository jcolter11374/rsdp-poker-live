import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./socket', () => ({ socket: {} }));
const { seedProblem, shownAs, watchCommitments } = await import('./fair');

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
  type V = Parameters<ReturnType<typeof watchCommitments>>[0];
  /** A table view: the next commitment offered, and the hand shown as [handNumber, commitment]. */
  const view = (next: string | null, hand: [number, string | null] | null, o: { table?: string; delay?: number | null; blocked?: boolean } = {}) =>
    ({
      id: o.table ?? 't1',
      me: { seat: o.delay == null ? 2 : null, playerId: 'me' },
      spectator: o.delay == null ? null : { delaySeconds: o.delay, seeAll: false, blocked: !!o.blocked },
      fair: next === null ? undefined : { nextCommit: next, handCommit: hand?.[1] ?? null },
      // A blocked spectator sees no hand at all.
      hand: hand && !o.blocked ? { handNumber: hand[0], phase: 'betting', names: { 2: 'me' }, ...(hand[1] ? { fair: { commit: hand[1], clientSeeds: [] } } : {}) } : null,
    }) as unknown as V;
  const quiet = (...commits: string[]) => {
    for (const c of commits) expect(seedProblem(c, listed(), 'me', false, 10_000), c).toBeNull();
  };
  const flagged = (c: string, re = /never dealt from/) => expect(seedProblem(c, listed(), 'me', false, 10_000), c).toMatch(re);
  let sock: string | undefined = 's1';
  beforeEach(() => {
    sock = 's1';
  });

  it('is quiet when every commitment is dealt from, in order', () => {
    const watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z'])); // joined after hand 7 (from a commitment offered before I looked)
    watch(view('A', null));
    watch(view('B', [8, 'A']));
    watch(view('B', [8, 'A']));
    watch(view(null, [8, 'A'])); // a view with no commitment changes nothing
    watch(view('C', [9, 'B']));
    quiet('Z', 'A', 'B', 'C');
  });

  it('warns about the hand dealt after a commitment that was replaced without a deal', () => {
    const watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view('A2', [7, 'Z']));
    quiet('A2');
    watch(view('B', [8, 'A2']));
    flagged('A2');
    // Everything after it in the same watch is marked too.
    watch(view('C', [9, 'B']));
    flagged('B');
  });

  it('is not fooled by a summary field, a blank commitment or a moment as a seated-looking spectator', () => {
    let watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    // A view claiming hand A was dealt, while the hand shown is still hand 7.
    watch({ ...view('A2', [7, 'Z']), fair: { nextCommit: 'A2', handCommit: 'A' } } as unknown as V);
    watch(view('B', [8, 'A2']));
    flagged('A2');
    store.clear();
    watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view(null, [7, 'Z']));
    watch({ ...view('', [7, 'Z']) } as V);
    watch(view('A2', [7, 'Z']));
    watch(view('B', [8, 'A2']));
    flagged('A2');
    store.clear();
    watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view('A2', [7, 'Z'], { delay: 0 })); // stood up, live spectator: still watching
    watch(view('B', [8, 'A2']));
    flagged('A2');
  });

  it('warns about a hand from a commitment never offered, and a hand number dealt twice', () => {
    let watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view('B', [8, 'X']));
    flagged('X', /never showed as the next hand's/);
    store.clear();
    watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view('B', [8, 'A']));
    watch(view('C', [8, 'B'])); // hand 8 shown again, from another commitment
    flagged('B', /shown again from a different commitment/);
  });

  it('marks the hands after one shown without its commitment', () => {
    const watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view('A', [8, null]));
    watch(view('B', [9, 'A']));
    flagged('A', /shown without its commitment/);
  });

  it('lets a hand from before provably fair dealing finish quietly when it is the one in play on arrival', () => {
    const watch = watchCommitments(() => sock);
    watch(view('A', [7, null]));
    watch(view('A', [7, null]));
    watch(view('A', [7, null]));
    watch(view('B', [8, 'A']));
    quiet('A');
  });

  it('never lets a second commitment for a hand number replace the first, across a reconnect too', () => {
    let watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view('B', [8, 'A']));
    sock = 's2'; // forced reconnect, then hand 8 again from another commitment
    watch = watchCommitments(() => sock);
    watch(view('C', [8, 'A2']));
    // Kept for Check this hand, which compares the record with it; not a live alarm, as a crash that lost a save looks the same.
    expect(shownAs('t1', 8)).toBe('A');
    quiet('A2');
  });

  it('writes nothing from views that hide or delay the hands', () => {
    const watch = watchCommitments(() => sock);
    watch(view('B', [8, 'A'], { delay: 30 }));
    watch(view('C', [9, 'B'], { delay: 0, blocked: true }));
    expect(shownAs('t1', 8)).toBeNull();
    expect(shownAs('t1', 9)).toBeNull();
  });

  it('remembers which commitment each hand number was shown under, for Check this hand', () => {
    const watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    watch(view('B', [8, 'A']));
    expect(shownAs('t1', 8)).toBe('A');
    expect(shownAs('t1', 9)).toBeNull();
    expect(shownAs('t2', 8)).toBeNull();
    watch(view('B', [9, null]));
    expect(shownAs('t1', 9)).toBe('none');
  });

  it('starts over when hands were hidden: watching turned off, then a seat', () => {
    const watch = watchCommitments(() => sock);
    watch(view('A', null, { delay: 0, blocked: true }));
    watch(view('B', [7, 'A'], { delay: 0, blocked: true }));
    watch(view('C', [8, 'B'], { delay: 0, blocked: true }));
    watch(view('D', [9, 'C'])); // sat down: the first hand seen is from C
    watch(view('E', [10, 'D']));
    quiet('C', 'D');
  });

  it('starts over after a reconnect, a new page, another table, or a delayed view turning live', () => {
    let watch = watchCommitments(() => sock);
    watch(view('A', [7, 'Z']));
    sock = 's2'; // the server restarted: a fresh commitment is honest
    watch(view('A2', [7, 'Z']));
    watch(view('B', [8, 'A2']));
    watch = watchCommitments(() => sock); // page left and opened again
    watch(view('A3', [8, 'A2']));
    watch(view('X', [3, 'W'], { table: 't2' }));
    watch(view('A4', [8, 'A2']));
    watch(view('B4', [9, 'A4']));
    // A delayed spectator sees hands late; sitting down, the live hand is newer.
    watch(view('C4', [9, 'A4'], { delay: 30 }));
    watch(view('D4', [10, 'C4'], { delay: 30 }));
    watch(view('E4', [11, 'D4']));
    sock = undefined; // offline: nothing to compare
    watch(view('F4', [11, 'D4']));
    sock = 's3';
    watch(view('G4', [12, 'F4']));
    quiet('A2', 'A3', 'X', 'A4', 'B4', 'C4', 'D4', 'E4', 'F4', 'G4');
  });
});
