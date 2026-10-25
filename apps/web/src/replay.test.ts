import { describe, expect, it } from 'vitest';
import { engine, type HandState } from '@rsdp/engine/core';
import type { HandRecordView } from '@rsdp/engine/wire';
import { start } from '../../../packages/engine/test/core/harness';
import { finalStacks, isReplayable, playerStats, replayFrames } from './replay';

const fmt = (n: number) => String(n);
/** A finished engine hand as one viewer gets it from the server. */
const record = (s: HandState, seat: number | null): HandRecordView => ({
  handNumber: 1,
  startedAt: 0,
  endedAt: 0,
  gameName: s.input.game.name,
  betting: s.input.betting,
  stakes: s.input.stakes,
  button: s.input.button,
  seats: s.seats.map((x) => ({ seat: x.seat, playerId: x.playerId, name: x.playerId, stack: x.startStack })),
  events: engine.visibleEvents(s, { seat, seeAll: false }),
});
const cardsAt = (h: HandRecordView, seat: number, viewer: string) =>
  replayFrames(h, viewer, fmt).at(-1)!.seats.get(seat)!.cards.map((c) => (c.shown || c.up ? c.card : '??'));

function passive(state: HandState, draw: (seat: number) => number[] = () => []) {
  for (let i = 0; i < 500 && state.phase !== 'complete'; i++) {
    if (state.phase === 'drawing') {
      engine.draw(state, state.toAct!, draw(state.toAct!));
      continue;
    }
    const seat = state.toAct!;
    const legal = engine.legalActions(state, seat)!;
    engine.act(state, seat, legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' });
  }
}

describe('replayFrames', () => {
  it('ends on the engine stacks and an empty pot', () => {
    const s = start({ stacks: [100, 100, 100] });
    passive(s);
    const last = replayFrames(record(s, 0), 'p0', fmt).at(-1)!;
    expect(last.done).toBe(true);
    expect(last.pot).toBe(0);
    for (const x of s.seats) expect(last.seats.get(x.seat)!.stack).toBe(x.stack);
  });

  it('gives the second run of a run-it-twice hand the shared cards', () => {
    const s = start({ stacks: [100, 100], options: { runItTwice: 'always' } });
    engine.act(s, s.toAct!, { type: 'call' });
    engine.act(s, s.toAct!, { type: 'check' });
    engine.act(s, s.toAct!, { type: 'bet', to: 98 });
    engine.act(s, s.toAct!, { type: 'call' });
    expect(s.phase).toBe('complete');
    const boards = replayFrames(record(s, 0), 'p0', fmt).at(-1)!.boards;
    expect(boards.map((run) => run[0])).toEqual(s.runs!.map((run) => run[0]));
  });

  it('shows the cards an opponent kept after drawing', () => {
    const s = start({ game: 'td27', stacks: [100, 100, 100] });
    passive(s, () => [0, 1]);
    const h = record(s, 0);
    let opponents = 0;
    for (const x of s.seats.filter((x) => x.seat !== 0)) {
      const shown = cardsAt(h, x.seat, 'p0');
      if (shown.includes('??')) continue; // mucked
      expect(shown).toEqual(x.cards.map((c) => c.card));
      opponents++;
    }
    expect(opponents).toBeGreaterThan(0);
    expect(cardsAt(h, 0, 'p0')).toEqual(s.seats[0].cards.map((c) => c.card));
  });
});

describe('playerStats and finalStacks', () => {
  it('counts calls and raises on the first round only', () => {
    const s = start({ stacks: [100, 100, 100] });
    const first = s.toAct!;
    engine.act(s, first, { type: 'raise', to: 6 });
    passive(s);
    const rows = new Map(playerStats([record(s, null)]).map((r) => [r.playerId, r]));
    expect(rows.get(`p${first}`)).toMatchObject({ hands: 1, counted: 1, vpip: 1, pfr: 1 });
    const net = finalStacks(record(s, null))!;
    for (const x of s.seats) expect(net[x.seat]).toBe(x.stack);
  });

  it('adds transfers after the hand ends', () => {
    const h = record(Object.assign(start({ stacks: [100, 100] }), {}), null);
    h.events = [
      { seq: 1, t: 'hand-end', stacks: { 0: 90, 1: 110 } },
      { seq: 2, t: 'transfer', kind: 'bounty-72', from: 1, to: 0, amount: 4 },
    ];
    expect(finalStacks(h)).toEqual({ 0: 94, 1: 106 });
  });
});

describe('isReplayable', () => {
  it('takes a real hand and refuses broken ones', () => {
    const s = start({ stacks: [100, 100] });
    passive(s);
    const h = record(s, 0);
    expect(isReplayable(h, fmt)).toBe(true);
    expect(isReplayable({ ...h, stakes: undefined }, fmt)).toBe(false);
    expect(isReplayable({ ...h, seats: [{ ...h.seats[0], seat: 1e9 }] }, fmt)).toBe(false);
    expect(isReplayable({ ...h, events: 'nope' }, fmt)).toBe(false);
    expect(isReplayable(null, fmt)).toBe(false);
  });
});
