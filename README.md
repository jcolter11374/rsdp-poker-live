# RSDP Poker Live!

Browser poker for friends, no sign-up. A host creates a cash table or a tournament, shares the link, and everyone plays in real time. Every game and option is free for everyone.

## Quick start

```bash
npm install
npm run dev        # server on :3001, web client on http://localhost:5173
npm test           # engine, tournament director and server tests
npm run typecheck
npm run smoke      # browser smoke test (needs a running server; see e2e/smoke.mjs)
```

Production: `npm run build && npm start` serves the built client and the game server together on `PORT` (default 3001). Data goes to Postgres when `DATABASE_URL` is set, otherwise to an embedded PGlite database in `apps/server/.data/` (or `PGLITE_DIR`).

## How it's built

```
packages/engine      Pure TypeScript poker engine, no I/O: Hold'em, Omaha (4/5/6, hi-lo), Stud,
                     Razz, Stud Hi-Lo, 2-7 Triple Draw, Badugi; no/pot/fixed limit; side pots,
                     run it twice, bomb pots, 7-2, double board; table settings; socket types.
packages/tournament  Pure tournament director: registration, scheduled and Sit & Go starts,
                     levels and breaks, seating and balancing, rebuys, add-ons, re-entry, payouts.
apps/server          Node + Express + Socket.IO. Runs tables and tournaments on a server clock,
                     saves them (Drizzle on Postgres or PGlite) and picks them up after a restart.
apps/web             React + Vite client: lobby, table, tournament lobby and creation pages.
```

The server is authoritative: clients send intents (`hand:act`, `seat:request`, `tournament:command`, …) and get back their own view after every change, with other players' cards hidden. Players are identified by a random secret kept in `localStorage`; the server stores only its hash and shows others a public player id.

## Tests and CI

GitHub Actions (`.github/workflows/ci.yml`) runs the typecheck, all unit tests (including the hand fuzzer and the Postgres storage tests against a Postgres service), a production build, and the browser smoke test on every push and pull request.

Play money only. This is an original app; it doesn't use any other site's branding, assets or code.
