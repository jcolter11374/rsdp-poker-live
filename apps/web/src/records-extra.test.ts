import { describe, expect, it } from 'vitest';
import { engine, type HandState } from '@rsdp/engine/core';
import type { HandRecordView } from '@rsdp/engine/wire';
import { deckWith, start } from '../../../packages/engine/test/core/harness';
import { findHighlights } from './highlights';
import { ohhFile } from './ohh';
import { fullLogCsv, fullLogLines, handsJson } from './records';
import { isReplayable } from './replay';

const fmt = (n: number) => String(n);
const record = (s: HandState, seat: number | null, handNumber = 1): HandRecordView => ({
  handNumber,
  startedAt: 1000 * handNumber,
  endedAt: 1000 * handNumber + 500,
  gameName: s.input.game.name,
  betting: s.input.betting,
  stakes: s.input.stakes,
  button: s.input.button,
  seats: s.seats.map((x) => ({ seat: x.seat, playerId: x.playerId, name: x.playerId === 'p0' ? 'Ann' : 'Bob', stack: x.startStack })),
  events: engine.visibleEvents(s, { seat, seeAll: false }),
});

/** Heads up, all in before the flop: Ann's 7-2 against Bob's kings, and the 7-2 gets there. */
function sevenDeuceCracksKings() {
  // Cards go round from the big blind first heads up (seat 1, 0, 1, 0), then the board.
  const s = start({ stacks: [100, 100], button: 0, top: ['Kh', '7c', 'Ks', '2d', '7s', '2s', '3h', '9c', 'Jd'] });
  for (let i = 0; i < 10 && s.phase !== 'complete'; i++) {
    const seat = s.toAct!;
    const legal = engine.legalActions(s, seat)!;
    if (legal.canRaise) engine.act(s, seat, { type: legal.canCheck ? 'bet' : 'raise', to: legal.maxTo });
    else engine.act(s, seat, { type: 'call' });
  }
  return s;
}

describe('highlights', () => {
  it('finds the underdog who got there, and the knockout', () => {
    const s = sevenDeuceCracksKings();
    expect(s.phase).toBe('complete');
    const hole = s.seats
      .find((x) => x.playerId === 'p0')!
      .cards.map((c) => c.card)
      .sort();
    expect(hole).toEqual(['2d', '7c']);
    const [h] = findHighlights([record(s, 1)], fmt);
    expect(h).toBeDefined();
    expect(h.playerId).toBe('p0');
    expect(['underdog', 'knockout', 'seven-deuce']).toContain(h.kind);
    expect(h.headline).toMatch(/Ann/);
  });

  it('skips quiet hands', () => {
    const s = start({ stacks: [100, 100] });
    engine.act(s, s.toAct!, { type: 'fold' });
    expect(findHighlights([record(s, 0)], fmt)).toEqual([]);
  });
});

describe('open hand history', () => {
  it('writes Hold’em hands with the hero’s cards, streets and pots', () => {
    const s = sevenDeuceCracksKings();
    const { text, count } = ohhFile([record(s, 0)], { tableName: 'Test', centsMode: false, seatCount: 9, myId: 'p0' });
    expect(count).toBe(1);
    const { ohh } = JSON.parse(text.trim()) as { ohh: Record<string, any> };
    expect(ohh).toMatchObject({ spec_version: '1.4.7', game_type: 'Holdem', bet_limit: { bet_type: 'NL' }, hero_player_id: 1, table_size: 9, big_blind_amount: 2 });
    expect(ohh.players).toHaveLength(2);
    expect(ohh.rounds.map((r: { street: string }) => r.street)).toEqual(['Preflop', 'Flop', 'Turn', 'River', 'Showdown']);
    const dealt = ohh.rounds[0].actions.find((a: { action: string; player_id: number }) => a.action === 'Dealt Cards' && a.player_id === 1);
    expect(dealt.cards.sort()).toEqual(['2d', '7c']);
    expect(ohh.pots[0].amount).toBe(200);
    expect(ohh.pots[0].player_wins[0]).toMatchObject({ player_id: 1, win_amount: 200 });
  });

  it('labels the blinds and a big blind ante the way trackers expect', () => {
    const posts = (s: HandState) => {
      const { ohh } = JSON.parse(ohhFile([record(s, 0)], { tableName: 'T', centsMode: false, seatCount: 9, myId: 'p0' }).text.trim()) as {
        ohh: { rounds: { actions: { action: string; player_id: number }[] }[] };
      };
      return ohh.rounds[0].actions.filter((a) => a.action.startsWith('Post')).map((a) => [a.player_id, a.action]);
    };
    // Three-handed, button on seat 0: seat 1 posts the small blind and seat 2 the big blind.
    const plain = start({ stacks: [100, 100, 100], button: 0 });
    while (plain.phase !== 'complete') engine.act(plain, plain.toAct!, { type: 'fold' });
    expect(posts(plain)).toEqual([
      [2, 'Post SB'],
      [3, 'Post BB'],
    ]);
    // A big blind ante is dead money, but it is still an ante, not a dead blind.
    const bba = start({ stacks: [100, 100, 100], button: 0, stakes: { ante: 2, anteType: 'big-blind' } });
    while (bba.phase !== 'complete') engine.act(bba, bba.toAct!, { type: 'fold' });
    expect(posts(bba)).toEqual([
      [2, 'Post SB'],
      [3, 'Post BB'],
      [3, 'Post Ante'],
    ]);
  });

  it('leaves out games trackers can’t read', () => {
    const s = start({ game: 'stud', stacks: [100, 100] });
    expect(ohhFile([record(s, 0)], { tableName: 'T', centsMode: false, seatCount: 8, myId: 'p0' }).count).toBe(0);
  });
});

describe('full log', () => {
  it('merges the table log, chat and hands in time order', () => {
    const s = sevenDeuceCracksKings();
    const lines = fullLogLines(
      [
        { at: 500, text: 'Ann sat down' },
        { at: 5000, text: 'The host paused' },
      ],
      [{ at: 900, playerId: 'p1', name: 'Bob', text: 'gl, "all"' }],
      [record(s, 0)],
      'p0',
      fmt,
    );
    expect(lines[0].text).toBe('Ann sat down');
    expect(lines[1]).toMatchObject({ kind: 'chat', text: 'Bob: gl, "all"' });
    expect(lines.at(-1)!.text).toBe('The host paused');
    expect(lines.some((l) => l.kind === 'hand' && /7♣/.test(l.text))).toBe(true);
    expect(fullLogCsv(lines)).toContain('"Bob: gl, ""all"""');
  });
});

describe('hands file', () => {
  it('leaves the bots’ reasons out, and opens again in the replayer', () => {
    const s = sevenDeuceCracksKings();
    const h: HandRecordView = { ...record(s, 0), botNotes: [{ seq: 6, seat: 1, level: 'normal', rule: 'call', share: 0.8, cost: 0.33, need: 0.36 }] };
    const file = JSON.parse(handsJson('Test', false, [h, record(s, 0, 2)], new Date(0)));
    expect(file).toMatchObject({ format: 'rsdp-hands', version: 1, table: 'Test', exportedAt: '1970-01-01T00:00:00.000Z', centsMode: false });
    expect(file.hands).toHaveLength(2);
    for (const x of file.hands) expect('botNotes' in x).toBe(false);
    expect(file.hands[0].events).toEqual(h.events);
    // The hand shown on screen keeps them.
    expect(h.botNotes).toHaveLength(1);
    expect(file.hands.every((x: unknown) => isReplayable(x, fmt))).toBe(true);
  });
});
