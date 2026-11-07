import { Modal } from './SeatDialog';

const KEYS: [string, string][] = [
  ['F', 'Fold'],
  ['K', 'Check'],
  ['C', 'Call'],
  ['R', 'Raise: jumps to the amount box (type it, then Enter). In limit games it raises.'],
  ['0-9', 'On your turn: start typing a bet amount (then Enter)'],
  [
    'A',
    "All in, on your turn in no limit and pot limit games. The first press puts the most you can bet in the box and says what it will send. Press A again or Enter to send it, or Esc to cancel. In pot limit it's the most the pot allows, which can be less than all in. Facing a bet of all your chips, it picks the call. Not in limit games, and it does nothing before your turn.",
  ],
  ['B', 'Show amounts in chips or big blinds'],
  ['T', 'Tip on your turn (hands with only bots)'],
  ['W', 'In the replayer: why the bots played'],
  ['Enter', 'Type in the chat. Enter again sends it and takes you back to the table (Esc leaves without sending). Just after A, Enter sends the all-in instead'],
  ['?', 'Show this list'],
];

/** Every keyboard shortcut at the table. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <dl className="shortcuts">
        {KEYS.map(([k, what]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <p className="hint">
        Before your turn, F, K and C tick a pre-move instead (Check / Fold or Fold, Check, Call), which plays the moment your
        turn comes. Press the same key again to untick it. Call any has no key: click it.
      </p>
      <p className="hint">They work whenever you're not typing in a box. In the hand replayer, the arrow keys step and Space plays.</p>
      <div className="row">
        <button className="primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </Modal>
  );
}

/** Whether this device has a keyboard and mouse, so keyboard hints are worth showing. */
export const hasKeyboard = () => typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches;
