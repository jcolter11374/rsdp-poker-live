import { useSyncExternalStore, type CSSProperties } from 'react';
import { FELTS } from '@rsdp/engine/settings';

export type Felt = (typeof FELTS)[number];
export type Deck = 'two' | 'four';
export type Back = 'red' | 'blue' | 'green' | 'black';
export type Units = 'chips' | 'bb';
export type GestureMode = 'sound' | 'silent' | 'off';

/** How the table looks to this browser. Nobody else sees these. */
export interface Prefs {
  /** 'table' follows the host's felt. */
  felt: Felt | 'table';
  /** Four-colour deck: clubs green, diamonds blue. */
  deck: Deck;
  back: Back;
  /** Stacks, bets and pots in chips or in big blinds (B switches). */
  units: Units;
  /** Fold, check, bet and deal noises; the turn and time alerts always play. */
  tableSounds: boolean;
  /** A beep for new chat messages. */
  chatSound: boolean;
  /** Gestures thrown at the table: with sound, silent, or not shown. */
  gestures: GestureMode;
  /** Show players' pictures. */
  avatars: boolean;
  /** Show players' mood emoji. */
  moods: boolean;
  /** Players whose picture this viewer hid. */
  hiddenAvatars: string[];
  /** Keep the screen on while seated at a table. */
  wakeLock: boolean;
  /** Table motion: thrown cards, counting stacks, sparkles. Off keeps the look and drops the movement. */
  tableMotion: boolean;
}

export const FELT_COLORS: Record<Felt, { name: string; light: string; felt: string; edge: string }> = {
  green: { name: 'Green', light: '#3a8f5f', felt: '#2d7b4f', edge: '#23603e' },
  blue: { name: 'Blue', light: '#3a77a8', felt: '#2c6491', edge: '#214d70' },
  red: { name: 'Red', light: '#a84444', felt: '#8f3434', edge: '#6e2828' },
  purple: { name: 'Purple', light: '#7055a8', felt: '#5d4591', edge: '#473570' },
  charcoal: { name: 'Charcoal', light: '#4f555e', felt: '#3e434a', edge: '#2c3036' },
  teal: { name: 'Teal', light: '#2f8f8c', felt: '#257a77', edge: '#1c5e5c' },
};

export const BACKS: Record<Back, string> = { red: 'Red', blue: 'Blue', green: 'Green', black: 'Black' };

const KEY = 'rsdp.prefs';
const DEFAULTS: Prefs = {
  felt: 'table',
  deck: 'two',
  back: 'red',
  units: 'chips',
  tableSounds: true,
  chatSound: true,
  gestures: 'sound',
  avatars: true,
  moods: true,
  hiddenAvatars: [],
  wakeLock: true,
  tableMotion: true,
};
const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
    return {
      felt: raw.felt === 'table' || (FELTS as readonly string[]).includes(raw.felt) ? raw.felt : DEFAULTS.felt,
      deck: raw.deck === 'four' ? 'four' : 'two',
      back: typeof raw.back === 'string' && Object.hasOwn(BACKS, raw.back) ? raw.back : DEFAULTS.back,
      units: raw.units === 'bb' ? 'bb' : 'chips',
      tableSounds: flag(raw.tableSounds, DEFAULTS.tableSounds),
      chatSound: flag(raw.chatSound, DEFAULTS.chatSound),
      gestures: raw.gestures === 'silent' || raw.gestures === 'off' ? raw.gestures : 'sound',
      avatars: flag(raw.avatars, DEFAULTS.avatars),
      moods: flag(raw.moods, DEFAULTS.moods),
      hiddenAvatars: Array.isArray(raw.hiddenAvatars) ? raw.hiddenAvatars.filter((x: unknown) => typeof x === 'string').slice(0, 500) : [],
      wakeLock: flag(raw.wakeLock, DEFAULTS.wakeLock),
      tableMotion: flag(raw.tableMotion, DEFAULTS.tableMotion),
    };
  } catch {
    return DEFAULTS;
  }
}

let current = load();
const listeners = new Set<() => void>();

/** The deck, card back and table motion are page-wide, so they go on the root element for the CSS (feel.css). */
function apply(p: Prefs) {
  document.documentElement.dataset.deck = p.deck;
  document.documentElement.dataset.back = p.back;
  document.documentElement.dataset.feel = p.tableMotion ? 'depth motion moments identity' : 'depth moments identity';
  document.documentElement.dataset.motion = p.tableMotion ? 'on' : 'off';
}

/** Whether the table moves: the player's own switch, and their device's reduce-motion setting. */
export const tableMotion = () =>
  current.tableMotion && !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
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

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => current;

// Another tab changed the look: follow it here too.
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  current = load();
  apply(current);
  listeners.forEach((l) => l());
});

/** The current choices, outside React (sounds read them as they play). */
export const getPrefs = (): Prefs => current;

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, snapshot);
}

/** The felt this viewer sees: their own pick, else the host's, else green. */
export function feltStyle(prefs: Prefs, hostFelt: Felt | undefined): CSSProperties {
  const c = FELT_COLORS[prefs.felt === 'table' ? (hostFelt ?? 'green') : prefs.felt];
  return { '--felt': c.felt, '--felt-edge': c.edge } as CSSProperties;
}
