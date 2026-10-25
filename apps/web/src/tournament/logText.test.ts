import { describe, expect, it } from 'vitest';
import { logText } from './logText';

describe('activity lines', () => {
  it('reads like sentences', () => {
    expect(logText({ type: 'eliminated', name: 'Ana', place: 3, by: ['Bo', 'Cy'], reason: 'busted' })).toBe('Ana busted in 3rd by Bo and Cy');
    expect(logText({ type: 'eliminated', name: 'Ana', place: 7, by: [], reason: 'quit' })).toBe('Ana left in 7th');
    expect(logText({ type: 'registered', name: 'Ana', late: true, entryNo: 1 })).toBe('Ana registered (late)');
    expect(logText({ type: 'registered', name: 'Ana', late: true, entryNo: 2 })).toBe('Ana re-entered');
    expect(logText({ type: 'chipsAdded', name: 'Ana', chips: 5000, reason: 'rebuy' })).toBe('Ana rebought for 5,000');
  });
});
