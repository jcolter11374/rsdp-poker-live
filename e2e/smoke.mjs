// Browser smoke test: a cash table plays a hand, another bets, raises and folds,
// a practice hand against bots gives a coach tip, and a tournament seats its
// players and deals. Runs against a server that serves the built web app.
//
//   npm run build && npm start &            (or the dev servers)
//   BASE_URL=http://localhost:3001 node e2e/smoke.mjs
//
// Screenshots go to e2e/out/, and a failed step adds one of every open page. Any console error fails the run, and so
// does a serious or critical accessibility problem on the main pages (docs/ACCESSIBILITY.md).
// SMOKE_A11Y=report prints the accessibility problems instead of failing on them.

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { io } from 'socket.io-client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3001';
// It creates tables and a tournament with made-up players, so it never runs against the live site.
if (/fly\.dev/.test(BASE)) {
  console.error('smoke test refused: it would leave test tables and tournaments on the live site');
  process.exit(1);
}
// Only the server under test is ever contacted: any other request is blocked and fails the run.
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const SERVER = new URL(BASE).host;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });
const errors = [];
/** Every page the run opens, so a failed step can screenshot them all. */
const pages = [];
const a11y = [];
// Only the upgrade rehearsal (upgrade.yml) sets SMOKE_A11Y=report. It runs main's copy of this test, with the newer
// axe and Playwright a release brings, against main's image: a new rule there could flag what is already live, which
// that release can't change, though the data it makes is fine. CI's own smoke test always fails on these problems.
const A11Y = process.env.SMOKE_A11Y || 'fail';
if (A11Y !== 'fail' && A11Y !== 'report') {
  console.error(`SMOKE_A11Y is "fail" (the default) or "report", not "${A11Y}"`);
  process.exit(1);
}

const browser = await chromium.launch();

/** The WCAG 2.2 AA rules (with the 2.0 and 2.1 ones they build on) that axe checks. */
const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * An accessibility check that isn't axe's (a screen reader hears "Your turn"). Failing, it fails the run at once,
 * or with SMOKE_A11Y=report it is noted with axe's problems.
 */
async function a11yCheck(label, fn) {
  try {
    await fn();
  } catch (e) {
    if (A11Y !== 'report') throw e;
    a11y.push(`${label}: ${e.message.split('\n')[0]}`);
  }
}

/**
 * Checks the page as it is now with axe, and notes every serious or critical problem; any fails the run at the end.
 * Short animations (cards being dealt, chips flying) finish first, so nothing is checked half faded in.
 */
async function checkA11y(page, label) {
  await page.evaluate(() => {
    const short = document.getAnimations().filter((a) => {
      const t = a.effect?.getComputedTiming();
      return t && Number.isFinite(t.endTime) && t.endTime - Number(a.currentTime ?? 0) < 3000;
    });
    return Promise.race([Promise.all(short.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 4000))]);
  });
  await a11yCheck(`${label} (axe)`, async () => {
    const result = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
    for (const v of result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')) {
      a11y.push(`${label}: ${v.help} (${v.id}, ${v.impact}) at ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('; ')}`);
    }
  });
}

async function open(label, viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (LOCAL.has(url.hostname) || url.host === SERVER) return route.continue();
    errors.push(`${label}: blocked a request to ${url.origin}`);
    return route.abort();
  });
  return watch(await ctx.newPage(), label);
}

/** Another tab for the same browser (the same signed-in player), watched like the first. */
async function openTab(page, label) {
  return watch(await page.context().newPage(), label);
}

function watch(p, label) {
  pages.push({ p, label });
  p.setDefaultTimeout(15_000);
  p.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
  p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  p.on('dialog', (d) => d.accept());
  return p;
}

/**
 * Checks or calls for whoever is to act until the hand is over, for up to `seconds`. When everyone is all in it runs
 * the board once: the table does that anyway once nobody has answered for 12 seconds, so the hand ends the same way.
 * A hand here takes up to about 20 s. The limit stays under one turn that runs out (30 s, then the 30 s time bank),
 * so a move that never reaches the table fails here instead of passing when the table acts for the player.
 */
async function playOut(players, seconds = 45) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    let acted = false;
    for (const p of players) {
      const buttons = p.locator('.action-bar.my-turn .buttons button');
      const texts = await buttons.allInnerTexts();
      const pick = texts.findIndex((t) => /^(Check|Call|Stand pat|Bring in|Run it once)/.test(t));
      if (pick >= 0) {
        await buttons.nth(pick).click().catch(() => {});
        acted = true;
        await p.waitForTimeout(200);
      }
    }
    if (await players[0].locator('.pot.result').count()) return;
    if (!acted) await players[0].waitForTimeout(250);
  }
  const bars = await Promise.all(players.map((p) => p.locator('.action-bar').first().innerText({ timeout: 1000 }).catch(() => 'none')));
  throw new Error(`the hand did not finish in ${seconds} s; action bar: ${bars.map((b) => b.replace(/\s+/g, ' ').trim()).join(' / ')}`);
}

/**
 * Stops a cash game and waits until it has stopped. If the next hand was dealt before the click, the stop
 * waits for that hand to end, so it is played out (left alone, it would only end as everyone's clock ran down).
 */
async function stopGame(host, players) {
  await host.click('button:has-text("Stop game")');
  const stopped = host.locator('button:has-text("Start game")');
  await stopped.or(host.locator('button:has-text("Stopping after this hand")')).waitFor();
  if (!(await stopped.count())) await playOut(players);
  await stopped.waitFor();
}

