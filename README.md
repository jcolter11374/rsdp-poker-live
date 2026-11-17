# RSDP Live!

Browser poker for friends, no sign-up. A host creates a cash table or a tournament, shares the link, and everyone plays in real time. Every game and option is free for everyone.

Live at https://rsdp-poker-live.fly.dev. Play money only.

## Start here

New to the project? Read these three, in this order. Together they take under an hour.

1. **This page**, for what the project is and how to run it.
2. **[docs/CODE_TOUR.md](docs/CODE_TOUR.md)**, the map of the code: what each folder does, one bet followed from the button to every screen, which files to read first, and how a change reaches the live site.
3. **[CONTRIBUTING.md](CONTRIBUTING.md)**, how work is tracked and released: issues, pull requests, the checks a change needs, and [how the docs are kept current](CONTRIBUTING.md#keeping-the-docs-current).

To see what is going on right now, look at the [open issues](https://github.com/jcolter11374/rsdp-poker-live/issues) (bugs, work in progress, what is waiting on whom) and the newest [release](https://github.com/jcolter11374/rsdp-poker-live/releases) (normally what is live; the site's `/api/version` says exactly which commit it runs). Those are the record; nothing important lives only in someone's notes.

Everything else is for looking things up when you need it:

| If you want to… | Read | Kept current by |
| --- | --- | --- |
| Know the exact rules a part of the code follows (dense; a reference, not a first read) | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Any change to those rules |
| Know the tournament director's rules and how the server calls it | [packages/tournament/README.md](packages/tournament/README.md) | Any change to the director |
| Know why things are the way they are, and who decided | [docs/DECISIONS.md](docs/DECISIONS.md) | A new entry for each decision; old ones aren't edited |
| Check that the cards are dealt fairly, and see what the operator could still do | [docs/FAIRNESS.md](docs/FAIRNESS.md) (the site's `/fairness` page shows this file) | Any change to dealing, who sees what, or the public record |
| See what the site keeps about players, and its terms | [docs/PRIVACY.md](docs/PRIVACY.md), [docs/TERMS.md](docs/TERMS.md) (the site's `/privacy` and `/terms` pages show these files) | PRIVACY: any change to what is stored, for how long, how it's deleted, cookies or outside services. TERMS: any change to what the site promises or asks of players |
| Host it, back it up, restore it, or release it | [docs/DEPLOY.md](docs/DEPLOY.md) | Any change to hosting, settings, backups or the release steps |
| Fix it when something goes wrong (site down, bad release, leaked key) | [docs/RUNBOOK.md](docs/RUNBOOK.md) | Any change to what an alarm means or how to recover; each incident adds a line |
| Know what works with screen readers and keyboards, and what doesn't yet | [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md) | Any change to the look or controls of the table or the site's main pages |
| Play-test a release on a copy of the site | [e2e/playtest/README.md](e2e/playtest/README.md) | Any new play-test script |
| See what each release changed | [CHANGELOG.md](CHANGELOG.md) and [Releases](https://github.com/jcolter11374/rsdp-poker-live/releases) | Made by `npm run changelog` from the site's release notes; a test fails if it's stale |
| See the software this is built on | [docs/CREDITS.md](docs/CREDITS.md) (the site's `/credits` page) | Any new library |
| Report a security problem | [.github/SECURITY.md](.github/SECURITY.md) (privately, please) | |
| Know the rules the AI coding sessions work under | [CLAUDE.md](CLAUDE.md) | John's standing rules |

## Quick start

You need Node.js 22.12 or later.

```bash
npm install
npm run dev        # game server on :3001, website on http://localhost:5173
npm test           # unit tests for the engine, tournament director, server and website
npm run typecheck
npm run smoke      # browser smoke test (needs a browser and a running server; see docs/CODE_TOUR.md)
```

Production: `npm run build && npm start` serves the built website and the game server together on `PORT` (default 3001). Data goes to Postgres when `DATABASE_URL` is set, otherwise to an embedded PGlite database in `apps/server/.data/` (or `PGLITE_DIR`).

## How it's built

```
packages/engine      Pure TypeScript poker engine, no I/O: Hold'em, Omaha (4/5/6, hi-lo), Stud,
                     Razz, Stud Hi-Lo, 2-7 Triple Draw, Badugi; no/pot/fixed limit; side pots,
                     run it twice, bomb pots, 7-2, double board; table settings; socket types;
                     the fair shuffle and hand checker.
packages/tournament  Pure tournament director: registration, scheduled and Sit & Go starts,
                     levels and breaks, seating and balancing, rebuys, add-ons, re-entry, payouts.
apps/server          Node + Express + Socket.IO. Runs tables and tournaments on a server clock,
                     saves them (Drizzle on Postgres or PGlite) and picks them up after a restart.
apps/web             React + Vite website: lobby, table, replayer, tournament pages, rules guides.
scripts/             Stand-alone checkers for hands and the public record, backups, deploy helpers.
```

The server is authoritative: browsers send intents (`hand:act`, `seat:request`, `tournament:command`, …) and get back their own view after every change, with other players' cards hidden. Players are identified by a random secret kept in `localStorage`; the server stores only its hash and shows others a public player id. [docs/CODE_TOUR.md](docs/CODE_TOUR.md) follows one bet from the button to every screen.

## Tests and CI

GitHub Actions (`.github/workflows/ci.yml`) runs the typecheck, all unit tests (including the hand fuzzers and the Postgres storage tests against a Postgres service), a production build, the browser smoke test against the Docker image, and a backup restore drill on every pull request and every push to `main` or `develop`. Merges to `main` deploy a GitHub-built, signed image to Fly.io; scheduled jobs watch the live site and back it up, and another runs the fuzz tests far deeper than CI does (see [docs/CODE_TOUR.md](docs/CODE_TOUR.md#from-a-commit-to-the-live-site)).

## Who made it

John runs the project and makes the product decisions. Most of the code was written with an AI coding assistant (Claude, through Claude Code). Changes are checked by the tests above and by a separate review pass we run ourselves with another AI session; that is not an independent audit, and no outside auditor has reviewed the code. [docs/FAIRNESS.md](docs/FAIRNESS.md) explains what you can check for yourself without trusting us.

This is an original app; it doesn't use any other site's branding, assets or code. It is built on open-source software, credited with licenses in [docs/CREDITS.md](docs/CREDITS.md) and on the site's `/credits` page.

The code is open source under the [MIT license](LICENSE): anyone may use, copy or change it, as long as the copyright notice and license go with it.
