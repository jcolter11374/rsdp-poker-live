import { useState } from 'react';
import type { BettingKind } from '@rsdp/engine/core';
import type { SettingsPatch } from '@rsdp/engine/settings';
import { getVariant, VARIANT_LIST } from '@rsdp/engine/variants';
import { call, saveName, savedName } from './socket';
import { BETTING_NAME } from './format';
import { InstallApp } from './pwa';
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
  const spec = getVariant(gameId);
  const stud = spec.family === 'stud';

  const pickGame = (id: string) => {
    setGameId(id);
    setBetting(getVariant(id).defaultBetting);
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    saveName(name);
    const settings: SettingsPatch = {
      table: { name: `${name.trim() || 'Friends'}'s table`, maxSeats: Math.min(9, spec.maxPlayers) },
      game: { gameId, betting },
      // Stud has no blinds: the ante and bring-in start the pot. Limit bets are the big blind and twice it.
      stakes: {
        ...(stud ? { smallBlind: 0, bigBlind, ante, anteType: ante > 0 ? 'per-player' : 'none', bringIn: 0 } : { smallBlind, bigBlind }),
        ...(betting === 'fixed-limit' ? { smallBet: bigBlind, bigBet: bigBlind * 2 } : {}),
      },
      timing: { decisionSeconds: turnSeconds },
    };
    call<{ tableId: string }>('table:create', { settings })
      .then((res) => onCreated(res.tableId))
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <main className="home">
      <h1 className="logo">
        RSDP Poker <span>Live!</span>
      </h1>
      <p className="tagline">Start a table, send the link, and play with friends. No sign-up.</p>
      <TournamentList />
      <form className="card-panel" onSubmit={create}>
        <label>
          Your name
          <input value={name} maxLength={20} required onChange={(e) => setName(e.target.value)} />
        </label>
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
        {error && <p className="error">{error}</p>}
        <button className="primary big" disabled={busy}>
          Create table
        </button>
        <p className="muted">Everything else (run it twice, straddles, rebuys, game rotation) is in Table settings once you're in.</p>
      </form>
      <p className="tagline">
        Or <a href="/tn/new">host a tournament</a>: schedule it and it starts on its own.
      </p>
      <p className="tagline">
        New to Stud, Razz, Triple Draw or Badugi? <a href="/rules">Learn the games</a>.
      </p>
      <InstallApp />
    </main>
  );
}
