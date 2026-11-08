// Play-test: spectators on a delay (#435, #452). Two players and a host at a cash table, someone watching on a delay
// through the socket and in a browser. Each check prints PASS or FAIL: what a delayed spectator is sent, and when,
// while the live table ends hands, changes its seats, stakes and delay, and fills a seat from the waitlist; the link
// preview and the public record too. Takes about 2 minutes, in real time.
//   BASE_URL=http://localhost:3001 node e2e/playtest/spectator-delay.mjs
// See README.md.

import { io } from 'socket.io-client';
import { BASE, OUT, DESK, browser, errors, open, shot } from './lib.mjs';
import { writeFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = Math.random().toString(36).slice(2, 8);
const sockets = [];
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

/** A socket like a browser's: acked calls, the latest view, waiting for a view that matches, and every view with its time. */
function client(name) {
  const socket = io(BASE, { auth: { token: `pt-${run}-${name}-0123456789abcdef` }, transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  let last = null;
  const seen = [];
  const waiters = [];
  socket.on('table:state', (v) => {
    last = v;
    seen.push({ at: Date.now(), v });
    for (const w of [...waiters]) if (w.test(v)) waiters.splice(waiters.indexOf(w), 1) && w.resolve(v);
  });
  const call = (event, ...args) =>
    new Promise((resolve, reject) => socket.emit(event, ...args, (res) => (res?.ok ? resolve(res) : reject(new Error(res?.error ?? 'no answer')))));
  const until = (test, ms = 60_000) =>
    new Promise((resolve, reject) => {
      if (last && test(last)) return resolve(last);
      const w = { test, resolve };
      waiters.push(w);
      setTimeout(() => {
        if (waiters.includes(w)) waiters.splice(waiters.indexOf(w), 1) && reject(new Error('timed out waiting for a view'));
      }, ms);
    });
  return { socket, call, until, view: () => last, seen };
}
/** Whoever is to act, once their view says so. */
async function toAct(...ps) {
  for (let i = 0; i < 100; i++) {
    const p = ps.find((x) => x.view()?.legal);
    if (p) return p;
    await sleep(50);
  }
  throw new Error('nobody is to act');
}
const handEntries = async () => (await (await fetch(`${BASE}/api/audit/entries?kind=hand&limit=500`)).json()).entries.length;
const preview = async (id) => (await (await fetch(`${BASE}/t/${id}`)).text()).match(/og:description" content="([^"]*)"/)?.[1] ?? '';

const D = 15;
try {
  // ---- A table watched live, then on a delay turned on between hands (items 3 and 6).
  const ann = client('ann');
  const ben = client('ben');
  const fan = client('fan');
  const { tableId } = await ann.call('table:create', {
    settings: {
      table: { name: 'Delay play-test' },
      stakes: { smallBlind: 100, bigBlind: 200, centsMode: true },
      seating: { requireApproval: false },
      spectators: { allowed: true, delaySeconds: 0 },
      timing: { decisionSeconds: 0, autoStartNextHand: false },
    },
  });
  for (const c of [ann, ben, fan]) await c.call('table:join', { tableId });
  await ann.call('seat:request', { seat: 0, name: 'Ann', stack: 10_000 });
  await ben.call('seat:request', { seat: 1, name: 'Ben', stack: 10_000 });
  await ann.until((v) => v.seats.filter(Boolean).length === 2);
  await ann.call('host:start');
  await ann.until((v) => !!v.hand);
  await (await toAct(ann, ben)).call('hand:act', { type: 'fold' });
  const ended1 = await ann.until((v) => v.hand?.phase === 'complete');
  const stacks1 = ended1.seats.slice(0, 2).map((s) => s?.stack);
  const watcher = await open('Watcher', DESK);
  await watcher.goto(`${BASE}/t/${tableId}`);
  await watcher.waitForSelector('.seat', { timeout: 30_000 }).catch(() => {});

  // Between hands, so the delay starts at once; then the next hand is dealt straight away.
  await ann.call('host:settings', { patch: { spectators: { delaySeconds: D } } });
  await sleep(300);
  await ann.call('host:deal');
  await ann.until((v) => v.hand?.handNumber === 2);
  await sleep(500);
  const waiting = fan.view();
  check('item 3: before anything is old enough, the spectator sees the stacks as they were, not the blinds of the live hand', waiting.hand?.handNumber !== 2 && waiting.seats.slice(0, 2).every((s, i) => s?.stack === stacks1[i]), `shown ${waiting.seats.slice(0, 2).map((s) => s?.stack)}, before the hand ${stacks1}, live ${ann.view().seats.slice(0, 2).map((s) => s?.stack)}`);

  const sentBefore = fan.seen.length;
  await (await toAct(ann, ben)).call('hand:act', { type: 'call' });
  await sleep(400);
  await (await toAct(ann, ben)).call('hand:act', { type: 'check' });
  await sleep(1500);
  check('item 6: the spectator is sent nothing while the live hand plays on', fan.seen.length === sentBefore, `${fan.seen.length - sentBefore} updates`);
  await ben.call('chat:send', { text: 'nice' });
  await fan.until((v) => v.chat.some((m) => m.text === 'nice'), 5_000).catch(() => {});
  check('item 6: chat still reaches them at once', fan.view().chat.some((m) => m.text === 'nice'));

  // ---- During hand 2: fewer seats, a shorter delay and higher stakes, for the next hand (items 1, 2 and 4).
  await ann.call('host:settings', { patch: { table: { maxSeats: 6 }, spectators: { delaySeconds: 5 }, stakes: { smallBlind: 500, bigBlind: 1_000 } } });
  const entriesBefore = await handEntries();
  await (await toAct(ann, ben)).call('hand:act', { type: 'fold' });
  const end2 = Date.now();
  await ann.until((v) => v.hand?.phase === 'complete' && v.hand.handNumber === 2);
  await sleep(500);
  check('item 5: the public record does not have hand 2 as soon as it ends', (await handEntries()) === entriesBefore);
  // Dealt when the pause after a hand runs out, not when the host presses Deal.
  await ann.call('host:deal');
  const live3 = await ann.until((v) => v.hand?.handNumber === 3);
  const deal3 = Date.now();
  await sleep(500);
  const shown = fan.view();
  check('item 1: the live table has 6 seats, the spectator still sees 10', live3.seats.length === 6 && shown.seats.length === 10, `live ${live3.seats.length}, shown ${shown.seats.length}`);
  check('item 2: the delay banner still says the old delay', shown.spectator?.delaySeconds === D, `shown ${shown.spectator?.delaySeconds}, live ${live3.settings.spectators.delaySeconds}`);
  const p = await preview(tableId);
  check('item 4: a pasted link shows the stakes the spectator sees, not the live ones', p.includes('1/2') && !p.includes('5/10'), p);
  await shot(watcher, 'delay-behind', 'A spectator 15 s behind: ten seats and the old stakes while the live table has dealt with six seats and 5/10.');

  // ---- The spectator reaches the end of hand 2 and hand 3 on the old delay, then runs 5 s behind.
  const sawEnd = await fan.until((v) => v.hand?.handNumber === 2 && v.hand.phase === 'complete', 30_000);
  const sawEndAt = Date.now();
  check('item 2: the end of hand 2 shows on the old delay', Math.abs(sawEndAt - end2 - D * 1000) < 1_500, `${((sawEndAt - end2) / 1000).toFixed(1)} s after it`);
  void sawEnd;
  for (let i = 0; i < 20 && (await handEntries()) === entriesBefore; i++) await sleep(250);
  check('item 5: hand 2 is in the public record once the spectator sees it end', (await handEntries()) === entriesBefore + 1, `${((Date.now() - end2) / 1000).toFixed(1)} s after it`);
  const saw3 = await fan.until((v) => v.hand?.handNumber === 3, 30_000);
  const saw3At = Date.now();
  check('item 1 and 2: hand 3 shows with 6 seats and the new delay, 15 s after its deal', saw3.seats.length === 6 && saw3.spectator?.delaySeconds === 5 && Math.abs(saw3At - deal3 - D * 1000) < 1_500, `${saw3.seats.length} seats, ${saw3.spectator?.delaySeconds} s, ${((saw3At - deal3) / 1000).toFixed(1)} s after the deal`);
  await shot(watcher, 'delay-caught-up', 'The same spectator once their view reaches hand 3: six seats, 5/10, and the 5 s delay.');
  const events = saw3.hand.events.length;
  const moveAt = Date.now();
  await (await toAct(ann, ben)).call('hand:act', { type: 'call' });
  await fan.until((v) => v.hand?.handNumber === 3 && v.hand.events.length > events, 30_000);
  check('item 2: from hand 3 on, moves show 5 s behind', Math.abs(Date.now() - moveAt - 5_000) < 1_500, `${((Date.now() - moveAt) / 1000).toFixed(1)} s`);

  // ---- A waitlist offer to someone on a delay (#452).
  const host = client('host');
  const cat = client('cat');
  const rail = client('rail');
  const small = await host.call('table:create', {
    settings: { table: { maxSeats: 2 }, seating: { requireApproval: false, waitlist: true }, spectators: { allowed: true, delaySeconds: 10 }, timing: { decisionSeconds: 0, autoStartNextHand: false } },
  });
  for (const c of [host, cat, rail]) await c.call('table:join', { tableId: small.tableId });
  await host.call('seat:request', { seat: 0, name: 'Host', stack: 10_000 });
  await cat.call('seat:request', { seat: 1, name: 'Cat', stack: 10_000 });
  await host.until((v) => v.seats.filter(Boolean).length === 2);
  await host.call('host:start');
  await host.until((v) => !!v.hand);
  await rail.call('waitlist:join', { name: 'Rail', stack: 10_000 });
  cat.socket.emit('seat:stand', { afterHand: true });
  await sleep(300);
  await (await toAct(host, cat)).call('hand:act', { type: 'fold' });
  const freed = Date.now();
  await host.until((v) => !v.seats[1] && v.offers.length > 0);
  await sleep(500);
  check('#452: the offer does not show before the spectator sees the seat come free', !rail.view().offers.some((o) => o.playerId === rail.view().me.playerId) && rail.view().seats[1]?.name === 'Cat');
  const offered = await rail.until((v) => v.offers.some((o) => o.playerId === v.me.playerId), 30_000);
  const mine = offered.offers.find((o) => o.playerId === offered.me.playerId);
  check('#452: it shows with the seat free, about 10 s later, with the whole minute left', !offered.seats[1] && Math.abs(Date.now() - freed - 10_000) < 1_500 && Math.abs(mine.expiresAt - offered.serverNow - 60_000) < 1_500, `${((Date.now() - freed) / 1000).toFixed(1)} s later, ${((mine.expiresAt - offered.serverNow) / 1000).toFixed(0)} s left`);
  await rail.call('seat:request', { seat: 1, name: 'Rail', stack: 10_000 });
  check('#452: and they can take it', !!(await rail.until((v) => v.seats[1]?.name === 'Rail', 5_000).catch(() => null)));
} catch (e) {
  check('the play-test ran to the end', false, e.message);
} finally {
  for (const s of sockets) s.close();
  await browser.close();
  writeFileSync(`${OUT}/spectator-delay.json`, JSON.stringify({ base: BASE, results, errors }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed${errors.length ? `; browser errors: ${errors.join('; ')}` : ''}`);
  process.exit(failed ? 1 : 0);
}
