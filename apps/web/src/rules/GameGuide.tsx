import { useState } from 'react';
import type { TableSettings } from '@rsdp/engine/settings';
import { PlayingCard } from '../components/PlayingCard';
import { EXTRAS, extraFor, type ExtraGuide } from './extras';
import { GUIDES, cardsOf, guideFor, type CardList, type Guide } from './guides';
import './rules.css';

function Cards({ cards }: { cards: CardList }) {
  return (
    <span className="guide-cards">
      {cardsOf(cards).map((c) => (
        <PlayingCard key={c} card={c} small />
      ))}
    </span>
  );
}

type Picked = Guide | ExtraGuide;
const isGame = (g: Picked): g is Guide => 'games' in g;

/** A game guide or a side game / house rule guide, by id (with this table's numbers, given its settings). */
function anyGuide(id: string, settings?: TableSettings): Picked | null {
  return guideFor(id) ?? extraFor(id, settings);
}

/**
 * The guides for `gameIds` first (tagged "now" for `current`), then every
 * other game, then the side games and house rules: those in `extraIds` (the
 * ones on at this table) first. `current` may name a game or a side game.
 * `settings` are the table's, so a guide's examples can use its numbers.
 */
export function GameGuide({ gameIds = [], extraIds, current = null, settings }: { gameIds?: string[]; extraIds?: string[]; current?: string | null; settings?: TableSettings }) {
  const here = [...new Set(gameIds.map(guideFor).filter((g): g is Guide => !!g))];
  const others = GUIDES.filter((g) => !here.includes(g));
  const extrasHere = (extraIds ?? []).map((id) => extraFor(id, settings)).filter((g): g is ExtraGuide => !!g);
  const extrasOther = EXTRAS.filter((g) => !extrasHere.some((h) => h.id === g.id)).map((g) => extraFor(g.id, settings)!);
  // By id: a guide with the table's numbers is rebuilt when the settings change.
  const [pickedId, setPicked] = useState<string>(((current && anyGuide(current)) || here[0] || GUIDES[0]).id);
  const picked = anyGuide(pickedId, settings) ?? GUIDES[0];
  // "now" only makes sense at a table.
  const nowId = current && here.length ? guideFor(current)?.id : null;

  const chip = (g: Picked) => (
    <button key={g.id} className={`guide-chip ${g.id === picked.id ? 'on' : ''}`} aria-pressed={g.id === picked.id} onClick={() => setPicked(g.id)}>
      {g.name}
      {g.id === nowId && <span className="tag">now</span>}
    </button>
  );

  return (
    <div className="guide">
      <nav className="guide-picker" aria-label="Games and side games">
        <span className="guide-group">{here.length ? 'At this table' : 'Games'}</span>
        {here.map(chip)}
        {here.length > 0 && <span className="guide-group">Other games</span>}
        {others.map(chip)}
        {extrasHere.length > 0 && <span className="guide-group">Side games and house rules at this table</span>}
        {extrasHere.map(chip)}
        <span className="guide-group">{extrasHere.length ? 'Other side games and rules' : 'Side games and house rules'}</span>
        {extrasOther.map(chip)}
      </nav>
      {isGame(picked) ? <GuideBody key={picked.id} guide={picked} /> : <ExtraBody key={picked.id} guide={picked} />}
    </div>
  );
}

function ExtraBody({ guide: g }: { guide: ExtraGuide }) {
  return (
    <article className="guide-body">
      <h3>
        {g.name}
        {g.cashOnly && <span className="tag guide-cash">cash games</span>}
      </h3>
      <p className="guide-idea">{g.idea}</p>

      <details open>
        <summary>How it works here</summary>
        <ol>
          {g.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </details>

      <details open>
        <summary>{g.examples.length > 1 ? 'Examples' : 'Example'}</summary>
        {g.examples.map((ex) => (
          <div className="guide-showdown" key={ex.title}>
            <h4>{ex.title}</h4>
            {ex.cards?.map((c) => (
              <div className="guide-hand won" key={c.label}>
                <span className="who">{c.label}</span>
                <Cards cards={c.cards} />
              </div>
            ))}
            {ex.lines.map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
        ))}
      </details>

      <details>
        <summary>Host settings</summary>
        <ul>
          {g.settings.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </details>

      {g.elsewhere && (
        <details>
          <summary>If you've played it elsewhere</summary>
          <ul>
            {g.elsewhere.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

function GuideBody({ guide: g }: { guide: Guide }) {
  return (
    <article className="guide-body">
      <h3>{g.name}</h3>
      <p className="guide-idea">{g.idea}</p>

      <details open>
        <summary>How a hand goes</summary>
        <ol>
          {g.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </details>

      <details open>
        <summary>What wins</summary>
        <p>{g.goal}</p>
        <h4>{g.ladder.title}</h4>
        <ol className="guide-ladder">
          {g.ladder.hands.map((h) => (
            <li key={h.cards}>
              <Cards cards={h.cards} />
              <span>{h.label}</span>
            </li>
          ))}
        </ol>
        {g.ladder.note && <p className="muted">{g.ladder.note}</p>}
      </details>

      <details>
        <summary>Which hand wins?</summary>
        {g.showdowns.map((s, i) => (
          <div className="guide-showdown" key={i}>
            {s.board && (
              <div className="guide-hand">
                <span className="who">Board</span>
                <Cards cards={s.board} />
              </div>
            )}
            {(['a', 'b'] as const).map((side) => (
              <div className={`guide-hand ${s.winner === side || s.winner === 'tie' ? 'won' : ''}`} key={side}>
                <span className="who">{s[side].name}</span>
                <Cards cards={s[side].cards} />
                {(s.winner === side || s.winner === 'tie') && <span className="tag">{s.winner === 'tie' ? 'split' : s.half ? `wins ${s.half}` : 'wins'}</span>}
              </div>
            ))}
            <p>{s.why}</p>
          </div>
        ))}
      </details>

      <details>
        <summary>Tips for new players</summary>
        <ul>
          {g.tips.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </details>

      <details>
        <summary>Easy mistakes</summary>
        <ul>
          {g.mistakes.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </details>
    </article>
  );
}
