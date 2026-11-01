import { useEffect, useMemo, useState } from 'react';
import { tableRef, verifyHand, type CardEvent } from '@rsdp/engine';
import { digestOf, handInRecord, tableHand, type HandEntries } from '../audit';
import type { HandRecordView } from '@rsdp/engine/wire';
import { visibleEvents, type HandState } from '@rsdp/engine/core';
import { liveRecordFor, mySeedFor, seedListProblem, seedProblem, shownAs } from '../fair';
import { suitSymbol } from './PlayingCard';

const cardText = (c: string) => `${c[0] === 'T' ? '10' : c[0]}${suitSymbol(c[1])}`;
const when = (t: number) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** "Check this hand": the hand's fairness record, and once it is revealed, the hand dealt again right here in the browser. */
export function FairCheck({ hand, myId, tableId }: { hand: HandRecordView; myId: string | null; tableId?: string }) {
  const fair = hand.fair;
  // Changes when a card shown after the hand ends is added, which is recorded again.
  const digest = useMemo(() => digestOf(hand), [hand]);
  // The public record of this hand, to check it against once it is revealed.
  const [record, setRecord] = useState<HandEntries | 'failed' | null>(null);
  useEffect(() => {
    if (!tableId || !digest) return;
    let live = true;
    tableHand(tableId, hand.handNumber).then(
      (r) => live && setRecord(r),
      () => live && setRecord('failed'),
    );
    return () => {
      live = false;
    };
  }, [tableId, digest, hand.handNumber]);
  const report = useMemo(() => {
    if (!fair) return null;
    const seat = hand.seats.find((s) => s.playerId === myId)?.seat;
    const live = liveRecordFor(fair.commit);
    // My own records from the table: the seed I sent, and everything I saw while the hand was played.
    const extra: { label: string; ok: boolean; detail: string }[] = [];
    const problem = myId ? seedProblem(fair.commit, fair.clientSeeds, myId, seat !== undefined, live?.at ?? null) : null;
    const mine = mySeedFor(fair.commit);
    if (problem || (mine && seat !== undefined)) extra.push({ label: 'Your browser saw nothing wrong with the seeds or commitments', ok: !problem, detail: problem ?? `your seed ${mine!}` });
    // The record must be the hand this browser watched being dealt, under the commitment it was shown with.
    const shown = tableId ? shownAs(tableId, hand.handNumber) : null;
    if (shown) {
      const same = shown === fair.commit;
      extra.push({ label: 'It was dealt under the commitment shown at the table', ok: same, detail: same ? `${fair.commit.slice(0, 12)}…` : `the table showed hand #${hand.handNumber} under ${shown === 'none' ? 'no commitment' : `${shown.slice(0, 12)}…`}, but its record says ${fair.commit.slice(0, 12)}… (an honest server only does that if it crashed before saving that deal and dealt that hand number again)` });
    }
    // Every seed listed must be its own person's, someone dealt in: an extra one, even a copy, changes the deck unchecked.
    const listProblem = seedListProblem(fair.clientSeeds, { bots: hand.seats.filter((s) => s.bot).map((s) => s.playerId), dealt: hand.seats.map((s) => s.playerId) });
    if (fair.clientSeeds.length) extra.push({ label: 'Each seed is from a different person who was dealt in', ok: !listProblem, detail: listProblem ?? `${fair.clientSeeds.length} ${fair.clientSeeds.length === 1 ? 'seed' : 'seeds'}, none from a bot` });
    const missing = hand.seats.filter((s) => !fair.clientSeeds.some((c) => c.playerId === s.playerId)).map((s) => s.name);
    if (!fair.serverSeed || !fair.events) return { check: null, extra, missing };

    const proof = {
      commit: fair.commit,
      serverSeed: fair.serverSeed,
      clientSeeds: fair.clientSeeds.map((c) => c.seed),
      handSeed: fair.handSeed,
      button: hand.button,
      seats: hand.seats.map((s) => s.seat),
      events: fair.events as CardEvent[],
      // For scripts/verify-audit.mjs: what the public record's fingerprint of this hand covers.
      ...(tableId ? { record: { handId: fair.handId, table: tableRef(tableId), handNumber: hand.handNumber, seats: hand.seats.map((s) => ({ seat: s.seat, playerId: s.playerId, stack: s.stack })) } } : {}),
    };
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
    // Left out when the hand isn't from a table here, while it is looked up, or when the record can't be reached.
    if (tableId && record && record !== 'failed') {
      const inRecord = handInRecord(hand, record);
      if (inRecord.ok !== null) extra.push({ label: 'It is in the public record, unchanged', ok: inRecord.ok, detail: inRecord.detail });
    }
    return { check, extra, missing, proof };
  }, [fair, hand, myId, tableId, record]);
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
          {fair.revealsAt ? <>half an hour after the host stops the game, or {when(fair.revealsAt)} at the latest</> : 'half an hour after the host stops the game'}, so folded hands stay private while you play.
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
