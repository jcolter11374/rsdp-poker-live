import { useState } from 'react';
import { BOT_LEVELS, type BotLevel, type SeatView, type TableView } from '@rsdp/engine/wire';
import { call } from '../../socket';

export const LEVEL_INFO: Record<BotLevel, { label: string; about: string }> = {
  easy: { label: 'Easy', about: 'Calls a lot, bets small and never bluffs. Good for learning a new game.' },
  normal: { label: 'Normal', about: 'Plays the odds: steady, and rarely bluffs.' },
  hard: { label: 'Hard', about: 'Reads what your bets mean, learns how you play, uses position and bluffs.' },
};

const KEY = 'rsdp.botLevel';

/** The level picked last time, for the next bot. */
export function lastBotLevel(): BotLevel {
  try {
    const level = localStorage.getItem(KEY);
    return BOT_LEVELS.includes(level as BotLevel) ? (level as BotLevel) : 'normal';
  } catch {
    return 'normal';
  }
}

export function rememberBotLevel(level: BotLevel) {
  try {
    localStorage.setItem(KEY, level);
  } catch {
    // Private mode: it just isn't remembered.
  }
}

/** "Beth's hard bot"; Normal bots are just "Beth's bot". */
export function botOwnerLabel(bot: { ownerName: string; level?: BotLevel }, noun = 'bot') {
  const level = bot.level && bot.level !== 'normal' ? `${bot.level} ` : '';
  return bot.ownerName ? `${bot.ownerName}’s ${level}${noun}` : `${level}${noun}`;
}

/** On a nameplate the level comes before the owner, so a long name cuts the owner short, not the level: "hard · Beth's bot". */
export function botPlateLabel(bot: { ownerName: string; level?: BotLevel }) {
  const owner = bot.ownerName ? `${bot.ownerName}’s bot` : 'bot';
  return bot.level && bot.level !== 'normal' ? `${bot.level} · ${owner}` : owner;
}

/** Easy, Normal or Hard, with a line on how the picked one plays. */
export function LevelPicker({ value, onPick, disabled, name }: { value: BotLevel; onPick: (level: BotLevel) => void; disabled?: boolean; name: string }) {
  return (
    <>
      <div className="row wrap" role="radiogroup" aria-label="Bot level">
        {BOT_LEVELS.map((level) => (
          <label key={level} className="toggle">
            <input type="radio" name={name} checked={value === level} disabled={disabled} onChange={() => onPick(level)} />
            {LEVEL_INFO[level].label}
          </label>
        ))}
      </div>
      <p className="hint">{LEVEL_INFO[value].about}</p>
    </>
  );
}

/** Change a bot's level from its popup (its owner, or the host). It plays the new way from its next move. */
export function BotLevelControl({ view, seat }: { view: TableView; seat: SeatView }) {
  const [error, setError] = useState('');
  // Shown straight away, until the table says so too.
  const [picked, setPicked] = useState<BotLevel | null>(null);
  // The level shown is the live one, wherever the bot sits now.
  const live = view.seats.find((s) => s?.playerId === seat.playerId) ?? seat;
  const level = picked ?? live.bot?.level ?? 'normal';
  return (
    <div className="bot-level">
      <h3>Level</h3>
      <LevelPicker
        name={`level-${seat.playerId}`}
        value={level}
        onPick={(next) => {
          setError('');
          setPicked(next);
          rememberBotLevel(next);
          call('bot:level', { playerId: seat.playerId, level: next })
            .catch((err: Error) => setError(err.message))
            .finally(() => setPicked(null));
        }}
      />
      {error && <p className="error">{error}</p>}
    </div>
  );
}
