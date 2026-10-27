# A guided tour of the code

This page is for someone opening the repository for the first time and
wanting to understand how RSDP Poker Live! works: what each folder does, how
the pieces talk to each other, which files to read first, and how to run it
on your own computer.

It is a map, not the rulebook. The detailed rules each part follows live in
[ARCHITECTURE.md](ARCHITECTURE.md), how the cards are shuffled and how you
can check them lives in [FAIRNESS.md](FAIRNESS.md), and hosting, backups and
restores live in [DEPLOY.md](DEPLOY.md). This page links to those instead of
repeating them.

## The big picture

Everything runs in **one server process**. Browsers connect to it over a
WebSocket (a connection that stays open, so the server can push updates the
moment something happens). The server holds every live table and tournament
in memory, decides everything, and saves to a database so a restart picks up
where it left off.

```
  Browser (React app, apps/web)
     │   sends intents: "I bet 40", "seat me in seat 3", "here is my seed"
     │   receives: its own filtered view of the table after every change
     ▼
  Server (Node + Express + Socket.IO, apps/server)
     ├─ TableRuntime, one per table: seats, timers, between-hand steps
     │     └─ calls the poker engine (packages/engine) to play each hand
     ├─ TournamentManager: runs the tournament director (packages/tournament)
     │     and opens tables for it
     ├─ Public record (audit log): a hash chain of hands, chips and admin actions
     └─ Database (Postgres, or PGlite on a disk), through Drizzle
```

Three ideas explain most of the design:

1. **The server is in charge.** A browser never decides anything. It asks
   ("I raise to 120"), the server checks the request against the rules, and
   then sends each person a fresh picture of the table.
2. **Each person only receives what they may see.** Other players' hole
   cards, the undealt deck and the shuffle secrets stay on the server until
   the rules say they can be shown.
3. **The poker rules are pure code.** The engine and the tournament director
   take a state and an action and return a new state. They don't read the
   clock, touch the network or the database, or pick random numbers by
   themselves. That makes them easy to test exhaustively, and it means the
   same code can replay and check a hand in your browser.

## The folders

```
packages/engine      The poker rules. No I/O. Used by the server AND the browser.
packages/tournament  The tournament director: levels, seating, payouts. No I/O.
apps/server          The game server: tables, tournaments, accounts, database.
apps/web             The website: lobby, table, tournament pages, replayer.
e2e/                 A browser "smoke test" that plays real hands through the UI.
scripts/             Stand-alone checkers (hands, the public record), backups, deploy helpers.
.github/workflows/   Automated jobs on GitHub: tests, deploys, backups, watchers.
docs/                This page, ARCHITECTURE.md, FAIRNESS.md, DEPLOY.md.
```

It is one npm "workspace": a single `npm install` at the top sets up all four
parts, and they import each other by name (`@rsdp/engine`,
`@rsdp/tournament`). Everything is TypeScript.

### packages/engine: the poker rules

This is the heart of the game, and the part worth reading most carefully.

