// What cash.mjs and tourney.mjs share: real browsers, screenshots, and bots
// that click the same buttons a player would. See README.md.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const BASE = process.env.BASE_URL ?? 'http://localhost:3001';
// It creates tables and a tournament with made-up players, so it never runs against the live site.
if (/fly\.dev/.test(BASE)) {
  console.error('play-test refused: it would leave test tables and tournaments on the live site');
  process.exit(1);
}
// Only the server under test is ever contacted: any other request is blocked and listed with the errors.
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const SERVER = new URL(BASE).host;
export const OUT = process.env.OUT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'playtest');
mkdirSync(OUT, { recursive: true });
export const DESK = { width: 1280, height: 800 };
export const PHONE = { width: 390, height: 844 };

export const browser = await chromium.launch();
export const errors = [];

export async function open(label, viewport = DESK, video = false) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: viewport.width < 500 ? 2 : 1,
    isMobile: viewport.width < 500,
    hasTouch: viewport.width < 500,
    ...(video ? { recordVideo: { dir: `${OUT}/video`, size: viewport } } : {}),
  });
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (LOCAL.has(url.hostname) || url.host === SERVER) return route.continue();
    errors.push(`${label}: blocked a request to ${url.origin}`);
    return route.abort();
  });
  const p = await ctx.newPage();
  p.label = label;
  p.setDefaultTimeout(30_000);
  p.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
  p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  p.on('dialog', (d) => d.accept());
  return p;
}

export const shots = [];
export async function shot(p, name, caption) {
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  shots.push({ name, caption });
  console.log('shot', name);
}

/**
 * A bot that plays from a real browser page by clicking the action bar.
 * style: 'call' (check/call), 'shove' (all in), 'mixed' (mostly call, some raises/folds).
 */
export function bot(p, style = 'call') {
  const b = { p, style, stop: false, rit: true };
  (async () => {
    while (!b.stop) {
      try {
        const bar = p.locator('.action-bar.my-turn');
        if (await bar.count()) {
          const texts = await bar.locator('.buttons button').allInnerTexts();
          const click = async (re) => {
            const now = await bar.locator('.buttons button').allInnerTexts();
            const i = now.findIndex((t) => re.test(t));
            if (i < 0) return false;
            await bar.locator('.buttons button').nth(i).click({ timeout: 2000 });
            return true;
          };
          if (texts.some((t) => /Run it twice/.test(t))) {
            if (b.rit !== null) await click(b.rit ? /^Run it twice/ : /^Run it once/);
          }
          else if (texts.some((t) => /Stand pat|^Draw/.test(t))) await click(/Stand pat|^Draw/);
          else if (b.style === 'shove') {
            const allIn = bar.locator('.presets button:has-text("All in")');
            if (await allIn.count()) {
              await allIn.click({ timeout: 2000 });
              await p.waitForTimeout(150);
              (await click(/^All in/)) || (await click(/^(Call|Check|Bring)/));
            } else (await click(/^All in|\(all in\)/)) || (await click(/^(Call|Check|Bring|Raise|Bet|Complete)/));
          } else if (b.style === 'mixed' && Math.random() < 0.25) {
            const pot = bar.locator('.presets button:has-text("½ pot")');
            if (await pot.count()) {
              await pot.click({ timeout: 2000 });
              await p.waitForTimeout(150);
              (await click(/^(Raise|Bet|All in)/)) || (await click(/^(Check|Call|Bring)/));
            } else await click(/^(Check|Call|Bring)/);
          } else if (b.style === 'fold') (await click(/^Check$/)) || (await click(/^Fold/)) || (await click(/^(Bring)/));
          else await click(/^(Check|Call|Bring)/);
          await p.waitForTimeout(250);
        }
        const rebuy = p.locator('.banner button:has-text("Add chips")');
        if (b.autoRebuy !== false && (await rebuy.count())) {
          await rebuy.click({ timeout: 2000 });
          await p.locator('.modal button.primary').click({ timeout: 3000 });
        }
        if (b.host) {
          const approve = p.locator('.request button:has-text("Approve")');
          if (await approve.count()) await approve.first().click({ timeout: 2000 });
        }
      } catch {}
      await p.waitForTimeout(300);
    }
  })();
  return b;
}

export async function handOver(p, timeout = 90_000) {
  await p.locator('.pot.result').first().waitFor({ timeout });
}
