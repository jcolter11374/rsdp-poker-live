// Stopping the server (index.ts): each step's time goes in the log, and a limit makes sure a host's restart never hangs.

/** How long a shutdown may take before the server exits anyway. Fly waits 30 s before it kills the machine (fly.toml). */
export const SHUTDOWN_LIMIT_MS = 10_000;

/** The start of the line logged when the limit is reached. CI fails a stop that logs it (ci.yml). */
export const GAVE_UP = 'shutdown: gave up';

/** The start of the line logged when every step is done. CI checks a stop logs it. */
export const FINISHED = 'shutdown: finished';

/** What a shutdown (app.ts, close) tells the log as it goes. */
export interface ShutdownSteps {
  /** A step is starting, so the one before it is done. */
  step(name: string): void;
  /** Something worth a line of its own, such as connections that had to be cut. */
  note(text: string): void;
}

/** For a close() that nobody is timing (tests). */
export const quietSteps: ShutdownSteps = { step() {}, note() {} };

export interface ShutdownDeps {
  /** Saves everything and closes it, telling `steps` as each step starts. */
  run(steps: ShutdownSteps): Promise<void>;
  exit(code: number): void;
  /** Each step's time (stdout). */
  info?: (line: string) => void;
  /** A shutdown that failed or reached the limit (stderr). */
  error?: (line: string, err?: unknown) => void;
  limitMs?: number;
  now?: () => number;
}

/**
 * Runs a shutdown, then exits with `code`. Each step's time goes in the log ("shutdown: saving tables took 40 ms"),
 * so a slow one shows in `flyctl logs`. If it hasn't finished within the limit, it logs the step it was stuck on and
 * exits anyway, with the same code: whatever that step and the ones after it had left to do is skipped.
 */
export function shutDown(code: number, deps: ShutdownDeps): void {
  const now = deps.now ?? Date.now;
  const info = deps.info ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string, err?: unknown) => console.error(line, err ?? ''));
  const limitMs = deps.limitMs ?? SHUTDOWN_LIMIT_MS;
  const started = now();
  let current: string | null = null;
  let since = started;
  let exited = false;
  /** The step that just ended, and how long it took. */
  const ended = () => {
    if (current) info(`shutdown: ${current} took ${now() - since} ms`);
  };
  const exit = () => {
    if (exited) return;
    exited = true;
    clearTimeout(limit);
    deps.exit(code);
  };
  const steps: ShutdownSteps = {
    step(name) {
      ended();
      current = name;
      since = now();
    },
    note: (text) => info(`shutdown: ${text}`),
  };
  // Not unref'd: a step left waiting on nothing must not let the process slip out unnoticed before this logs it.
  const limit = setTimeout(() => {
    error(`${GAVE_UP} after ${limitMs} ms, stuck ${current ?? 'starting'} for ${now() - since} ms; exiting without finishing`);
    exit();
  }, limitMs);
  info(`shutdown: started${code ? ` (exit code ${code})` : ''}`);
  Promise.resolve()
    .then(() => deps.run(steps))
    .then(
      () => {
        if (exited) return;
        ended();
        info(`${FINISHED} in ${now() - started} ms`);
      },
      (e: unknown) => {
        if (!exited) error(`shutdown failed while ${current ?? 'starting'}`, e);
      },
    )
    .finally(exit);
}
