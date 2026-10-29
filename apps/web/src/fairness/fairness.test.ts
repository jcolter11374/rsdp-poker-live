import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBlocks, type Block } from './markdown';
import { sourceLink } from './FairnessPage';

const flat = (bs: Block[]): Block[] => bs.flatMap((b) => (b.t === 'box' ? flat(b.blocks) : [b]));
const doc = readFileSync(new URL('../../../../docs/FAIRNESS.md', import.meta.url), 'utf8');

describe('/fairness', () => {
  const top = parseBlocks(doc);
  const blocks = flat(top);

  it('opens with the trust box, right under the title', () => {
    expect(top[1]).toMatchObject({ t: 'box' });
    const box = top[1].t === 'box' ? top[1].blocks : [];
    expect(box[0]).toMatchObject({ t: 'h', text: "The short version: you're trusting John" });
    expect(box.filter((b) => b.t === 'p').length).toBe(4);
  });

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

describe('/privacy', () => {
  const privacy = readFileSync(new URL('../../../../docs/PRIVACY.md', import.meta.url), 'utf8');
  const blocks = parseBlocks(privacy);

  it('renders docs/PRIVACY.md with every table row the width of its header', () => {
    expect(blocks[0]).toMatchObject({ t: 'h', level: 1 });
    const tables = blocks.filter((b) => b.t === 'table');
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) for (const r of t.rows) expect(r.length, r.join(' | ')).toBe(t.head.length);
  });

  it('has the sections people come for', () => {
    const heads = blocks.filter((b) => b.t === 'h').map((b) => b.text.toLowerCase()).join('\n');
    for (const want of ['who is responsible', 'what the site keeps', 'why the site keeps', 'backups', 'how long', 'your rights', 'deleting']) expect(heads).toContain(want);
  });
});

describe('/terms', () => {
  const terms = readFileSync(new URL('../../../../docs/TERMS.md', import.meta.url), 'utf8');
  const blocks = parseBlocks(terms);

  it('has the disclaimer people need to see', () => {
    expect(blocks[0]).toMatchObject({ t: 'h', level: 1 });
    const heads = blocks.filter((b) => b.t === 'h').map((b) => b.text.toLowerCase()).join('\n');
    for (const want of ['no warranty', 'limitation of liability']) expect(heads).toContain(want);
    expect(terms).toMatch(/MERCHANTABILITY,\s+FITNESS FOR A PARTICULAR PURPOSE/);
  });
});
