import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, exportPreset, importPreset } from '@rsdp/engine/settings';

vi.mock('./socket', () => ({ socket: { on: () => {} }, call: () => Promise.reject(new Error('offline')), currentSession: () => null, onSession: () => {} }));

/** A guest's table presets, kept in a stubbed browser storage. */
async function guestPresets() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.stubGlobal('window', { addEventListener: () => {} });
  const { setupList } = await import('./savedSetups');
  return setupList('table', 'rsdp.presets', ({ name, json }) => ({ name, json: exportPreset(importPreset(json).settings, name) }));
}

afterEach(() => vi.unstubAllGlobals());

describe('saved setup names', () => {
  it('count an emoji as two, like the preset inside, so a long one gets the names message and not a preset error', async () => {
    const presets = await guestPresets();
    const json = exportPreset(defaultSettings('cash'), 'x');
    expect(await presets.save('🂡'.repeat(30), json)).toBe('🂡'.repeat(30));
    await expect(presets.save('🂡'.repeat(31), json)).rejects.toThrow(/^Names can be up to 60 characters$/);
    await expect(presets.rename('🂡'.repeat(30), '🂡'.repeat(31))).rejects.toThrow(/^Names can be up to 60 characters$/);
  });
});
