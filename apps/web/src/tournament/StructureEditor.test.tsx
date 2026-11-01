// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_CHIPS, validateStructure, type LevelRow, type StructureRow } from '@rsdp/tournament';
import { StructureEditor } from './StructureEditor';

afterEach(cleanup);

const level: LevelRow = { kind: 'level', sb: 25, bb: 50, ante: 5, anteType: 'per-player', minutes: 15 };

function setup() {
  const onChange = vi.fn<(rows: StructureRow[]) => void>();
  render(<StructureEditor rows={[level]} onChange={onChange} startingStack={10_000} expectedEntrants={9} maxRebuys={0} />);
  return onChange;
}

describe('StructureEditor typed blinds and ante', () => {
  // The server refuses any amount above MAX_CHIPS, so a typed amount stops there instead of failing on save.
  it.each([
    ['Small blind', 'sb'],
    ['Big blind', 'bb'],
    ['Ante', 'ante'],
  ] as const)('%s stops at the maximum chip amount', (label, field) => {
    const onChange = setup();
    const input = screen.getByRole('spinbutton', { name: label }) as HTMLInputElement;
    expect(input.max).toBe(String(MAX_CHIPS));
    fireEvent.change(input, { target: { value: String(MAX_CHIPS * 10) } });
    const row = onChange.mock.lastCall![0][0] as LevelRow;
    expect(row[field]).toBe(MAX_CHIPS);
  });

  it('a level typed up to the maximum still passes the structure check', () => {
    const onChange = setup();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Big blind' }), { target: { value: '9'.repeat(16) } });
    const rows = onChange.mock.lastCall![0];
    expect((rows[0] as LevelRow).bb).toBe(MAX_CHIPS);
    expect(validateStructure(rows, { maxRebuys: 0 }).errors).toEqual([]);
  });
});
