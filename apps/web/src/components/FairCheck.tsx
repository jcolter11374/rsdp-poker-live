import { useMemo } from 'react';
import { verifyHand } from '@rsdp/engine';
import type { HandRecordView } from '@rsdp/engine/wire';
import { mySeedFor } from '../fair';
import { suitSymbol } from './PlayingCard';

const cardText = (c: string) => `${c[0] === 'T' ? '10' : c[0]}${suitSymbol(c[1])}`;
const when = (t: number) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** "Check this hand": the hand's fairness record, and once it is revealed, the checks run right here in the browser. */
export function FairCheck({ hand }: { hand: HandRecordView }) {
  const fair = hand.fair;
  const check = useMemo(
    () =>
      fair?.serverSeed
        ? verifyHand({ handId: fair.handId, commit: fair.commit, serverSeed: fair.serverSeed, clientSeeds: fair.clientSeeds.map((c) => c.seed), handSeed: fair.handSeed, events: hand.events })
        : null,
    [fair, hand.events],
  );
  if (!fair) return <p className="muted">This hand was dealt before hands could be checked.</p>;
  const mine = mySeedFor(fair.commit);
  const mineUsed = !!mine && fair.clientSeeds.some((c) => c.seed === mine);

  const download = () => {
    const proof = { handId: fair.handId, commit: fair.commit, serverSeed: fair.serverSeed, clientSeeds: fair.clientSeeds.map((c) => c.seed), handSeed: fair.handSeed, events: hand.events };
    const url = URL.createObjectURL(new Blob([JSON.stringify(proof, null, 2)], { type: 'application/json' }));
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
      ) : check.ok ? (
        <p className="up">
          ✓ <b>This hand checks out.</b> {check.matched} cards you saw match the deck, which came from seeds no single person controlled.
        </p>
      ) : (
        <p className="down">
          ✗ <b>This hand does not check out.</b> Tell the host and keep the proof file.
        </p>
      )}
      {check && (
        <ul className="fair-list">
          {check.checks.map((c) => (
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
          {mine && <div className={mineUsed ? 'up' : 'muted'}>{mineUsed ? '✓ Your browser’s seed was mixed in.' : 'Your seed arrived after the deal, so it wasn’t used.'}</div>}
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
