import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./socket', () => ({ socket: {} }));
const { seedProblem } = await import('./fair');

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
    expect(seedProblem(C, listed(), 'me', true, 2_000)).toBeNull();
    // Not dealt in: nothing to say.
    expect(seedProblem(C, listed(), 'me', false, 10_000)).toBeNull();
  });

  it('catches a server that turns seeds down and then picks which to use', () => {
    sent({ seed: 'aa', at: 0, rejected: { after: 50 } });
    expect(seedProblem(C, listed('aa'), 'me', true, 10_000)).toMatch(/turned down .* but used it/);
    // Refused at once, whatever the reason given, yet the hand came seconds later: the seed was there in time.
    expect(seedProblem(C, listed(), 'me', true, 10_000)).toMatch(/dealt without it/);
    // Refused because the hand had just been dealt: this browser sees that hand right away.
    expect(seedProblem(C, listed(), 'me', true, 400)).toBeNull();
    expect(seedProblem(C, listed(), 'me', true, -200)).toBeNull();
  });
});
