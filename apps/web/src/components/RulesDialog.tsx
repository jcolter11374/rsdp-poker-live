import type { TableView } from '@rsdp/engine/wire';
import { BETTING_NAME } from '../format';
import { GameGuide } from '../rules/GameGuide';
import { Modal } from './SeatDialog';

const BETTING_RULES = {
  'no-limit': 'You may bet or raise any amount up to everything in front of you. A raise must be at least as big as the last bet or raise.',
  'pot-limit': 'The most you may bet or raise is the size of the pot (counting your call first).',
  'fixed-limit':
    'Bets and raises come in one fixed size: the small bet on the early streets, the big bet on the later ones. Each round allows a bet and a few raises.',
} as const;

/** How to play the game on the table now (and the others in a rotation), with guides to every other game too. */
export function RulesDialog({ view, onClose }: { view: TableView; onClose: () => void }) {
  const rot = view.settings.game.rotation;
  const ids = rot.enabled && rot.steps.length ? [...new Set(rot.steps.map((s) => s.gameId))] : [view.hand?.gameId ?? view.settings.game.gameId];
  const current = view.hand?.gameId ?? ids[0];
  const betting = view.hand?.betting ?? view.upcoming?.betting ?? view.settings.game.betting;
  return (
    <Modal title="How to play" onClose={onClose}>
      <div className="rules">
        {/* Keyed so the guide follows the rotation to the next game. */}
        <GameGuide key={current} gameIds={[current, ...ids]} current={current} />
        <section>
          <h3>Betting here: {BETTING_NAME[betting]}</h3>
          <p>{BETTING_RULES[betting]}</p>
        </section>
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
