// Browser smoke test: a cash table plays a hand, and a tournament seats its
// players and deals. Runs against a server that serves the built web app.
//
//   npm run build && npm start &            (or the dev servers)
//   BASE_URL=http://localhost:3001 node e2e/smoke.mjs
//
// Screenshots go to e2e/out/. Any console error fails the run.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:3001';
// It creates tables and a tournament with made-up players, so it never runs against the live site.
if (/fly\.dev/.test(BASE)) {
  console.error('smoke test refused: it would leave test tables and tournaments on the live site');
  process.exit(1);
}
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });
const errors = [];

const browser = await chromium.launch();

async function open(label, viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport });
  const p = await ctx.newPage();
  p.setDefaultTimeout(15_000);
  p.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
  p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  p.on('dialog', (d) => d.accept());
  return p;
}

/** Checks or calls for whoever is to act until the hand is over. */
async function playOut(players, maxSteps = 120) {
  for (let i = 0; i < maxSteps; i++) {
    let acted = false;
    for (const p of players) {
      const buttons = p.locator('.action-bar.my-turn .buttons button');
      const texts = await buttons.allInnerTexts();
      const pick = texts.findIndex((t) => /^(Check|Call|Stand pat|Bring in)/.test(t));
      if (pick >= 0) {
        await buttons.nth(pick).click().catch(() => {});
        acted = true;
        await p.waitForTimeout(200);
      }
    }
    if (await players[0].locator('.pot.result').count()) return;
    if (!acted) await players[0].waitForTimeout(250);
  }
  throw new Error('the hand did not finish');
}

async function step(name, fn) {
  const started = Date.now();
  await fn();
  console.log(`ok  ${name} (${Date.now() - started} ms)`);
}

