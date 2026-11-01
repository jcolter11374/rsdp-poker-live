// Play-test: a cash game. Four players (one on a phone) sit at a host's
// table and play Hold'em, run it twice, a bomb pot, Omaha and Stud, then the
// ledger, hands and replayer are opened. Takes about 4 minutes.
//   BASE_URL=http://localhost:3001 node e2e/playtest/cash.mjs
// See README.md.

import { writeFileSync } from 'node:fs';
import { BASE, OUT, DESK, PHONE, browser, errors, open, shot, shots, bot, handOver } from './lib.mjs';

const john = await open('John', DESK, true);
const maya = await open('Maya');
const dev = await open('Dev');
const rosa = await open('Rosa', PHONE, true);

async function settings(fn) {
  await john.click('button:has-text("Table settings")');
  await fn();
  await john.click('.modal button:has-text("Save")');
  await john.locator('.modal').waitFor({ state: 'detached' }).catch(() => {});
}
async function waitStreet(p, n) {
  await p.waitForFunction((n) => document.querySelectorAll('.board-row').length > 0 && document.querySelectorAll('.board-row')[0].querySelectorAll('.playing-card').length >= n, n, { timeout: 60_000 });
}

try {
  await john.goto(BASE);
  await shot(john, 'home-desktop', 'The front page. Type a name and you have a table; no sign-up.');
  await rosa.goto(BASE);
  await shot(rosa, 'home-phone', 'Same page on a phone.');

  await john.fill('input[required]', 'John');
  await john.click('button:has-text("Create table")');
  await john.waitForURL(/\/t\//);
  const url = john.url();
  await john.locator('.seat.empty button').first().click();
  await john.click('button:has-text("Sit down")');
  await john.waitForSelector('.seat.me');
  const jb = bot(john, 'call');
  jb.host = true;
  jb.stop = true; // John is driven by hand for the first part

  for (const [p, name] of [[maya, 'Maya'], [dev, 'Dev'], [rosa, 'Rosa']]) {
    await p.goto(url);
    await p.locator('.seat.empty button').first().click();
    await p.fill('.modal input[required]', name);
    await p.click('button:has-text("Ask to sit")');
    if (name === 'Rosa') {
      await john.locator('.request').first().waitFor();
      await shot(john, 'seat-request', 'Friends open the invite link and ask for a seat. The host approves each one.');
    }
    await john.locator('.request button:has-text("Approve")').first().click();
    await p.waitForSelector('.seat.me');
  }

  await settings(async () => {
    await john.click('.tabs button:has-text("Rules")');
    await john.locator('label:has-text("Run it twice") select, .field:has-text("Run it twice") select').first().selectOption('ask');
    await shot(john, 'settings-rules', 'Host settings. Run it twice is set to "Players choose".');
  });

  const bots = [bot(maya, 'call'), bot(dev, 'call'), bot(rosa, 'call')];
  const jb2 = bot(john, 'call');
  jb2.host = true;
  await john.click('button:has-text("Start game")');
  await waitStreet(john, 3);
  await shot(john, 'holdem-flop', "Hold'em, four players, on the flop. The bots are other browser windows clicking the same buttons you would.");
  await waitStreet(rosa, 3);
  await shot(rosa, 'holdem-phone', 'The same hand on Rosa\'s phone.');
  await handOver(john);
  await shot(john, 'holdem-result', 'Showdown: winning hand named, chips pushed, log updated on the right.');

  // Run it twice: John and Maya shove, the others fold.
  jb2.stop = true;
  bots[0].style = 'shove';
  bots[1].style = 'fold';
  bots[2].style = 'fold';
  await john.locator('.pot.result').first().waitFor({ state: 'detached', timeout: 60_000 });
  // John shoves by hand when it is his turn.
  for (let i = 0; i < 400; i++) {
    const bar = john.locator('.action-bar.my-turn');
    if (await bar.locator('.prompt:has-text("Run it twice")').count()) break;
    if (await bar.locator('.presets button:has-text("All in")').count()) {
      await bar.locator('.presets button:has-text("All in")').click();
      await john.waitForTimeout(200);
      await bar.locator('.buttons button.primary').click();
    } else if (await bar.locator('.buttons button:has-text("Call")').count()) {
      await bar.locator('.buttons button:has-text("Call")').click();
    }
    await john.waitForTimeout(250);
  }
  await shot(john, 'rit-prompt', 'Everyone is all in, so each player is asked: run it once or twice?');
  await john.click('.action-bar.my-turn button:has-text("Run it twice")');
  await handOver(john);
  await john.waitForTimeout(1500);
  await shot(john, 'rit-result', 'Run it twice: two boards dealt, the pot split between them.');
  await shot(rosa, 'rit-phone', 'The run-it-twice result on a phone.');

  // Bomb pot next hand.
  for (const b of bots) b.style = 'call';
  await john.click('button:has-text("Bomb pot next hand")');
  const jb3 = bot(john, 'call');
  jb3.host = true;
  await john.locator('.topbar:has-text("Bomb pot")').waitFor({ timeout: 90_000 });
  await waitStreet(john, 3);
  await shot(john, 'bomb-flop', 'Bomb pot: everyone antes, no preflop betting, straight to the flop.');
  await handOver(john);
  await shot(john, 'bomb-result', 'Bomb pot finished.');

  // Omaha.
  await settings(async () => {
    await john.click('.tabs button:has-text("Game")');
    await john.locator('.field:has-text("Game") select, label:has-text("Game") select').first().selectOption('plo4');
  });
  await john.locator('.seat.me .hole .playing-card:nth-child(4)').waitFor({ timeout: 120_000 });
  await waitStreet(john, 3);
  await shot(john, 'omaha', 'Switched to Pot-Limit Omaha from settings; it starts on the next hand. Four hole cards each.');
  await shot(rosa, 'omaha-phone', 'Omaha on a phone.');
  await handOver(john, 120_000);

  // Seven Card Stud.
  await settings(async () => {
    await john.click('.tabs button:has-text("Game")');
    await john.locator('.field:has-text("Game") select, label:has-text("Game") select').first().selectOption('stud');
  });
  await john.locator('.topbar:has-text("Stud")').waitFor({ timeout: 120_000 });
  await john.waitForFunction(() => document.querySelectorAll('.seat.me .playing-card').length >= 5, null, { timeout: 120_000 });
  await shot(john, 'stud', 'Seven Card Stud: up-cards on show, the low card brings it in.');
  await shot(rosa, 'stud-phone', 'Stud on a phone.');
  await handOver(john, 120_000);
  await shot(john, 'stud-result', 'Stud showdown.');

  // Rules guide from the table.
  await john.click('button:has-text("Menu")'); await john.click('text=How to play');
  await john.waitForTimeout(800);
  await shot(john, 'rules-dialog', 'The Rules button opens a guide for the game being played right now.');
  await john.keyboard.press('Escape');
  await john.locator('.modal button:has-text("Close"), .modal .icon[aria-label="Close"]').first().click().catch(() => {});

  // Let a few more hands go by, then stop the bots.
  await john.waitForTimeout(8000);
  for (const b of [...bots, jb3]) b.stop = true;
  await john.waitForTimeout(3000);

  // Ledger.
  await john.click('.side .tabs button:has-text("Ledger"), button:has-text("Ledger")');
  await john.waitForTimeout(800);
  await shot(john, 'ledger', 'Ledger: every buy-in, rebuy and stack, with net up or down.');
  const settle = john.locator('button:has-text("Settle")');
  if (await settle.count()) {
    await settle.first().click();
    await john.waitForTimeout(500);
    await shot(john, 'settle', 'Settle up: who pays whom, in the fewest payments.');
  }

  // Hands and replayer.
  await john.click('button:has-text("Hands")');
  await john.locator('.hand-open').first().waitFor();
  await shot(john, 'hands', 'Hands tab: every hand played tonight, with your win or loss.');
  await john.locator('.hand-open:has-text("▶ #2 ")').click();
  await john.locator('.replayer').waitFor();
  for (let i = 0; i < 9; i++) { await john.keyboard.press('ArrowRight'); await john.waitForTimeout(700); }
  await john.waitForTimeout(2500);
  await shot(john, 'replayer', 'Hand replayer, part way through the run-it-twice hand: step through action by action, or press play.');
  for (let i = 0; i < 40; i++) { await john.keyboard.press('ArrowRight'); await john.waitForTimeout(150); }
  await john.waitForTimeout(2500);
  await shot(john, 'replayer-end', 'The replayer at the end of that hand: both boards and who won each.');
  await john.locator('.replayer button[aria-label="Close"]').click().catch(() => {});
  await john.locator('.hand-open:has-text("▶ #4 ")').click();
  await john.locator('.replayer').waitFor();
  for (let i = 0; i < 40; i++) { await john.keyboard.press('ArrowRight'); await john.waitForTimeout(150); }
  await john.waitForTimeout(2500);
  await shot(john, 'replayer-omaha', 'Replaying the Omaha hand.');
  await john.locator('.replayer button[aria-label="Close"]').click().catch(() => {});

  // Phone: rules and ledger.
  await rosa.goto(`${BASE}/rules/stud`);
  await rosa.waitForTimeout(1000);
  await shot(rosa, 'rules-phone', 'The rules guides also have their own pages, here Seven Card Stud on a phone.');
} catch (e) {
  console.error('FAILED', e);
  await john.screenshot({ path: `${OUT}/fail-john.png` }).catch(() => {});
  await rosa.screenshot({ path: `${OUT}/fail-rosa.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  writeFileSync(`${OUT}/cash-shots.json`, JSON.stringify(shots, null, 1));
  writeFileSync(`${OUT}/cash-errors.json`, JSON.stringify(errors, null, 1));
  for (const p of [john, rosa]) await p.context().close();
  await browser.close();
}
