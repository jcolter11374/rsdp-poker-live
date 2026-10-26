import { useEffect, useMemo, useState } from 'react';
import { RUNOUT_SETTLE_MS, RUNOUT_STEP_MS, runoutSteps } from '@rsdp/engine/core';
import type { TableView } from '@rsdp/engine/wire';

interface Reveal {
  handNumber: number;
  steps: number;
  /** The newest log line before the runout: later ones (who won) wait for the result. */
  logCut: number;
}

/**
 * All-in runouts arrive in one update, finished. This holds the table back
 * and deals them out a street at a time (board 1 before board 2), so each card
 * lands with its own sound, then shows the result. The server holds the next
 * hand for as long (runoutMs). Opening the table mid-runout shows it finished.
 */
export function useRunoutReveal(live: TableView | null): TableView | null {
  const [reveal, setReveal] = useState<Reveal | null>(null);
  /** Steps shown so far; the count past the last is the settle beat. */
  const [shown, setShown] = useState(0);
  // Checked while rendering (not in an effect), so the finished board never flashes up first.
  const [before, setBefore] = useState(live);
  if (live !== before) {
    setBefore(live);
    const hand = live?.hand;
    if (reveal && reveal.handNumber !== hand?.handNumber) setReveal(null);
    const ranIt = (h: TableView['hand']) => !!h?.events.some((e) => e.t === 'run-it');
    const steps = hand ? runoutSteps(hand.events).length : 0;
    if (hand && before?.hand?.handNumber === hand.handNumber && !ranIt(before.hand) && steps) {
      setReveal({ handNumber: hand.handNumber, steps, logCut: before.log.at(-1)?.at ?? 0 });
      setShown(0);
    }
  }

  useEffect(() => {
    if (!reveal) return;
    if (shown > reveal.steps) return setReveal(null);
    const wait = shown === reveal.steps ? RUNOUT_SETTLE_MS : RUNOUT_STEP_MS;
    const t = setTimeout(() => setShown((n) => n + 1), wait);
    return () => clearTimeout(t);
  }, [reveal, shown]);

  return useMemo(() => (live && reveal && live.hand?.handNumber === reveal.handNumber ? holdBack(live, reveal, shown) : live), [live, reveal, shown]);
}

/** The table as it was with only the first `shown` runout steps dealt. */
export function holdBack(view: TableView, reveal: Pick<Reveal, 'logCut'>, shown: number): TableView {
  const hand = view.hand!;
  const steps = runoutSteps(hand.events);
  const hidden = new Set(steps.slice(shown).flat().map((e) => e.seq));
  const runsStarted = new Set(steps.slice(0, shown).flat().map((e) => e.run));
  const boards = hand.boards.map((run, r) =>
    run.map((cards, b) => {
      // A second run stays off the felt until its first card, so it reads as a new board.
      if (r > 0 && !runsStarted.has(r)) return [];
      const owed = steps
        .slice(shown)
        .flat()
        .filter((e) => e.run === r && e.board === b)
        .reduce((n, e) => n + e.cards.length, 0);
      return cards.slice(0, cards.length - owed);
    }),
  );
  const runIt = hand.events.find((e) => e.t === 'run-it')!.seq;
  const events = hand.events.filter((e) => e.seq <= runIt || (e.t === 'board' && !hidden.has(e.seq)));
  const won = hand.awards.reduce((s, a) => s + a.amount, 0);
  const pots = hand.pots.length ? hand.pots : [{ amount: won, eligible: [] }];
  return {
    ...view,
    hand: { ...hand, phase: 'betting', showdown: false, awards: [], boards, events, pots, potTotal: Math.max(hand.potTotal, won) },
    seats: view.seats.map((s) => s && { ...s, stack: s.stack - s.won, won: 0, handName: null }),
    log: view.log.filter((l) => l.at <= reveal.logCut),
    history: view.history.filter((h) => h.handNumber !== hand.handNumber),
    canShow: [],
    nextHandAt: null,
    rabbit: { available: false, cards: null },
  };
}
