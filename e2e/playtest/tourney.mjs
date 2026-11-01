// Play-test: a scheduled tournament. Seven players (one on a phone) register,
// nobody presses start, and it starts on its own at the set time; then
// everyone shoves until there is a winner. Takes about 3 minutes.
//   BASE_URL=http://localhost:3001 node e2e/playtest/tourney.mjs
// See README.md.

import { writeFileSync } from 'node:fs';
import { BASE, OUT, DESK, PHONE, browser, errors, open, shot, shots, bot } from './lib.mjs';

const john = await open('John', DESK, true);
const lobby = await open('Lobby watcher');
const rosa = await open('Rosa', PHONE, true);
const others = [];
for (const n of ['Maya', 'Dev', 'Sam', 'Lee', 'Kat']) others.push(await open(n));
const players = [john, rosa, ...others];
const names = ['John', 'Rosa', 'Maya', 'Dev', 'Sam', 'Lee', 'Kat'];

try {
  await john.goto(`${BASE}/tn/new`);
  await john.locator('label:has-text("Name") input').first().fill('Sunday Shootout');
  await john.locator('label:has-text("Starting stack") input').fill('1500');
  await john.locator('label:has-text("Seats per table") input').fill('4');
  // The form takes the browser's time zone, which is this computer's, so local time (not UTC) here too.
  const start = new Date(Date.now() + 150_000);
  start.setSeconds(0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const hh = pad(start.getHours());
  const mm = pad(start.getMinutes());
  await john.locator('label:has-text("Date") input').fill(`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`);
  await john.locator('label:has-text("Time") input[type=time]').fill(`${hh}:${mm}`);
  await john.waitForTimeout(500);
  await shot(john, 't-create', `Creating a tournament set to start on its own at ${hh}:${mm}. Nobody has to press start.`);
  await john.getByRole('button', { name: 'Create tournament' }).click();
  await john.waitForURL(/\/tn\/[0-9a-f]+$/);
  const id = john.url().split('/').pop();

  for (const [i, p] of players.entries()) {
    if (i > 0) await p.goto(`${BASE}/tn/${id}`);
    await p.locator('.tn-name input').fill(names[i]);
    await p.getByRole('button', { name: /^Register/ }).click();
    await p.getByText("You're registered.").waitFor();
  }
  await lobby.goto(`${BASE}/tn/${id}`);
  await lobby.waitForTimeout(1000);
  await shot(lobby, 't-lobby', 'The lobby with 7 players registered and the countdown running. Two tables of 4 seats.');
  await shot(rosa, 't-lobby-phone', 'Lobby on a phone.');

  // Nobody clicks anything now: wait for the clock.
  const bots = players.map((p) => bot(p, 'mixed'));
  const table = new RegExp(`/t/${id}-t\\d+$`);
  await john.waitForURL(table, { timeout: 240_000, waitUntil: 'commit' });
  console.log('started at', new Date().toISOString(), 'scheduled', start.toISOString());
  await john.waitForSelector('.seat .hole .playing-card', { timeout: 90_000 });
  await john.waitForTimeout(1500);
  await shot(john, 't-start', `${hh}:${mm} came and the tournament started by itself. Everyone was taken to their table.`);
  await rosa.waitForTimeout(500);
  await shot(rosa, 't-table-phone', 'Rosa at her tournament table on a phone, with the level and blinds on top.');
  await lobby.getByRole('tab', { name: /^Tables/ }).click().catch(() => {});
  await lobby.waitForTimeout(800);
  await shot(lobby, 't-tables', 'Lobby, Tables tab: both tables running.');

  // Speed it up: everyone shoves.
  await john.waitForTimeout(15_000);
  for (const b of bots) b.style = 'shove';
  let tookMerge = false;
  for (let i = 0; i < 400; i++) {
    const text = await lobby.locator('body').innerText();
    // The lobby shows "Winner" in capitals (CSS), so innerText has it as WINNER.
    if (/Winner/i.test(text)) break;
    if (/Players\s*1 \/ 7/.test(text) && !globalThis.lone) {
      globalThis.lone = true;
      await lobby.getByRole('tab', { name: /^Players/ }).click().catch(() => {});
      await lobby.waitForTimeout(800);
      await shot(lobby, 't-lone', 'FINDING: one player has every chip, but the tournament keeps running because late registration is still open (default: through level 4). Nothing on screen says why.');
      await john.goto(`${BASE}/tn/${id}`);
      await john.getByRole('tab', { name: /^Host/ }).click();
      await john.waitForTimeout(500);
      await john.locator('label:has-text("Late registration")').first().click();
      await john.waitForTimeout(800);
      await shot(john, 't-host-late', 'The host switches late registration off in the lobby\'s Host tab.');
    }
    if (!tookMerge && /Players\s*[2-4] \/ 7/.test(text)) {
      await lobby.getByRole('tab', { name: /^Players/ }).click().catch(() => {});
      await lobby.waitForTimeout(500);
      await shot(lobby, 't-players', 'Mid-tournament: players knocked out with their finishing places, chip counts for the rest.');
      tookMerge = true;
    }
    await lobby.waitForTimeout(1500);
  }
  await lobby.locator('text=Winner').first().waitFor({ timeout: 60_000 });
  await lobby.waitForTimeout(1500);
  await shot(lobby, 't-winner', 'Done: the winner, and the final places with payouts.');
  await lobby.getByRole('tab', { name: /^Payouts/ }).click().catch(() => {});
  await lobby.waitForTimeout(500);
  await shot(lobby, 't-payouts', 'Payouts tab after the finish.');
  await rosa.goto(`${BASE}/tn/${id}`);
  await rosa.locator('text=Winner').first().waitFor();
  await shot(rosa, 't-winner-phone', 'The finished lobby on a phone.');
  for (const b of bots) b.stop = true;
} catch (e) {
  console.error('FAILED', e);
  for (const p of [john, lobby, rosa]) await p.screenshot({ path: `${OUT}/fail-${p.label}.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  writeFileSync(`${OUT}/t-shots.json`, JSON.stringify(shots, null, 1));
  writeFileSync(`${OUT}/t-errors.json`, JSON.stringify(errors, null, 1));
  for (const p of [john, rosa]) await p.context().close();
  await browser.close();
}
