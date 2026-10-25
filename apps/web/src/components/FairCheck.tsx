import { useMemo } from 'react';
import { verifyHand, type CardEvent } from '@rsdp/engine';
import type { HandRecordView } from '@rsdp/engine/wire';
import { visibleEvents, type HandState } from '@rsdp/engine/core';
import { liveRecordFor, mySeedFor, seedProblem } from '../fair';
import { suitSymbol } from './PlayingCard';

const cardText = (c: string) => `${c[0] === 'T' ? '10' : c[0]}${suitSymbol(c[1])}`;
const when = (t: number) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** "Check this hand": the hand's fairness record, and once it is revealed, the hand dealt again right here in the browser. */
export function FairCheck({ hand, myId }: { hand: HandRecordView; myId: string | null }) {
  const fair = hand.fair;
  const report = useMemo(() => {
    if (!fair) return null;
    const seat = hand.seats.find((s) => s.playerId === myId)?.seat;
    const live = liveRecordFor(fair.commit);
    // My own records from the table: the seed I sent, and everything I saw while the hand was played.
    const extra: { label: string; ok: boolean; detail: string }[] = [];
    const problem = myId ? seedProblem(fair.commit, fair.clientSeeds, myId, seat !== undefined, live?.at ?? null) : null;
    const mine = mySeedFor(fair.commit);
    if (problem || (mine && seat !== undefined)) extra.push({ label: 'The seed under your name is the one your browser sent', ok: !problem, detail: problem ?? mine! });
    const missing = hand.seats.filter((s) => !fair.clientSeeds.some((c) => c.playerId === s.playerId)).map((s) => s.name);
    if (!fair.serverSeed || !fair.events) return { check: null, extra, missing };

    const proof = { commit: fair.commit, serverSeed: fair.serverSeed, clientSeeds: fair.clientSeeds.map((c) => c.seed), handSeed: fair.handSeed, button: hand.button, seats: hand.seats.map((s) => s.seat), events: fair.events as CardEvent[] };
    const check = verifyHand(proof);
    // The full record must be the one this hand's history shows.
    const asSeen = visibleEvents({ events: fair.events } as HandState, { seat: seat ?? null, seeAll: false });
    const same = JSON.stringify(asSeen) === JSON.stringify(hand.events);
    extra.push({ label: 'The full record matches this hand\u2019s history', ok: same, detail: same ? `${fair.events.length} events` : 'the revealed events differ from the hand history' });
    if (live) {
      const dealt = new Map<number, Set<string>>();
      const board = new Set<string>();
      for (const e of fair.events) {
        if (e.t === 'deal') e.cards.forEach((c) => (dealt.get(e.seat) ?? dealt.set(e.seat, new Set()).get(e.seat)!).add(c.card));
        if (e.t === 'draw') e.cards.forEach((c) => (dealt.get(e.seat) ?? dealt.set(e.seat, new Set()).get(e.seat)!).add(c));
        if (e.t === 'board') e.cards.forEach((c) => board.add(c));
      }
      const wrong: string[] = [];
      if (live.button !== hand.button) wrong.push(`the button was on seat ${live.button + 1}, not ${hand.button + 1}`);
      if ([...live.seats].sort().join() !== hand.seats.map((s) => s.seat).sort().join()) wrong.push('different seats were dealt in');
      for (const c of live.board) if (!board.has(c)) wrong.push(`${c} was on the board`);
      for (const [s, cards] of Object.entries(live.cards)) for (const c of cards) if (!dealt.get(+s)?.has(c)) wrong.push(`seat ${+s + 1} had ${c}`);
      extra.push({ label: 'It matches what you saw at the table', ok: !wrong.length, detail: wrong.length ? `the record disagrees: ${wrong.join('; ')}` : 'button, seats, board and every card you saw' });
    }
    return { check, extra, missing, proof };
  }, [fair, hand, myId]);
  if (!fair || !report) return <p className="muted">This hand can&rsquo;t be checked here: it was dealt before hands could be checked, or it was shared as a link.</p>;
  const { check, extra } = report;
  const checks = [...(check?.checks ?? []), ...extra];
  const ok = !!check?.ok && extra.every((c) => c.ok);

  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report.proof, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `hand-${hand.handNumber}-proof.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="fair-check">
      {!check ? (
        <p>
          🔒 <b>Sealed.</b> The deck was locked in before the deal. It can be checked{' '}
          {fair.revealsAt ? <>when the host stops the game, or {when(fair.revealsAt)}</> : 'once the host stops the game'}, so folded hands stay private while you play.
        </p>
      ) : ok ? (
        <p className="up">
          ✓ <b>This hand checks out.</b> It was dealt again from the seeds and all {check.matched} cards match, from a deck no single person could choose.
        </p>
      ) : (
        <p className="down">
          ✗ <b>This hand does not check out.</b> Tell the table and keep the proof file.
        </p>
      )}
      {checks.length > 0 && (
        <ul className="fair-list">
          {checks.map((c) => (
            <li key={c.label} className={c.ok ? 'up' : 'down'}>
              {c.ok ? '✓' : '✗'} {c.label}
              <div className="muted fair-detail">{c.detail}</div>
            </li>
          ))}
        </ul>
      )}
      <dl className="fair-facts">
        <dt>Commitment (shown before the deal)</dt>
        <dd>{fair.commit}</dd>
        <dt>Players&rsquo; seeds</dt>
        <dd>
          {fair.clientSeeds.length ? fair.clientSeeds.map((c) => `${c.name}: ${c.seed}`).join(', ') : 'none'}
          {report.missing.length > 0 && <div className="muted">No seed from {report.missing.join(', ')}.</div>}
        </dd>
        {fair.serverSeed && (
          <>
            <dt>Server seed</dt>
            <dd>{fair.serverSeed}</dd>
          </>
        )}
      </dl>
      {check?.deck && (
        <details>
          <summary>Whole deck, top card first</summary>
          <p className="fair-deck">{check.deck.map((c, i) => `${i + 1}. ${cardText(c)}`).join('  ')}</p>
        </details>
      )}
      {check && (
        <p className="muted">
          Check it yourself: <code>printf %s {fair.serverSeed} | sha256sum</code> gives the commitment. <button onClick={download}>Download proof</button> and run <code>node scripts/verify-hand.mjs</code> on it. See docs/FAIRNESS.md.
        </p>
      )}
    </div>
  );
}
