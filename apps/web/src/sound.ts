/** Tiny synthesized sound effects, so the app ships no audio files. */

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

export function setVolume(value: Volume) {
  volume = value;
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

/** Table noises are skipped in a background tab, so they don't pile up; alerts always play. */
const quietWhenHidden =
  (fn: () => void) =>
  (): void => {
    if (!document.hidden) fn();
  };

export const sounds = {
  deal: quietWhenHidden(() => {
    noise(0, 0.06, 0.25, 3000);
    noise(0.09, 0.06, 0.25, 3000);
  }),
  chips: quietWhenHidden(() => {
    tone(2400, 0, 0.05, 'triangle', 0.08);
    tone(2900, 0.04, 0.05, 'triangle', 0.08);
    tone(2600, 0.08, 0.06, 'triangle', 0.06);
  }),
  raise: quietWhenHidden(() => {
    tone(2400, 0, 0.05, 'triangle', 0.09);
    tone(2900, 0.04, 0.05, 'triangle', 0.09);
    tone(2600, 0.08, 0.06, 'triangle', 0.08);
    tone(3100, 0.13, 0.06, 'triangle', 0.08);
    tone(2700, 0.18, 0.08, 'triangle', 0.06);
  }),
  allIn: quietWhenHidden(() => {
    for (let i = 0; i < 7; i++) tone(2200 + ((i * 370) % 900), i * 0.035, 0.07, 'triangle', 0.08);
    tone(196, 0, 0.35, 'sine', 0.12);
  }),
  check: quietWhenHidden(() => {
    noise(0, 0.04, 0.5, 400);
    noise(0.12, 0.04, 0.5, 400);
  }),
  fold: quietWhenHidden(() => noise(0, 0.15, 0.15, 1200)),
  chat: quietWhenHidden(() => tone(1560, 0, 0.08, 'sine', 0.06)),
  turn: () => {
    tone(880, 0, 0.12, 'sine', 0.12);
    tone(1320, 0.12, 0.18, 'sine', 0.12);
  },
  /** A few seconds left on your clock. */
  hurry: () => {
    tone(1760, 0, 0.08, 'square', 0.05);
    tone(1760, 0.16, 0.08, 'square', 0.05);
    tone(1760, 0.32, 0.08, 'square', 0.05);
  },
  /** Someone asked the host for a seat or chips. */
  request: () => {
    tone(1047, 0, 0.1, 'sine', 0.1);
    tone(784, 0.1, 0.16, 'sine', 0.1);
  },
  win: quietWhenHidden(() => {
    tone(660, 0, 0.12, 'triangle');
    tone(880, 0.1, 0.12, 'triangle');
    tone(1100, 0.2, 0.25, 'triangle');
  }),
};
