import { useState } from 'react';
import type { TableView } from '@rsdp/engine/wire';
import { nitSchema } from '@rsdp/engine/modifiers';
import { chipFormat } from '../../format';
import { nitStatus } from '../../nit';
import { call } from '../../socket';
import { PlayingCard } from '../PlayingCard';
import { Modal } from '../SeatDialog';
import './extras.css';

/**
 * Hand aids under the action bar: rabbit hunting after a hand that ended
 * before all the cards were out, the Nit game opt-in and round, and the
 * house fee total. (The time bank button is on the action bar.)
 */
export function HandExtras({ view }: { view: TableView }) {
  const [error, setError] = useState('');
  const run = (p: Promise<unknown>) => p.then(() => setError('')).catch((e: Error) => setError(e.message));
  const me = view.me.seat !== null ? view.seats[view.me.seat] : null;
  const rabbit = view.rabbit ?? { available: false, cards: null };
  const nitOn = view.mode === 'cash' && !!me && nitSchema.get(view.settings).enabled;
  const showRake = view.rakeTotal !== null && view.rakeTotal !== undefined;
  if (!rabbit.available && !nitOn && !view.nit && !showRake) return null;
  const fmt = chipFormat(view.settings.stakes.centsMode);

  return (
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
      {error && <span className="error">{error}</span>}
    </div>
  );
}

function NitRow(props: {
  view: TableView;
  me: TableView['seats'][number];
  fmt: (n: number) => string;
  canTick: boolean;
  onTick: (v: boolean) => void;
}) {
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
      {nit.locked && canTick && <span className="hint">Locked in until this round ends. {me!.nitOptIn ? 'Untick to skip the next one.' : "You'll skip the next one."}</span>}
      {help && (
        <Modal title="The Nit game" onClose={() => setHelp(false)}>
          <ol className="nit-help">
            <li>Tick the box to join. Once {cfg.minPlayers} ticked players are dealt into a hand, a round starts and everyone in it is on the nit (the NIT tag on their seat).</li>
            <li>Win a pot all by yourself to get off the nit. A chop, a split hi-lo pot or a run-it-twice split doesn't count.</li>
            <li>When only one player is still on the nit, they pay {prize} to each of the others and the round ends.</li>
            <li>Once a round starts you're in it until it ends. Unticking only keeps you out of the next round. Leaving the table while you're on the nit pays everyone straight away.</li>
            <li>The host sets the prize and how many players are needed. Turning the game off cancels a round, and nobody pays.</li>
          </ol>
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
