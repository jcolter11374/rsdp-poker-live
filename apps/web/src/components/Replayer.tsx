import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { HandRecordView, TableView } from '@rsdp/engine/wire';
import { gameLabel, stakesLabel, type Fmt } from '../format';
import { frameView, handNet, replayFrames } from '../replay';
import { Table } from './Table';
import { LogText } from './PlayingCard';
import { usePortrait } from '../layout';

const SPEEDS = [1, 2, 4];

/** A hand the replayer can't draw shows a note instead of taking the table page down with it. */
class ReplayBoundary extends Component<{ onClose: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="replayer-backdrop" onClick={this.props.onClose}>
        <div className="replayer" role="dialog" aria-label="Hand replay">
          <p>This hand can’t be replayed.</p>
          <button onClick={this.props.onClose}>Close</button>
        </div>
      </div>
    );
  }
}

export function Replayer(props: Parameters<typeof ReplayerView>[0]) {
  return (
    <ReplayBoundary onClose={props.onClose}>
      <ReplayerView {...props} />
    </ReplayBoundary>
  );
}

/**
 * Plays finished hands back on the table, step by step or on its own, with
 * the log line for each step. Cards show only as the viewer could see them.
 */
function ReplayerView({
  hands,
  start,
  tableName,
  seatCount,
  myId,
  felt,
  fmt,
  onClose,
}: {
  hands: HandRecordView[];
  /** Index in `hands` to open first. */
  start: number;
  tableName: string;
  seatCount: number;
  myId: string | null;
  /** The table's felt, so the replay looks like the table. */
  felt?: TableView['settings']['table']['felt'];
  fmt: Fmt;
  onClose: () => void;
}) {
  const compact = usePortrait();
  const [index, setIndex] = useState(start);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const hand = hands[index];
  const frames = useMemo(() => (hand ? replayFrames(hand, myId, fmt) : []), [hand, myId, fmt]);
  const last = frames.length - 1;

  const goTo = (i: number) => {
    setIndex(i);
    setStep(0);
    setPlaying(true);
  };

  useEffect(() => {
    if (!playing) return;
    if (step >= last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => Math.min(last, s + 1)), 1100 / speed);
    return () => clearTimeout(t);
  }, [playing, step, last, speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
        // Moving by hand stops the autoplay.
        setPlaying(false);
        if (e.key === 'ArrowRight') setStep((s) => Math.min(last, s + 1));
        else if (e.key === 'ArrowLeft') setStep((s) => Math.max(0, s - 1));
        else setStep(e.key === 'Home' ? 0 : last);
      } else if (e.key === ' ') setPlaying((p) => !p);
      else return;
      // The replayer sits on top: keep these keys from the slider, the sheet or the table underneath.
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [last, onClose]);

  if (!hand || !frames.length) return null;
  const frame = frames[Math.min(step, last)];
  const view = frameView(tableName, seatCount, hand, frame, myId, felt);
  const family = view.hand!.family;
  const net = myId ? handNet(hand, myId) : null;

  return (
    <div className="replayer-backdrop">
      <div className={`replayer ${compact ? 'compact' : ''}`} role="dialog" aria-label="Hand replay">
        <div className="replayer-head">
          <div>
            <b>Hand #{hand.handNumber}</b> · {gameLabel(view.hand!.gameId, hand.betting)} {stakesLabel(hand.stakes, family, hand.betting, fmt)}
            <span className="muted"> · {new Date(hand.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
            {net !== null && <span className={net > 0 ? 'up' : net < 0 ? 'down' : 'muted'}> · you {net > 0 ? `+${fmt(net)}` : fmt(net)}</span>}
          </div>
          <button className="icon" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="replayer-table">
          <Table key={hand.handNumber} view={view} skew={0} fmt={fmt} compact={compact} />
        </div>
        <div className="replayer-caption">
          <LogText text={frame.caption || ' '} />
        </div>
        <input
          className="replayer-scrub"
          type="range"
          min={0}
          max={last}
          value={step}
          aria-label="Step"
          onChange={(e) => {
            setPlaying(false);
            setStep(+e.target.value);
          }}
        />
        <div className="replayer-controls">
          <button disabled={index === 0} onClick={() => goTo(index - 1)} title="Previous hand">
            ⏮
          </button>
          <button disabled={step === 0} onClick={() => (setPlaying(false), setStep(step - 1))} title="Back a step (←)">
            ◀
          </button>
          <button
            className="primary"
            onClick={() => {
              if (step >= last) setStep(0);
              setPlaying(!playing || step >= last);
            }}
            title="Play or pause (space)"
          >
            {playing ? '❚❚' : step >= last ? '↺' : '▶'}
          </button>
          <button disabled={step >= last} onClick={() => (setPlaying(false), setStep(step + 1))} title="Forward a step (→)">
            ▶
          </button>
          <button disabled={index >= hands.length - 1} onClick={() => goTo(index + 1)} title="Next hand">
            ⏭
          </button>
          <button onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])} title="Speed">
            {speed}×
          </button>
        </div>
      </div>
    </div>
  );
}
