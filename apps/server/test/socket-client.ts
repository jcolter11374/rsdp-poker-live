import { io as connect, type Socket } from 'socket.io-client';
import type { ClientToServer, ServerToClient, TableView } from '@rsdp/engine/wire';

export type Client = Socket<ServerToClient, ClientToServer>;

/** A test browser: acked calls that reject on an error ack, and waiting for a view that matches. */
export function socketClient(url: string, token: string, clients: Client[]) {
  const c: Client = connect(url, { auth: { token }, transports: ['websocket'], forceNew: true });
  clients.push(c);
  let last: TableView | null = null;
  const waiters: { test: (v: TableView) => boolean; resolve: (v: TableView) => void }[] = [];
  c.on('table:state', (v) => {
    last = v;
    for (const w of [...waiters]) if (w.test(v)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(v);
    }
  });
  const call = <T = object>(event: string, ...args: unknown[]) =>
    new Promise<T>((resolve, reject) => {
      (c.emit as (e: string, ...a: unknown[]) => void)(event, ...args, (res: { ok: boolean; error?: string } & T) => (res.ok ? resolve(res) : reject(new Error(res.error))));
    });
  return {
    socket: c,
    call,
    view: () => last!,
    until: (test: (v: TableView) => boolean) =>
      new Promise<TableView>((resolve) => {
        if (last && test(last)) return resolve(last);
        waiters.push({ test, resolve });
      }),
  };
}
