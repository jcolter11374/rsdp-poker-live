import { describe, expect, it } from 'vitest';
import type { ChatView } from '@rsdp/engine/wire';
import { newChat } from './components/table/Chat';

const msg = (at: number, text = `m${at}`): ChatView => ({ at, playerId: 'p', name: 'Pat', text });

describe('newChat', () => {
  it('finds lines added to a growing list', () => {
    const before = [msg(1), msg(2)];
    expect(newChat(before, [...before, msg(3)]).map((m) => m.at)).toEqual([3]);
  });
  it('still finds new lines once the view is capped and stops growing', () => {
    const before = [msg(1), msg(2), msg(3)];
    expect(newChat(before, [msg(2), msg(3), msg(4)]).map((m) => m.at)).toEqual([4]);
    expect(newChat(before, before)).toEqual([]);
  });
  it('treats everything as new when the old last line has scrolled out', () => {
    expect(newChat([msg(1)], [msg(5), msg(6)]).map((m) => m.at)).toEqual([5, 6]);
  });
  it('tells apart two lines sent in the same millisecond', () => {
    const before = [msg(1, 'a')];
    expect(newChat(before, [msg(1, 'a'), msg(1, 'b')]).map((m) => m.text)).toEqual(['b']);
  });
});
