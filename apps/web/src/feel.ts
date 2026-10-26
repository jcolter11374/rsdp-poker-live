/*
 * Prototype "feel packs" for the table, switched on with ?feel=depth,motion,moments,identity
 * (or ?feel=all, or ?feel=off) and remembered in this browser. Each pack is a set of CSS rules
 * under :root[data-feel~='name'] in feel.css, plus a few small hooks in the table.
 */
export const FEEL_PACKS = ['depth', 'motion', 'moments', 'identity'] as const;
export type FeelPack = (typeof FEEL_PACKS)[number];

const KEY = 'rsdp.feel';

function read(): FeelPack[] {
  let raw: string | null = null;
  try {
    const q = new URLSearchParams(location.search).get('feel');
    if (q !== null) {
      localStorage.setItem(KEY, q);
      raw = q;
    } else raw = localStorage.getItem(KEY);
  } catch {}
  if (!raw || raw === 'off') return [];
  if (raw === 'all') return [...FEEL_PACKS];
  return raw.split(',').filter((p): p is FeelPack => (FEEL_PACKS as readonly string[]).includes(p));
}

export const feel = new Set<FeelPack>(read());
export const hasFeel = (p: FeelPack) => feel.has(p);

if (feel.size) document.documentElement.dataset.feel = [...feel].join(' ');
