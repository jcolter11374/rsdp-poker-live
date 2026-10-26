import { useState } from 'react';
import type { BettingKind } from '@rsdp/engine/core';
import { bettingAdvice } from '@rsdp/engine/variants';
import { BETTING_NAME } from '../format';

/**
 * A friendly "are you sure?" under a game and betting picker when the pairing is
 * unusual (No Limit Stud, say). It never blocks: the host can switch in one tap or
 * keep it. It shows only after the host changes the pairing, so a table already set
 * up that way isn't nagged each time settings open, and "Keep it" hides it until
 * the pairing changes again.
 */
export function BettingNudge({ gameId, betting, onSwitch }: { gameId: string; betting: BettingKind; onSwitch: (b: BettingKind) => void }) {
  const key = `${gameId}:${betting}`;
  const [quiet, setQuiet] = useState(key);
  const advice = bettingAdvice(gameId, betting);
  if (!advice || quiet === key) return null;
  return (
    <div className={`betting-nudge ${advice.level}`} role="status">
      <p>{advice.message}</p>
      <div className="betting-nudge-actions">
        <button type="button" className="primary" onClick={() => onSwitch(advice.suggest)}>
          Switch to {BETTING_NAME[advice.suggest]}
        </button>
        <button type="button" onClick={() => setQuiet(key)}>
          Keep it
        </button>
      </div>
    </div>
  );
}
