import { useState } from 'react';
import type { BettingKind } from '@rsdp/engine/core';
import type { SettingsPatch } from '@rsdp/engine/settings';
import { getVariant, VARIANT_LIST } from '@rsdp/engine/variants';
import { call, saveName, savedName } from './socket';
import { BETTING_NAME } from './format';
import { InstallApp } from './pwa';
import { presetSettings, usePresets } from './presets';
import { WhatsNewBanner } from './roadmap/WhatsNewPage';
import { AccountLink } from './account/AccountPages';
import { TournamentList } from './tournament/TournamentList';

export function Home({ onCreated }: { onCreated: (tableId: string) => void }) {
  const [name, setName] = useState(savedName);
  const [gameId, setGameId] = useState('nlhe');
  const [betting, setBetting] = useState<BettingKind>('no-limit');
  const [smallBlind, setSmallBlind] = useState(1);
  const [bigBlind, setBigBlind] = useState(2);
  const [ante, setAnte] = useState(1);
  const [turnSeconds, setTurnSeconds] = useState(30);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bots, setBots] = useState(3);
  const presets = usePresets();
  const [presetName, setPresetName] = useState('');
  const preset = presets.find((p) => p.name === presetName) ?? null;
  const spec = getVariant(gameId);
  const stud = spec.family === 'stud';

  const pickGame = (id: string) => {
    setGameId(id);
    setBetting(getVariant(id).defaultBetting);
  };

  /** A table for friends, or with `practice` a table for you and some bots that deals at once. */
  const create = (e: React.FormEvent | null, practice = false) => {
    e?.preventDefault();
    setBusy(true);
    saveName(name);
    let fromPreset: SettingsPatch | null = null;
    try {
      fromPreset = preset && (presetSettings(preset) as SettingsPatch);
    } catch (err) {
      setBusy(false);
      return setError((err as Error).message);
    }
    const tableName = practice ? `${name.trim() || 'My'}'s practice table` : `${name.trim() || 'Friends'}'s table`;
    const quick: SettingsPatch = {
      table: { name: tableName, maxSeats: Math.min(9, spec.maxPlayers) },
      game: { gameId, betting },
      // Stud has no blinds: the ante and bring-in start the pot. Limit bets are the big blind and twice it.
      stakes: {
        ...(stud ? { smallBlind: 0, bigBlind, ante, anteType: ante > 0 ? 'per-player' : 'none', bringIn: 0 } : { smallBlind, bigBlind }),
        ...(betting === 'fixed-limit' ? { smallBet: bigBlind, bigBet: bigBlind * 2 } : {}),
      },
      timing: { decisionSeconds: turnSeconds },
    };
    const settings: SettingsPatch = fromPreset ? { ...fromPreset, table: { ...fromPreset.table, name: quick.table!.name, mode: 'cash' } } : quick;
    if (practice && !name.trim()) {
      setBusy(false);
      return setError('Pick a name first');
    }
    call<{ tableId: string }>('table:create', { settings, ...(practice ? { practice: { name, bots } } : {}) })
      .then((res) => onCreated(res.tableId))
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <main className="home">
      <AccountLink />
      <h1 className="logo">
        RSDP Poker <span>Live!</span>
      </h1>
      <p className="tagline">Start a table, send the link, and play with friends. No sign-up needed.</p>
      <WhatsNewBanner />
      <TournamentList />
      <form className="card-panel" onSubmit={create}>
        <label>
          Your name
          <input value={name} maxLength={20} required onChange={(e) => setName(e.target.value)} />
        </label>
        {presets.length > 0 && (
          <label>
            Start from
            <select value={presetName} onChange={(e) => setPresetName(e.target.value)}>
              <option value="">A quick setup (below)</option>
              {presets.map((p) => (
                <option key={p.name} value={p.name}>
                  Preset: {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!preset && (
          <>
            <div className="row">
              <label>
                Game
                <select value={gameId} onChange={(e) => pickGame(e.target.value)}>
                  {VARIANT_LIST.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Betting
                <select value={betting} onChange={(e) => setBetting(e.target.value as BettingKind)}>
                  {(['no-limit', 'pot-limit', 'fixed-limit'] as const).map((b) => (
                    <option key={b} value={b}>
                      {BETTING_NAME[b]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row">
              {stud ? (
                <label>
                  Ante
                  <input type="number" min={0} value={ante} onChange={(e) => setAnte(+e.target.value)} />
                </label>
              ) : (
                <label>
                  Small blind
                  <input type="number" min={0} value={smallBlind} onChange={(e) => setSmallBlind(+e.target.value)} />
                </label>
              )}
              <label>
                {stud ? 'Small bet' : 'Big blind'}
                <input type="number" min={1} value={bigBlind} onChange={(e) => setBigBlind(+e.target.value)} />
              </label>
            </div>
            <label>
              Seconds to act (0 for no clock)
              <input type="number" min={0} max={600} value={turnSeconds} onChange={(e) => setTurnSeconds(+e.target.value)} />
            </label>
            <p className="muted">{spec.rules}</p>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary big" disabled={busy}>
          Create table
        </button>
        <p className="muted">Everything else (run it twice, straddles, rebuys, game rotation) is in Table settings once you're in.</p>
        <div className="practice">
          <p className="muted">New to a game? Try it against practice bots first. They play the game above, with play chips, and the cards are dealt straight away.</p>
          <div className="row">
            <label>
              Bots
              <select value={bots} onChange={(e) => setBots(+e.target.value)}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" disabled={busy} onClick={() => create(null, true)}>
              Practice with bots
            </button>
          </div>
        </div>
      </form>
      <p className="tagline">
        Or <a href="/tn/new">host a tournament</a>: schedule it and it starts on its own.
      </p>
      <p className="tagline">
        New to Stud, Razz, Triple Draw or Badugi? <a href="/rules">Learn the games</a>.
      </p>
      <p className="tagline">
        See <a href="/whats-new">what's new</a> and what's coming on the <a href="/roadmap">roadmap</a>.{' '}
        Wondering if the deal is fair? <a href="/fairness">See how we prove it</a>.
      </p>
      <InstallApp />
    </main>
  );
}
