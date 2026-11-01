// Commands that take an answer from the server, with a time limit. Kept apart
// from socket.ts (which connects as soon as it loads) so it can be tested.

type AckResult = { ok: true } | { ok: false; error: string };

/** What socket.io gives call(): emit with a time limit, whose answer callback hears about time running out or the connection dropping. */
export interface TimedEmitter {
  timeout(ms: number): { emit(event: string, ...args: unknown[]): unknown };
}

/**
 * How long a command waits for the server's answer, counting time spent
 * waiting for the connection to come back. Without a limit, a command sent
 * just before the connection dropped never settled (socket.io forgets a
 * plain answer callback when the connection goes), and its button stayed busy.
 */
export const CALL_TIMEOUT_MS = 30_000;
/** Downloads of a whole game's hands can be big, so they get longer on a slow phone connection. */
export const SLOW_CALLS: Record<string, number> = { 'table:export': 120_000, 'table:fullLog': 120_000 };

/** What a player sees when no answer came. */
export const NO_ANSWER = 'No answer from the server. Check your connection, then try again.';
export const DROPPED = 'The connection dropped before the server answered. Check whether it went through, then try again.';

/** No answer came: time ran out, or the connection dropped. The server may or may not have done it. */
export class NoAnswerError extends Error {
  constructor(readonly dropped: boolean) {
    super(dropped ? DROPPED : NO_ANSWER);
    this.name = 'NoAnswerError';
  }
}

/**
 * call() for a socket: emits an event that takes an answer and resolves with
 * the reply; rejects with the server's message when it refuses, and with a
 * NoAnswerError (NO_ANSWER or DROPPED) when no answer comes. A command still waiting to be
 * sent when time runs out is dropped, so it can't go through later. Events
 * without a payload pass none.
 */
export function callerFor<Event extends string = string>(socket: TimedEmitter, limitFor: (event: Event) => number = (e) => SLOW_CALLS[e] ?? CALL_TIMEOUT_MS) {
  return function call<T extends object = object>(event: Event, ...payload: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      socket.timeout(limitFor(event)).emit(event, ...payload, (err: Error | null, res?: AckResult & T) => {
        if (err) reject(new NoAnswerError(/disconnect/i.test(err.message)));
        else if (res?.ok) resolve(res);
        else reject(new Error((res && !res.ok && res.error) || NO_ANSWER));
      });
    });
  };
}