| Where | What it does |
| --- | --- |
| [`src/cards.ts`](../packages/engine/src/cards.ts) | Cards are two-letter strings (`As` = ace of spades, `Td` = ten of diamonds). |
| [`src/fairness.ts`](../packages/engine/src/fairness.ts) | The shuffle. Turns the server's secret plus the players' seeds into a deck (`deckFromSeed`), and `verifyHand`, which re-deals a finished hand to check it. Explained in [FAIRNESS.md](FAIRNESS.md). |
| [`src/core/types.ts`](../packages/engine/src/core/types.ts), [`api.ts`](../packages/engine/src/core/api.ts) | The shapes everything else agrees on: a hand's input, its state, its events, the legal actions. Start here. |
| [`src/core/hand.ts`](../packages/engine/src/core/hand.ts) | The hand itself: `startHand`, `act`, `draw`, `voteRunItTwice`, `show`, `timeout`. Every step adds events (`state.events`) that describe what happened. |
| [`src/core/betting.ts`](../packages/engine/src/core/betting.ts), [`pots.ts`](../packages/engine/src/core/pots.ts), [`settle.ts`](../packages/engine/src/core/settle.ts), [`forced.ts`](../packages/engine/src/core/forced.ts) | Legal bets and raises for no limit, pot limit and fixed limit; side pots; who wins what; blinds, antes, straddles. |
| [`src/core/visibility.ts`](../packages/engine/src/core/visibility.ts) | `visibleEvents`: the filter that removes anything a given viewer may not see. Every event sent to a browser goes through it. |
| [`src/variants/`](../packages/engine/src/variants) | Each game (Hold'em, Omaha, Stud, Razz, Stud Hi-Lo, 2-7 Triple Draw, Badugi…) as a spec, plus hand evaluators for high, low and Badugi hands. |
| [`src/modifiers/`](../packages/engine/src/modifiers) | Optional extras that plug into a hand without changing the core: bomb pots, double board, the 7-2 bounty, the Nit game, rake. |
| [`src/settings/`](../packages/engine/src/settings) | The table settings schema, shared by the server (which enforces it) and the settings dialog (which edits it). |
| [`src/wire.ts`](../packages/engine/src/wire.ts) | The list of every message the browser and server send each other, with their types. A good index of what the app can do. |
| [`src/audit.ts`](../packages/engine/src/audit.ts) | The rules of the public record's hash chain. |

### packages/tournament: the tournament director

A tournament is a long-running state machine: registration, a start time,
blind levels and breaks, balancing and breaking tables, rebuys and add-ons,
knockouts, payouts. [`src/director.ts`](../packages/tournament/src/director.ts)
does all of it as `apply(state, command, now)` and `tick(state, now)`, each
returning a new state and a list of events. It never plays cards: the server
plays the hands and reports the results back. `nextWakeAt` tells the server
when the director next needs to be woken (the next level, a scheduled start).

Other files hold blind structures (`structure.ts`), payout tables
(`payouts.ts`), seating (`seating.ts`), repeating events (`recurrence.ts`)
and seasons (`season.ts`).

### apps/server: the game server

| Where | What it does |
| --- | --- |
| [`src/index.ts`](../apps/server/src/index.ts) | Start-up: open the database, open the public record, build the app, resume saved tables and tournaments, and save everything on shutdown. Short, and a good first read. |
| [`src/app.ts`](../apps/server/src/app.ts) | Wires everything together: the HTTP routes (`/api/...`) and every socket message handler (`on('hand:act', …)`, `on('table:create', …)` and so on). Also `broadcast`, which sends each watcher their own view after a change. |
| [`src/runtime/table.ts`](../apps/server/src/runtime/table.ts) | `TableRuntime`: one per table. Seat requests and approvals, host controls, timers, the time bank, bots, and the steps between hands (apply queued settings, handle busts, plan blinds, shuffle, deal). The largest file, so read it by method name rather than top to bottom. |
| [`src/runtime/view.ts`](../apps/server/src/runtime/view.ts) | `tableView`: builds what one particular person sees. This is where hidden information is filtered out. |
| [`src/tournament/manager.ts`](../apps/server/src/tournament/manager.ts) | Runs the director on a real clock, opens and closes tables for it, and saves and resumes tournaments. |
| [`src/scheduler/scheduler.ts`](../apps/server/src/scheduler/scheduler.ts) | Timers that must survive a restart (a tournament's start time, for example) are kept as rows in a `jobs` table. |
| [`src/bots/`](../apps/server/src/bots) | Practice bots (`strategy.ts`) and coach tips (`coach.ts`). Bots only see what their own seat could see. |
| [`src/identity/`](../apps/server/src/identity), [`accounts.ts`](../apps/server/src/accounts.ts), [`google.ts`](../apps/server/src/google.ts) | Who you are: a random secret your browser keeps (the server stores only its hash), optional accounts with passwords, and Sign in with Google. |
| [`src/audit.ts`](../apps/server/src/audit.ts) | Writes the public record as hands finish and chips move. |
| [`src/db/`](../apps/server/src/db) | The database tables (`schema.ts`) and the code that reads and writes them. Migrations are the numbered SQL files in [`apps/server/drizzle/`](../apps/server/drizzle) and run automatically at start-up. |
| [`src/restore.ts`](../apps/server/src/restore.ts), [`db/backup.ts`](../apps/server/src/db/backup.ts) | Backups out, restores in. See [DEPLOY.md](DEPLOY.md#backups). |

### apps/web: the website

A React app built with Vite. [`src/App.tsx`](../apps/web/src/App.tsx) maps
each address (`/t/<id>` for a table, `/tn/<id>` for a tournament, `/rules`,
`/fairness`, …) to a page. [`src/socket.ts`](../apps/web/src/socket.ts)
opens the connection and keeps your browser's secret.

- [`src/TablePage.tsx`](../apps/web/src/TablePage.tsx) listens for
  `table:state` and draws the table with the components in
  [`src/components/`](../apps/web/src/components): `Table.tsx` (the felt and
  seats), `ActionBar.tsx` (your buttons), `SidePanel.tsx` (log, ledger, chat),
  `Replayer.tsx` and `FairCheck.tsx`.
- [`src/fair.ts`](../apps/web/src/fair.ts) is your browser's half of fair
  dealing: it sends your seed for the next hand and watches that it was used.
  [`src/audit.ts`](../apps/web/src/audit.ts) checks the public record on
  each visit.
- [`src/tournament/`](../apps/web/src/tournament) holds the tournament lobby
  and creation pages; [`src/rules/`](../apps/web/src/rules) the How to play
  guides; [`src/account/`](../apps/web/src/account) sign-in, profile,
  leaderboard and hand search.
- The `/fairness` page is [docs/FAIRNESS.md](FAIRNESS.md) itself, so the site
  and the repository can't say different things.

## Follow one bet from click to screen

Reading this path once is the fastest way to see how the parts fit.

1. You press **Raise** in
   [`ActionBar.tsx`](../apps/web/src/components/ActionBar.tsx). It sends the
   socket message `hand:act` with `{ type: 'raise', to: 120 }` (raise to 120 chips in total this round).
2. In [`app.ts`](../apps/server/src/app.ts), `on('hand:act', …)` cleans up
   the input and calls `act` on your table's `TableRuntime`. If anything
   throws (not your turn, too small a raise), the error goes back to your
   browser only.
3. [`TableRuntime.act`](../apps/server/src/runtime/table.ts) finds your seat
   and calls the engine's `act` in
   [`core/hand.ts`](../packages/engine/src/core/hand.ts), which checks the
   raise against the legal actions and records events.
4. The runtime then does whatever is now due (deal the next street, end the
   hand, start a timer) and calls `onChange`.
5. `onChange` in `app.ts` updates the public record, schedules a save of the
   table, and calls `broadcast`. For **each** person watching, `tableView`
   builds their own view, with `visibleEvents` filtering out cards they may
   not see, and sends it as `table:state`.
6. Every browser redraws. When the hand ends, `onHandFinished` saves the
   hand to the `hands` table and adds its fingerprint to the public record.

A new hand starts from `dealHand` in the runtime. The server published a
fingerprint of this hand's secret one hand earlier; it now combines that
secret with the seeds the seated browsers sent, builds the deck with
`deckFromSeed`, and calls the engine's `startHand`. FAIRNESS.md explains why
it happens in that order.

## Where to start reading

- **"Is the shuffle fair?"** Read the short version at the top of
  [FAIRNESS.md](FAIRNESS.md), then
  [`packages/engine/src/fairness.ts`](../packages/engine/src/fairness.ts)
  (under 300 lines), then
  [`scripts/verify-hand.mjs`](../scripts/verify-hand.mjs), which checks a
  hand without using any of the app's code. FAIRNESS.md also lists, plainly,
  the ways the person running the server could still cheat, and what the
  public checks can and can't catch.
- **"How do the poker rules work?"** `core/types.ts`, then `core/hand.ts`,
  then the tests in [`packages/engine/test/core`](../packages/engine/test/core).
- **"How does a table run?"** `apps/server/src/index.ts`, then the socket
  handlers in `app.ts`, then `TableRuntime` (`dealHand`, `act`,
  `finishHand`).
- **"How do tournaments work?"** `packages/tournament/src/types.ts`, then
  `director.ts`, then `apps/server/src/tournament/manager.ts`.
- **"How does the site look and behave?"** `apps/web/src/App.tsx`, then
  `TablePage.tsx` and `components/Table.tsx`.

The tests are often the clearest description of intended behaviour. Each
package has a `test/` folder (the website keeps its tests next to the code as
`*.test.ts`).

## Running it on your own computer

You need [Node.js](https://nodejs.org) 22 (20 or later works for the
stand-alone checkers) and git.

```bash
git clone https://github.com/jcolter11374/rsdp-poker-live
cd rsdp-poker-live
npm install
npm run dev
```

Open http://localhost:5173. The game server runs on port 3001 and the
website on 5173 (it reloads as you edit). Without any setup, data goes to an
embedded database in `apps/server/.data/`; delete that folder to start fresh.
To play against yourself, open a second browser or a private window, since
each browser is a different player. Practice bots work locally too.

Other commands, all from the top folder:

```bash
npm test             # every unit test in all four parts
npm run typecheck    # TypeScript checks without building
npm run build        # build the website for production
npm start            # serve the built website and the game server together on :3001
npm run smoke        # browser test against a running server (BASE_URL=http://localhost:3001)
```

To run one test file, go into its package and name it, for example
`cd packages/engine && npx vitest run test/core` or
`cd apps/server && npx vitest run test/runtime.test.ts`. The Postgres tests
are skipped unless `TEST_DATABASE_URL` points at a throwaway database.

The same production image the live site runs can be built with Docker; see
[DEPLOY.md](DEPLOY.md#local-check-of-the-production-image).

## From a commit to the live site

| Step | Where |
| --- | --- |
| Work happens on branches and is merged into `develop`. Releases are merged from `develop` into `main`. | |
| Every push and pull request runs the checks: typecheck, all tests (including fuzz tests that play 3,000 random hands through the engine and random games through whole tables), a production build, the browser smoke test against the Docker image, and a backup restore drill. | [`ci.yml`](../.github/workflows/ci.yml) |
| When those pass on `main`, GitHub builds the image, signs a record of which commit it came from, and tells Fly.io to run exactly that image. | [`deploy.yml`](../.github/workflows/deploy.yml) |
| Every hour, a GitHub job checks which image the live site really runs, and copies the public record to the `transparency` branch. Anything wrong opens a public issue. | [`transparency.yml`](../.github/workflows/transparency.yml), [`scripts/transparency/`](../scripts/transparency) |
| Every night, a GitHub job takes an encrypted backup and test-restores it. | [`backup.yml`](../.github/workflows/backup.yml), [DEPLOY.md](DEPLOY.md#backups) |
| Every 5 minutes, a GitHub job checks the site is up. | [`uptime.yml`](../.github/workflows/uptime.yml) |

The live site is a single small machine on Fly.io. It must stay a single
copy, because the live tables exist in that one process's memory; see
[DEPLOY.md](DEPLOY.md).

## How this was built, honestly

John directs the project and makes the product decisions. Most of the code
was written by an AI coding assistant (Claude, through Claude Code), working
in several parallel threads on separate parts. That is why
[ARCHITECTURE.md](ARCHITECTURE.md) talks about "workstreams" (W0 to W4) that
own different folders, and why many commits are co-authored by Claude.

Changes are checked by the automated tests and CI above, and by a separate
review pass that we run ourselves with another AI session. Those reviews are
not independent and nobody outside the project has audited the code. If you
are checking fairness, rely on what you can verify yourself: the code is
public, `scripts/verify-hand.mjs` and `scripts/verify-audit.mjs` use none of
the app's code, and FAIRNESS.md says what those checks prove and what they
don't.

## A few words you'll see in the code

| Word | Meaning |
| --- | --- |
| **runtime** | The server object that runs one table (`TableRuntime`). |
| **view** | What one person is sent about a table, with hidden things removed. |
| **event** | One thing that happened in a hand (a card dealt, a bet, a pot won). The hand is its list of events. |
| **director** | The tournament logic in `packages/tournament`. |
| **commit / commitment** | A fingerprint of a secret, published before the secret is used, so it can't be swapped later. |
| **server seed, client seed, hand seed** | The server's secret for a hand, each browser's contribution, and the two combined into the deck. |
| **public record / audit log** | The append-only hash chain of hands, chip movements and admin actions. |
| **snapshot** | A table's whole state saved as JSON, so a restart resumes it. |
| **PGlite** | Postgres compiled to run inside the Node process, used when no separate database is set up. |
| **host / co-host / staff** | The table's creator, and people they gave some host powers. |
