/** Synthesized sound effects, so the app ships no audio files. */

import { useSyncExternalStore } from 'react';
import type { GestureKind } from '@rsdp/engine/wire';
import { getPrefs, tableMotion } from './prefs';
import { renderSound, type SoundName } from './soundbank';

const VOLUME_KEY = 'rsdp.volume';
/** Where the first version kept a plain on/off switch. */
const MUTE_KEY = 'rsdp.muted';

/** Off, low, medium, high. */
export const VOLUMES = [0, 0.2, 0.55, 1] as const;
export type Volume = (typeof VOLUMES)[number];
export const VOLUME_NAME: Record<Volume, string> = { 0: 'Sound off', 0.2: 'Sound low', 0.55: 'Sound medium', 1: 'Sound high' };

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let volume: Volume = (() => {
  try {
    const saved = localStorage.getItem(VOLUME_KEY);
    if (saved !== null && (VOLUMES as readonly number[]).includes(Number(saved))) return Number(saved) as Volume;
    return localStorage.getItem(MUTE_KEY) === '1' ? 0 : 0.55;
  } catch {
    return 0.55;
  }
})();

export function getVolume(): Volume {
  return volume;
}

const volumeListeners = new Set<() => void>();

/** The volume, kept current across every control that changes it. */
export function useVolume(): Volume {
  return useSyncExternalStore((cb) => {
    volumeListeners.add(cb);
    return () => volumeListeners.delete(cb);
  }, getVolume);
}

export function setVolume(value: Volume) {
  volume = value;
  volumeListeners.forEach((cb) => cb());
  if (master) master.gain.value = value;
  try {
    localStorage.setItem(VOLUME_KEY, String(value));
  } catch {
    /* ignore */
  }
}

/** The next level up, wrapping from high back to off. */
export const nextVolume = (v: Volume): Volume => VOLUMES[(VOLUMES.indexOf(v) + 1) % VOLUMES.length];

function audio(): AudioContext | null {
  if (volume === 0) return null;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

// Browsers only let a page make sound after a tap or key press, and iOS can
// suspend audio after an app switch: wake it on every interaction.
if (typeof window !== 'undefined') {
  const unlock = () => {
    if (volume > 0) audio();
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
  document.addEventListener('visibilitychange', () => !document.hidden && ctx?.state === 'suspended' && void ctx.resume());
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', gain = 0.15) {
  const a = audio();
  if (!a || !master) return;
  const t = a.currentTime + start;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur);
}

function noise(start: number, dur: number, gain = 0.2, filter = 2000) {
  const a = audio();
  if (!a || !master) return;
  const t = a.currentTime + start;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = filter;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

/** Each table sound is rendered a few times with different randomness, so repeats don't sound mechanical. */
const VARIANTS = 3;
const rendered = new Map<SoundName, AudioBuffer[]>();

/** How loud each sound plays against the others (the master volume sits on top). */
const LEVEL: Partial<Record<SoundName, number>> = { turn: 0.55, turnBell: 0.55, hurry: 0.5, request: 0.5, chat: 0.6 };

function play(name: SoundName) {
  const a = audio();
  if (!a || !master) return;
  const bufs = rendered.get(name) ?? [];
  rendered.set(name, bufs);
  let buf: AudioBuffer;
  if (bufs.length < VARIANTS) {
    // Rendered on first use, one variant per play, so no single play waits for all of them.
    const data = renderSound(name, a.sampleRate);
    buf = a.createBuffer(1, data.length, a.sampleRate);
    buf.getChannelData(0).set(data);
    bufs.push(buf);
  } else buf = bufs[Math.floor(Math.random() * bufs.length)];
  const src = a.createBufferSource();
  src.buffer = buf;
  const g = a.createGain();
  g.gain.value = LEVEL[name] ?? 0.42;
  src.connect(g).connect(master);
  src.start();
}

/**
 * Table noises are skipped in a background tab, so they don't pile up, and
 * when the player turned table sounds off; alerts always play.
 */
const quietWhenHidden =
  (fn: () => void) =>
  (): void => {
    if (!document.hidden && getPrefs().tableSounds) fn();
  };

export const sounds = {
  deal: quietWhenHidden(() => play('deal')),
  /** Board cards turning over: one snap per card, timed to the card turning face up on screen (feel.css feel-turn). */
  /** `count` is the most cards any one board row got; rows that land together turn together (Table.tsx), so they share snaps. */
  flip: (count: number) =>
    quietWhenHidden(() => {
      // Three or fewer new cards turn one after another; a whole board turns at once, with one snap.
      const snaps = count <= 3 ? count : 1;
      const moving = tableMotion();
      for (let i = 0; i < snaps; i++) setTimeout(() => play('flip'), moving ? 360 + i * 160 : i * 90);
    })(),
  chips: quietWhenHidden(() => play('chips')),
  raise: quietWhenHidden(() => play('raise')),
  allIn: quietWhenHidden(() => play('allIn')),
  check: quietWhenHidden(() => play('check')),
  fold: quietWhenHidden(() => play('fold')),
  /** The pot pushed to someone else. */
  pot: quietWhenHidden(() => play('pot')),
  chat: () => {
    if (!document.hidden && getPrefs().chatSound) play('chat');
  },
  /** A gesture landing on a seat. */
  gesture: (kind: GestureKind) => {
    if (document.hidden || getPrefs().gestures !== 'sound') return;
    GESTURE_SOUNDS[kind]();
  },
  turn: () => play('turn'),
  /** A few seconds left on your clock. */
  hurry: () => play('hurry'),
  /** Someone asked the host for a seat or chips. */
  request: () => play('request'),
  win: quietWhenHidden(() => play('win')),
};

const chime = (notes: number[], gap = 0.08, type: OscillatorType = 'sine', gain = 0.08) => () => notes.forEach((f, i) => tone(f, i * gap, 0.14, type, gain));

const GESTURE_SOUNDS: Record<GestureKind, () => void> = {
  heart: chime([784, 988, 1175]),
  clap: () => [0, 0.11, 0.22, 0.33].forEach((t) => noise(t, 0.035, 0.35, 1800)),
  cheers: chime([1568, 2093], 0.09, 'triangle', 0.07),
  fire: () => noise(0, 0.4, 0.18, 600),
  laugh: chime([660, 590, 660, 590, 660], 0.07, 'triangle', 0.06),
  cry: () => {
    tone(520, 0, 0.3, 'sine', 0.07);
    tone(440, 0.25, 0.4, 'sine', 0.07);
  },
  money: chime([2637, 3136, 2637, 3520], 0.05, 'triangle', 0.06),
  fish: chime([392, 330, 262], 0.1, 'sine', 0.08),
  shark: () => {
    tone(82, 0, 0.25, 'sawtooth', 0.06);
    tone(87, 0.3, 0.25, 'sawtooth', 0.06);
  },
  clown: chime([523, 659, 784, 659, 523], 0.06, 'square', 0.04),
  tomato: () => noise(0, 0.12, 0.4, 300),
  rose: chime([1047, 1319, 1568, 2093], 0.1, 'sine', 0.06),
};
