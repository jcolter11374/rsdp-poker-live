import { describe, expect, it } from 'vitest';
import { groupLog } from './logGroups';

const l = (text: string) => ({ text });

describe('groupLog', () => {
  it('folds a run of three or more sit-downs into one line', () => {
    const out = groupLog([
      l('John sat down in seat 1 with 200'),
      l("John's practice bot Ace sat down in seat 2 with 200"),
      l("John's practice bot Chip sat down in seat 3 with 200"),
      l('The host started the game'),
    ]);
    expect(out.map((o) => o.text)).toEqual(['3 players sat down: John, Ace (bot) and Chip (bot)', 'The host started the game']);
    expect(out[0].full?.split('\n')).toHaveLength(3);
  });

  it('leaves one or two sit-downs as they are', () => {
    const lines = [l('Ann sat down in seat 1 with 100'), l('Bob sat down in seat 4 with 100'), l('Bob stood up')];
    expect(groupLog(lines).map((o) => o.text)).toEqual(lines.map((x) => x.text));
  });
});
