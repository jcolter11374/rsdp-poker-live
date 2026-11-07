// The coach's worker thread starts here, in plain JavaScript. The server runs
// its TypeScript through tsx, but this thread is started without the server's
// own flags (under vitest there are none to inherit anyway), so it loads tsx
// itself and then its own code. It works the same under npm run dev, npm test
// and the production image (node --import tsx).
import { register } from 'tsx/esm/api';

register();
await import('./coachThread.ts');
