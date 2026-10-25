import type { BettingKind } from '@rsdp/engine/core';
import { bombPotSchema, bounty72Schema, doubleBoardSchema, type BombPotSettings, type Bounty72Settings, type DoubleBoardSettings } from '@rsdp/engine/modifiers';
import type { TableSettings } from '@rsdp/engine/settings';
import { VARIANT_LIST } from '@rsdp/engine/variants';
import { BETTING_NAME } from '../../format';
import { ChipsField, Field, NumberField, Toggle } from './fields';
import './settings.css';

const BETTINGS: BettingKind[] = ['no-limit', 'pot-limit', 'fixed-limit'];
/** Bomb pots skip the first betting round, so they need a flop game with blinds. */
const BOMB_GAMES = VARIANT_LIST.filter((v) => v.family === 'flop' && v.forcedBets === 'blinds');

export interface SideGamesProps {
  draft: TableSettings;
  cents: boolean;
  /** Edit one modifier section of the draft. */
  setModifier: (id: string, patch: object) => void;
}

/** Bomb pots, double board and the 7-2 bounty: cash games only, all free. */
export function SideGamesTab({ draft, cents, setModifier }: SideGamesProps) {
  const bomb = bombPotSchema.get(draft);
  const board = doubleBoardSchema.get(draft);
  const bounty = bounty72Schema.get(draft);
  const setBomb = (p: Partial<BombPotSettings>) => setModifier(bombPotSchema.id, p);
  const setBoard = (p: Partial<DoubleBoardSettings>) => setModifier(doubleBoardSchema.id, p);
  const setBounty = (p: Partial<Bounty72Settings>) => setModifier(bounty72Schema.id, p);

  return (
    <>
      <h4>Bomb pots</h4>
      <p className="hint">Everyone posts, the flop comes straight away and betting starts after it. The host can also call one for the next hand from Host controls.</p>
      <Toggle label="Deal bomb pots on their own" checked={bomb.enabled} onChange={(enabled) => setBomb({ enabled })} />
      <div className="row">
        <NumberField label="Chance each hand (%)" value={bomb.chancePercent} min={0} max={100} disabled={!bomb.enabled} onChange={(chancePercent) => setBomb({ chancePercent })} />
        <NumberField label="Or every (hands)" value={bomb.everyHands} min={0} max={1000} hint="0 = off" disabled={!bomb.enabled} onChange={(everyHands) => setBomb({ everyHands })} />
      </div>
      <div className="row">
        <NumberField label="Each player posts (big blinds)" value={bomb.bigBlinds} min={1} max={100} onChange={(bigBlinds) => setBomb({ bigBlinds })} />
        <Field label="Bomb pot game">
          <select
            value={bomb.gameId}
            onChange={(e) => {
              const v = BOMB_GAMES.find((g) => g.id === e.target.value);
              setBomb({ gameId: e.target.value, betting: v?.defaultBetting ?? bomb.betting });
            }}
          >
            <option value="">Same as the table</option>
            {BOMB_GAMES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>
        {bomb.gameId && (
          <Field label="Betting">
            <select value={bomb.betting} onChange={(e) => setBomb({ betting: e.target.value as BettingKind })}>
              {BETTINGS.map((b) => (
                <option key={b} value={b}>
                  {BETTING_NAME[b]}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <h4>Double board</h4>
      <Toggle label="Deal two boards" checked={board.enabled} onChange={(enabled) => setBoard({ enabled })} />
      <Field label="When" hint="Each pot is split between the best hand on each board. Skipped when the deck is too small for everyone.">
        <select value={board.when} disabled={!board.enabled} onChange={(e) => setBoard({ when: e.target.value as DoubleBoardSettings['when'] })}>
          <option value="bomb-pots">Bomb pots only</option>
          <option value="always">Every hand</option>
        </select>
      </Field>

      <h4>7-2 bounty</h4>
      <p className="hint">Win a pot holding 7-2 and show it: every other player dealt in pays you the bounty. Hold'em only.</p>
      <Toggle label="Play the 7-2 bounty" checked={bounty.enabled} onChange={(enabled) => setBounty({ enabled })} />
      <div className="row">
        <ChipsField label="Bounty per player" value={bounty.amount} cents={cents} disabled={!bounty.enabled} onChange={(amount) => setBounty({ amount: Math.max(1, amount) })} />
        <Field label="Which 7-2">
          <select value={bounty.suits} disabled={!bounty.enabled} onChange={(e) => setBounty({ suits: e.target.value as Bounty72Settings['suits'] })}>
            <option value="any">Any 7-2</option>
            <option value="offsuit">Offsuit only</option>
            <option value="suited">Suited only</option>
          </select>
        </Field>
      </div>
      <Toggle label="Show a winning 7-2 automatically" checked={bounty.autoShow} disabled={!bounty.enabled} onChange={(autoShow) => setBounty({ autoShow })} />
    </>
  );
}
