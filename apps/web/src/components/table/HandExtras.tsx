import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HandRecordView, TableView } from '@rsdp/engine/wire';
import { nitSchema } from '@rsdp/engine/modifiers';
import { chipFormat } from '../../format';
import { nitStatus } from '../../nit';
import { usePrefs } from '../../prefs';
import { call } from '../../socket';
import { PlayingCard } from '../PlayingCard';
import { Replayer } from '../Replayer';
import { Modal } from '../SeatDialog';
import './extras.css';

/**
 * Hand aids under the action bar: rabbit hunting after a hand that ended
 * before all the cards were out, the Nit game opt-in and round, the house
 * fee total, and after a hand against bots only, why the bots played as
 * they did. (The time bank button is on the action bar.)
 */
export function HandExtras({ view }: { view: TableView }) {
  const [error, setError] = useState('');
  const run = (p: Promise<unknown>) => p.then(() => setError('')).catch((e: Error) => setError(e.message));
  const prefs = usePrefs();
  // The hand whose reasons are open in the replayer. It stays open when the next hand is dealt.
  const [whyHand, setWhyHand] = useState<HandRecordView | null>(null);
  const [whyBusy, setWhyBusy] = useState(false);
  // A hand the server has no reasons for.
  const [noWhy, setNoWhy] = useState<number | null>(null);
  const me = view.me.seat !== null ? view.seats[view.me.seat] : null;
  const rabbit = view.rabbit ?? { available: false, cards: null };
  const nitOn = view.mode === 'cash' && !!me && nitSchema.get(view.settings).enabled;
  const showRake = view.rakeTotal !== null && view.rakeTotal !== undefined;
  const fmt = chipFormat(view.settings.stakes.centsMode);
  // The hand to offer the bots' reasons for: this one once it is over, and then the one before all through the next
  // hand, so the button never goes at the deal (when a tap meant for it would land on the next hand's buttons).
  const ended = view.hand?.phase === 'complete' && view.tips ? view.hand.handNumber : null;
  const [lastWhy, setLastWhy] = useState<number | null>(null);
  useEffect(() => {
    if (ended !== null) setLastWhy(ended);
  }, [ended]);
  const previous = view.history.at(-1)?.handNumber;
  const askWhy = !prefs.botReasons ? null : (ended ?? (lastWhy !== null && lastWhy === previous && view.hand?.handNumber !== lastWhy ? lastWhy : null));
  const showWhy = (handNumber: number) => {
    setWhyBusy(true);
    call<{ hand: HandRecordView }>('table:history', { handNumber })
      .then(({ hand }) => {
        setError('');
        if (hand.botNotes?.length) setWhyHand(hand);
        else setNoWhy(handNumber);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setWhyBusy(false));
  };
  // On the page's body, so it never adds to the area under the table.
  const replayer =
    whyHand &&
    createPortal(
      <Replayer
        hands={[whyHand]}
        start={0}
        why
        tableId={view.id}
        tableName={view.name}
        seatCount={view.seats.length}
        myId={view.me.playerId}
        felt={view.settings.table.felt}
        fmt={fmt}
        onClose={() => setWhyHand(null)}
      />,
      document.body,
    );
  const extras = rabbit.available || nitOn || !!view.nit || showRake || askWhy !== null;

  // The replayer comes first and outside the row, so it stays mounted (where it is in the hand, Why on or off) when the
  // row comes or goes.
  return (
    <>
      {replayer}
      {extras && (
        <div className="hand-extras">
          {rabbit.available && !rabbit.cards && (
            <button title="See the cards that would have come. Only you see them." onClick={() => run(call('hand:rabbit'))}>
              🐇 Rabbit hunt
            </button>
          )}
          {rabbit.cards && (
            <div className="rabbit-cards">
              <span className="muted">Would have come:</span>
              {rabbit.cards.map((board, b) => (
                <span className="cards" key={b}>
                  {rabbit.cards!.length > 1 && <span className="muted">Board {b + 1}</span>}
                  {board.map((c) => (
                    <PlayingCard key={c} card={c} small />
                  ))}
                </span>
              ))}
            </div>
          )}
          {(nitOn || view.nit) && <NitRow view={view} me={me} fmt={fmt} canTick={nitOn} onTick={(v) => run(call('seat:prefs', { nitGame: v }))} />}
          {showRake && <span className="muted">House fees: {fmt(view.rakeTotal!)}</span>}
          {askWhy !== null &&
            (noWhy === askWhy ? (
              <span className="muted">No reasons for this hand.</span>
            ) : (
              <button
                className="why-bots"
                disabled={whyBusy}
                onClick={() => showWhy(askWhy)}
                title={askWhy === ended ? undefined : `Hand #${askWhy}, the hand before this one`}
              >
                {askWhy === ended ? 'Why did the bots play that way?' : 'Why did the bots play last hand?'}
              </button>
            ))}
          {error && <span className="error">{error}</span>}
        </div>
      )}
    </>
  );
}

function NitRow(props: { view: TableView; me: TableView['seats'][number]; fmt: (n: number) => string; canTick: boolean; onTick: (v: boolean) => void }) {
  const { view, me, fmt, canTick } = props;
  const [help, setHelp] = useState(false);
  const nit = nitStatus(view, me, fmt);
  const cfg = nitSchema.get(view.settings);
  const prize = fmt(view.nit?.prize ?? cfg.prizeBigBlinds * view.settings.stakes.bigBlind);
  return (
    <div className="nit-row">
      <div className="nit-line">
        {canTick && (
          <label className="toggle" title="Ticking or unticking only changes the next round, never the one being played">
            <input type="checkbox" checked={me!.nitOptIn} onChange={(e) => props.onTick(e.target.checked)} />
            {nit.label}
          </label>
        )}
        <button className="nit-help-button" aria-label="How the Nit game works" title="How the Nit game works" onClick={() => setHelp(true)}>
          ?
        </button>
        <span className="muted nit-status">{nit.status}</span>
      </div>
      {nit.locked && canTick && (
        <span className="hint">Locked in until this round ends. {me!.nitOptIn ? 'Untick to skip the next one.' : "You'll skip the next one."}</span>
      )}
      {help && (
        <Modal title="The Nit game" onClose={() => setHelp(false)}>
          <ol className="nit-help">
            <li>
              Tick the box to join. Once {cfg.minPlayers} ticked players are dealt into a hand, a round starts and everyone in it is on the nit (the NIT tag on
              their seat).
            </li>
            <li>Win a pot all by yourself to get off the nit. A chop, a split hi-lo pot or a run-it-twice split doesn't count.</li>
            <li>When only one player is still on the nit, they pay {prize} to each of the others and the round ends.</li>
            <li>
              Once a round starts you're in it until it ends. Unticking only keeps you out of the next round. Leaving the table while you're on the nit pays
              everyone straight away.
            </li>
            <li>The host sets the prize and how many players are needed. Turning the game off cancels a round, and nobody pays.</li>
          </ol>
          <a className="nit-help-more" href="/rules/nit-game" target="_blank" rel="noreferrer">
            Full guide with examples
          </a>
          <div className="row">
            <button className="primary" onClick={() => setHelp(false)}>
              Got it
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
