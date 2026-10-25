import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createApp } from './app';

const PORT = Number(process.env.PORT ?? 3001);

registerAllVariants(variants);

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const server = createApp({ webDist });

server.http.listen(PORT, () => console.log(`RSDP Poker Live! server on http://localhost:${PORT}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close().finally(() => process.exit(0));
  });
}
