import { describe, expect, it } from 'vitest';
import { renderSound, seeded, type SoundName } from './soundbank';

const NAMES: SoundName[] = ['deal', 'chips', 'raise', 'allIn', 'pot', 'check', 'fold', 'turn', 'turnBell', 'hurry', 'request', 'chat', 'win'];

describe('renderSound', () => {
  for (const name of NAMES) {
    it(`renders ${name} as a clean, audible, short buffer`, () => {
      for (const soft of [false, true]) {
        const data = renderSound(name, 44100, seeded(3), soft);
        let peak = 0;
        let finite = true;
        for (const v of data) {
          finite &&= Number.isFinite(v);
          peak = Math.max(peak, Math.abs(v));
        }
        expect(finite).toBe(true);
        expect(peak).toBeGreaterThan(0.1);
        expect(peak).toBeLessThanOrEqual(0.7);
        expect(data.length / 44100).toBeLessThanOrEqual(1.5);
        // Fades out, so nothing clicks at the end.
        expect(Math.abs(data[data.length - 1])).toBeLessThan(1e-3);
      }
    });
  }

  it('renders the same sound the same way from the same seed', () => {
    expect(renderSound('chips', 22050, seeded(9))).toEqual(renderSound('chips', 22050, seeded(9)));
  });
});
