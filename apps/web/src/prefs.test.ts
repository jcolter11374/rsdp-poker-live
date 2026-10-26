import { afterEach, describe, expect, it, vi } from 'vitest';

/** prefs.ts reads storage and sets the page's data attributes as it loads, so each test loads it afresh. */
async function loadWith(saved: Record<string, unknown> | null) {
  vi.resetModules();
  const store = new Map<string, string>(saved ? [['rsdp.prefs', JSON.stringify(saved)]] : []);
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  vi.stubGlobal('document', { documentElement: { dataset: {} } });
  vi.stubGlobal('window', { addEventListener: () => {} });
  const prefs = await import('./prefs');
  return { prefs, store };
}

afterEach(() => vi.unstubAllGlobals());

describe('prefs', () => {
  it('has coach tips and bot reasons on by default', async () => {
    const { prefs } = await loadWith(null);
    expect(prefs.getPrefs()).toMatchObject({ tips: true, botReasons: true });
  });

  it('keeps them off once turned off, and ignores anything but true or false', async () => {
    expect((await loadWith({ tips: false, botReasons: false })).prefs.getPrefs()).toMatchObject({ tips: false, botReasons: false });
    expect((await loadWith({ tips: 'no', botReasons: 0 })).prefs.getPrefs()).toMatchObject({ tips: true, botReasons: true });
  });

  it('saves a change', async () => {
    const { prefs, store } = await loadWith({ tips: true });
    prefs.setPrefs({ tips: false });
    expect(JSON.parse(store.get('rsdp.prefs')!)).toMatchObject({ tips: false, botReasons: true });
  });
});