try {
  await step('cash table: create, approve a seat, play a hand', async () => {
    const host = await open('cash host');
    const guest = await open('cash guest');
    await host.goto(BASE);
    await host.fill('input[required]', 'Ann');
    await host.click('button:has-text("Create table")');
    await host.waitForURL(/\/t\//);
    await host.locator('.seat.empty button').first().click();
    await host.click('button:has-text("Sit down")');
    await host.waitForSelector('.seat.me');

    await guest.goto(host.url());
    await guest.locator('.seat.empty button').nth(2).click();
    await guest.fill('.modal input[required]', 'Bob');
    await guest.click('button:has-text("Ask to sit")');
    await host.click('.request button:has-text("Approve")');
    await guest.waitForSelector('.seat.me');
    await host.click('button:has-text("Start game")');
    await host.waitForSelector('.seat .hole .playing-card');
    await playOut([host, guest]);
    await host.screenshot({ path: path.join(OUT, 'cash.png') });

    // A private note on Bob: saved, shown on his seat, and never shown to Bob.
    await host.click('.seat:not(.me) .note-badge');
    await host.click('.note-swatch.red');
    await host.fill('.note-text', 'Bluffs rivers');
    await host.click('.modal button:has-text("Save")');
    await host.waitForSelector('.seat:not(.me) .note-badge.has-note');
    await host.reload();
    await host.waitForSelector('.seat:not(.me) .note-badge.has-note');
    if (await guest.locator('.note-badge.has-note').count()) throw new Error('Bob can see a note');
    await host.screenshot({ path: path.join(OUT, 'notes.png') });

    // Bob picks a picture and a mood from his own seat; Ann sees both and throws him a gesture.
    await guest.click('.seat.me .nameplate');
    await guest.click('.avatar-pick[aria-label="fox"]');
    await guest.click('.mood-pick:has-text("🤠")');
    await guest.click('.modal button:has-text("Close")');
    await host.waitForSelector('.seat:not(.me) .seat-avatar .avatar:not(.initials)');
    await host.waitForSelector('.seat:not(.me) .seat-mood:has-text("🤠")');
    await host.click('.seat:not(.me) .nameplate');
    await host.click('.gesture-grid button[aria-label^="Fish"]');
    await guest.waitForSelector('.gesture-flight');
    await guest.screenshot({ path: path.join(OUT, 'gesture.png') });
    // B shows the felt in big blinds.
    await host.keyboard.press('b');
    await host.waitForSelector('.seat.me .stack:has-text("BB")');
    await host.keyboard.press('b');

    // Records: share the hand as a link anyone can open, and download the full log and tracker file.
    await host.click('.side-panel .tabs button:has-text("Hands")');
    await host.click('.hand-row .hand-text:has-text("Share")');
    await host.click('.modal button:has-text("Make a link")');
    const link = await host.locator('.share-hand input[readonly]').inputValue();
    await host.click('.modal button:has-text("Close")');
    const viewer = await open('shared hand viewer', { width: 390, height: 844 });
    await viewer.goto(link);
    await viewer.waitForSelector('.replayer .felt');
    await viewer.screenshot({ path: path.join(OUT, 'shared-hand.png') });
    await viewer.close();
    const ohh = host.waitForEvent('download');
    await host.click('button:has-text("Tracker (OHH)")');
    if (!(await ohh).suggestedFilename().endsWith('.ohh')) throw new Error('no OHH file');
    await host.click('.side-panel .tabs button:has-text("Log")');
    const log = host.waitForEvent('download');
    await host.click('button:has-text("Download full log")');
    if (!(await log).suggestedFilename().endsWith('-log.txt')) throw new Error('no full log');

    // Fair dealing: the hand is sealed while the game runs, and checks out once the host stops it.
    await guest.click('.side-panel .tabs button:has-text("Hands")');
    await guest.locator('.hand-open').first().click();
    await guest.click('.replayer button:has-text("Check this hand")');
    await guest.waitForSelector('.fair-check:has-text("Sealed")');
    await guest.click('.replayer button[aria-label="Close"]');
    await host.click('button:has-text("Stop game")');
    await host.waitForSelector('button:has-text("Start game")');
    await guest.waitForTimeout(500);
    await guest.locator('.hand-open').first().click();
    await guest.click('.replayer button:has-text("Check this hand")');
    await guest.waitForSelector('.fair-check:has-text("This hand checks out")');
    await guest.screenshot({ path: path.join(OUT, 'fair-check.png') });
    await guest.click('.replayer button[aria-label="Close"]');
  });

  await step('rules guides: open a game from its link and switch games', async () => {
    const p = await open('rules');
    await p.goto(`${BASE}/rules/badugi`);
    await p.waitForSelector('.guide-body h3:has-text("Badugi")');
    await p.click('.guide-chip:has-text("Razz")');
    await p.waitForSelector('.guide-body h3:has-text("Razz")');
    await p.close();
  });

  await step('side games: a PLO bomb pot on two boards at a Hold\'em table', async () => {
    const host = await open('side games host');
    const guest = await open('side games guest');
    await host.goto(BASE);
    await host.fill('input[required]', 'Dee');
    await host.click('button:has-text("Create table")');
    await host.waitForURL(/\/t\//);
    await host.locator('.seat.empty button').first().click();
    await host.click('button:has-text("Sit down")');
    await guest.goto(host.url());
    await guest.locator('.seat.empty button').nth(2).click();
    await guest.fill('.modal input[required]', 'Eli');
    await guest.click('button:has-text("Ask to sit")');
    await host.click('.request button:has-text("Approve")');
    await guest.waitForSelector('.seat.me');
    await host.click('button:has-text("Table settings")');
    await host.click('.tabs button:has-text("Side games")');
    await host.locator('label:has-text("Bomb pot game") select').selectOption('plo4');
    await host.locator('label.toggle:has-text("Deal two boards") input').check();
    await host.click('.modal button:has-text("Save")');
    await host.click('button:has-text("Bomb pot next hand")');
    await host.click('button:has-text("Start game")');
    await host.locator('.topbar:has-text("Bomb pot")').waitFor();
    await host.locator('.board-row').nth(1).waitFor();
    await playOut([host, guest]);
    await host.screenshot({ path: path.join(OUT, 'bomb-pot.png') });
  });

  await step('tournament: create, register with names, start, everyone taken to the table', async () => {
    const host = await open('tournament host');
    await host.goto(`${BASE}/tn/new`);
    await host.getByRole('radio', { name: 'When I start it' }).click();
    await host.locator('label:has-text("Name") input').first().fill('Smoke Cup');
    await host.getByRole('button', { name: 'Create tournament' }).click();
    await host.waitForURL(/\/tn\/[0-9a-f]+$/);
    const id = host.url().split('/').pop();

    const players = [host, await open('tournament player 2'), await open('tournament player 3', { width: 390, height: 844 })];
    const names = ['Hana', 'Bo', 'Cy'];
    for (const [i, p] of players.entries()) {
      if (i > 0) await p.goto(`${BASE}/tn/${id}`);
      await p.locator('.tn-name input').fill(names[i]);
      await p.getByRole('button', { name: /^Register/ }).click();
      await p.getByText("You're registered.").waitFor();
    }
    await host.getByRole('tab', { name: /^Host/ }).click();
    await host.getByRole('button', { name: 'Start now' }).click();

    const table = new RegExp(`/t/${id}-t1$`);
    for (const p of players) await p.waitForURL(table, { waitUntil: 'commit' });
    await host.locator('.tn-strip:has-text("Level 1")').waitFor();
    await host.waitForSelector('.seat .hole .playing-card');
    await playOut(players);
    const log = await host.locator('.side').innerText();
    for (const name of names) if (!log.includes(name)) throw new Error(`${name} was not in the first hand`);
    if (log.includes('(auto)')) throw new Error('a player was acted for automatically in the first hand');
    await host.screenshot({ path: path.join(OUT, 'tournament.png') });
  });

  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`);
  console.log('smoke test passed');
} catch (e) {
  console.error('smoke test FAILED:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
