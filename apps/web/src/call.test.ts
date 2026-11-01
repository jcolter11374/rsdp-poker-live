import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Server, type Socket as ServerSocket } from 'socket.io';
import { io, type Socket } from 'socket.io-client';
import { callerFor, DROPPED, NO_ANSWER, NoAnswerError, type AnswerSocket } from './call';

type Ack = (res: { ok: boolean; error?: string; n?: number }) => void;

/** A real socket.io server and client, as in the browser. */
async function pair(handle: (s: ServerSocket) => void) {
  const http = createServer();
  const server = new Server(http);
  const heard: string[] = [];
  server.on('connection', (s) => {
    s.onAny((event) => heard.push(event));
    handle(s);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const client: Socket = io(url, { transports: ['websocket'], forceNew: true, reconnectionDelay: 50, reconnectionDelayMax: 50 });
  await new Promise<void>((r) => client.once('connect', () => r()));
  open.push({ server, client, http });
  return { server, client, heard, call: callerFor(client as unknown as AnswerSocket, () => 300) };
}
const open: { server: Server; client: Socket; http: ReturnType<typeof createServer> }[] = [];
afterEach(async () => {
  for (const { server, client, http } of open.splice(0)) {
    client.close();
    server.close();
    http.close();
  }
});

describe('call', () => {
  it("resolves with the server's answer, and rejects with its refusal", async () => {
    const { call } = await pair((s) => {
      s.on('good', (n: number, ack: Ack) => ack({ ok: true, n: n + 1 }));
      s.on('bad', (ack: Ack) => ack({ ok: false, error: 'not your turn' }));
    });
    await expect(call<{ n: number }>('good', 1)).resolves.toMatchObject({ ok: true, n: 2 });
    const refused = await call('bad').catch((e: Error) => e);
    expect(refused).toMatchObject({ message: 'not your turn' });
    // A refusal is the server's answer, not a lost one.
    expect(refused).not.toBeInstanceOf(NoAnswerError);
  });

  it('gives up when the server never answers', async () => {
    const { call } = await pair((s) => s.on('silent', () => {}));
    const started = Date.now();
    const err = await call('silent').catch((e: Error) => e);
    expect(err).toBeInstanceOf(NoAnswerError);
    expect(err).toMatchObject({ message: NO_ANSWER, dropped: false });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects at once when the connection drops after the command went out', async () => {
    const { call } = await pair((s) => s.on('then-drop', () => s.conn.close()));
    const started = Date.now();
    const err = await call('then-drop').catch((e: Error) => e);
    expect(err).toBeInstanceOf(NoAnswerError);
    expect(err).toMatchObject({ message: DROPPED, dropped: true });
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('a command made while offline waits for the connection, then goes out once', async () => {
    const { client, call, heard } = await pair((s) => s.on('late', (ack: Ack) => ack({ ok: true })));
    client.io.reconnection(false);
    client.disconnect();
    // Longer offline than the time limit: the limit only starts once the command goes out.
    const pending = call('late');
    await new Promise((r) => setTimeout(r, 500));
    expect(heard).not.toContain('late');
    client.connect();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(heard.filter((e) => e === 'late')).toHaveLength(1);
  });

  it('a table move made while offline is refused after the reconnect, not played late', async () => {
    // Like the table server: a move needs the player re-joined to the table, and joining takes a moment.
    const { client, call, heard } = await pair((s) => {
      let joined = false;
      s.on('join', async (ack: Ack) => {
        await new Promise((r) => setTimeout(r, 5));
        joined = true;
        ack({ ok: true });
      });
      s.on('act', (ack: Ack) => ack(joined ? { ok: true } : { ok: false, error: 'join a table first' }));
    });
    // Like the table page: join again on every connect.
    client.on('connect', () => void call('join').catch(() => {}));
    client.io.reconnection(false);
    client.disconnect();
    const check = call('act');
    const fold = call('act');
    client.connect();
    await expect(check).rejects.toThrow('join a table first');
    await expect(fold).rejects.toThrow('join a table first');
    expect(heard).toEqual(['act', 'act', 'join']);
  });
});
