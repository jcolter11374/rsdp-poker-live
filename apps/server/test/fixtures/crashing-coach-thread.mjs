// The coach's own thread, except that it falls over in the middle of a tip for hand 666 (it exits) or hand 667 (it
// throws), the way a bug or running out of memory would bring a real one down. For coach-worker.test.ts.
import { parentPort } from 'node:worker_threads';

let throwing = null;
// Listening before the real thread does, so it can fall over before any answer goes back.
parentPort.on('message', ({ id, job }) => {
  if (job.handNumber === 666) process.exit(3);
  if (job.handNumber === 667) throwing = id;
});
// The answer for hand 667 throws instead of going back, and so does the thread's report of that, which nothing catches.
const send = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (m) => {
  if (throwing !== null && m.id === throwing) throw new Error('the coach fell over');
  send(m);
};
await import('../../src/bots/coachThread.mjs');
