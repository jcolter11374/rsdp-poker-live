import { useState } from 'react';
import { PlayingCard } from '../components/PlayingCard';
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

/** The guides for `gameIds` first (tagged "now" for `current`), then every other game. */
export function GameGuide({ gameIds = [], current = null }: { gameIds?: string[]; current?: string | null }) {
  const here = [...new Set(gameIds.map(guideFor).filter((g): g is Guide => !!g))];
  const others = GUIDES.filter((g) => !here.includes(g));
  const [picked, setPicked] = useState<Guide>((current && guideFor(current)) || here[0] || GUIDES[0]);
  // "now" only makes sense at a table.
  const nowId = current && here.length ? guideFor(current)?.id : null;

  const chip = (g: Guide) => (
    <button key={g.id} className={`guide-chip ${g === picked ? 'on' : ''}`} aria-pressed={g === picked} onClick={() => setPicked(g)}>
      {g.name}
      {g.id === nowId && <span className="tag">now</span>}
    </button>
  );

  return (
    <div className="guide">
      <nav className="guide-picker" aria-label="Games">
        {here.length > 0 && <span className="guide-group">At this table</span>}
        {here.map(chip)}
        {here.length > 0 && <span className="guide-group">Other games</span>}
        {others.map(chip)}
      </nav>
      <GuideBody key={picked.id} guide={picked} />
    </div>
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
