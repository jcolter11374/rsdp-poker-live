import { useEffect, useState } from 'react';
import { Home } from './Home';
import { TablePage } from './TablePage';

function roomFromPath(): string | null {
  const m = location.pathname.match(/^\/t\/([\w-]+)/);
  return m ? m[1] : null;
}

export function App() {
  const [roomId, setRoomId] = useState(roomFromPath);

  useEffect(() => {
    const onPop = () => setRoomId(roomFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const open = (id: string) => {
    history.pushState(null, '', `/t/${id}`);
    setRoomId(id);
  };

  return roomId ? <TablePage roomId={roomId} /> : <Home onCreated={open} />;
}
