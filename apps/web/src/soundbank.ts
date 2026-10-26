/**
 * Table sounds, synthesized as sample buffers: clay chips knocking together,
 * cards sliding on felt, a soft mallet for "your turn". Each sound is built
 * from a few physical-ish pieces (struck resonators, filtered noise, a small
 * room) instead of plain beeps, so they sound full rather than thin. Pure
 * functions of the sample rate and a random source, so they run in the
 * browser and in Node (for previews and tests).
 */

export type Rand = () => number;

/** A seeded random source, so a preview renders the same every time. */
export function seeded(seed: number): Rand {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

class Mix {
  readonly out: Float32Array;
  constructor(
    readonly sr: number,
    seconds: number,
  ) {
    this.out = new Float32Array(Math.ceil(sr * seconds));
  }

  /** Decaying sine partials struck at `at`: the ring of a chip, a wooden bar, a bell. */
  modes(at: number, modes: readonly (readonly [freq: number, decay: number, gain: number])[], attack = 0.0005) {
    const { sr, out } = this;
    const start = Math.floor(at * sr);
    for (const [f, d, g] of modes) {
      const len = Math.min(out.length - start, Math.ceil(d * 7 * sr));
      // A decaying phasor, turned one sample at a time (cheaper than sin and exp per sample).
      const w = (2 * Math.PI * f) / sr;
      const k = Math.exp(-1 / (d * sr));
      const c = Math.cos(w) * k;
      const sn = Math.sin(w) * k;
      const ramp = Math.max(1, attack * sr);
      let re = g;
      let im = 0;
      for (let i = 0; i < len; i++) {
        out[start + i] += i < ramp ? (im * i) / ramp : im;
        const r = re * c - im * sn;
        im = re * sn + im * c;
        re = r;
      }
    }
  }

  /** Noise through a band-pass filter whose centre glides from f0 to f1, with an attack/decay envelope. */
  noise(at: number, dur: number, gain: number, f0: number, f1: number, q: number, rand: Rand, attack = 0.002) {
    const { sr, out } = this;
    const start = Math.floor(at * sr);
    const len = Math.min(out.length - start, Math.ceil(dur * sr));
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    let b0 = 0;
    let a1 = 0;
    let a2 = 0;
    for (let i = 0; i < len; i++) {
      const p = i / len;
      // The filter moves in small steps, which is plenty for a glide.
      if (i % 32 === 0) {
        const w = (2 * Math.PI * f0 * Math.pow(f1 / f0, p)) / sr;
        const alpha = Math.sin(w) / (2 * q);
        const a0 = 1 + alpha;
        b0 = alpha / a0;
        a1 = (-2 * Math.cos(w)) / a0;
        a2 = (1 - alpha) / a0;
      }
      const x = rand() * 2 - 1;
      const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      const t = i / sr;
      const env = Math.min(1, t / attack) * Math.pow(1 - p, 2);
      out[start + i] += gain * env * y;
    }
  }

  /** A soft low thump, like something landing on felt. */
  thump(at: number, freq: number, dur: number, gain: number) {
    this.modes(at, [[freq, dur, gain], [freq * 2.3, dur * 0.4, gain * 0.3]], 0.002);
  }

  /** A small, dark room so things sound like they're in the same place. */
  room(mix = 0.12, size = 1) {
    const { sr, out } = this;
    const dry = Float32Array.from(out);
    const combs = [1116, 1188, 1277, 1356].map((n) => Math.floor(((n * size) / 44100) * sr));
    const wet = new Float32Array(out.length);
    for (const d of combs) {
      const buf = new Float32Array(d);
      let idx = 0;
      let lp = 0;
      for (let i = 0; i < out.length; i++) {
        const y = buf[idx];
        lp = y * 0.6 + lp * 0.4;
        buf[idx] = dry[i] + lp * 0.72;
        idx = (idx + 1) % d;
        wet[i] += y / combs.length;
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = dry[i] + wet[i] * mix;
  }

  /** Scales to the given peak and fades the last few ms so nothing clicks. */
  done(peak: number) {
    const { out, sr } = this;
    let max = 0;
    for (const v of out) max = Math.max(max, Math.abs(v));
    const k = max > 0 ? peak / max : 0;
    const fade = Math.floor(sr * 0.01);
    for (let i = 0; i < out.length; i++) out[i] *= k * Math.min(1, (out.length - i) / fade);
    return out;
  }
}

/** One clay chip knocking another: a sharp click and a short, dense ring. */
function chip(m: Mix, at: number, gain: number, rand: Rand, tone = 1) {
  const j = () => 0.94 + rand() * 0.12;
  m.noise(at, 0.004, gain * 0.9, 6000, 4000, 0.7, rand, 0.0002);
  m.modes(at, [
    [1180 * tone * j(), 0.006, gain * 0.35],
    [2350 * tone * j(), 0.011, gain * 0.5],
    [3480 * tone * j(), 0.008, gain * 0.38],
    [5050 * tone * j(), 0.006, gain * 0.25],
    [7100 * tone * j(), 0.004, gain * 0.14],
  ]);
}

/** Several chips in quick succession, each a little softer. */
function chips(m: Mix, at: number, count: number, spread: number, gain: number, rand: Rand, tone = 1) {
  for (let i = 0; i < count; i++) chip(m, at + (i * spread) / Math.max(1, count - 1) + rand() * 0.008, gain * (1 - (i / count) * 0.45), rand, tone);
}

/** A card sliding across felt and settling. */
function card(m: Mix, at: number, gain: number, rand: Rand, len = 0.085) {
  m.noise(at, len, gain, 4200, 1500, 0.9, rand, 0.006);
  m.noise(at + len * 0.75, 0.03, gain * 0.5, 900, 500, 0.7, rand, 0.001);
  m.thump(at + len * 0.8, 170, 0.025, gain * 0.25);
}

/** A soft mallet on a wooden bar (a marimba note). */
function mallet(m: Mix, at: number, freq: number, gain: number, decay = 0.45) {
  m.modes(
    at,
    [
      [freq, decay, gain],
      [freq * 3.93, decay * 0.18, gain * 0.28],
      [freq * 9.2, decay * 0.05, gain * 0.08],
    ],
    0.003,
  );
}

/** A warm, low bell. */
function bell(m: Mix, at: number, freq: number, gain: number) {
  m.modes(
    at,
    [
      [freq, 0.7, gain],
      [freq * 2.01, 0.35, gain * 0.35],
      [freq * 2.99, 0.18, gain * 0.15],
      [freq * 0.5, 0.5, gain * 0.25],
    ],
    0.012,
  );
}

export type SoundName =
  | 'deal'
  | 'flip'
  | 'chips'
  | 'raise'
  | 'allIn'
  | 'pot'
  | 'check'
  | 'fold'
  | 'turn'
  | 'turnBell'
  | 'hurry'
  | 'request'
  | 'chat'
  | 'win';

/** Renders one sound at sample rate `sr`. `soft` is the muted set: lower chips, gentler cards. */
export function renderSound(name: SoundName, sr: number, rand: Rand = Math.random, soft = false): Float32Array {
  const tone = soft ? 0.78 : 1;
  switch (name) {
    case 'deal': {
      const m = new Mix(sr, 0.3);
      card(m, 0, 1, rand);
      card(m, 0.1, 0.9, rand);
      m.room(0.08);
      return m.done(soft ? 0.32 : 0.42);
    }
    case 'flip': {
      // A board card snapped face up on the cloth: a short bright flick and a soft slap.
      const m = new Mix(sr, 0.22);
      card(m, 0, 0.8, rand, 0.04);
      m.noise(0.035, 0.012, 0.6, 5200, 2600, 0.8, rand, 0.0004);
      m.thump(0.04, 210, 0.03, 0.35);
      m.room(0.06);
      return m.done(soft ? 0.3 : 0.4);
    }
    case 'chips': {
      const m = new Mix(sr, 0.35);
      chips(m, 0, 3, 0.11, 1, rand, tone);
      m.room(0.1);
      return m.done(soft ? 0.38 : 0.5);
    }
    case 'raise': {
      const m = new Mix(sr, 0.45);
      chips(m, 0, 5, 0.2, 1, rand, tone);
      m.room(0.1);
      return m.done(soft ? 0.42 : 0.55);
    }
    case 'allIn': {
      const m = new Mix(sr, 0.8);
      m.noise(0, 0.45, 0.25, 2200, 1200, 0.6, rand, 0.05);
      chips(m, 0.02, 14, 0.42, 1, rand, tone);
      m.thump(0.45, 90, 0.12, 0.7);
      m.room(0.14);
      return m.done(soft ? 0.5 : 0.62);
    }
    case 'pot': {
      const m = new Mix(sr, 0.7);
      m.noise(0, 0.38, 0.22, 2600, 1300, 0.6, rand, 0.04);
      for (let i = 0; i < 11; i++) chip(m, 0.03 + rand() * 0.34, 0.5 + rand() * 0.5, rand, tone);
      m.room(0.12);
      return m.done(soft ? 0.42 : 0.52);
    }
    case 'check': {
      const m = new Mix(sr, 0.32);
      for (const at of [0, 0.12]) {
        m.thump(at, 150, 0.035, 1);
        m.noise(at, 0.03, 0.6, 700, 300, 0.8, rand, 0.001);
      }
      m.room(0.08);
      return m.done(soft ? 0.45 : 0.55);
    }
    case 'fold': {
      const m = new Mix(sr, 0.3);
      card(m, 0, 0.8, rand, 0.14);
      m.room(0.08);
      return m.done(soft ? 0.25 : 0.32);
    }
    case 'turn': {
      // Two soft marimba notes, rising: G4 then C5.
      const m = new Mix(sr, 1.1);
      mallet(m, 0, 392, 1);
      mallet(m, 0.14, 523.25, 0.9);
      m.room(0.16, 1.4);
      return m.done(0.42);
    }
    case 'turnBell': {
      const m = new Mix(sr, 1.4);
      bell(m, 0, 329.63, 1);
      bell(m, 0.18, 440, 0.8);
      m.room(0.18, 1.5);
      return m.done(0.4);
    }
    case 'hurry': {
      // Three wood-block ticks.
      const m = new Mix(sr, 0.6);
      for (const at of [0, 0.16, 0.32]) m.modes(at, [[880, 0.03, 1], [2420, 0.012, 0.4]], 0.001);
      m.room(0.08);
      return m.done(0.4);
    }
    case 'request': {
      const m = new Mix(sr, 0.9);
      mallet(m, 0, 523.25, 1, 0.35);
      mallet(m, 0.13, 392, 0.9, 0.4);
      m.room(0.14, 1.3);
      return m.done(0.36);
    }
    case 'chat': {
      const m = new Mix(sr, 0.4);
      mallet(m, 0, 1046.5, 1, 0.12);
      m.room(0.08);
      return m.done(0.2);
    }
    case 'win': {
      const m = new Mix(sr, 1.2);
      m.noise(0, 0.4, 0.2, 2600, 1300, 0.6, rand, 0.04);
      for (let i = 0; i < 12; i++) chip(m, 0.02 + rand() * 0.38, 0.5 + rand() * 0.5, rand, tone);
      mallet(m, 0.3, 523.25, 0.5, 0.4);
      mallet(m, 0.38, 659.25, 0.45, 0.4);
      mallet(m, 0.46, 783.99, 0.45, 0.5);
      m.room(0.14, 1.3);
      return m.done(0.5);
    }
  }
}
