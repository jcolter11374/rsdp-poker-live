import { getVariant } from '@rsdp/engine/variants';
import type { TableView } from '@rsdp/engine/wire';
import { BETTING_NAME } from '../format';
import { Modal } from './SeatDialog';

const BETTING_RULES = {
  'no-limit': 'You may bet or raise any amount up to everything in front of you. A raise must be at least as big as the last bet or raise.',
  'pot-limit': 'The most you may bet or raise is the size of the pot (counting your call first).',
  'fixed-limit':
    'Bets and raises come in one fixed size: the small bet on the early streets, the big bet on the later ones. Each round allows a bet and a few raises.',
} as const;

const HIGH_HANDS = [
  'Straight flush',
  'Four of a kind',
  'Full house',
  'Flush',
  'Straight',
  'Three of a kind',
  'Two pair',
  'One pair',
  'High card',
];

/** How to play the game on the table now (and the others in a rotation). */
export function RulesDialog({ view, onClose }: { view: TableView; onClose: () => void }) {
  const rot = view.settings.game.rotation;
  const ids = rot.enabled && rot.steps.length ? [...new Set(rot.steps.map((s) => s.gameId))] : [view.hand?.gameId ?? view.settings.game.gameId];
  const current = view.hand?.gameId ?? ids[0];
  const ordered = [current, ...ids.filter((id) => id !== current)];
  const betting = view.hand?.betting ?? view.upcoming?.betting ?? view.settings.game.betting;
  return (
    <Modal title="How to play" onClose={onClose}>
      <div className="rules">
        {ordered.map((id) => {
          let spec;
          try {
            spec = getVariant(id);
          } catch {
            return null;
          }
          return (
            <section key={id}>
              <h3>
                {spec.name}
                {id === current && <span className="tag">now</span>}
              </h3>
              <p>{spec.rules}</p>
              <p className="muted">Betting rounds: {spec.streets.map((s) => s.name).join(', ')}.</p>
            </section>
          );
        })}
        <section>
          <h3>{BETTING_NAME[betting]}</h3>
          <p>{BETTING_RULES[betting]}</p>
        </section>
        <section>
          <h3>High hands, best first</h3>
          <ol className="rank-list">
            {HIGH_HANDS.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ol>
        </section>
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
