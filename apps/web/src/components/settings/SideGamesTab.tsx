import type { BettingKind } from '@rsdp/engine/core';
import {
  bombPotSchema,
  bounty72Schema,
  doubleBoardSchema,
  nitSchema,
  rakeSchema,
  type BombPotSettings,
  type Bounty72Settings,
  type DoubleBoardSettings,
  type NitSettings,
  type RakeSettings,
} from '@rsdp/engine/modifiers';
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

/** Bomb pots, double board, the 7-2 bounty, the Nit game and the house fee: cash games only, all free. */
export function SideGamesTab({ draft, cents, setModifier }: SideGamesProps) {
  const bomb = bombPotSchema.get(draft);
  const board = doubleBoardSchema.get(draft);
  const bounty = bounty72Schema.get(draft);
  const setBomb = (p: Partial<BombPotSettings>) => setModifier(bombPotSchema.id, p);
  const setBoard = (p: Partial<DoubleBoardSettings>) => setModifier(doubleBoardSchema.id, p);
  const setBounty = (p: Partial<Bounty72Settings>) => setModifier(bounty72Schema.id, p);
  const nit = nitSchema.get(draft);
  const setNit = (p: Partial<NitSettings>) => setModifier(nitSchema.id, p);
  const rake = rakeSchema.get(draft);
  const setRake = (p: Partial<RakeSettings>) => setModifier(rakeSchema.id, p);
  const percentField = (label: string, value: number, onChange: (v: number) => void, disabled: boolean) => (
    <Field label={label}>
      <input type="number" min={0} max={100} step={0.5} value={value} disabled={disabled} onChange={(e) => onChange(Math.round(+e.target.value * 100) / 100)} />
    </Field>
  );

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

      <h4>Nit game</h4>
      <p className="hint">
        Players opt in from their seat. Once enough are dealt in, a round starts: win a pot outright to get off the nit. The last player still on it pays the prize to each of the others. Leaving while on the nit pays straight away.
      </p>
      <Toggle label="Play the Nit game" checked={nit.enabled} onChange={(enabled) => setNit({ enabled })} />
      <div className="row">
        <NumberField label="Prize (big blinds, to each player)" value={nit.prizeBigBlinds} min={1} max={100} disabled={!nit.enabled} onChange={(prizeBigBlinds) => setNit({ prizeBigBlinds })} />
        <NumberField label="Players needed" value={nit.minPlayers} min={2} max={10} disabled={!nit.enabled} onChange={(minPlayers) => setNit({ minPlayers })} />
      </div>

      <h4>House fee (simulated rake)</h4>
      <p className="hint">A share of each pot goes to the house. Nothing is charged for real; the table keeps a running total.</p>
      <Toggle label="Take a house fee" checked={rake.enabled} onChange={(enabled) => setRake({ enabled })} />
      <div className="row">
        {percentField('Fee (% of each pot)', rake.percent, (percent) => setRake({ percent }), !rake.enabled)}
        <ChipsField label="Cap per pot" value={rake.cap} cents={cents} hint="0 = no cap" disabled={!rake.enabled} onChange={(cap) => setRake({ cap })} />
        <ChipsField label="Smallest pot with a fee" value={rake.minPot} cents={cents} hint="0 = any" disabled={!rake.enabled} onChange={(minPot) => setRake({ minPot })} />
      </div>
      <Toggle label="No flop, no fee" checked={rake.noFlopNoDrop} disabled={!rake.enabled} onChange={(noFlopNoDrop) => setRake({ noFlopNoDrop })} />
      <div className="row">
        <NumberField
          label="Short-handed rate at or below (players)"
          value={rake.shortHanded.players}
          min={0}
          max={10}
          hint="0 = off"
          disabled={!rake.enabled}
          onChange={(players) => setRake({ shortHanded: { ...rake.shortHanded, players } })}
        />
        {percentField('Short-handed fee (%)', rake.shortHanded.percent, (percent) => setRake({ shortHanded: { ...rake.shortHanded, percent } }), !rake.enabled || !rake.shortHanded.players)}
        <ChipsField
          label="Short-handed cap"
          value={rake.shortHanded.cap}
          cents={cents}
          hint="0 = no cap"
          disabled={!rake.enabled || !rake.shortHanded.players}
          onChange={(cap) => setRake({ shortHanded: { ...rake.shortHanded, cap } })}
        />
      </div>
      <Field label="Who sees the total">
        <select value={rake.visibleTo} disabled={!rake.enabled} onChange={(e) => setRake({ visibleTo: e.target.value as RakeSettings['visibleTo'] })}>
          <option value="host">Only the host</option>
          <option value="everyone">Everyone</option>
        </select>
      </Field>
    </>
  );
}
