import { useState } from 'react';
import type { BettingKind } from '@rsdp/engine/core';
import type { SettingsPatch } from '@rsdp/engine/settings';
import { getVariant, VARIANT_LIST } from '@rsdp/engine/variants';
import { BOT_LEVELS, type BotLevel } from '@rsdp/engine/wire';
import { call, saveName, savedName } from './socket';
import { BETTING_NAME } from './format';
import { BettingNudge } from './components/BettingNudge';
import { InstallApp } from './pwa';
import { presetSettings, usePresets } from './presets';
import { WhatsNewBanner } from './roadmap/WhatsNewPage';
import { SiteFooter, SiteHeader } from './components/SiteHeader';
import { TournamentList } from './tournament/TournamentList';
import { LEVEL_INFO, lastBotLevel, rememberBotLevel } from './components/table/BotLevels';

export function Home({ onCreated }: { onCreated: (tableId: string) => void }) {
  const [name, setName] = useState(savedName);
  const [gameId, setGameId] = useState('nlhe');
  const [betting, setBetting] = useState<BettingKind>('no-limit');
  const [smallBlind, setSmallBlind] = useState(1);
  const [bigBlind, setBigBlind] = useState(2);
  const [ante, setAnte] = useState(1);
  const [turnSeconds, setTurnSeconds] = useState(30);
  const [error, setError] = useState('');
  // Which card the error belongs to, so it shows next to the button that was pressed.
  const [errorFor, setErrorFor] = useState<'cash' | 'practice'>('cash');
  const [busy, setBusy] = useState(false);
  const [bots, setBots] = useState(3);
  const [botLevel, setBotLevel] = useState(lastBotLevel);
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
    setErrorFor(practice ? 'practice' : 'cash');
    setError('');
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
      document.getElementById('home-name')?.focus();
      return setError('Pick a name first (under Start a cash game)');
    }
    call<{ tableId: string }>('table:create', { settings, ...(practice ? { practice: { name, bots, level: botLevel } } : {}) })
      .then((res) => onCreated(res.tableId))
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="site-page home-page">
      <SiteHeader />
      <main>
        <section className="home-hero">
          <h1 className="logo">
            RSDP Poker <span>Live!</span>
          </h1>
          <p className="home-lede">Start a table, send the link, and play with friends. No sign-up needed.</p>
          <p className="home-about">
            Every game and option is free. <a href="/about">See what you can do here</a>.
          </p>
          <div className="home-choices">
            <a className="home-choice" href="#cash" onClick={focusCash}>
              <strong>Start a cash game</strong>
              <span>Pick a game and blinds, then share the link.</span>
            </a>
            <a className="home-choice" href="/tn/new">
              <strong>Host a tournament</strong>
              <span>Schedule it and it starts on its own.</span>
            </a>
          </div>
          <WhatsNewBanner />
        </section>
        <div className="home-grid">
          <form id="cash" className="card-panel home-cash" onSubmit={create}>
            <h2>Start a cash game</h2>
            <label>
              Your name
              <input id="home-name" value={name} maxLength={20} required placeholder="What friends call you" onChange={(e) => setName(e.target.value)} />
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
                <BettingNudge gameId={gameId} betting={betting} onSwitch={setBetting} />
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
            {error && errorFor === 'cash' && <p className="error">{error}</p>}
            <button className="primary big" disabled={busy}>
              Create table
            </button>
            <p className="muted">Everything else (run it twice, straddles, rebuys, game rotation) is in Table settings once you're in.</p>
          </form>
          <div className="home-side">
            <TournamentList />
            <section className="card-panel home-practice" aria-label="Practice">
              <h2>Practice first</h2>
              <p className="muted">New to a game? Play the game picked under Start a cash game against practice bots, with play chips. The cards are dealt straight away.</p>
              {error && errorFor === 'practice' && <p className="error">{error}</p>}
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
                <label>
                  Level
                  <select
                    value={botLevel}
                    onChange={(e) => {
                      setBotLevel(e.target.value as BotLevel);
                      rememberBotLevel(e.target.value as BotLevel);
                    }}
                  >
                    {BOT_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {LEVEL_INFO[level].label}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" disabled={busy} onClick={() => create(null, true)}>
                  Practice with bots
                </button>
              </div>
              <p className="hint">{LEVEL_INFO[botLevel].about}</p>
              <p className="muted">
                Stud, Razz, Triple Draw or Badugi? <a href="/rules">Learn the games</a>.
              </p>
            </section>
          </div>
        </div>
        <InstallApp />
      </main>
      <SiteFooter />
    </div>
  );
}

/** "Start a cash game" jumps to the form and puts you in the name box. */
function focusCash(e: React.MouseEvent) {
  e.preventDefault();
  const box = document.getElementById('home-name') as HTMLInputElement | null;
  box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  box?.focus({ preventScroll: true });
}
