/// <reference lib="webworker" />
import { equity, type EquityInput } from './equity';

/** Works out all-in equity off the main thread, so a big Omaha run-out never stalls the table. */
self.onmessage = (e: MessageEvent<{ key: string; input: EquityInput }>) => {
  let result = null;
  try {
    result = equity(e.data.input);
  } catch {
    /* an odd spot: just show nothing */
  }
  self.postMessage({ key: e.data.key, result });
};
