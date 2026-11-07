// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engine, RUNOUT_SETTLE_MS, runoutSteps, runoutWaits, type HandState } from '@rsdp/engine/core';
import type { HandRecordView, TableView } from '@rsdp/engine/wire';
import { start } from '../../../packages/engine/test/core/harness';
import { Table } from './components/Table';
import { frameView, replayFrames } from './replay';
import { useRunoutReveal } from './runout';

vi.mock('./socket', () => ({
  call: vi.fn(),
  socket: { on: () => {}, off: () => {}, emit: () => {}, connected: false },
  currentSession: () => null,
  onSession: () => () => {},
}));

const fmt = (n: number) => String(n);

/** Heads up, run once: check and call to the street with `boardCards` cards out, then all in and called. */
function allInWith(boardCards: number): HandState {
  const s = start({ stacks: [100, 100] });
  while (s.runs[0][0].length < boardCards) {
    const legal = engine.legalActions(s, s.toAct!)!;
    engine.act(s, s.toAct!, legal.canCheck ? { type: 'check' } : { type: 'call' });
  }
  engine.act(s, s.toAct!, { type: 'raise', to: engine.legalActions(s, s.toAct!)!.maxTo });
  engine.act(s, s.toAct!, { type: 'call' });
  expect(s.phase).toBe('complete');
  expect(s.runs).toHaveLength(1);
  return s;
}

/**
 * The table as seat 0 sees it just before the runout and when the hand is over: whole TableViews, made from the hand's
 * events the way the replayer makes them.
 */
function views(s: HandState): { before: TableView; done: TableView } {
  const hand: HandRecordView = {
    handNumber: 1,
    startedAt: 0,
    endedAt: 0,
    gameName: s.input.game.name,
    betting: s.input.betting,
    stakes: s.input.stakes,
    button: s.input.button,
    seats: s.seats.map((x) => ({ seat: x.seat, playerId: x.playerId, name: x.playerId, stack: x.startStack })),
    events: engine.visibleEvents(s, { seat: 0, seeAll: false }),
  };
  const frames = replayFrames(hand, 'p0', fmt);
  const runIt = hand.events.findIndex((e) => e.t === 'run-it');
  const view = (i: number) => frameView('Test', 2, hand, frames[i], 'p0');
  return { before: view(frames.filter((f) => f.upTo <= runIt).length - 1), done: view(frames.length - 1) };
}

/** The table page's way: the server's table goes through the runout reveal, then onto the table. */
function Shown({ live }: { live: TableView }) {
  const view = useRunoutReveal(live)!;
  return <Table view={view} skew={0} fmt={fmt} />;
}

/** How a card comes onto the board: dealt, carried down from the first run (run it twice), or turned over where it waited. */
const MOTION = ['deal-board', 'copy-board', 'turn-held'];

describe('a single all-in runout on the table (#412)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom has no layout: the table measures nothing and keeps its first guess at its size.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  for (const [street, cards] of [['before the flop', 0], ['on the flop', 3]] as const) {
    it(`keeps each board card's look from when it lands to the result, and turns over only the river, all in ${street}`, () => {
      const s = allInWith(cards);
      const { before, done } = views(s);
      const { container, rerender } = render(<Shown live={before} />);
      rerender(<Shown live={done} />);

      // Every board card the first time it was seen: its element and how it came onto the board.
      const first = new Map<string, { el: Element; motion: string[] }>();
      const look = () => {
        const seen = [...container.querySelectorAll('.board .board-row .playing-card:not(.back)')];
        for (const el of seen) {
          const card = el.getAttribute('aria-label')!;
          const motion = MOTION.filter((m) => el.classList.contains(m));
          const was = first.get(card);
          if (!was) first.set(card, { el, motion });
          else {
            // Same element, same animation: a card that changes either plays its animation again.
            expect(el, card).toBe(was.el);
            expect(motion, card).toEqual(was.motion);
          }
        }
        return seen.length;
      };

      // The board after each step: the cards out before the all in, then each street's.
      const out: number[] = [cards];
      for (const step of runoutSteps(done.hand!.events)) out.push(out.at(-1)! + step.flatMap((e) => (e.t === 'board' ? e.cards : [])).length);
      const waits = runoutWaits(done.hand!.events);
      expect(look()).toBe(cards);
      for (const [k, wait] of waits.entries()) {
        // Before the last card, a face-down card waits where it will turn over.
        expect(!!container.querySelector('.held-slot'), `step ${k}`).toBe(k === waits.length - 1);
        act(() => vi.advanceTimersByTime(wait));
        expect(look(), `step ${k}`).toBe(out[k + 1]);
      }
      expect(out.at(-1)).toBe(5);
      expect(container.querySelector('.held-slot')).toBeNull();
      act(() => vi.advanceTimersByTime(RUNOUT_SETTLE_MS));
      // The result, the hand as the server sent it, with the same cards on the board.
      expect(container.querySelector('.felt.showdown')).not.toBeNull();
      expect(look()).toBe(5);
      // Only the river waited face down, so only it turned over; every other card was dealt.
      const board = [...container.querySelectorAll('.board .board-row .playing-card')];
      expect(board.map((el) => MOTION.filter((m) => el.classList.contains(m)))).toEqual([...board.slice(1).map(() => ['deal-board']), ['turn-held']]);
    });
  }
});
