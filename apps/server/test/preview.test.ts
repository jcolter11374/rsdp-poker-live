import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { variants } from '@rsdp/engine/core';
import { registerAllVariants } from '@rsdp/engine/variants';
import { createTournament, defaultSettings } from '@rsdp/tournament';
import { io as connect } from 'socket.io-client';
import { createApp, webBuild } from '../src/app';
import { tournamentPreview, withPreview } from '../src/preview';

beforeAll(() => registerAllVariants(variants));

const T0 = Date.parse('2026-10-30T02:30:00Z');
const INDEX = '<!doctype html><html><head><title>RSDP Poker Live!</title></head><body><div id="root"></div></body></html>';

describe('link previews', () => {
  it('describes a scheduled tournament in its own time zone', () => {
    const s = createTournament({
      id: 'abc',
      hostId: 'h',
      settings: defaultSettings({ name: 'Thursday <Deep>', start: { kind: 'scheduled', startAt: T0, schedule: { timeZone: 'America/Los_Angeles', startDate: '2026-10-29', time: '19:30' } } }),
      now: T0 - 86_400_000,
      seed: 1,
    });
    const p = tournamentPreview(s, T0 - 86_400_000);
    expect(p.title).toBe('Thursday <Deep> · RSDP Poker Live!');
    expect(p.description).toBe("No-Limit Hold'em tournament · Thu, Oct 29, 7:30 PM PDT · 0 players registered · starts automatically. Tap to open the lobby and register.");
    const html = withPreview(INDEX, p, 'https://x.test/tn/abc', 'https://x.test');
    expect(html).toContain('<title>Thursday &lt;Deep&gt; · RSDP Poker Live!</title>');
    expect(html).toContain('<meta property="og:image" content="https://x.test/og.jpg" />');
    expect(html).not.toContain('<Deep>');
    // `$'` and friends in a name are text, not replacement patterns.
    const odd = withPreview(INDEX, { title: "Pwn $' $& night", description: '$`' }, 'https://x.test/', 'https://x.test');
    expect(odd).toContain("<title>Pwn $' $&amp; night</title>");
    expect(odd.match(/<div id="root">/g)).toHaveLength(1);
  });

  describe('served pages', () => {
    let dir = '';
    let server: ReturnType<typeof createApp> | undefined;
    afterEach(async () => {
      await server?.close();
      await rm(dir, { recursive: true, force: true });
    });

    it('puts the tournament in the page a chat app fetches', async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'rsdp-web-'));
      await writeFile(path.join(dir, 'index.html'), INDEX);
      server = createApp({ webDist: dir, log: () => {} });
      await new Promise<void>((resolve) => server!.http.listen(0, resolve));
      const base = `http://localhost:${(server.http.address() as AddressInfo).port}`;
      const id = await server.tournaments.create('host', defaultSettings({ name: 'Sunday Mix' }));
      const page = await (await fetch(`${base}/tn/${id}`, { headers: { 'x-forwarded-proto': 'https' } })).text();
      expect(page).toContain('<meta property="og:title" content="Sunday Mix · RSDP Poker Live!" />');
      expect(page).toMatch(/og:image" content="https:\/\/localhost:\d+\/og.jpg"/);
      expect(page).toContain('<div id="root"></div>');
      // Unknown links and the home page still load the app.
      expect(await (await fetch(`${base}/tn/0123456789abcdef`)).text()).toContain('<div id="root"></div>');
      expect(await (await fetch(`${base}/`)).text()).toContain('og:description');
      expect(await (await fetch(`${base}/t/nope`)).text()).toContain('<title>RSDP Poker Live!</title>');
    });
    it('tells each tab that connects which build of the app it serves', async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'rsdp-web-'));
      await writeFile(path.join(dir, 'index.html'), INDEX.replace('</head>', '<script type="module" crossorigin src="/assets/index-AbC123.js"></script></head>'));
      server = createApp({ webDist: dir, log: () => {} });
      await new Promise<void>((resolve) => server!.http.listen(0, resolve));
      const c = connect(`http://localhost:${(server.http.address() as AddressInfo).port}`, { auth: { token: 'f'.repeat(32) }, transports: ['websocket'], forceNew: true });
      try {
        expect(await new Promise((resolve) => c.on('build', resolve))).toBe('/assets/index-AbC123.js');
      } finally {
        c.close();
      }
    });
  });

  it('reads the build from the entry script, and finds none in a page without one', () => {
    expect(webBuild('<script type="module" crossorigin src="/assets/index-DoztcAGG.js"></script>')).toBe('/assets/index-DoztcAGG.js');
    expect(webBuild(INDEX)).toBeNull();
  });
});
