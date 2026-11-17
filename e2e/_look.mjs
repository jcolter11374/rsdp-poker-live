import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const BASE = process.env.BASE_URL, TAG = process.env.TAG, OUT = process.env.OUT; mkdirSync(OUT, { recursive: true });
if (/fly\.dev/.test(BASE)) process.exit(1);
const browser = await chromium.launch();
const SCENES = [
  { name: 'side-nlh', vp: { width: 844, height: 390 }, mobile: true, game: 'nlhe', secs: 70, note: true },
  { name: 'side-se-stud', vp: { width: 568, height: 320 }, mobile: true, game: 'stud', secs: 50, note: true },
  { name: 'phone-stud', vp: { width: 390, height: 664 }, mobile: true, game: 'stud', secs: 60 },
  { name: 'laptop-stud', vp: { width: 1366, height: 768 }, mobile: false, game: 'stud', secs: 60 },
];
const only = process.env.ONLY?.split(',');
const report = {};
await Promise.all(SCENES.filter((s) => !only || only.includes(s.name)).map(async (sc) => {
  const ctx = await browser.newContext({ viewport: sc.vp, deviceScaleFactor: 2, isMobile: sc.mobile, hasTouch: sc.mobile });
  const p = await ctx.newPage(); p.on('dialog', (d) => d.accept());
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE);
  await p.fill('input[required]', 'Pia');
  await p.selectOption('label:has-text("Game") select', sc.game);
  await p.selectOption('.home-practice label:has-text("Bots") select', '3');
  await p.click('button:has-text("Practice with bots")');
  await p.waitForURL(/\/t\//);
  await p.waitForSelector('.seat.me');
  if (await p.locator('.side.drawer.open').count()) await p.keyboard.press('Escape');
  const heights = []; let shotTurn = 0, turns = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < sc.secs * 1000) {
    const h = await p.evaluate(() => Math.round(document.querySelector('.felt')?.getBoundingClientRect().height ?? -1));
    if (heights.at(-1)?.h !== h) heights.push({ t: Math.round((Date.now() - t0) / 100) / 10, h });
    const bar = p.locator('.action-bar.my-turn');
    if (await bar.count()) {
      if (shotTurn < 2 && turns >= 1) { await p.screenshot({ path: `${OUT}/${TAG}-${sc.name}-turn${++shotTurn}.png` }); }
      await p.waitForTimeout(500);
      const btns = bar.locator('.buttons button');
      const texts = await btns.allInnerTexts().catch(() => []);
      const i = texts.findIndex((t) => /^(Check|Call|Bring|Post)/.test(t));
      if (i >= 0) { await btns.nth(i).click({ timeout: 2000 }).catch(() => {}); turns++; }
    }
    await p.waitForTimeout(120);
  }
  let note = null;
  if (sc.note) {
    await p.screenshot({ path: `${OUT}/${TAG}-${sc.name}-between.png` });
    let b = p.locator('header button:has-text("Sit out")');
    if (!(await b.isVisible().catch(() => false))) { await p.click('button[aria-label="Menu"]').catch(() => {}); b = p.locator('button:has-text("Sit out")').first(); }
    await b.click({ timeout: 5000 }).catch((e) => (note = 'no sit out: ' + e.message.slice(0, 80)));
    await p.keyboard.press('Escape').catch(() => {});
    await p.locator('.dock-notes .banner').first().waitFor({ timeout: 40000 }).catch(() => (note = (note ?? '') + ' no note'));
    await p.waitForTimeout(1500);
    await p.screenshot({ path: `${OUT}/${TAG}-${sc.name}-note.png` });
    note = { note, felt: await p.evaluate(() => Math.round(document.querySelector('.felt').getBoundingClientRect().height)), text: await p.locator('.dock-notes').innerText().catch(() => '') };
  }
  report[sc.name] = { heights, turns, note, errs };
  await ctx.close();
}));
writeFileSync(`${OUT}/${TAG}-report.json`, JSON.stringify(report, null, 1));
for (const [k, v] of Object.entries(report)) console.log(TAG, k, 'turns', v.turns, 'heights', v.heights.map((x) => `${x.h}@${x.t}`).join(' '), JSON.stringify(v.note), v.errs.join('|'));
await browser.close();
