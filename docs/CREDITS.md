# Credits

RSDP Poker Live! stands on free, open-source software that thousands of volunteers and companies have written and given away. This page names it and thanks them.

## What's ours and what isn't

The poker is ours. The rules for every game, the betting, the shuffle and the fairness checks, the tournaments, the practice bots, the table sounds and the whole look were written for this site from scratch. John runs the project and makes the product decisions, and most of the code was written with an AI coding assistant (Claude, through Claude Code). We didn't copy any other poker site's code, branding or artwork.

Everything underneath the poker is other people's work, used under their open-source licenses. Think of it like a house: we designed and built the house, but the bricks, pipes and wiring came from the store.

## The main building blocks

| What | What it does here | License |
| --- | --- | --- |
| [TypeScript](https://www.typescriptlang.org/) | The language the whole site is written in. It checks the code for mistakes before it runs. | Apache 2.0 |
| [Node.js](https://nodejs.org/) | Runs the game server: deals the cards, keeps the tables and saves the hands. | MIT |
| [Express](https://expressjs.com/) | Answers the server's web requests and hands out the pages. | MIT |
| [Socket.IO](https://socket.io/) | The live line between your browser and the table, so a bet shows up for everyone at once. | MIT |
| [React](https://react.dev/) | Draws the pages and the table in your browser and keeps them up to date. | MIT |
| [Vite](https://vite.dev/) | Bundles the browser code into the small files your browser downloads. | MIT |
| [PGlite](https://pglite.dev/) | The database that stores tables, hands and accounts. It is [PostgreSQL](https://www.postgresql.org/) packed to run inside the server. | Apache 2.0 (PostgreSQL License for PostgreSQL itself) |
| [node-postgres](https://node-postgres.com/) | Talks to a regular PostgreSQL server, for setups that use one instead of PGlite. | MIT |
| [Drizzle ORM](https://orm.drizzle.team/) | Helps the server read and write the database. | Apache 2.0 |
| [Zod](https://zod.dev/) | Checks that table settings and other things sent to the server are well formed before it acts on them. | MIT |
| [nanoid](https://github.com/ai/nanoid) | Makes the short random codes in table and tournament links. | MIT |
| [tsx](https://tsx.is/) and [esbuild](https://esbuild.github.io/) | Let the server run TypeScript directly, turning it into JavaScript as it starts. | MIT |
| [Inter](https://rsms.me/inter/) by Rasmus Andersson and the Inter Project Authors | The main font. | SIL Open Font License 1.1 |
| [Barlow Condensed](https://github.com/jpt/barlow) by the Barlow Project Authors | The font for big numbers like chip counts and the pot. | SIL Open Font License 1.1 |

The two fonts come through [Fontsource](https://fontsource.org/), which packages free fonts for websites.

Each of these uses smaller packages of its own, and those use others: about a hundred and ten packages in all. The full list, with each one's version and license, is at the bottom of the [credits page](https://rsdp-poker-live.fly.dev/credits) on the site.

## Tools that build and test it

These don't run with the game (Vite adds one tiny helper to what your browser downloads, so it's in the list below too), but the site couldn't be made without them: [Vitest](https://vitest.dev/) runs more than a thousand automatic tests, [Playwright](https://playwright.dev/) drives real browsers through whole games, [Rollup](https://rollupjs.org/) and esbuild do the bundling inside Vite, and [pokersolver](https://github.com/goldfire/pokersolver) is a second, independent hand ranker the tests check our own against. [GitHub](https://github.com/) holds the code and runs the checks, and [Fly.io](https://fly.io/) hosts the server, on [Debian](https://www.debian.org/) Linux.

## The licenses

Almost everything here uses the MIT, ISC, BSD or Apache 2.0 licenses. They all let anyone use the software for free, on the condition that the authors' copyright notice and license go along with it. The fonts use the SIL Open Font License, which asks the same of fonts.

So the site carries the license and notice files of every package, in full and word for word as their authors ship them, in one file: [third-party-licenses.txt](https://rsdp-poker-live.fly.dev/third-party-licenses.txt). The list on the credits page and that file are made automatically each time the site is built, from the packages actually installed, so they can't fall out of date. They count every package the browser and server parts depend on, so a few marked "your browser" (helpers React and Socket.IO only use while building, or only outside a browser) never actually reach it; listing too much is the safe side. A few server-only packages ship no license file of their own; for those the file names the license their authors chose.

None of these authors made, checked or endorse this site. Any bugs in the poker are ours.

The site's own code is open source too, under the MIT license: anyone may use, copy or change it, as long as the copyright notice and license go along with it. The [license](https://github.com/jcolter11374/rsdp-poker-live/blob/main/LICENSE) is in the code on GitHub.
