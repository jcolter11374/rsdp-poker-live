import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBlocks } from './markdown';
import { sourceLink } from './FairnessPage';

const doc = readFileSync(new URL('../../../../docs/FAIRNESS.md', import.meta.url), 'utf8');

describe('/fairness', () => {
  const blocks = parseBlocks(doc);

  it('renders docs/FAIRNESS.md without leftover Markdown', () => {
    expect(blocks[0]).toMatchObject({ t: 'h', level: 1 });
    const texts = blocks.flatMap((b) => (b.t === 'p' || b.t === 'h' ? [b.text] : b.t === 'ul' || b.t === 'ol' ? b.items : b.t === 'table' ? [...b.head, ...b.rows.flat()] : []));
    for (const text of texts) {
      const plain = text.replace(/`[^`]+`/g, '');
      expect(plain, text).not.toMatch(/^#|^\||^```/);
      expect((plain.match(/\*\*/g) ?? []).length % 2, text).toBe(0);
    }
  });

  it('keeps every table row the width of its header', () => {
    const tables = blocks.filter((b) => b.t === 'table');
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) for (const r of t.rows) expect(r.length, r.join(' | ')).toBe(t.head.length);
  });

  it('has the sections people come for', () => {
    const heads = blocks.filter((b) => b.t === 'h').map((b) => b.text.toLowerCase()).join('\n');
    for (const want of ['statistic', 'checking a hand', 'audit']) expect(heads).toContain(want);
  });

  it('points repo links at the source on GitHub', () => {
    expect(sourceLink('../packages/engine/src/fairness.ts')).toBe('https://github.com/jcolter11374/rsdp-poker-live/blob/main/packages/engine/src/fairness.ts');
    expect(sourceLink('ARCHITECTURE.md')).toBe('https://github.com/jcolter11374/rsdp-poker-live/blob/main/docs/ARCHITECTURE.md');
    expect(sourceLink('https://example.com/x')).toBe('https://example.com/x');
    expect(sourceLink('#scheme')).toBe('#scheme');
  });
});
