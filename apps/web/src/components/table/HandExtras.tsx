import { useState } from 'react';
import type { TableView } from '@rsdp/engine/wire';
import { nitSchema } from '@rsdp/engine/modifiers';
import { chipFormat } from '../../format';
import { call } from '../../socket';
import { PlayingCard } from '../PlayingCard';
import './extras.css';

/**
 * Hand aids under the action bar: the time bank button on your turn, and
 * rabbit hunting after a hand that ended before all the cards were out,
 * the Nit game opt-in and round, and the house fee total.
 */
export function HandExtras({ view }: { view: TableView }) {
  const [error, setError] = useState('');
  const run = (p: Promise<unknown>) => p.then(() => setError('')).catch((e: Error) => setError(e.message));
  const me = view.me.seat !== null ? view.seats[view.me.seat] : null;
  const myTurn = !!me && view.turn?.seat === me.seat && !!view.hand && view.hand.phase !== 'complete';
  const canBank = myTurn && !view.turn!.usingBank && view.turn!.deadline !== null && me!.timeBank > 0;
  const rabbit = view.rabbit ?? { available: false, cards: null };
  const nitOn = view.mode === 'cash' && !!me && nitSchema.get(view.settings).enabled;
  const showRake = view.rakeTotal !== null && view.rakeTotal !== undefined;
  if (!canBank && !rabbit.available && !nitOn && !view.nit && !showRake) return null;
  const fmt = chipFormat(view.settings.stakes.centsMode);

  return (
    <div className="hand-extras">
      {canBank && <button onClick={() => run(call('hand:timeBank'))}>Time bank +{me!.timeBank}s</button>}
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
      {nitOn && (
        <label className="toggle">
          <input type="checkbox" checked={me!.nitOptIn} onChange={(e) => run(call('seat:prefs', { nitGame: e.target.checked }))} />
          Play the Nit game
        </label>
      )}
      {view.nit && (
        <span className="muted">
          Nit game: {view.nit.holders} of {view.nit.participants} still holding · the last pays {fmt(view.nit.prize)} each
        </span>
      )}
      {showRake && <span className="muted">House fees: {fmt(view.rakeTotal!)}</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}
