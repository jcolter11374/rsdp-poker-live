// The area under the table (the Dock) starts at a seed height, so the table doesn't get smaller when the action bar,
// a coach tip or the bots' reasons button first shows (#476). These are the tallest contents measured on a copy, in
// Chromium; a seed below one of them would shrink the table mid-session again.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Each rule's selectors and min-height seed (0 for none but the held height), with its @media condition ('' for none). */
function seeds(): { media: string; selectors: string[]; px: number }[] {
  const out: { media: string; selectors: string[]; px: number }[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  const take = (body: string, media: string) => {
    for (const m of body.matchAll(rule)) {
      const px = /min-height:\s*(?:max\((\d+)px,\s*)?var\(--held/.exec(m[2]);
      if (px) out.push({ media, selectors: m[1].split(',').map((s) => s.trim()), px: Number(px[1] ?? 0) });
    }
  };
  let top = '';
  for (let i = 0; i < css.length; ) {
    const at = css.indexOf('@media', i);
    if (at < 0) {
      top += css.slice(i);
      break;
    }
    top += css.slice(i, at);
    const open = css.indexOf('{', at);
    let depth = 1;
    let j = open + 1;
    for (; depth > 0; j++) depth += css[j] === '{' ? 1 : css[j] === '}' ? -1 : 0;
    take(css.slice(open + 1, j - 1), css.slice(at + 6, open).trim());
    i = j;
  }
  take(top, '');
  return out;
}

/** The seed that rule (selector, in that @media) sets: the last one in the file, as the cascade would take it. */
function seed(selector: string, media = ''): number | undefined {
  return seeds()
    .filter((s) => s.media === media && s.selectors.includes(selector))
    .at(-1)?.px;
}

describe('the Dock seeds at a practice table (#476)', () => {
  it.each([
    // A computer: [selector, @media, tallest content measured].
    ['.dock.seated', '', 217, "no limit, a tip open and the bots' reasons button"],
    ['.dock.seated', '(max-height: 820px)', 185, 'the same on a shorter window'],
    ['.dock.seated.limit.tips.why', '', 216, 'fixed limit or a draw, a tip open and the reasons button'],
    ['.dock.seated.limit.tips.why', '(max-height: 820px)', 184, 'the same on a shorter window'],
    ['.dock.seated.limit.why', '', 167, 'fixed limit, tips off, the reasons button'],
    ['.dock.seated.limit.why', '(max-height: 820px)', 141, 'the same on a shorter window'],
    // A touch screen in the computer layout: the open tip's buttons are taller.
    ['.table-page:not(.portrait) .dock.seated.tips.why', '(pointer: coarse)', 237, 'a touch screen, a tip open and the reasons button'],
    ['.table-page:not(.portrait) .dock.seated.tips.why', '(pointer: coarse) and (max-height: 820px)', 205, 'the same on a shorter screen'],
    // A phone held upright.
    ['.portrait .dock.seated.why', '', 263, "no limit, the reasons button, the bar's buttons on two lines"],
    ['.portrait .dock.seated.why', '(max-height: 760px)', 247, 'the same on a shorter phone'],
    ['.portrait .dock.seated.limit.tips.why', '', 241, 'fixed limit or a draw, a tip open and the reasons button'],
    ['.portrait .dock.seated.limit.tips.why', '(max-height: 760px)', 229, 'the same on a shorter phone'],
    ['.portrait .dock.seated.limit.why', '', 139, 'fixed limit, tips off, the reasons button'],
  ])('%s %s holds %i px: %s', (selector, media, tallest) => {
    expect(seed(selector, media)).toBeGreaterThanOrEqual(tallest);
  });

  it('reads the rules as the file has them', () => {
    expect(seed('.dock.seated.limit')).toBe(113);
    // Phones on their side: no seed, the table needs every pixel.
    expect(seed('.portrait .dock.seated.limit.tips.why', '(max-height: 500px)')).toBe(0);
    expect(seed('.portrait .dock.seated.why', '(max-height: 500px)')).toBe(0);
  });
});