/** Starts noting the table's size (its scale and the felt's height) every animation frame (#350). */
async function sampleTableSizes(page) {
  await page.evaluate(() => {
    const seen = (window.__tableSizes = new Set());
    const sample = () => {
      const felt = document.querySelector('.felt');
      if (felt) seen.add(`scale ${felt.style.getPropertyValue('--k')}, felt ${Math.round(felt.getBoundingClientRect().height)}px`);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

/** The table's sizes seen over a quarter of a second at this window size, after it has had time to settle. */
async function tableSizesAt(page, width, height) {
  // A change of width, so the bar under the table lets go of a taller size it held from an earlier height (Dock.tsx).
  await page.setViewportSize({ width: width - 1, height });
  await page.waitForTimeout(100);
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__tableSizes.clear());
  await page.waitForTimeout(250);
  return page.evaluate(() => [...window.__tableSizes]);
}

/**
 * Starts noting, every animation frame, the felt's size and place, the seats' scale and every player's seat spot: each
 * distinct combination is one layout. `layoutsSeen` stops and returns them, so one entry means nothing moved.
 */
const sampleLayouts = (p) =>
  p.evaluate(() => {
    const seen = (window.__layouts = new Set());
    const sample = () => {
      const felt = document.querySelector('.felt');
      if (felt) {
        const r = felt.getBoundingClientRect();
        // The players' seats. (Empty seats' markers can still shift a pixel or two when the first stacks change, which is
        // the seat spacing's business, not this check's.)
        const seats = [...felt.querySelectorAll('.seat[data-seat]')].map((s) => `${s.style.left},${s.style.top}`).join(' ');
        seen.add(`felt ${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.top)}, seats ${felt.style.getPropertyValue('--seat-scale')}: ${seats}`);
      }
      if (window.__layouts === seen) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
const layoutsSeen = (p) =>
  p.evaluate(() => {
    const s = [...window.__layouts];
    window.__layouts = null;
    return s;
  });

async function step(name, fn) {
  const started = Date.now();
  await fn();
  console.log(`ok  ${name} (${Date.now() - started} ms)`);
}

try {
  await step('accessibility: home, sign-in, sign-up and new tournament pages, on a computer and a phone', async () => {
    for (const [label, viewport] of [['computer', undefined], ['phone', { width: 390, height: 844 }]]) {
      const p = await open(`pages (${label})`, viewport);
      // Each page, and something that shows it has finished loading.
      for (const [route, ready] of [['/', 'input[required]'], ['/signin', 'form'], ['/signup', 'form'], ['/tn/new', 'button:has-text("Create tournament")']]) {
        await p.goto(`${BASE}${route}`);
        await p.locator(ready).first().waitFor();
        // Lists that arrive after the page (open tournaments on the home page) have a moment to land.
        await p.waitForTimeout(600);
        await checkA11y(p, `${route} (${label})`);
      }
      await p.close();
    }
  });

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
    // Two people in the hand: no coach tip for whoever is to act, not even with the T key.
    const first = await Promise.any([host, guest].map((p) => p.locator('.action-bar.my-turn').waitFor().then(() => p)));
    await first.keyboard.press('t');
    await first.waitForTimeout(300);
    for (const p of [host, guest]) if (await p.locator('.play-tip-button, #play-tip').count()) throw new Error('a coach tip showed in a hand between two people');
    // A screen reader hears that it's their turn, from a region nobody sees.
    await a11yCheck('table, your turn (read aloud)', () => first.locator('[role="log"]', { hasText: 'Your turn' }).waitFor({ state: 'attached' }));
    await checkA11y(first, 'table, your turn');
    await checkA11y(first === host ? guest : host, 'table, waiting to act');
    const watcher = await open('cash spectator');
    await watcher.goto(host.url());
    await watcher.waitForSelector('.seat .hole .playing-card');
    await checkA11y(watcher, 'table, watching');
    await watcher.close();
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
    // No hand downloads while seated in a running game (no live HUDs): a note says when they open.
    await host.waitForSelector('.side-panel .records-locked');
    if (await host.locator('button:has-text("Tracker (OHH)")').count()) throw new Error('tracker download offered mid-game');

    // Fair dealing: the hand is sealed while the game runs, and still for half an hour after the host stops it.
    // STOP_REVEAL_WAIT_MS: against a server started with a short fairStopRevealMs, wait that long and check it opens.
    await guest.click('.side-panel .tabs button:has-text("Hands")');
    await guest.locator('.hand-open').first().click();
    await guest.click('.replayer button:has-text("Check this hand")');
    await guest.waitForSelector('.fair-check:has-text("Sealed")');
    await guest.click('.replayer button[aria-label="Close"]');
    await stopGame(host, [host, guest]);
    await guest.waitForTimeout(500);
    await guest.locator('.hand-open').first().click();
    await guest.click('.replayer button:has-text("Check this hand")');
    await guest.waitForSelector('.fair-check:has-text("Sealed"):has-text("half an hour after the host stops the game")');
    await guest.click('.replayer button[aria-label="Close"]');
    const revealWait = Number(process.env.STOP_REVEAL_WAIT_MS ?? 0);
    if (revealWait > 0) {
      // No reload: the open page hears the hands have opened and fetches them again.
      await guest.waitForTimeout(revealWait);
      await guest.locator('.hand-open').first().click();
      await guest.click('.replayer button:has-text("Check this hand")');
      await guest.waitForSelector('.fair-check:has-text("This hand checks out")');
      await guest.screenshot({ path: path.join(OUT, 'fair-check.png') });
      await guest.click('.replayer button[aria-label="Close"]');
    }

    // With the game stopped, the tracker file and the full log download.
    await host.click('.side-panel .tabs button:has-text("Hands")');
    const ohh = host.waitForEvent('download');
    await host.click('button:has-text("Tracker (OHH)")');
    if (!(await ohh).suggestedFilename().endsWith('.ohh')) throw new Error('no OHH file');
    await host.click('.side-panel .tabs button:has-text("Log")');
    const log = host.waitForEvent('download');
    await host.click('button:has-text("Download full log")');
    if (!(await log).suggestedFilename().endsWith('-log.txt')) throw new Error('no full log');
  });

  await step('cash table: bet with a preset, raise from the bet box, fold', async () => {
    const host = await open('betting host');
    const guest = await open('betting guest');
    await host.goto(BASE);
    await host.fill('input[required]', 'Fay');
    await host.click('button:has-text("Create table")');
    await host.waitForURL(/\/t\//);
    await host.locator('.seat.empty button').first().click();
    await host.click('button:has-text("Sit down")');
    await host.waitForSelector('.seat.me');
    await guest.goto(host.url());
    await guest.locator('.seat.empty button').nth(2).click();
    await guest.fill('.modal input[required]', 'Gus');
    await guest.click('button:has-text("Ask to sit")');
    await host.click('.request button:has-text("Approve")');
    await guest.waitForSelector('.seat.me');
    await host.click('button:has-text("Start game")');

    const move = (p, label) => p.locator('.action-bar.my-turn .buttons button', { hasText: label });
    // A tap within half a second of your last move is taken as a double tap and ignored, so wait a little longer.
    const press = async (p, label) => {
      await move(p, label).waitFor();
      await p.waitForTimeout(600);
      await move(p, label).click();
    };
    // Heads up the button acts first before the flop and the big blind first after it.
    const button = await Promise.any([host, guest].map((p) => p.locator('.action-bar.my-turn').waitFor().then(() => p)));
    const blind = button === host ? guest : host;
    await press(button, /^Call/);
    await press(blind, /^Check/);

    // On the flop the big blind bets the pot from the presets...
    await move(blind, /^Bet /).waitFor();
    const smallest = await move(blind, /^Bet /).innerText();
    await blind.locator('.action-bar.my-turn .presets button', { hasText: /^Pot$/ }).click();
    const potBet = await move(blind, /^Bet /).innerText();
    if (potBet === smallest) throw new Error(`the Pot preset left the bet at "${smallest}"`);
    await press(blind, /^Bet /);

    // ...the button raises to twice the smallest raise, typed in the bet box...
    const box = button.locator('.action-bar.my-turn input[aria-label="Amount"]');
    await box.waitFor();
    const to = String(2 * Number(await box.getAttribute('min')));
    await box.fill(to);
    const raise = (await move(button, /^Raise to/).innerText()).split('\n')[0];
    if (!raise.includes(to)) throw new Error(`typed ${to} in the bet box but the button says "${raise}"`);
    await press(button, /^Raise to/);

    // ...and the big blind folds.
    await press(blind, /^Fold/);
    await host.waitForSelector('.pot.result');
    // Read the log before stopping: if the next hand is dealt first, the stop plays it out and the log moves on. Only
    // the log: the keyboard tip heads the side column for its first 20 s, and its own text says " folds".
    const log = await host.locator('.side-panel').innerText();
    for (const words of [' bets ', ' raises to ', ' folds']) if (!log.includes(words)) throw new Error(`the hand log has no "${words.trim()}"`);
    await host.screenshot({ path: path.join(OUT, 'betting.png') });
    // Stop the game: left running, the table would keep dealing and timing out after the run, and CI's backup
    // drill reads the leaderboard twice and wants it unchanged.
    await stopGame(host, [host, guest]);
  });

  await step('cash table: the seats stay put when the game starts', async () => {
    // Before the first hand, a banner above the table said to press Start game. It took height from the felt, so when it
    // went the felt grew and every seat slid to a new spot while the first cards came (#383). The middle of the table says
    // it now. On a laptop (the host, with the side column) and a wide, short screen (a player), from before the host
    // presses Start game until the cards are out, the felt keeps its size and no player's seat moves or changes size.
    const host = await open('start host', { width: 1280, height: 800 });
    const guest = await open('start guest', { width: 2300, height: 824 });
    await host.goto(BASE);
    await host.fill('input[required]', 'Lou');
    await host.click('button:has-text("Create table")');
    await host.waitForURL(/\/t\//);
    await host.locator('.seat.empty button').first().click();
    await host.click('button:has-text("Sit down")');
    await host.waitForSelector('.seat.me');
    await guest.goto(host.url());
    await guest.locator('.seat.empty button').nth(2).click();
    await guest.fill('.modal input[required]', 'Mo');
    await guest.click('button:has-text("Ask to sit")');
    await host.click('.request button:has-text("Approve")');
    await guest.waitForSelector('.seat.me');
    for (const [p, says] of [
      [host, 'press Start game'],
      [guest, 'Waiting for the host to start the game'],
    ]) {
      await p.locator('.felt .board-notice', { hasText: says }).waitFor();
      // (The host's "1 request is waiting" banner goes once the approval reaches the host's page.)
      await p.waitForFunction(() => !document.querySelector('.felt-area > .banner')).catch(async () => {
        throw new Error(`a banner above the table: ${await p.locator('.felt-area > .banner').first().innerText()}`);
      });
    }
    // The request banner has just gone, and seats glide to new spots in 0.4s.
    await host.waitForTimeout(900);
    await Promise.all([sampleLayouts(host), sampleLayouts(guest)]);
    await host.click('button:has-text("Start game")');
    for (const p of [host, guest]) await p.waitForSelector('.seat .hole .playing-card');
    await host.waitForTimeout(1000);
    for (const [p, who] of [
      [host, 'the host at 1280x800'],
      [guest, 'a player at 2300x824'],
    ]) {
      const seen = await layoutsSeen(p);
      if (seen.length !== 1) throw new Error(`for ${who}, the table moved when the game started:\n  ${seen.join('\n  ')}`);
      if (await p.locator('.felt .board-notice').count()) throw new Error(`for ${who}, the middle of the table still says to start the game`);
    }
    await host.screenshot({ path: path.join(OUT, 'started.png') });
    await stopGame(host, [host, guest]);
    // Stopped, the middle of the table says so, under the last hand's result, and the dealer button (which would sit on
    // the note) is gone.
    await host.locator('.felt .board-notice', { hasText: 'The game is stopped' }).waitFor();
    await guest.locator('.felt .board-notice', { hasText: 'Waiting for the host to start it again' }).waitFor();
    for (const p of [host, guest]) if (await p.locator('.felt .dealer').count()) throw new Error('the dealer button is still on the table after the game stopped');
  });

  await step('cash table: the seats stay put when a note comes or goes mid-hand', async () => {
    // A seat request for the host, sitting out, and "the host is stopping the game after this hand" were banners above the
    // table. Each took height from the felt, so every seat moved and changed size when one came or went, usually in the
    // middle of a hand (#388). They sit under the table now, in room that area already holds, and give way to the betting
    // buttons on your turn. A host on a laptop and a player on a wide, short screen, sampled every frame from the deal
    // while a newcomer asks to sit and cancels, the player sits out and comes back, and the host stops after the hand.
    const host = await open('notes host', { width: 1280, height: 800 });
    const guest = await open('notes guest', { width: 2300, height: 824 });
    await host.goto(BASE);
    await host.fill('input[required]', 'Kim');
    await host.click('button:has-text("Create table")');
    await host.waitForURL(/\/t\//);
    await host.locator('.seat.empty button').first().click();
    await host.click('button:has-text("Sit down")');
    await host.waitForSelector('.seat.me');
    await guest.goto(host.url());
    await guest.locator('.seat.empty button').nth(2).click();
    await guest.fill('.modal input[required]', 'Ned');
    await guest.click('button:has-text("Ask to sit")');
    await host.click('.request button:has-text("Approve")');
    await guest.waitForSelector('.seat.me');
    await host.click('button:has-text("Start game")');
    for (const p of [host, guest]) await p.waitForSelector('.seat .hole .playing-card');
    // The first cards are still flying in.
    await host.waitForTimeout(1000);
    await Promise.all([sampleLayouts(host), sampleLayouts(guest)]);
    // On your turn the notes give way to the betting buttons; nobody acts in this step, so whose turn it is holds.
    const myTurn = async (p) => (await p.locator('.action-bar.my-turn').count()) > 0;
    // (A banner above the table counts here too, so that if one came back, the layout check below is what says so.)
    const note = (p, text) => p.locator('.dock .dock-notes, .felt-area > .banner', { hasText: text }).first();

    // A newcomer asks to sit, then thinks better of it.
    const newcomer = await open('notes newcomer', { width: 390, height: 664 });
    await newcomer.goto(host.url());
    await newcomer.locator('.seat.empty button').first().click();
    await newcomer.fill('.modal input[required]', 'Oz');
    await newcomer.click('button:has-text("Ask to sit")');
    await host.locator('.request').waitFor();
    if (!(await myTurn(host))) await note(host, '1 request is waiting for you').waitFor();
    await newcomer.click('.felt-area > .banner button:has-text("Cancel")');
    await host.locator('.request').waitFor({ state: 'detached' });
    await note(host, 'request').waitFor({ state: 'detached' });

    // Whoever isn't on turn sits out (staying in this hand), then comes back. (Sitting out on your own turn times the turn
    // out at once: a fold, which would end the hand heads-up.)
    const waiting = (await myTurn(guest)) ? host : guest;
    await waiting.click('header button:has-text("Sit out")');
    await note(waiting, "You're sitting out").waitFor();
    await waiting.click(`header button:has-text("I'm back")`);
    await note(waiting, 'sitting out').waitFor({ state: 'detached' });

    // The host stops the game after this hand: everyone is told.
    await host.click('button:has-text("Stop game")');
    for (const p of [host, guest]) if (!(await myTurn(p))) await note(p, 'The host is stopping the game after this hand').waitFor();
    // Seats glide for 0.4s, so a move would have shown by now.
    await host.waitForTimeout(600);
    for (const [p, who] of [
      [host, 'the host at 1280x800'],
      [guest, 'a player at 2300x824'],
    ]) {
      const seen = await layoutsSeen(p);
      if (seen.length !== 1) throw new Error(`for ${who}, the table moved when a note came or went:\n  ${seen.join('\n  ')}`);
      if (await p.locator('.felt-area > .banner').count()) throw new Error(`for ${who}, a banner above the table: ${await p.locator('.felt-area > .banner').first().innerText()}`);
    }
    await waiting.screenshot({ path: path.join(OUT, 'mid-hand-notes.png') });
    // Finish the hand, so the game stops.
    await playOut([host, guest]);
    await host.locator('button:has-text("Start game")').waitFor();
  });

  await step('practice: a hand against bots, with a coach tip on your turn', async () => {
    const p = await open('practice');
    await p.goto(BASE);
    await p.fill('input[required]', 'Pia');
    await p.click('button:has-text("Practice with bots")');
    await p.waitForURL(/\/t\//);
    // The bots play on their own, and a hand folded round to Pia's big blind ends without her turn, so allow a few hands.
    const pill = p.locator('.action-bar.my-turn .play-tip-button');
    await pill.waitFor({ timeout: 60_000 });
    await pill.click();
    const tip = p.locator('#play-tip');
    await tip.filter({ hasText: /to win|of the pot|Draw|Stand pat/ }).waitFor().catch(async () => {
      throw new Error(`no tip, the panel said: ${(await tip.innerText().catch(() => 'nothing')).trim()}`);
    });
    await p.screenshot({ path: path.join(OUT, 'practice-tip.png') });
    // Stopped like the cash tables: closed mid-hand, the hand would only end as Pia's clock ran out, after the
    // run, and CI's backup drill would find the public record had moved on since it read it.
    await stopGame(p, [p]);
    await p.close();
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
    // Stopped like the other cash tables, so it isn't still dealing when CI's backup drill runs.
    await stopGame(host, [host, guest]);
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
    await checkA11y(host, 'tournament lobby, host');
    await checkA11y(players[2], 'tournament lobby (phone)');
    // The lobby chat with messages in it: your own (on its redder background) and another player's, with the host's
    // Hide, Mute and Delete beside them.
    for (const [p, text] of [
      [host, 'Good luck, everyone'],
      [players[2], 'Thanks, you too'],
    ]) {
      await p.getByRole('tab', { name: /^Chat/ }).click();
      await p.getByRole('textbox', { name: 'Message' }).fill(text);
      await p.getByRole('button', { name: 'Send' }).click();
      await p.locator('.tn-chat-list li.mine', { hasText: text }).waitFor();
    }
    await host.locator('.tn-chat-list li', { hasText: 'Thanks, you too' }).getByRole('button', { name: 'Mute' }).waitFor();
    await players[2].locator('.tn-chat-list li', { hasText: 'Good luck, everyone' }).waitFor();
    await checkA11y(host, 'tournament lobby chat, host');
    await checkA11y(players[2], 'tournament lobby chat (phone)');
    // The host starts from the card by the clock, without opening the Host tab.
    await host.locator('.tn-host-start').getByRole('button', { name: 'Start now' }).click();

    const table = new RegExp(`/t/${id}-t1$`);
    for (const p of players) await p.waitForURL(table, { waitUntil: 'commit' });
    await host.locator('.tn-strip:has-text("Level 1")').waitFor();
    await host.waitForSelector('.seat .hole .playing-card');
    await players[2].waitForSelector('.seat .hole .playing-card');
    await checkA11y(players[2], 'tournament table (phone)');
    await playOut(players);
    const log = await host.locator('.side').innerText();
    for (const name of names) if (!log.includes(name)) throw new Error(`${name} was not in the first hand`);
    if (log.includes('(auto)')) throw new Error('a player was acted for automatically in the first hand');
    await host.screenshot({ path: path.join(OUT, 'tournament.png') });

    // A wide, short window (John's is about 2300x824): the tournament's clock moves to the bottom-right corner, so the
    // table gets the same big layout a cash table gets there. The strip above it used to take just enough height to
    // drop the seats and cards to their smallest size (#385). Frame by frame, it holds that one size (#350).
    await host.setViewportSize({ width: 2300, height: 824 });
    await host.locator('.tn-corner:has-text("Level 1")').waitFor();
    if (await host.locator('.tn-strip').count()) throw new Error('the tournament strip still takes room above the table on a wide window');
    // A rebuy offer or an add-on goes under the table there, in a spot that takes no room while nothing is asked. (On
    // your turn the spot is hidden anyway, so this looks at it off turn: the next hand waits for the showdown.)
    const asks = await host.locator('.dock-notes.tournament-asks:not(.your-turn)').evaluate((el) => `${el.childElementCount} inside, display ${getComputedStyle(el).display}`);
    if (asks !== '0 inside, display none') throw new Error(`the empty spot for tournament asks under the table takes room (${asks})`);
    await sampleTableSizes(host);
    for (const h of [824, 800]) {
      const sizes = await tableSizesAt(host, 2300, h);
      if (sizes.length !== 1) throw new Error(`a tournament table at 2300x${h} kept changing size: ${sizes.join(' / ')}`);
      const k = await host.locator('.felt').evaluate((el) => parseFloat(el.style.getPropertyValue('--k')));
      if (!(k >= 1)) throw new Error(`a tournament table at 2300x${h} stayed small (scale ${k})`);
      if (h === 824) await host.screenshot({ path: path.join(OUT, 'tournament-wide-short.png') });
    }
    // The Log drawer is a little narrower than the box: the box goes while the drawer is open, rather than peek out.
    await host.click('.drawer-button');
    await host.locator('.tn-corner').waitFor({ state: 'hidden' });
    await host.click('.drawer-button');
    await host.locator('.tn-corner').waitFor();
    await host.setViewportSize({ width: 1280, height: 860 });

    // The host ends it early the way the Host tab asks (pause, let the hand in progress finish, end), so its
    // table isn't still dealing when CI's backup drill runs. The players stay at the table to finish that hand.
    const lobby = await openTab(host, 'tournament host lobby');
    await lobby.goto(`${BASE}/tn/${id}`);
    await lobby.getByRole('tab', { name: /^Host/ }).click();
    await lobby.getByRole('button', { name: 'Pause', exact: true }).click();
    await lobby.locator('.tn-status-paused').waitFor();
    const finished = lobby.locator('.tn-status-finished');
    for (let tries = 0; !(await finished.count()); tries++) {
      if (tries === 10) throw new Error('the tournament did not end');
      // A hand dealt before the pause is still being played: play it out first.
      if (!(await host.locator('.pot.result').count())) await playOut(players);
      // The director may not have heard the hand end yet, and then refuses: try again.
      await lobby.getByRole('button', { name: 'End and rank by chips' }).click();
      await finished.waitFor({ timeout: 2000 }).catch(() => {});
    }
  });

  await step('wide desktop: a bigger table, chat in the corner, the log behind a button', async () => {
    const host = await open('wide host', { width: 1920, height: 1080 });
    await host.goto(BASE);
    await host.fill('input[required]', 'Wen');
    await host.click('button:has-text("Create table")');
    await host.waitForURL(/\/t\//);
    await host.locator('.seat.empty button').first().click();
    await host.click('button:has-text("Sit down")');
    await host.waitForSelector('.seat.me');
    // No side column: chat is in the corner, and the table has grown into the room.
    if (await host.locator('aside.side:not(.drawer)').count()) throw new Error('the side column is still there on a wide window');
    await host.locator('.corner-chat .chat-form input').waitFor();
    await host.locator('.felt.grown').waitFor();
    const scale = await host.locator('.felt').evaluate((el) => parseFloat(el.style.getPropertyValue('--seat-scale')));
    if (!(scale > 1.1)) throw new Error(`the seats didn't grow on a wide window (scale ${scale})`);
    // A host whose game hasn't started sees the panel open, with Start game in it; the top bar's button closes it.
    await host.locator('.side.drawer.open button:has-text("Start game")').waitFor();
    await host.click('.drawer-button');
    await host.locator('.side.drawer:not(.open)').waitFor();
    await host.locator('button:has-text("Start game")').waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {
      throw new Error('Start game still shows with the panel closed');
    });
    await host.click('.drawer-button');
    await host.locator('.side.drawer.open').waitFor();
    await host.keyboard.press('Escape');
    await host.locator('.side.drawer:not(.open)').waitFor();
    // Enter jumps into the corner chat, and a message shows there.
    await host.evaluate(() => document.activeElement?.blur());
    await host.keyboard.press('Enter');
    const focused = await host.evaluate(() => !!document.activeElement?.closest('.corner-chat'));
    if (!focused) throw new Error('Enter did not jump into the corner chat');
    await host.keyboard.type('hello from the corner');
    await host.keyboard.press('Enter');
    await host.locator('.corner-chat .chat-line:has-text("hello from the corner")').waitFor();
    await host.screenshot({ path: path.join(OUT, 'wide.png') });
  });

  await step('wide, short window: the table holds still', async () => {
    // A wide, short screen (a laptop on a big monitor) once made the whole table twitch between two sizes (#350): the
    // keyboard tip changed the felt's height as it came and went, and a rounding loop flipped the scale back and forth.
    // Across a range of window heights, the table must settle on one size, and the same size with or without the tip.
    const host = await open('short host', { width: 2300, height: 800 });
    const guest = await open('short guest');
    await host.goto(BASE);
    await host.fill('input[required]', 'Sid');
    await host.click('button:has-text("Create table")');
    await host.waitForURL(/\/t\//);
    await host.locator('.seat.empty button').first().click();
    await host.click('button:has-text("Sit down")');
    await host.waitForSelector('.seat.me');
    await guest.goto(host.url());
    await guest.locator('.seat.empty button').nth(2).click();
    await guest.fill('.modal input[required]', 'Kim');
    await guest.click('button:has-text("Ask to sit")');
    await host.click('.request button:has-text("Approve")');
    await guest.waitForSelector('.seat.me');
    await host.click('button:has-text("Start game")');
    await host.waitForSelector('.seat .hole .playing-card');
    if (await host.locator('.side.drawer.open').count()) await host.keyboard.press('Escape');
    // A fresh visit, so the tip's 20 seconds start now and it is still up when the first sweep ends.
    await host.reload();
    await host.waitForSelector('.seat .hole .playing-card');
    if (await host.locator('.side.drawer.open').count()) await host.keyboard.press('Escape');
    await host.locator('.tip-toast').waitFor();
    await sampleTableSizes(host);
    const sweep = async (from, to) => {
      const sizes = [];
      for (let h = from; h <= to; h += 12) {
        const seen = await tableSizesAt(host, 2300, h);
        if (seen.length !== 1) throw new Error(`at 2300x${h} the table kept changing size: ${seen.join(' / ')}`);
        sizes.push(seen[0]);
      }
      return sizes;
    };
    const withTip = await sweep(760, 880);
    if (!(await host.locator('.tip-toast').count())) throw new Error('the keyboard tip went before the sweep with it was done');
    await host.click('.tip-toast button:has-text("Got it")');
    const withoutTip = await sweep(760, 880);
    withTip.forEach((s, i) => {
      if (s !== withoutTip[i]) throw new Error(`at 2300x${760 + 12 * i} the keyboard tip changed the table's size: ${s} with it, ${withoutTip[i]} without`);
    });
    // Shorter still, where the table keeps shrinking below its usual size down to the smallest seats (#385), rather than
    // dropping to the laptop layout (where the table has no scale of its own) as soon as there isn't room for scale 1.
    const low = await sweep(604, 748);
    const scales = low.map((s) => parseFloat(s.slice('scale '.length)));
    scales.forEach((k, i) => {
      if (!(k >= 0.72 && k < 1.05)) throw new Error(`at 2300x${604 + 12 * i} the table didn't keep the big-table layout at a smaller size: ${low[i]}`);
      if (i && k < scales[i - 1]) throw new Error(`at 2300x${604 + 12 * i} the table got smaller as the window got taller: ${low[i - 1]}, then ${low[i]}`);
    });
    await host.setViewportSize({ width: 2300, height: 800 });
    await host.click('.drawer-button');
    await stopGame(host, [host, guest]);
  });

  await step("phone: other players' cards keep off their neighbours' names and stacks", async () => {
    // On a phone, the row of cards above a player's nameplate once covered the next player's name and stack, most of all at
    // full Omaha tables, in the top corners (#318). A full 9-seat Omaha table, four cards each: at each phone size, no row
    // of cards, yours included, covers another player's name or stack, and none goes off the screen.
    const host = await open('phone host');
    await host.goto(BASE);
    await host.fill('input[required]', 'Pat');
    await host.selectOption('label:has-text("Game") select', 'plo4');
    await host.click('button:has-text("Create table")');
    await host.waitForURL(/\/t\//);
    await host.locator('.seat.empty button').first().click();
    await host.click('button:has-text("Sit down")');
    await host.waitForSelector('.seat.me');
    // Everyone else sits down: seats fill in order, so the table is full and the rows are side by side.
    const guests = [];
    for (const name of ['Bea', 'Cal', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy']) {
      const guest = await open(`phone guest ${name}`);
      await guest.goto(host.url());
      await guest.locator('.seat.empty button').first().click();
      await guest.fill('.modal input[required]', name);
      await guest.click('button:has-text("Ask to sit")');
      await host.click('.request button:has-text("Approve")');
      await guest.waitForSelector('.seat.me');
      guests.push(guest);
    }
    await host.click('button:has-text("Start game")');
    await host.waitForFunction(() => document.querySelectorAll('.seat:not(.me) .hole:not(.mucked) .playing-card').length === 32);
    for (const [width, height] of [[390, 844], [390, 664], [360, 640], [430, 932]]) {
      await host.setViewportSize({ width, height });
      // Seats glide to their new spots (0.4s), then the rows are set out.
      await host.waitForTimeout(800);
      const problems = await host.evaluate(() => {
        const box = (el) => el.getBoundingClientRect();
        const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        const seats = [...document.querySelectorAll('.felt .seat[data-seat]')];
        const found = [];
        // Your own cards too: they move aside, and get smaller only if they must.
        for (const s of seats) {
          const hole = s.querySelector('.hole:not(.mucked)');
          if (!hole?.querySelector('.playing-card')) continue;
          const row = box(hole);
          // innerText leaves out the host's tag, which phones hide.
          const name = s.querySelector('.name')?.innerText;
          if (row.left < 0 || row.right > innerWidth) found.push(`${name}'s cards go off the screen`);
          for (const o of seats) {
            if (o === s) continue;
            for (const part of o.querySelectorAll('.nameplate .name, .nameplate .stack'))
              if (hit(row, box(part))) found.push(`${name}'s cards cover ${o.querySelector('.name')?.innerText}'s ${part.classList.contains('name') ? 'name' : 'stack'}`);
          }
        }
        return found;
      });
      if (problems.length) throw new Error(`at ${width}x${height}: ${problems.join(', ')}`);
      await host.screenshot({ path: path.join(OUT, `phone-omaha-${width}x${height}.png`) });
    }
    await host.setViewportSize({ width: 1280, height: 860 });
    await stopGame(host, [host, ...guests]);
  });

  await step('wide, short window: run it twice stays clear of the seats', async () => {
    // On a wide, short screen the two runs of the board went under the top player's nameplate, and the winners' lines and
    // "Next hand in" onto the bottom player's cards (#417). The middle now fits between them, and the seats hold still.
    const host = await open('two runs host', { width: 2300, height: 824 });
    const guest = await open('two runs guest');
    await host.goto(BASE);
    await host.fill('input[required]', 'Hal');
    await host.click('button:has-text("Create table")');
    await host.waitForURL(/\/t\//);
    await host.locator('.seat.empty button').first().click();
    await host.click('button:has-text("Sit down")');
    await host.waitForSelector('.seat.me');
    await guest.goto(host.url());
    await guest.locator('.seat.empty button').nth(2).click();
    await guest.fill('.modal input[required]', 'Ivy');
    await guest.click('button:has-text("Ask to sit")');
    await host.click('.request button:has-text("Approve")');
    await guest.waitForSelector('.seat.me');
    await host.click('button:has-text("Table settings")');
    await host.click('.tabs button:has-text("Rules")');
    await host.locator('label:has-text("Run it twice") select').selectOption('always');
    await host.click('.modal button:has-text("Save")');
    await host.click('button:has-text("Start game")');
    await host.waitForSelector('.seat .hole .playing-card');
    if (await host.locator('.side.drawer.open').count()) await host.keyboard.press('Escape');
    await sampleLayouts(host);

    // The first to act moves all in and the other calls, so the board is run twice.
    const move = (p, label) => p.locator('.action-bar.my-turn .buttons button', { hasText: label });
    const first = await Promise.any([host, guest].map((p) => p.locator('.action-bar.my-turn').waitFor().then(() => p)));
    const other = first === host ? guest : host;
    // The preset's text is "All in" and its keyboard hint (⇧A).
    await first.locator('.action-bar.my-turn .presets button', { hasText: /^All in/ }).click();
    await first.waitForTimeout(600);
    await move(first, /^All in/).click();
    await move(other, /^Call/).waitFor();
    await other.waitForTimeout(600);
    await move(other, /^Call/).click();
    // An all in before the flop is run out a card at a time, both runs about 20 seconds; the second run's row comes
    // with its first card, about 14 seconds in.
    await host.locator('.board-row').nth(1).waitFor({ timeout: 30000 });
    await host.locator('.pot.result').first().waitFor({ timeout: 30000 });
    // "Next hand in" follows unless a player is out of chips.
    await host.locator('.board .next-hand').waitFor({ timeout: 5000 }).catch(() => {});
    await host.waitForTimeout(1500);
    const covered = await host.evaluate(() => {
      const box = (e) => e.getBoundingClientRect();
      const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const middle = [...document.querySelectorAll('.felt .board .playing-card, .felt .board .pot.result, .felt .board .next-hand')];
      const seats = [...document.querySelectorAll('.felt .seat:not(.empty) .nameplate, .felt .seat .hole .playing-card')];
      const out = [];
      for (const m of middle) for (const s of seats) if (area(box(m), box(s)) > 4) out.push(`${m.textContent.trim().slice(0, 30) || m.className} on ${s.closest('.seat').querySelector('.name')?.textContent ?? 'a seat'}`);
      return out;
    });
    await host.screenshot({ path: path.join(OUT, 'run-it-twice-wide.png') });
    if (covered.length) throw new Error(`at 2300x824 the middle of the table covers a player: ${[...new Set(covered)].join('; ')}`);
    const layouts = await layoutsSeen(host);
    if (layouts.length !== 1) throw new Error(`the seats moved during the hand: ${layouts.join(' / ')}`);
    // Host controls are behind the drawer button in this layout.
    await host.click('.drawer-button');
    await stopGame(host, [host, guest]);
  });

  await step('Omaha on a laptop: no nameplate covers another, and the seats hold still', async () => {
    // Four-card Omaha has the widest nameplates. At a nine-seat table on a 1280x800 window, the seats once ran out of room
    // and went back to even spacing, and your nameplate covered the next player's (#363).
    const p = await open('omaha layout', { width: 1280, height: 800 });
    await p.goto(BASE);
    await p.fill('input[required]', 'Oli');
    await p.selectOption('label:has-text("Game") select', 'plo4');
    await p.selectOption('.home-practice label:has-text("Bots") select', '3');
    await p.click('button:has-text("Practice with bots")');
    await p.waitForURL(/\/t\//);
    await p.waitForSelector('.seat.me .hole .playing-card');
    if (await p.locator('.side.drawer.open').count()) await p.keyboard.press('Escape');
    // Every nameplate (with the cards beside it) and empty seat, against every other: which ones overlap.
    const covered = () =>
      p.evaluate(() => {
        const box = (el) => el.getBoundingClientRect();
        const seats = [...document.querySelectorAll('.felt .seat[data-seat]')].map((el) => {
          const hole = el.querySelector('.hole:not(.mucked)');
          // Cards sliding to or back from the muck are on their way, not where they sit.
          const cards = hole && hole.childElementCount && getComputedStyle(hole).transform === 'none' ? box(hole) : null;
          return { name: `seat ${Number(el.dataset.seat) + 1}`, plate: box(el.querySelector('.nameplate')), cards };
        });
        const empties = [...document.querySelectorAll('.felt .seat.empty')].map((el, i) => ({ name: `empty seat ${i + 1}`, plate: box(el) }));
        const over = (a, b) => a && b && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        const found = [];
        seats.forEach((a, i) => {
          for (const b of [...seats.slice(i + 1), ...empties]) {
            if (over(a.plate, b.plate)) found.push(`${a.name} and ${b.name}`);
            else if (over(a.cards, b.plate) || over(b.cards, a.plate)) found.push(`${a.name}'s or ${b.name}'s cards`);
          }
        });
        return found;
      });
    const check = async (what) => {
      // Seats glide to new places in 0.4s.
      await p.waitForTimeout(900);
      const found = await covered();
      if (found.length) throw new Error(`${what}: these overlap: ${found.join(', ')}`);
    };
    const addBots = async (count) => {
      for (let i = 0; i < count; i++) {
        await p.locator('.seat.empty .add-bot').first().click();
        await p.click('.modal button.primary:has-text("Add")');
        await p.locator('.modal').waitFor({ state: 'detached' });
      }
    };
    await check('four players at 1280x800');
    await p.setViewportSize({ width: 2300, height: 824 });
    await check('four players at 2300x824');
    await p.setViewportSize({ width: 1280, height: 800 });
    await addBots(2);
    await check('six players at 1280x800');
    await addBots(3);
    await check('nine players at 1280x800');
    // Oli checks or calls when it's her turn, so the hands play on instead of waiting on her clock.
    const play = async (ms) => {
      const buttons = p.locator('.action-bar.my-turn .buttons button');
      for (const end = Date.now() + ms; Date.now() < end; ) {
        const pick = (await buttons.allInnerTexts().catch(() => [])).findIndex((t) => /^(Check|Call)/.test(t));
        if (pick >= 0) await buttons.nth(pick).click({ timeout: 2000 }).catch(() => {});
        await p.waitForTimeout(250);
      }
    };
    // Wait for a hand dealt after the last bot sat down (Oli's cards change), so the seats are where they'll stay.
    const hand = () => p.locator('.seat.me .hole .playing-card').evaluateAll((cards) => cards.map((c) => c.getAttribute('aria-label')).join());
    const before = await hand();
    for (let i = 0; i < 120 && (await hand()) === before; i++) await play(500);
    await p.waitForTimeout(900);
    // Frame to frame, the seats stay where they are while the hands play: cards dealt, bets, folds and the lines under
    // the nameplates coming and going (#350's twitch, #363's spacing).
    await p.evaluate(() => {
      const seen = (window.__spots = new Set());
      const sample = () => {
        seen.add([...document.querySelectorAll('.felt .seat')].map((s) => `${s.style.left},${s.style.top}`).join(' '));
        if (window.__spots === seen) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await play(8000);
    const spots = await p.evaluate(() => {
      const n = window.__spots.size;
      window.__spots = null;
      return n;
    });
    if (spots !== 1) throw new Error(`the seats moved ${spots - 1} times in eight seconds of play`);
    await p.screenshot({ path: path.join(OUT, 'omaha-laptop.png') });
    await stopGame(p, [p]);
    await p.close();
  });

  await step("Dealer's choice: the Pick button leaves the top bar the same height", async () => {
    // The next chooser's Pick next game button once squeezed the top bar's line onto a second line, so the bar grew and
    // the table shrank and moved mid-hand (#408). At each window size the bar must be as tall with the button as without.
    const p = await open('pick button', { width: 1280, height: 800 });
    await p.goto(BASE);
    await p.fill('input[required]', 'Pia');
    await p.selectOption('label:has-text("Game") select', 'choice');
    await p.selectOption('.home-practice label:has-text("Bots") select', '1');
    await p.click('button:has-text("Practice with bots")');
    await p.waitForURL(/\/t\//);
    const picker = p.locator('.modal[aria-label="Pick the next game"]');
    const pickButton = p.locator('.topbar .pick-button');
    // Pia picks when it's her turn to, and checks or folds, until the bot's pick is on its last hand and she picks next.
    const buttons = p.locator('.action-bar.my-turn .buttons button');
    // When Pia's own pick starts, the button can show for a frame before the picker opens by itself, so it only counts
    // if it is still there, with no picker, a moment later.
    const pickShowing = async () => (await pickButton.count()) > 0 && !(await picker.count());
    const pickReady = async () => {
      if (!(await pickShowing())) return false;
      await p.waitForTimeout(300);
      return pickShowing();
    };
    for (const end = Date.now() + 150_000; !(await pickReady()); ) {
      if (Date.now() > end) throw new Error('Pia never got the Pick next game button');
      if (await picker.count()) {
        await picker.locator('.game-picker-pick:not(:disabled)').first().click().catch(() => {});
      } else {
        const texts = await buttons.allInnerTexts().catch(() => []);
        let i = texts.findIndex((t) => /^(Check|Stand pat|Bring in|Run it once)/.test(t));
        if (i < 0) i = texts.findIndex((t) => /^Fold/.test(t));
        if (i >= 0) await buttons.nth(i).click({ timeout: 2000 }).catch(() => {});
      }
      await p.waitForTimeout(250);
    }
    if (await p.locator('.side.drawer.open').count()) await p.keyboard.press('Escape');
    // Narrow computer windows too, where the bar is tighter and the button just says Pick.
    const sizes = [
      [760, 800],
      [900, 800],
      [1000, 800],
      [1280, 800],
      [2300, 824],
    ];
    const bars = async () => {
      const out = [];
      for (const [width, height] of sizes) {
        await p.setViewportSize({ width, height });
        await p.waitForTimeout(300);
        out.push(await p.locator('.topbar').evaluate((bar) => Math.round(bar.getBoundingClientRect().height)));
      }
      return out;
    };
    const withButton = await bars();
    if (!(await pickButton.count())) throw new Error('the Pick next game button went before the bar was measured');
    await pickButton.click();
    await picker.waitFor();
    const without = await bars();
    sizes.forEach(([width, height], i) => {
      if (withButton[i] !== without[i]) throw new Error(`at ${width}x${height} the Pick button changed the top bar's height: ${withButton[i]}px with it, ${without[i]}px without`);
    });
    await picker.locator('.game-picker-pick:not(:disabled)').first().click();
    await picker.waitFor({ state: 'detached' });
    // Back to a laptop window, where Stop game is in the side column.
    await p.setViewportSize({ width: 1280, height: 800 });
    await stopGame(p, [p]);
    await p.close();
  });

  await step('HORSE on a laptop: the seats stay put when the game changes', async () => {
    // A mixed table is laid out once for every game it deals. Once, the seats were placed again for each game's hands, so
    // they slid round the table when Limit Hold'em gave way to Omaha hi-lo (#409).
    const p = await open('mixed layout', { width: 1280, height: 800 });
    await p.goto(BASE);
    await p.fill('input[required]', 'Oli');
    await p.selectOption('label:has-text("Game") select', 'mix:horse');
    await p.selectOption('.home-practice label:has-text("Bots") select', '3');
    await p.click('button:has-text("Practice with bots")');
    await p.waitForURL(/\/t\//);
    await p.waitForSelector('.seat.me .hole .playing-card');
    if (await p.locator('.side.drawer.open').count()) await p.keyboard.press('Escape');
    const play = async (ms) => {
      const buttons = p.locator('.action-bar.my-turn .buttons button');
      for (const end = Date.now() + ms; Date.now() < end; ) {
        const pick = (await buttons.allInnerTexts().catch(() => [])).findIndex((t) => /^(Check|Call)/.test(t));
        if (pick >= 0) await buttons.nth(pick).click({ timeout: 2000 }).catch(() => {});
        await p.waitForTimeout(250);
      }
    };
    // From the second Hold'em hand (the first deal's settling is over) until a while after Omaha hi-lo is dealt.
    const cards = p.locator('.seat.me .hole .playing-card');
    const hand = () => cards.evaluateAll((all) => all.map((c) => c.getAttribute('aria-label')).join());
    const first = await hand();
    for (let i = 0; i < 120 && (await hand()) === first; i++) await play(500);
    await p.waitForTimeout(900);
    await p.evaluate(() => {
      const at = () => [...document.querySelectorAll('.felt .seat')].map((s) => [parseFloat(s.style.left), parseFloat(s.style.top)]);
      const start = at();
      window.__moved = 0;
      const sample = () => {
        if (window.__moved === null) return;
        const now = at();
        if (now.length === start.length) now.forEach(([x, y], i) => (window.__moved = Math.max(window.__moved, Math.hypot(x - start[i][0], y - start[i][1]))));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    let omaha = false;
    for (let i = 0; i < 360 && !omaha; i++) {
      await play(500);
      omaha = (await cards.count()) === 4;
    }
    if (!omaha) throw new Error('Omaha hi-lo was never dealt');
    await play(4000);
    const moved = await p.evaluate(() => {
      const most = window.__moved;
      window.__moved = null;
      return Math.round(most);
    });
    // A few pixels are allowed: if the table's size changes by a pixel or two, the seats keep their places round it and so
    // move with its edge.
    if (moved > 12) throw new Error(`a seat moved ${moved}px when the game changed from Hold'em to Omaha hi-lo`);
    await p.screenshot({ path: path.join(OUT, 'horse-laptop.png') });
    await stopGame(p, [p]);
    await p.close();
  });

  await step('laptop, nine players: the seats hold still when hands are shown', async () => {
    // When a hand is over, the hand each player shows is named under their stack. A long one ("Full House, Queens full of
    // Jacks") widened a short-named player's nameplate, which the seats weren't spaced for, so at a full table on a laptop
    // every seat but yours moved 6 to 30px as the result came (#427). Practice bots don't show their cards, so eight other
    // players join here from plain connections. They check or call, so every hand goes to a showdown, and when it's over
    // they all show their cards, as anyone may.
    const host = await open('showdown host', { width: 1366, height: 768 });
    await host.goto(BASE);
    await host.fill('input[required]', 'Ned');
    await host.click('button:has-text("Create table")');
    await host.waitForURL(/\/t\//);
    await host.locator('.seat.empty button').first().click();
    await host.click('button:has-text("Sit down")');
    await host.waitForSelector('.seat.me');
    const tableId = new URL(host.url()).pathname.split('/').pop();
    const guests = [];
    try {
      for (const [i, name] of ['Bea', 'Cal', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy'].entries()) {
        const s = io(BASE, { auth: { token: randomBytes(24).toString('hex') }, transports: ['websocket'] });
        guests.push(s);
        const call = (ev, arg) => s.timeout(10_000).emitWithAck(ev, arg).then((res) => (res?.ok === false ? Promise.reject(new Error(`${name}, ${ev}: ${res.error}`)) : res));
        // On their turn each checks or calls, and once the hand is over shows what they hold. A turn that comes while the
        // last move is still on its way is taken once that move is done, so nobody waits out their clock.
        let busy = false;
        let latest = null;
        let showed = null;
        const act = () => {
          const v = latest;
          if (busy || !v) return;
          const handNumber = v.hand?.handNumber;
          let move;
          if (v.legal) move = () => call('hand:act', { type: v.legal.canCheck ? 'check' : 'call', handNumber });
          else if (v.canShow?.length && showed !== handNumber) move = () => call('hand:show', { cards: v.canShow, handNumber }).then(() => (showed = handNumber));
          else return;
          busy = true;
          move()
            .catch(() => {})
            .finally(() => {
              busy = false;
              if (latest !== v) act();
            });
        };
        s.on('table:state', (v) => {
          latest = v;
          act();
        });
        await call('table:join', { tableId });
        // $50 at $0.25/$0.50, so nobody runs out of chips in the hands this plays.
        await call('seat:request', { seat: i + 1, name, stack: 5000, consent: true });
        await host.locator('.request button:has-text("Approve")').first().click();
        await host.locator(`.seat[data-seat="${i + 1}"]:not(.empty)`).waitFor();
      }
      // As someone who opens the table once everyone is seated: seats grow their room for what they've shown, and while
      // the others sat down their nameplates showed more than they do in a hand.
      await host.reload();
      await host.waitForSelector('.seat.me');
      await host.waitForTimeout(900);
      await host.click('button:has-text("Start game")');
      await host.waitForSelector('.seat.me .hole .playing-card');
      await host.waitForTimeout(900);
      await sampleLayouts(host);
      // Hands to their results, until one where another player's nameplate is wider once the hands are shown than when
      // the cards were dealt. With eight hands shown, a long one usually comes in the first or second (about 7 hands in
      // 10), so eight hands without one is about a 1 in 10,000 chance.
      const widths = () =>
        host.evaluate(() => Object.fromEntries([...document.querySelectorAll('.felt .seat[data-seat]:not(.me)')].map((s) => [s.dataset.seat, s.querySelector('.nameplate').getBoundingClientRect().width])));
      let widened = 0;
      let hands = 0;
      while (!widened && hands < 8) {
        // The next hand is dealt a few seconds after the last one's result (a split pot has a line for each winner).
        await host.locator('.pot.result').first().waitFor({ state: 'detached', timeout: 30_000 });
        await host.waitForSelector('.seat.me .hole .playing-card');
        const dealt = await widths();
        await playOut([host], 60);
        hands++;
        await host.waitForTimeout(1000);
        const shown = await widths();
        widened = Object.keys(dealt).filter((seat) => shown[seat] > dealt[seat] + 2).length;
      }
      const seen = await layoutsSeen(host);
      if (seen.length !== 1) throw new Error(`the seats moved in ${hands} hands:\n  ${seen.join('\n  ')}`);
      if (!widened) throw new Error(`in ${hands} hands no hand shown made a nameplate wider, so this step checked nothing`);
      await host.screenshot({ path: path.join(OUT, 'nine-players-laptop.png') });
      await stopGame(host, [host]);
    } finally {
      for (const s of guests) s.close();
    }
    await host.close();
  });

  await step('computer: a table opened mid-hand draws the middle full size', async () => {
    // A page opened or reloaded mid-hand places the seats for a guessed felt first, then for the real one, and they glide
    // there. The middle (board, pot, winners' lines) was fitted to where the seats were on the way, near it, and as a fit
    // only gets smaller within a hand, the board and pot stayed at 60% until the next deal (#462). Six players join from
    // plain connections and check or call to the river, then wait there while a watcher opens the table on a big screen,
    // where nothing comes near the middle.
    const players = [];
    let hold = true;
    try {
      for (const name of ['Ned', 'Bea', 'Cal', 'Dee', 'Eli', 'Fay']) {
        const s = io(BASE, { auth: { token: randomBytes(24).toString('hex') }, transports: ['websocket'] });
        // The host's start and stop take no argument, only the answer.
        const call = (ev, ...args) => s.timeout(10_000).emitWithAck(ev, ...args).then((res) => (res?.ok === false ? Promise.reject(new Error(`${name}, ${ev}: ${res.error}`)) : res));
        let busy = false;
        const p = { s, call, latest: null };
        p.act = () => {
          const v = p.latest;
          if (busy || !v?.legal || (hold && (v.hand?.boards?.[0]?.[0]?.length ?? 0) >= 5)) return;
          busy = true;
          call('hand:act', { type: v.legal.canCheck ? 'check' : 'call', handNumber: v.hand?.handNumber })
            .catch(() => {})
            .finally(() => {
              busy = false;
              if (p.latest !== v) p.act();
            });
        };
        s.on('table:state', (v) => {
          p.latest = v;
          p.act();
        });
        players.push(p);
      }
      const [host] = players;
      const { tableId } = await host.call('table:create', { settings: { table: { maxSeats: 9 }, seating: { requireApproval: false }, timing: { decisionSeconds: 60 } } });
      for (const [i, p] of players.entries()) {
        await p.call('table:join', { tableId });
        await p.call('seat:request', { seat: [0, 1, 3, 4, 6, 7][i], name: ['Ned', 'Bea', 'Cal', 'Dee', 'Eli', 'Fay'][i], stack: 200, consent: true });
      }
      await host.call('host:start');
      const deadline = Date.now() + 60_000;
      while ((host.latest?.hand?.boards?.[0]?.[0]?.length ?? 0) < 5) {
        if (Date.now() > deadline) throw new Error('the hand never reached the river');
        await new Promise((r) => setTimeout(r, 250));
      }
      const page = await open('mid-hand watcher', { width: 1920, height: 1080 });
      // Notes the middle's scale every frame from the first one.
      await page.addInitScript(() => {
        const scales = (window.__scales = new Set());
        const sample = () => {
          const stack = document.querySelector('.felt .board-stack');
          if (stack?.querySelector('.playing-card')) scales.add(getComputedStyle(stack).scale);
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      for (const how of ['opened', 'reloaded']) {
        if (how === 'opened') await page.goto(`${BASE}/t/${tableId}`);
        else await page.reload();
        await page.waitForFunction(() => document.querySelectorAll('.felt .board .playing-card').length === 5);
        await page.waitForTimeout(2000);
        const scales = await page.evaluate(() => [...window.__scales]);
        if (!scales.length) throw new Error(`${how} mid-hand, no frame with the board in the middle was read, so this step checked nothing`);
        if (scales.some((s) => s !== 'none' && s !== '1')) throw new Error(`${how} mid-hand, the middle was drawn at ${scales.join(', ')}`);
      }
      await page.screenshot({ path: path.join(OUT, 'opened-mid-hand.png') });
      await page.close();
      // The hand is played out and the game stopped, so the backup check after this finds every hand finished.
      hold = false;
      for (const p of players) p.act();
      await host.call('host:stop');
      const done = Date.now() + 60_000;
      while (host.latest?.hand && !host.latest.hand.awards?.length) {
        if (Date.now() > done) throw new Error("the hand didn't end");
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      for (const p of players) p.s.close();
    }
  });

  await step('laptop, Stud Hi-Lo: a split pot keeps the middle full size', async () => {
    // A split pot's winners' lines sit side by side where the felt has room (#417). At a stud table a side seat's seven
    // cards reach in further than that room allows for, and the middle was drawn up to 30% smaller to clear them, where
    // the lines one under the other fit at full size. They're stacked there now (#474). Four players check or call every
    // hand to the showdown; about half of Stud Hi-Lo hands then split. Watchers at 1440x900 and 1600x900 read the middle's
    // scale every frame.
    const players = [];
    try {
      for (const name of ['Ned', 'Bea', 'Cal', 'Dee']) {
        const s = io(BASE, { auth: { token: randomBytes(24).toString('hex') }, transports: ['websocket'] });
        const call = (ev, ...args) => s.timeout(10_000).emitWithAck(ev, ...args).then((res) => (res?.ok === false ? Promise.reject(new Error(`${name}, ${ev}: ${res.error}`)) : res));
        let busy = false;
        let seeded = '';
        const p = { s, call, latest: null };
        p.act = () => {
          const v = p.latest;
          if (busy || !v?.legal) return;
          busy = true;
          call('hand:act', { type: v.legal.canBringIn ? 'bring-in' : v.legal.canCheck ? 'check' : 'call', handNumber: v.hand?.handNumber })
            .catch(() => {})
            .finally(() => {
              busy = false;
              if (p.latest !== v) p.act();
            });
        };
        s.on('table:state', (v) => {
          p.latest = v;
          // A seed for each next hand, as a page sends: otherwise the deal waits up to 10 s for one (FAIR_SEED_WAIT_MS).
          const commit = v.fair?.nextCommit;
          if (commit && commit !== seeded && v.me?.seat != null) {
            seeded = commit;
            s.emit('fair:seed', { commit, seed: randomBytes(16).toString('hex') }, () => {});
          }
          p.act();
        });
        players.push(p);
      }
      const [host] = players;
      const { tableId } = await host.call('table:create', { settings: { table: { maxSeats: 8 }, game: { gameId: 'stud8' }, seating: { requireApproval: false }, timing: { decisionSeconds: 60 } } });
      // Two of them at the ends of the table, where their cards reach towards the middle.
      for (const [i, p] of players.entries()) {
        await p.call('table:join', { tableId });
        await p.call('seat:request', { seat: [0, 2, 4, 6][i], name: ['Ned', 'Bea', 'Cal', 'Dee'][i], stack: 5000, consent: true });
      }
      // Two watchers, on the window sizes where it showed (the lines' lengths decide whether a given split needs it).
      const pages = [await open('stud split watcher 1440', { width: 1440, height: 900 }), await open('stud split watcher 1600', { width: 1600, height: 900 })];
      for (const page of pages) {
        await page.goto(`${BASE}/t/${tableId}`);
        await page.waitForSelector('.felt .seat');
        // For each split pot shown (by its lines), every scale the middle was drawn at.
        await page.evaluate(() => {
          const splits = (window.__splits = new Map());
          const sample = () => {
            const stack = document.querySelector('.felt .board-stack');
            const several = stack?.querySelector(':scope > .results.several');
            if (several) {
              const key = [...several.children].map((c) => c.textContent).join(' | ');
              if (!splits.has(key)) splits.set(key, new Set());
              splits.get(key).add(getComputedStyle(stack).scale);
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
      }
      await host.call('host:start');
      // Four split pots, which take about eight hands (7 to 8 s each with the seeds sent: the 6 s a showdown shows, and
      // play); before the fix more than half of them drew the middle smaller at one size or the other, so all four passing
      // would be about a 1 in 40 chance. 150 s is about 20 hands: fewer than four splits in those is well under 1 in 100.
      const splits = (page) => page.evaluate(() => [...window.__splits.entries()].map(([k, s]) => [k, [...s]]));
      const deadline = Date.now() + 150_000;
      while ((await splits(pages[0])).length < 4) {
        if (Date.now() > deadline) throw new Error(`only ${(await splits(pages[0])).length} split pots in 150 s`);
        await pages[0].waitForTimeout(1000);
      }
      // The last split's lines show until the next deal: let them finish.
      await pages[0].waitForTimeout(1500);
      for (const [i, page] of pages.entries()) {
        const small = (await splits(page)).filter(([, scales]) => scales.some((s) => s !== 'none' && s !== '1'));
        if (small.length) throw new Error(`at ${i ? '1600x900' : '1440x900'} the middle was drawn smaller for ${small.length} split pots: ${small.map(([k, s]) => `${k} at ${s.join(', ')}`).join('; ')}`);
      }
      await pages[0].screenshot({ path: path.join(OUT, 'stud-split-laptop.png') });
      for (const page of pages) await page.close();
      await host.call('host:stop');
      const done = Date.now() + 60_000;
      while (host.latest?.hand && !host.latest.hand.awards?.length) {
        if (Date.now() > done) throw new Error("the hand didn't end");
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      for (const p of players) p.s.close();
    }
  });

  // The server saves a table up to half a second after its last change (SAVE_DEBOUNCE_MS in app.ts), and a hand at once.
  // CI's backup check reads the leaderboard right after this, so give the last table's save time to land: read in that
  // half second, the board counts the last hand but not its chips, and the restored copy doesn't match.
  await new Promise((r) => setTimeout(r, 2000));

  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`);
  if (a11y.length) {
    const found = `accessibility problems (docs/ACCESSIBILITY.md says how to check them):\n${a11y.join('\n')}`;
    if (A11Y !== 'report') throw new Error(found);
    console.warn(`${found}\nSMOKE_A11Y=report: reported, not failed.`);
  }
  console.log('smoke test passed');
} catch (e) {
  console.error('smoke test FAILED:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
  // What every open page showed when it failed, uploaded with the other screenshots.
  for (const [i, { p, label }] of pages.entries()) {
    if (!p.isClosed()) await p.screenshot({ path: path.join(OUT, `failed-${i + 1}-${label}.png`) }).catch(() => {});
  }
} finally {
  await browser.close();
}
