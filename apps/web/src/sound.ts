/** Tiny synthesized sound effects, so the app ships no audio files. */

const MUTE_KEY = 'rsdp.muted';
let ctx: AudioContext | null = null;
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
})();

export function isMuted() {
  return muted;
}

export function setMuted(value: boolean) {
  muted = value;
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function audio(): AudioContext | null {
  if (muted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', gain = 0.15) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + start;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur);
}

function noise(start: number, dur: number, gain = 0.2, filter = 2000) {
  const a = audio();
  if (!a) return;
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
  src.connect(f).connect(g).connect(a.destination);
  src.start(t);
}

export const sounds = {
  deal: () => {
    noise(0, 0.06, 0.25, 3000);
    noise(0.09, 0.06, 0.25, 3000);
  },
  chips: () => {
    tone(2400, 0, 0.05, 'triangle', 0.08);
    tone(2900, 0.04, 0.05, 'triangle', 0.08);
    tone(2600, 0.08, 0.06, 'triangle', 0.06);
  },
  check: () => {
    noise(0, 0.04, 0.5, 400);
    noise(0.12, 0.04, 0.5, 400);
  },
  fold: () => noise(0, 0.15, 0.15, 1200),
  turn: () => {
    tone(880, 0, 0.12, 'sine', 0.12);
    tone(1320, 0.12, 0.18, 'sine', 0.12);
  },
  win: () => {
    tone(660, 0, 0.12, 'triangle');
    tone(880, 0.1, 0.12, 'triangle');
    tone(1100, 0.2, 0.25, 'triangle');
  },
};
