import express from 'express';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server, type Socket } from 'socket.io';
import { ActionError, type Ack, type ClientToServer, type ServerToClient } from '@rsdp/engine';
import { Room } from './room';

const PORT = Number(process.env.PORT ?? 3001);
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;

const app = express();
const http = createServer(app);
const io = new Server<ClientToServer, ServerToClient>(http, {
  cors: process.env.NODE_ENV === 'production' ? undefined : { origin: true },
});

const rooms = new Map<string, Room>();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

// In production the server also serves the built web client.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

/** Public player id derived from the browser's secret token, so the token never leaves the server. */
function playerIdFor(token: unknown): string | null {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  return createHash('sha256').update(token).digest('base64url').slice(0, 16);
}

function broadcast(room: Room) {
  for (const s of io.sockets.sockets.values()) {
    if (s.data.roomId === room.id) s.emit('room:state', room.viewFor(s.data.playerId));
  }
}

type Sock = Socket<ClientToServer, ServerToClient, object, { playerId: string; roomId?: string }>;

/** Runs a handler, turning engine errors into an error ack instead of a crash. */
function guarded<T>(ack: Ack<T> | undefined, fn: () => T | void) {
  try {
    const result = fn();
    ack?.({ ok: true, ...(result ?? {}) } as never);
  } catch (err) {
    if (!(err instanceof ActionError)) console.error(err);
    ack?.({ ok: false, error: err instanceof Error ? err.message : 'something went wrong' });
  }
}

io.use((socket, next) => {
  const playerId = playerIdFor(socket.handshake.auth?.token);
  if (!playerId) return next(new Error('missing token'));
  socket.data.playerId = playerId;
  next();
});

io.on('connection', (socket: Sock) => {
  const me = socket.data.playerId;
  const room = () => {
    const r = socket.data.roomId ? rooms.get(socket.data.roomId) : undefined;
    if (!r) throw new ActionError('join a table first');
    return r;
  };
  const hostRoom = () => {
    const r = room();
    if (!r.isHost(me)) throw new ActionError('only the host can do that');
    return r;
  };

  socket.on('room:create', (input, ack) =>
    guarded(ack, () => {
      const sb = Math.floor(Number(input.smallBlind));
      const bb = Math.floor(Number(input.bigBlind));
      const r = new Room(me, {
        hostName: String(input.hostName ?? '').slice(0, 20) || 'Host',
        smallBlind: sb,
        bigBlind: bb,
        turnSeconds: 0,
      });
      r.settings(sb, bb, Math.floor(Number(input.turnSeconds) || 0));
      r.onChange = () => broadcast(r);
      rooms.set(r.id, r);
      return { roomId: r.id };
    }),
  );

  socket.on('room:join', ({ roomId }, ack) =>
    guarded(ack, () => {
      const r = rooms.get(String(roomId));
      if (!r) throw new ActionError('table not found');
      socket.data.roomId = r.id;
      socket.emit('room:state', r.viewFor(me));
    }),
  );

  socket.on('seat:request', ({ seat, name, stack }, ack) =>
    guarded(ack, () => room().requestSeat(me, Number(seat), String(name ?? ''), Number(stack))),
  );
  socket.on('seat:cancel', () => guarded(undefined, () => room().cancelRequest(me)));
  socket.on('player:action', (action, ack) => guarded(ack, () => room().act(me, action)));
  socket.on('player:stand', () => guarded(undefined, () => room().stand(me)));
  socket.on('player:sitOut', ({ value }) => guarded(undefined, () => room().sitOut(me, !!value)));
  socket.on('chat:send', ({ text }) => guarded(undefined, () => room().addChat(me, String(text ?? ''))));

  socket.on('host:approve', ({ requestId }, ack) => guarded(ack, () => hostRoom().approve(requestId)));
  socket.on('host:reject', ({ requestId }) => guarded(undefined, () => hostRoom().reject(requestId)));
  socket.on('host:start', (ack) => guarded(ack, () => hostRoom().start()));
  socket.on('host:pause', ({ value }) => guarded(undefined, () => hostRoom().setPaused(!!value)));
  socket.on('host:settings', ({ smallBlind, bigBlind, turnSeconds }, ack) =>
    guarded(ack, () => hostRoom().settings(Number(smallBlind), Number(bigBlind), Number(turnSeconds))),
  );
  socket.on('host:setStack', ({ playerId, stack }, ack) =>
    guarded(ack, () => hostRoom().setStack(String(playerId), Number(stack))),
  );
  socket.on('host:kick', ({ playerId }) => guarded(undefined, () => hostRoom().stand(String(playerId))));
});

// Drop tables nobody has touched for a while. State is in memory only for now.
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (now - r.lastActivity > ROOM_IDLE_MS) {
      r.dispose();
      rooms.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

http.listen(PORT, () => console.log(`RSDP Poker Live! server on http://localhost:${PORT}`));
