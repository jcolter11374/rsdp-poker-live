import { useEffect, useSyncExternalStore } from 'react';
import type { SeatView, TableView } from '@rsdp/engine/wire';
import { equity, type Equity, type EquityInput } from '../../equity';

/*
 * Win percentages on each hand once everyone is all in and the cards are face
 * up, and after the hand, what they were at that moment. Worked out only from cards the viewer can already see, so it gives away
 * nothing; the replayer gets it too, since it draws the same table.
 */

/**
 * The run-out to work out for a view, or null when there's nothing to show.
 * While the cards are still coming it is the spot now; once a Hold'em or Omaha
 * hand is over it is the spot when the hands went face up, so an all-in that
 * ran out at once still shows who was ahead.
 */
export function equityInput(view: TableView): { key: string; input: EquityInput } | null {
  const hand = view.hand;
  if (!hand || hand.family === 'draw') return null;
  const done = hand.phase === 'complete';
  if (done ? hand.family !== 'flop' : hand.boards.length > 1) return null;
  const seats = view.seats.filter((s): s is SeatView => !!s && s.inHand);
  const live = seats.filter((s) => !s.folded);
  if (live.length < 2 || live.some((s) => !s.cards.length || s.cards.some((c) => c.card === '??'))) return null;
  const stud = hand.family === 'stud';
  // Stud's shared last card (eight players reaching seventh street) is too rare to count.
  if (stud && (hand.boards[0] ?? []).some((b) => b.length)) return null;
  let boards: string[][] = stud ? [] : hand.boards[0]?.length ? hand.boards[0] : [[]];
  if (done) {
    // The board as it stood at the first show that more cards came after: the all-in moment.
    const reveal = hand.events.findIndex((e, i) => e.t === 'show' && hand.events.slice(i).some((x) => x.t === 'board'));
    if (reveal < 0) return null;
    boards = [];
    for (const e of hand.events.slice(0, reveal)) if (e.t === 'board' && e.run === 0) boards[e.board] = [...(boards[e.board] ?? []), ...e.cards];
    const count = hand.boards[0]?.length || 1;
    boards = Array.from({ length: count }, (_, i) => boards[i] ?? []);
  }
  const input: EquityInput = {
    gameId: hand.gameId,
    hands: live.map((s) => ({ seat: s.seat, cards: s.cards.map((c) => c.card) })),
    boards,
    dead: seats.filter((s) => s.folded).flatMap((s) => s.cards.map((c) => c.card).filter((c) => c !== '??')),
  };
  return { key: JSON.stringify(input), input };
}

const results = new Map<string, Equity | null>();
const listeners = new Set<() => void>();
let worker: Worker | null | undefined;

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('../../equity.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ key: string; result: Equity | null }>) => {
      results.set(e.data.key, e.data.result);
      listeners.forEach((cb) => cb());
    };
  } catch {
    worker = null;
  }
  return worker;
}

function request(job: { key: string; input: EquityInput }) {
  if (results.has(job.key)) return;
  // Keep the cache small: a hand needs a handful of entries.
  if (results.size > 50) results.delete(results.keys().next().value!);
  results.set(job.key, null);
  const w = getWorker();
  if (w) w.postMessage(job);
  else {
    results.set(job.key, equity(job.input));
    listeners.forEach((cb) => cb());
  }
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** Each live seat's share of the pot right now, or null. */
export function useEquity(view: TableView): Equity | null {
  const job = equityInput(view);
  const key = job?.key ?? '';
  useEffect(() => {
    if (job) request(job);
  }, [key]);
  return useSyncExternalStore(subscribe, () => (key ? (results.get(key) ?? null) : null));
}

/** "54%" under a hand in an all-in run-out. */
export function EquityTag({ view, seat }: { view: TableView; seat: SeatView }) {
  const eq = useEquity(view);
  const share = eq?.[seat.seat];
  if (share === undefined) return null;
  const pct = share * 100;
  const text = pct > 0 && pct < 1 ? '<1%' : pct < 100 && pct > 99 ? '>99%' : `${Math.round(pct)}%`;
  const best = Math.max(...Object.values(eq!));
  return (
    <span className={`equity-tag ${share === best && share > 0 ? 'ahead' : ''}`} title={view.hand?.phase === 'complete' ? 'Chance to win when the hands went face up' : 'Chance to win the pot from here (ties and split pots count as the share won)'}>
      {text}
    </span>
  );
}
