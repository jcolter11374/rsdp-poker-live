import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedSetup } from '@rsdp/engine/wire';

/** Socket.IO's default limit on one message, which the server keeps. */
const MESSAGE_LIMIT = 1_000_000;

const sent: { event: string; input: { setups?: SavedSetup[] } }[] = [];
const account: SavedSetup[] = [];
let sessionListener: ((s: unknown) => void) | null = null;

vi.mock('./socket', () => ({
  socket: { on: () => {} },
  currentSession: () => null,
  onSession: (cb: (s: unknown) => void) => {
    sessionListener = cb;
    return () => {};
  },
  call: async (event: string, input: { setups?: SavedSetup[] }) => {
    sent.push({ event, input });
    // A message over the limit makes the server drop the connection: no answer comes.
    if (new TextEncoder().encode(JSON.stringify(input)).length > MESSAGE_LIMIT) throw new Error('no answer');
    if (event === 'setups:import') {
      const kept = (input.setups ?? []).filter((s) => s.json.length <= 64 * 1024 && account.length < 100);
      account.push(...kept);
      return { added: kept.length, kept: kept.map((s) => s.name) };
    }
    if (event === 'setups:list') return { setups: [...account] };
    throw new Error(`unexpected ${event}`);
  },
}));

const { bringSetupsOver, setupList } = await import('./savedSetups');

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  sent.length = 0;
  account.length = 0;
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('window', { addEventListener: () => {} });
});

const signIn = async () => {
  sessionListener?.({ account: { id: 'a' } });
  await vi.waitFor(() => expect(sent.some((m) => m.event === 'setups:list')).toBe(true));
};

describe('bringing saved setups onto an account', () => {
  it('sends a big pile in messages small enough for the server, and brings them all', async () => {
    // 50 large setups: about 3 MB together, more than one message may carry.
    const big = Array.from({ length: 50 }, (_, i) => ({ name: `S${i}`, json: JSON.stringify({ name: `S${i}`, pad: 'x'.repeat(60_000) }) }));
    store.set('test.setups', JSON.stringify(big));
    bringSetupsOver(true);
    const list = setupList('tournament', 'test.setups', (s) => s);
    await signIn();
    const imports = sent.filter((m) => m.event === 'setups:import');
    expect(imports.length).toBeGreaterThan(1);
    for (const m of imports) expect(new TextEncoder().encode(JSON.stringify(m.input)).length).toBeLessThan(MESSAGE_LIMIT);
    expect(account.map((s) => s.name).sort()).toEqual(big.map((s) => s.name).sort());
    // All went onto the account, so the browser forgets them.
    expect(store.has('test.setups')).toBe(false);
    expect(list.list()).toHaveLength(50);
  });

  it('keeps in the browser one too big for the account, without sending it', async () => {
    const setups = [
      { name: 'Huge', json: JSON.stringify({ pad: 'é'.repeat(200_000) }) },
      { name: 'Small', json: '{}' },
    ];
    store.set('test.setups', JSON.stringify(setups));
    bringSetupsOver(true);
    setupList('tournament', 'test.setups', (s) => s);
    await signIn();
    const imported = sent.filter((m) => m.event === 'setups:import').flatMap((m) => m.input.setups ?? []);
    expect(imported.map((s) => s.name)).toEqual(['Small']);
    expect(JSON.parse(store.get('test.setups') ?? '[]').map((s: SavedSetup) => s.name)).toEqual(['Huge']);
  });
});
