import { useEffect, useRef, useState } from 'react';
import type { RoomView } from '@rsdp/engine';
import { socket } from '../socket';

type Tab = 'log' | 'chat' | 'ledger';

export function SidePanel({ view }: { view: RoomView }) {
  const [tab, setTab] = useState<Tab>('log');
  const [text, setText] = useState('');
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [tab, view.log.length, view.chat.length]);

  return (
    <div className="panel side-panel">
      <div className="tabs">
        {(['log', 'chat', 'ledger'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'log' ? 'Hand log' : t === 'chat' ? 'Chat' : 'Ledger'}
          </button>
        ))}
      </div>
      <div className="scroll" ref={scroller}>
        {tab === 'log' && view.log.map((line, i) => <div key={i} className={line.startsWith('---') ? 'log-hand' : ''}>{line}</div>)}
        {tab === 'chat' &&
          view.chat.map((m, i) => (
            <div key={i}>
              <b>{m.name}:</b> {m.text}
            </div>
          ))}
        {tab === 'ledger' && <Ledger view={view} />}
      </div>
      {tab === 'chat' && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            socket.emit('chat:send', { text });
            setText('');
          }}
        >
          <input value={text} maxLength={300} placeholder="Say something" onChange={(e) => setText(e.target.value)} />
          <button>Send</button>
        </form>
      )}
    </div>
  );
}

function Ledger({ view }: { view: RoomView }) {
  const seatedIds = new Set(view.seats.filter(Boolean).map((s) => s!.playerId));
  const canEdit = view.isHost && !(view.hand && view.hand.street !== 'complete');
  return (
    <table className="ledger">
      <thead>
        <tr>
          <th>Player</th>
          <th>Buy-in</th>
          <th>Stack</th>
          <th>Net</th>
          {view.isHost && <th />}
        </tr>
      </thead>
      <tbody>
        {view.ledger.map((e) => (
          <tr key={e.playerId}>
            <td>{e.name}</td>
            <td>{e.buyIn}</td>
            <td>{e.stack}</td>
            <td className={e.net > 0 ? 'up' : e.net < 0 ? 'down' : ''}>{e.net > 0 ? `+${e.net}` : e.net}</td>
            {view.isHost && (
              <td>
                {seatedIds.has(e.playerId) && (
                  <>
                    <button
                      disabled={!canEdit}
                      title={canEdit ? 'Change stack' : 'Wait for the hand to end'}
                      onClick={() => {
                        const v = prompt(`New stack for ${e.name}`, String(e.stack));
                        if (v !== null) socket.emit('host:setStack', { playerId: e.playerId, stack: Math.floor(+v) }, () => {});
                      }}
                    >
                      Edit
                    </button>
                    {e.playerId !== view.hostId && (
                      <button onClick={() => confirm(`Remove ${e.name}?`) && socket.emit('host:kick', { playerId: e.playerId })}>
                        Kick
                      </button>
                    )}
                  </>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
