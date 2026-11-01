# RSDP Poker Live!

Browser poker for friends, no sign-up. A host creates a cash table or a tournament, shares the link, and everyone plays in real time. Every game and option is free for everyone.

Live at https://rsdp-poker-live.fly.dev. Play money only.

## Where to read next

| If you want to… | Read |
| --- | --- |
| Understand how the code fits together, where to start reading, and how to run it | [docs/CODE_TOUR.md](docs/CODE_TOUR.md) |
| Check that the cards are dealt fairly, and see what the operator could still do | [docs/FAIRNESS.md](docs/FAIRNESS.md) (the same text as the site's `/fairness` page) |
| Know the exact rules each part of the code follows | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Host it, back it up or restore it | [docs/DEPLOY.md](docs/DEPLOY.md) |
| Fix it when something goes wrong (site down, bad release, leaked key) | [docs/RUNBOOK.md](docs/RUNBOOK.md) |
| Know why things are the way they are, and who decided | [docs/DECISIONS.md](docs/DECISIONS.md) |
| Report a security problem | [.github/SECURITY.md](.github/SECURITY.md) (privately, please) |
| See known bugs, what is being worked on, and what is waiting on whom | [Issues](https://github.com/jcolter11374/rsdp-poker-live/issues), and [CONTRIBUTING.md](CONTRIBUTING.md) for how we track and ship work |
| See what each release changed | [CHANGELOG.md](CHANGELOG.md) and [Releases](https://github.com/jcolter11374/rsdp-poker-live/releases) |

## Quick start

You need Node.js 22.

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

GitHub Actions (`.github/workflows/ci.yml`) runs the typecheck, all unit tests (including the hand fuzzers and the Postgres storage tests against a Postgres service), a production build, the browser smoke test against the Docker image, and a backup restore drill on every pull request and every push to `main` or `develop`. Merges to `main` deploy a GitHub-built, signed image to Fly.io; hourly and nightly jobs watch the live site and back it up (see [docs/CODE_TOUR.md](docs/CODE_TOUR.md#from-a-commit-to-the-live-site)).

## Who made it

John runs the project and makes the product decisions. Most of the code was written with an AI coding assistant (Claude, through Claude Code). Changes are checked by the tests above and by a separate review pass we run ourselves with another AI session; that is not an independent audit, and no outside auditor has reviewed the code. [docs/FAIRNESS.md](docs/FAIRNESS.md) explains what you can check for yourself without trusting us.

This is an original app; it doesn't use any other site's branding, assets or code. It is built on open-source software, credited with licenses in [docs/CREDITS.md](docs/CREDITS.md) and on the site's `/credits` page.
