import { useSyncExternalStore, type CSSProperties } from 'react';
import { FELTS } from '@rsdp/engine/settings';

export type Felt = (typeof FELTS)[number];
export type Deck = 'two' | 'four';
export type Back = 'red' | 'blue' | 'green' | 'black';

/** How the table looks to this browser. Nobody else sees these. */
export interface Prefs {
  /** 'table' follows the host's felt. */
  felt: Felt | 'table';
  /** Four-colour deck: clubs green, diamonds blue. */
  deck: Deck;
  back: Back;
}

export const FELT_COLORS: Record<Felt, { name: string; light: string; felt: string; edge: string }> = {
  green: { name: 'Green', light: '#2a8a5d', felt: '#1f6f4a', edge: '#0f3d28' },
  blue: { name: 'Blue', light: '#2f6fa8', felt: '#1f527f', edge: '#0f2b45' },
  red: { name: 'Red', light: '#a83a3a', felt: '#7f2525', edge: '#431111' },
  purple: { name: 'Purple', light: '#6f4ba8', felt: '#51357f', edge: '#2a1a45' },
  charcoal: { name: 'Charcoal', light: '#4a5058', felt: '#33383f', edge: '#16191d' },
  teal: { name: 'Teal', light: '#2a8a8a', felt: '#1f6a6f', edge: '#0f383d' },
};

export const BACKS: Record<Back, string> = { red: 'Red', blue: 'Blue', green: 'Green', black: 'Black' };

const KEY = 'rsdp.prefs';
const DEFAULTS: Prefs = { felt: 'table', deck: 'two', back: 'red' };

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      felt: raw.felt === 'table' || (FELTS as readonly string[]).includes(raw.felt) ? raw.felt : DEFAULTS.felt,
      deck: raw.deck === 'four' ? 'four' : 'two',
      back: raw.back in BACKS ? raw.back : DEFAULTS.back,
    };
  } catch {
    return DEFAULTS;
  }
}

let current = load();
const listeners = new Set<() => void>();

/** The deck and card back are page-wide, so they go on the root element for the CSS. */
function apply(p: Prefs) {
  document.documentElement.dataset.deck = p.deck;
  document.documentElement.dataset.back = p.back;
}
apply(current);

export function setPrefs(patch: Partial<Prefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private windows may refuse; the choice still holds for this visit.
  }
  apply(current);
  listeners.forEach((l) => l());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  );
}

/** The felt this viewer sees: their own pick, else the host's, else green. */
export function feltStyle(prefs: Prefs, hostFelt: Felt | undefined): CSSProperties {
  const c = FELT_COLORS[prefs.felt === 'table' ? (hostFelt ?? 'green') : prefs.felt];
  return { '--felt-light': c.light, '--felt': c.felt, '--felt-edge': c.edge } as CSSProperties;
}
