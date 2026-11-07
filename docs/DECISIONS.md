# Decisions

The lasting decisions behind RSDP Live!: what was decided, by whom, when, why, and where it shows in the code. Read this before changing something that looks odd. It may be on purpose.

How this file works:

- **Who decided** says whether it was John's call or Claude's. Claude sessions make routine engineering and product calls themselves and report them. Those are marked "Claude", and John can overturn any of them.
- Quotes of John are his own words, checked against his messages. Everything else is a summary.
- Entries are never rewritten. When a decision changes, add a new entry that says which one it replaces, and mark the old one **Replaced by D*n***. The one exception is an **Open question** line: once John answers, replace it with his answer and the date, and link where he said it.
- Private details stay out of this public file: friends' names, the group's spreadsheet, budgets.

| # | Decision | Decided | By |
| --- | --- | --- | --- |
| [D01](#d01-scope-full-parity-every-paid-feature-free) | Scope: full parity, every paid feature free | 2026-10-25 | John |
| [D02](#d02-the-groups-games-and-house-rules) | The group's games and house rules | 2026-10-25 | John |
| [D03](#d03-priorities-cash-games-first) | Priorities: cash games first | 2026-10-25 | John |
| [D04](#d04-who-decides-what) | Who decides what | 2026-10-25, 2026-11-01 | John |
| [D05](#d05-branches-merges-and-releases) | Branches, merges and releases | 2026-10-25, 2026-10-26 | John, with Claude's conditions |
| [D06](#d06-whats-new-and-the-changelog) | What's new and the changelog | 2026-10-26 | John |
| [D07](#d07-never-test-against-the-live-site) | Never test against the live site | 2026-10-25 | John |
| [D08](#d08-hosting-one-always-on-machine-on-flyio) | Hosting: one always-on machine on Fly.io | 2026-10-25 | Claude; cost rule John |
| [D09](#d09-stack-and-storage) | Stack and storage | 2026-10-25 | Claude, accepted by John |
| [D10](#d10-provably-fair-dealing-and-when-hands-are-revealed) | Provably fair dealing, and when hands are revealed | 2026-10-25, 2026-11-01 | John; design Claude |
| [D11](#d11-making-it-harder-for-john-to-cheat) | Making it harder for John to cheat | 2026-10-26 | John picked; design Claude |
| [D12](#d12-honest-trust-wording) | Honest trust wording | 2026-10-26, 2026-10-29 | John |
| [D13](#d13-daily-encrypted-backups) | Daily encrypted backups | 2026-10-26 | John approved; design Claude |
| [D14](#d14-no-live-huds-safeguards-for-spectators) | No live HUDs; safeguards for spectators | 2026-10-26 | John; details Claude |
| [D15](#d15-cash-tables-in-dollars-and-cents) | Cash tables in dollars and cents | 2026-10-27 | John |
| [D16](#d16-the-groups-tournament-defaults) | The group's tournament defaults | 2026-10-30 to 2026-11-01 | John |
| [D17](#d17-tournament-rules-chosen-by-claude) | Tournament rules chosen by Claude | 2026-10-25 | Claude |
| [D18](#d18-cash-table-simplifications-on-purpose) | Cash-table simplifications, on purpose | 2026-10-25, 2026-10-26 | Claude; nudge John |
| [D19](#d19-accounts-privacy-and-keeping-records) | Accounts, privacy and keeping records | 2026-10-25 to 2026-10-27 | John and Claude |
| [D20](#d20-group-results-proposed-not-built) | Group results (proposed, not built) | 2026-10-30 | John; plan Claude |
| [D21](#d21-look-and-feel) | Look and feel | 2026-10-25 to 2026-10-29 | John |
| [D22](#d22-how-work-is-tracked-and-checked) | How work is tracked and checked | 2026-11-01 | John asked; details Claude |
| [D23](#d23-the-code-is-under-the-mit-license) | The code is under the MIT license | 2026-11-01 | John |
| [D24](#d24-claude-sessions-may-read-the-live-site) | Claude sessions may read the live site | 2026-11-05 | John |
| [D25](#d25-full-and-light-changes) | Full and light changes | 2026-11-05 | John; the lists Claude |
| [D26](#d26-a-game-night-recap-for-john-read-by-claude) | A game-night recap for John, read by Claude | 2026-11-05 | John asked; design Claude |
| [D27](#d27-the-operator-can-read-table-chat) | The operator can read table chat | 2026-11-05 | John; design Claude |
| [D28](#d28-one-comparison-page-may-name-pokernow) | One comparison page may name PokerNow | 2026-11-06 | John |
| [D29](#d29-in-a-mix-with-stud-only-the-stud-games-ante) | In a mix with stud, only the stud games ante | 2026-11-06 | Claude |
| [D30](#d30-a-definition-of-done) | A definition of done | 2026-11-06 | John asked; wording Claude |
| [D31](#d31-mixed-game-details-settled-while-fixing-its-bugs) | Mixed-game details settled while fixing its bugs | 2026-11-06 | Claude |
| [D32](#d32-a-database-engine-that-changes-postgres-version-moves-in-three-releases) | A database engine that changes Postgres version moves in three releases | 2026-11-06 | Claude |
| [D33](#d33-dealers-choice) | Dealer's choice | 2026-11-06 | John; the fine print Claude |
| [D34](#d34-releases-go-out-when-theyre-ready-not-at-a-quiet-time) | Releases go out when they're ready, not at a quiet time | 2026-11-07 | John |
| [D35](#d35-the-site-is-called-rsdp-live) | The site is called RSDP Live! | 2026-11-07 | John |
| [D36](#d36-a-worked-out-stud-bring-in-is-a-round-amount) | A worked-out stud bring-in is a round amount | 2026-11-07 | Claude |
| [D37](#d37-the-cash-game-recap) | The cash game recap | 2026-11-07 | Claude |
| [D38](#d38-hand-entries-go-into-the-public-record-after-the-spectator-delay) | Hand entries go into the public record after the spectator delay | 2026-11-07 | John; details Claude |
| [D39](#d39-what-spectators-on-a-delay-are-shown) | What spectators on a delay are shown | 2026-11-07 | John; details Claude |

---

## D01. Scope: full parity, every paid feature free

- **Decided:** 2026-10-25, by John.
- **Decision:** "Clone" means full feature parity with PokerNow, not a small first version, with John's own additions later. Every feature PokerNow charges for (bomb pots, 7-2, double board, game rotation, Sit & Gos, the replayer and so on) is free for everyone: no payments and no tiers. The code, art, sounds and wording are all original. The site's own pages don't name PokerNow (a test checks the About page), except one comparison page (D28). Two older release notes do (the all-in runout line in the changelog and "Blinds the RSDP way" in What's new); they are live, so they stay. New pages and notes shouldn't name it.
- **Why:** getting the paid features to the whole group for free is one of John's main reasons for the project.
- **Where:** README (free for everyone; original app), [ARCHITECTURE.md](ARCHITECTURE.md) ("No PokerNow code, art, sounds or wording"), `apps/web/src/about/about.test.ts` (About page only).
- **Don't** scope a feature down without asking John.

## D02. The group's games and house rules

- **Decided:** 2026-10-25, by John.
- **Decision:**
  - Beyond PokerNow's games: Seven Card Stud, Razz, Stud Hi-Lo, 2-7 Triple Draw and Badugi, with rules help in the game.
  - Scheduled tournaments start by themselves, with no click from the creator.
  - Run it twice is for cash games only.
  - The host's approval of rebuys is a setting the host can turn off. It is on by default at cash tables and off in tournaments.
  - Buy-in amounts aren't enforced; the group agrees them among themselves.
  - Where PokerNow differs from how the group plays, the group's way is the default and PokerNow's is an option.
- **Why:** the group plays these games and is teaching them to friends. Starting tournaments by hand was John's biggest annoyance with PokerNow.
- **Where:** README (games), `packages/tournament/README.md` (auto-start, rebuy approval), `packages/engine/src/settings/schema.ts` (run it twice off in tournaments; buy-ins not enforced by default).

## D03. Priorities: cash games first

- **Decided:** 2026-10-25, by John.
- **Decision:** cash games must be rock solid first, because that's where friends will try the site and build trust. There's no rush for tournaments. Clubs and AI game analysis are off the roadmap for now. Audio and video chat stay, at the very end.
- **Where:** `apps/web/src/roadmap/roadmap.json`.

## D04. Who decides what

- **Decided:** 2026-10-25, and 2026-11-01 for the record-keeping rule, by John.
- **Decision:** Claude leads the day-to-day work. It makes engineering and routine product calls, starts work as needed, and posts short updates. It brings John only real product decisions: what the product is, or what it costs. On 2026-11-01 John asked for standard professional practice in tracking and documenting the work. GitHub is the record, and an AI session's memory is only a cache.
- **Why:** John doesn't want to micromanage. Four wrong status reports on 31 Oct and 1 Nov came from facts kept only in an AI session's memory.
- **Where:** [CONTRIBUTING.md](../CONTRIBUTING.md), [CLAUDE.md](../CLAUDE.md), D22.

## D05. Branches, merges and releases

- **Decided:** by John, in two steps:
  - **2026-10-25, 21:12 UTC, on a choice card.** He picked "Yes, merge to develop": merge each fix into `develop` once CI is green and a review passes, and report afterwards. Merging into `main` still needed his OK then. (Minutes later he also wrote: "I'll leave all of this up to your discretion. Don't confuse my enthusiasm for impatience.")
  - **2026-10-26, 05:13 UTC.** "Feel free to push things as they are done without asking me." From then on, finished work may go live without asking him each time.
- **Decision:** feature branch → `develop` → `main`, and a merge into `main` deploys. A review pass means one we run ourselves, recorded on the pull request (D22).
- **Claude's own conditions** on the standing OK, not John's words: test each release on a copy first, prefer quiet times, and tell John after each release. Asking first about anything that costs money or changes the product is John's own rule (D04, D08). **Partly replaced by D25** (2026-11-05): a release of only light changes skips the copy test and the wait for a quiet time. **The quiet-time condition is gone altogether since [D34](#d34-releases-go-out-when-theyre-ready-not-at-a-quiet-time)** (2026-11-07).
- **Settled 2026-11-05 by [D25](#d25-full-and-light-changes) ([#236](https://github.com/jcolter11374/rsdp-poker-live/issues/236)):** John approved Claude's two-path proposal, which keeps quiet times for releases with any full change and lets releases of only light changes go out whenever they're ready. (The question was whether John's "go ahead and push updates now. Don't worry about active tables" of 2026-10-26, 23:00 UTC, applied to every release or only to that one. He didn't say; the new rule replaces it.)
- **Where:** [DEPLOY.md](DEPLOY.md#releasing), [CODE_TOUR.md](CODE_TOUR.md).

## D06. What's new and the changelog

- **Decided:** 2026-10-26, by John.
- **Decision:** John: "Also minor bug fixes don't need to go into the what's new tracker. We could maybe have a changelog on the site for that." So What's new lists features players will notice, and /changelog lists every release with its small fixes. Releases bundle finished work when it's ready, with no fixed schedule (Claude's call).
- **Where:** `apps/web/src/roadmap/whatsnew.json`, `changelog.json`, `ChangelogPage.tsx`. Release versions and tags: D22.

## D07. Never test against the live site

- **Decided:** 2026-10-25, by John, after test data reached the live site (the "Smoke Cup", PR #35).
- **Decision:** never run bots, test tables or test games against the live site; test on a copy. Only read-only checks touch the live site, from GitHub Actions. **Replaced in part by [D24](#d24-claude-sessions-may-read-the-live-site)** (sessions may now also read it directly). Removing something from the live site needs John's OK. Practice bots are only ever seated by hand by a player or host: seats are never filled with bots automatically, and tournaments refuse bots.
- **Where:** `e2e/smoke.mjs` (refuses the live address), `deploy.yml` (read-only checks), `apps/server/src/runtime/table.ts` (no bots in tournaments), [RUNBOOK.md](RUNBOOK.md#incident-log).

## D08. Hosting: one always-on machine on Fly.io

- **Decided:** 2026-10-25. Claude set it up; the cost rule is John's.
- **Decision:** one always-on Fly.io machine (1 GB of memory) with a 1 GB data volume, never two copies. Fly bills John's account by usage. Anything that raises the cost needs John's OK first.
- **Why:** all live game state runs in one process, and a scheduled tournament must start even when nobody has the site open. Why Fly rather than another host wasn't recorded.
- **Where:** `fly.toml`, [DEPLOY.md](DEPLOY.md#flyio-production).

## D09. Stack and storage

- **Decided:** 2026-10-25. Claude proposed it and John accepted. The database upkeep (2026-10-26) is Claude's.
- **Decision:**
  - TypeScript throughout: pure engine and tournament packages; an Express and Socket.IO server that's in charge and holds tables in memory; a React website.
  - Storage through Drizzle: Postgres when `DATABASE_URL` is set, otherwise embedded PGlite, which is what the live site runs.
  - PGlite has no automatic clean-up, so the server vacuums it at start-up and every 5 minutes. Don't remove that.
  - Idle cash tables are unloaded from memory after 45 minutes.
- **Why:** pure packages are easy to test and can replay hands in the browser. Without the clean-up, the 1 GB volume fills after roughly 600 to 700 hands (about 1.5 MB a hand). Why the live site uses PGlite rather than a managed Postgres wasn't recorded.
- **Where:** [ARCHITECTURE.md](ARCHITECTURE.md), `apps/server/src/db/client.ts`.

## D10. Provably fair dealing, and when hands are revealed

- **Decided:** 2026-10-25 by John (the requirement and the reveal rule). The design is Claude's. The reveal rule was changed by John on 2026-11-01.
- **Decision:** a fair, random deal anyone can check afterwards (rsdp-fair-v1). The server commits to a secret seed a hand ahead, seated players' browsers add their own seeds, and anyone can re-deal a revealed hand. Folded cards stay private while a game is on. A hand's seeds are revealed once the game has stayed stopped for 30 minutes, or 12 hours after the hand, whichever comes first. The 30 minutes were added by John on 2026-11-01; before that, stopping the game revealed at once.
- **Why:** the deal must survive anyone's checking. The 30 minutes stop a quick Stop-then-Start from showing folded cards mid-session.
- **Where:** [FAIRNESS.md](FAIRNESS.md), `apps/server/src/runtime/table.ts` ("John's call, 2026-11-01"), PR #170.
- **Don't** weaken the browser checks, or reveal sooner, without asking John.

## D11. Making it harder for John to cheat

- **Decided:** 2026-10-26. John picked "the recommended package" from options Claude wrote up (PR #97). It cost nothing.
- **Decision:**
  - GitHub builds and signs every image, and Fly runs that exact image.
  - A hash-chained public record of hands, ledgers and admin actions is copied to the `transparency` branch.
  - A watcher checks the live machine and opens a public issue when something is wrong.
  - Players can see all this on the /transparency page.
  - Not chosen: card-protocol cryptography ("mental poker", judged impractical), a paid audit, and a friend as co-admin.
- **Operating rules (Claude's):**
  - Never deploy from a laptop.
  - Add any new secret to the watcher's list, or any new setting to `fly.toml`, before it's set.
- **Where:** [FAIRNESS.md](FAIRNESS.md#checking-john), `scripts/transparency/`, [DEPLOY.md](DEPLOY.md#adding-a-setting-or-secret).

## D12. Honest trust wording

- **Decided:** 2026-10-26 and 2026-10-29, by John.
- **Decision:** be completely honest with players about trust. /fairness lists every way John could cheat. Our own review passes are never called "independent". They're "a separate review we ran ourselves, not an outside auditor". No overselling. The AI-made explainer video stays off /fairness (it oversold). A "you're trusting John" box leads /fairness, and /terms says free, non-commercial and as-is (John read and approved both, PR #141).
- **Where:** [FAIRNESS.md](FAIRNESS.md), [TERMS.md](TERMS.md), README.
- Any page, release note or doc must keep to this.

## D13. Daily encrypted backups

- **Decided:** 2026-10-26. John approved, at no cost, and made the key pair himself. The design is Claude's.
- **Decision:**
  - GitHub Actions takes a backup once a day (the "Nightly backup" workflow, which GitHub usually starts between about 15:30 and 16:30 UTC; see [DEPLOY.md](DEPLOY.md)), test-restores it on a real server, and locks it to John's public key.
  - Only John holds the private key, and no AI session ever handles it.
  - Backups are kept 90 days.
  - A failure, or the site going down, opens an issue.
- **Where:** [DEPLOY.md](DEPLOY.md#backups), `.github/workflows/backup.yml`, `uptime.yml`.

## D14. No live HUDs; safeguards for spectators

- **Decided:** 2026-10-26, by John. The exemptions and safeguard details are Claude's.
- **Decision:**
  - No tracking tools at running tables: while the game runs, hand downloads are locked for anyone seated (in a tournament, anyone still in the event) and for onlookers who never played at the table, so a second device can't fetch them for a seated player. Reviewing hands afterwards is fine.
  - The in-table Stats tab stays. John's call; don't ask again.
  - A host can let spectators see every card, but only between hands and only for later hands. Players must agree before they sit, and everyone sees a warning.
  - Exempt from the lock: practice tables where only bots have played against you, the host and co-hosts while they aren't seated, and players who have left the table.
- **Where:** [FAIRNESS.md](FAIRNESS.md#huds-and-tracking-software), `apps/server/src/runtime/table.ts`, PRs #90, #168.

## D15. Cash tables in dollars and cents

- **Decided:** 2026-10-27, by John: "I think for cash we just don't have chips as an option. We treat it just like a casino and have chips for all the denomations of money."
- **Decision:** every cash table made since PR #132 (2026-10-27) counts in dollars and cents (one engine chip is one cent), with casino chips for each denomination. Older tables keep counting in chips. The home page starts new tables at .25/.50. Tournaments stay in plain chips. A table's unit never changes after it's created.
- **Where:** `packages/engine/src/settings/money.ts`, `apps/web/src/Home.tsx` (the .25/.50 start), PR #132.

## D16. The group's tournament defaults

- **Decided:** 2026-10-30 to 2026-11-01, by John.
- **Decision:**
  - New tournaments default to the group's own setup: No-Limit Hold'em, 63,000 chips, 28 levels of 8 minutes, no antes or breaks, and late registration through level 5 (the group's own PokerNow structure, PR #163).
  - The group's payout table is the default (PR #158), and the prize pool is on by default with a $20 buy-in (PR #161).
  - Table rules: 10 seconds to act, a 20-second time bank that refills every 30 hands, and no rabbit hunting (PR #165). Straddles are never allowed in tournaments.
  - Hosts can change the table rules until the first table opens (PR #172).
- **Where:** `packages/tournament/src/structure.ts` (RSDP levels and table rules), `saved.ts` (the RSDP starter), `payouts.ts` (the RSDP payout table), and `apps/web/src/tournament/TournamentCreate.tsx`, which makes them the new-tournament default. The package's own `defaultSettings()` in `director.ts` is still the generic 10,000-chip setup; the form starts from it and applies the RSDP starter.

## D17. Tournament rules chosen by Claude

- **Decided:** 2026-10-25, by Claude. All reversible.
- **Decision:**
  - Auto-start seats players 60 seconds early, and waits up to 15 minutes when there are fewer than 2 entrants.
  - Players busted in the same hand finish in order of their starting stacks, with ties during hand-for-hand.
  - A busted player who doesn't take a rebuy offer is placed with the hand that busted them, not when the offer ends (PR #170).
  - A player who joins a table mid-game is dealt in at once without posting, except on the button, the small blind or between them, where they wait one hand for the button to pass (the usual card-room rule; issue #311). Added 2026-11-05; John chose to keep this standard rule.
  - Bounties are shown per entry. A progressive knockout puts part of each bounty on the winner's head.
  - Invite codes are single-use, or one shared code. Invite-only events stay off the home page.
  - Season points: entrants minus place, plus one.
  - Browser alerts are opt-in. Guests can host and register with a display name.
  - One co-host model covers cash and tournaments.
- **Where:** `packages/tournament/README.md` ("Rules chosen"), `packages/tournament/src/listing.ts`.

## D18. Cash-table simplifications, on purpose

- **Decided:** 2026-10-25 and 2026-10-26, by Claude. The betting nudge is John's.
- **Decision:** these are simpler than PokerNow on purpose. Don't "fix" them without asking John.
  - The Nit game's loser pays from their stack at the end of the round, with no money held aside. A shortfall goes on their buy-in.
  - Hidden rake is cosmetic; the log still shows it.
  - Losing hands are mucked by default, with a show-all option.
  - Defaults: waitlist off (when it's on, a freed seat is held 60 seconds for the next person; someone whose offer is let go, because the table is getting smaller or a Dealer's choice game has no room for it, keeps their place, and the offers of anyone behind them are let go too, so the seats are offered again in queue order), offline players' seats never released, profanity filter off, rabbit hunting on in cash games. The host can shuffle seats only between hands.
  - Unusual game and betting pairings get a gentle nudge but are never blocked (John, 2026-10-26).
- **Why:** simpler code with outcomes the group accepts.
- **Where:** `apps/web/src/rules/extras.ts` (the Nit rule as players are told it).

## D19. Accounts, privacy and keeping records

- **Decided:** 2026-10-25 to 2026-10-27. John chose Google sign-in, how records are kept, the analytics and the privacy policy. Claude chose guest play without accounts and the password reset without email.
- **Decision:**
  - Accounts are optional; guests can play and host.
  - Sign in with Google uses only the basic profile, no email address.
  - Password reset works without email, through a one-time code from the admin.
  - Hands and ledgers are kept for good. Anyone can hide a table from their own profile. A host can delete only a table where no real game happened.
  - Practice games are kept apart from real ones.
  - No ads, no analytics services, no trackers and no third-party scripts. IP addresses are held in memory only and never saved. Rate-limit entries are forgotten within about an hour; the address a tournament was made from is kept while that tournament is open (PR #168). A restart forgets them all. [PRIVACY.md](PRIVACY.md) has the exact wording.
  - Any new stored data, cookie or outside service needs a [PRIVACY.md](PRIVACY.md) update.
- **Where:** [ARCHITECTURE.md](ARCHITECTURE.md), [PRIVACY.md](PRIVACY.md).

## D20. Group results (proposed, not built)

- **Proposed:** 2026-10-30. John set the goal; the plan is Claude's.
- **Proposal:** the group's own results spreadsheet stays the official record for now. Later, the site may help keep it up to date, with results visible only to signed-in members of the group. The details are still open. Two parts have shipped: the default payout table (D16, PR #158), and the prize pool on by default with a $20 buy-in, so buy-ins and prizes are saved with each tournament's results (PR #161).

## D21. Look and feel

- **Decided:** 2026-10-25 to 2026-10-29, by John, choosing from mock-ups.
- **Decision:**
  - A clean, flat felt look, with original art.
  - Cards tucked into the nameplate.
  - Lit felt, motion, big moments and the group's crest, with the spin toned down.
  - Original sounds, and the turn clock as a smooth line.
  - John sees before-and-after pictures before a change to the table's look goes live.

## D22. How work is tracked and checked

- **Decided:** 2026-11-01. John asked for standard practice (D04); the details below are Claude's and reversible.
- **Decision:**
  - Every piece of work is a GitHub issue, and every pull request names its issue.
  - Each release gets a date-based version, a git tag and GitHub release notes (PR #175).
  - Each review pass is posted as a comment on its pull request: what was checked, the findings, how each was resolved, and the commit reviewed.
  - Library updates arrive as monthly Dependabot pull requests into `develop`. A weekly check keeps an issue open while high or critical security advisories exist.
- **Not done, on purpose:**
  - A paid staging server (it would roughly double the bill; releases are tested on a copy instead, see [DEPLOY.md](DEPLOY.md#before-a-release-testing-on-a-copy)).
  - Required approvals on pull requests. Every PR comes from John's one account, and GitHub doesn't let an author approve their own PR.
  - Strict commit formats, and an outside error-tracking service (it would send players' data to another company).
- **Where:** [CONTRIBUTING.md](../CONTRIBUTING.md), [CLAUDE.md](../CLAUDE.md), `.github/dependabot.yml`.

## D23. The code is under the MIT license

- **Decided:** 2026-11-01, by John, choosing MIT over AGPL-3.0 or keeping all rights reserved (issue #202).
- **Decision:** the code is open source under the MIT license. Anyone may use, copy, change and run their own copy, as long as the copyright notice and license go with it. Before this the repository had no license, so people could read the code but had no clear permission to copy it, though the fairness page encourages keeping a copy.
- **Where:** [LICENSE](../LICENSE), the `license` field in every package.json, README, [CREDITS.md](CREDITS.md).

## D24. Claude sessions may read the live site

- **Decided:** 2026-11-05, by John, saying yes to letting Claude's sessions read the live site (issue #298). Replaces the "from GitHub Actions" part of D07; the rest of D07 stands.
- **Decision:** Claude's cloud environment allows one extra host, `rsdp-poker-live.fly.dev`, so a session can read the live site directly to check a release or read feedback. Only reads: GET requests to public pages and read-only endpoints such as `/api/version` and `/api/health`. Still never bots, test tables, test tournaments, sign-ups or anything else that writes (D07). Fly itself (`fly.io`, `flyctl`, deploys, secrets) is not on the list and still goes only through `main`'s workflows.
- **Why:** routing every read through a workflow made release checks and reading feedback slow.
- **Where:** the cloud environment's network settings (John's Claude account, not this repo), [CLAUDE.md](../CLAUDE.md), [RUNBOOK.md](RUNBOOK.md).

## D25. Full and light changes

- **Decided:** 2026-11-05, 16:10 UTC, by John, on Claude's proposal; the details are Claude's. Claude set out what each shortcut would risk: skipping the review pass lets more bugs reach players, skipping the play-test means problems show up in a real game instead, and releasing at any time means a game can pause for a few seconds while the server restarts. The checks on GitHub can't be skipped. Claude recommended keeping the full process for anything that touches the game itself, and for low-risk fixes like wording, layout or download buttons, "a lighter review plus releasing as soon as it's ready". John: "If you think it is reasonable yes. If you think it is reckless no". Claude judged it reasonable: the checks on GitHub still run on every change, and every change that could affect a game keeps every step.
- **Decision:** a change takes one of two paths.
  - **Full**, for anything that touches the game or players' data: dealing, chips and pots, timers, tournaments, hidden cards, privacy, fairness and the public record, sign-in, stored data, how the site runs, and the safety checks themselves. CI, a separate review pass, a play-test on a copy, and a release at a quiet time (**replaced by [D34](#d34-releases-go-out-when-theyre-ready-not-at-a-quiet-time)**: no quiet-time wait).
  - **Light**, for changes that can't affect a game, who is allowed to see what, or what's stored: displayed wording, layout, download buttons that offer only what people can already download, docs. CI and a shorter review pass, and live as soon as it's ready.
  - When unsure, full. A release takes the path of its riskiest change.
- **Claude's calls**, not John's words: the exact lists and what a light review checks (in CONTRIBUTING.md), and dropping the copy test for light-only releases. The copy test was Claude's own condition in D05, and the proposal had already told John that skipping it means problems turn up in a real game.
- **Still applies:** D21 (John sees before-and-after pictures of a change to the table's look before it goes live) and D14 (the no-HUD lock on downloads).
- **Replaces** part of D05's conditions (the copy test and quiet times, for light changes), and settles D05's open question (#236).
- **Where:** [CONTRIBUTING.md](../CONTRIBUTING.md#full-or-light-how-much-checking-a-change-needs), [DEPLOY.md](DEPLOY.md#releasing), [CLAUDE.md](../CLAUDE.md), the [pull request template](../.github/pull_request_template.md).

## D26. A game-night recap for John, read by Claude

**Replaced in part by [D27](#d27-the-operator-can-read-table-chat)** (the operator may now read table chat; the recap still reads none).

- **Decided:** 2026-11-05. John asked for a short recap after each game night (errors, player feedback, anything odd) so he never has to go looking (issue #297). The design is Claude's and reversible.
- **Decision:**
  - The server keeps its own error lines (and browser error reports) for 30 days in its database, and a line at each clean shutdown, so a restart without one reads as a crash. Fly's log forgets within days.
  - `GET /api/admin/recap` returns errors, restarts, activity counts, tournaments (late or never started) and what players sent with Send feedback, without names or tables (John chose to include the words, 2026-11-05) for a window of time. No chat: whether the operator may read table chat is John's call (issue #300). It takes a separate read-only key (`REPORT_KEY`), so the scheduled recap never holds the key that can delete tables or download the database.
  - A scheduled Claude task reads it the morning after a night with games and writes John a summary in his private Claude project, split into "could affect a real game" and "minor". Quiet nights send nothing.
- **Not done, on purpose:**
  - An outside error-tracking service (D22 still stands). The recap sends Anthropic far less: no chat, names, addresses, cards or chips. [PRIVACY.md](PRIVACY.md) says so.
  - Posting recaps to GitHub: the repository is public.
  - Recording each read in the public record: like the admin page's lookups, reading changes nothing.
- **Where:** `apps/server/src/recap.ts`, [DEPLOY.md](DEPLOY.md#game-night-recap).

## D27. The operator can read table chat

- **Decided:** 2026-11-05, by John: "I think the operator should be able to read table chat" (issue #300). The design is Claude's.
- **Decision:**
  - `GET /api/admin/chat/:id` returns the chat of one cash table, or of every table a tournament opened, by the table's or tournament's id. It works while the table is open and after it has closed. It sends only the words, the names players saw and the times: no player ids, no table log.
  - The admin page has a "Read a table's chat" form for it, with a download as text.
  - Only the admin key opens it. The read-only `REPORT_KEY` does not, so the scheduled recap can't read chat with the key it holds today.
  - Every read goes in the public record as an admin action (`read-table-chat` or `read-tournament-chat`), with only a fingerprint of the table or tournament (the same one its hands use, so people with its link can tell it was theirs), before the chat is sent, the way a backup is recorded. [/transparency](https://rsdp-poker-live.fly.dev/transparency) shows each one as "Chat read".
  - [/fairness](FAIRNESS.md#how-the-developer-could-cheat-you), [/privacy](PRIVACY.md) and /transparency say so.
- **What isn't recorded:** chat seen any other way: reading the database or a backup, a shell on the server, or being at the table. The pages say so.
- **Why recorded:** John could already read chat in the database (PRIVACY.md said so). The admin page makes it easy, so each use is public, unlike the admin page's other lookups, which change nothing and aren't recorded (D26's reasoning for the recap).
- **Not done, on purpose:** a GitHub workflow that downloads chat: the repository is public, and a workflow's files can be downloaded by others. Whether the game-night recap (D26) should use chat is a separate call for that work; if it does, its key, what it reads and the public record entry need their own decision.
- **Replaces** D26's "No chat: whether the operator may read table chat is John's call (issue #300)" as far as the operator goes; the recap itself still reads no chat until a change says otherwise.
- **Where:** `apps/server/src/app.ts` (`/api/admin/chat/:id`), `apps/web/src/roadmap/AdminPage.tsx`, [FAIRNESS.md](FAIRNESS.md), [PRIVACY.md](PRIVACY.md), `apps/web/src/fairness/TransparencyPage.tsx`.

## D28. One comparison page may name PokerNow

- **Decided:** 2026-11-06, by John, on a decision card ("Only on the comparison page"), after he asked to publish the feature comparison (issue #339).
- **Decision:** one public page may name PokerNow: a dated, factual feature comparison of this site, PokerNow free and PokerNow Plus. Every other page, guide and release note still doesn't name it.
  - The comparison stays honest, like /fairness: it keeps the rows where PokerNow is ahead (voice and video, phone alerts, track record) and marks things we dropped on purpose.
  - It says when it was checked and links PokerNow's own plans page as the source, since their features change.
  - It states facts, with no digs at PokerNow, and uses none of its art, logos or wording.
- **Why:** the no-name rule came from a session building the About page (2026-10-26), as caution about looking like a knock-off; John was never asked and no reason was recorded. A fair comparison helps friends see what they get here.
- **Replaces** D01's "the site's own pages don't name PokerNow" for that one page only.
- **Where:** issue #339 (the page, not built yet); `apps/web/src/about/about.test.ts` keeps the About page name-free.

## D29. In a mix with stud, only the stud games ante

- **Decided:** 2026-11-06, while adding HORSE and 8-Game (issue #335). John asked for the mixes; this detail is Claude's and reversible.
- **Decision:** a cash table has one set of stakes for every game in its rotation. When the rotation includes a stud game (Seven Card Stud, Razz, Stud Hi-Lo), the ante setting is the stud ante: hold'em, Omaha and draw hands in that rotation post no ante (of either kind). A rotation with no stud game keeps its antes in every game, as before. The Limit games bet the Limit small and big bets, which a new HORSE or 8-Game table sets to the big blind and twice it.
- **Why:** that is how HORSE and 8-Game are played in card rooms and online. Without it, a hold'em orbit in HORSE would ante as well as post blinds.
- **Not done, on purpose:** separate stakes for each game in a rotation (for example different blinds for 8-Game's No-Limit and Pot-Limit rounds). One set of stakes keeps the Stakes tab simple; the Mixed games guide says so.
- **Tournaments too** (added 2026-11-06, issue #338): in a tournament whose rotation includes a stud game, the levels that deal a blind game post no ante; the stud levels post the level's ante. A tournament's rotation can give each game its own betting (`gameBetting`), so HORSE and 8-Game tournaments play Limit Hold'em and Limit Omaha Hi-Lo.
- **Where:** `packages/engine/src/variants/mixes.ts` (`MIXED_GAMES`, `skipsMixedGameAnte`), `handSetup` in `apps/server/src/runtime/table.ts`, `levelFor` in `packages/tournament/src/director.ts`.

## D30. A definition of done

- **Decided:** 2026-11-06. John asked how to stop work being reported done when only part of it was, and why it kept happening (issue #344). The wording is Claude's.
- **Decision:** work is done only when the whole original ask is finished and checked on the live site, by looking only (D07, D24; anything that needs a game is tested on a local copy). Merged but not released is "on develop", not done. Before anyone reports done or closes a thread, every follow-up issue it opened is either being actively worked on or labelled `status: waiting on John` / `status: waiting on others` with the reason in a comment. The steps are in [CONTRIBUTING.md](../CONTRIBUTING.md#definition-of-done).
- **Why:** twice on 2026-11-05/06 a session shipped part of an ask, opened an issue for the rest and stopped: HORSE and 8-Game reached cash tables but tournaments (#338) sat untouched, and bigger cards reached only some games (#317, then #331). The old rules allowed it: "done" meant the issue was closed, and leftovers only had to become new issues. Sessions are short-lived and nothing picks up a new issue by itself, so an issue with no owner was work nobody was doing.
- **Where:** [CONTRIBUTING.md](../CONTRIBUTING.md#definition-of-done), [CLAUDE.md](../CLAUDE.md), the [pull request template](../.github/pull_request_template.md).

## D31. Mixed-game details settled while fixing its bugs

- **Decided:** 2026-11-06, by Claude, fixing the mixed-game bugs found while planning Dealer's choice (issues #354 to #361). All reversible.
- **Decision:**
  - **A big-blind ante in a stud game** (a tournament level or a cash table) is paid by everyone as a per-player ante of about an eighth of it, rounded to the presets' tidy ante amounts, at least 1 and never more than the big-blind ante: 300 becomes 40 (#354). The lobby clock and structure table show the ante each level's game really deals, and the structure editor tells the host.
  - **A cash blind schedule raises the Limit bets and the stud bring-in** with the blinds, keeping the table's own size of each to its big blind: a table set to 0.25/0.50 with bets of 0.50/1 bets 8/16 at blinds of 4/8 (#358). A table with no big blind of its own bets the level's big blind and twice it, as tournaments do. A level with no big blind (a stud schedule that only raises the antes) keeps the Stakes tab's bets and bring-in, since there is nothing to size them by.
  - **A bomb pot during a stud game** is dealt from the button the stud hand would have had, so it takes one hand of the orbit, as a bomb pot does in hold'em (#355).
  - **A smaller table mid-game** moves the seat where the current game's orbit began with its player (#356). If that seat is empty (its player left), the orbit follows the next player round from it, whom the button reaches when it would have reached the seat; if the button is on an empty seat in between, it has just gone past the start, and the orbit counts from there. If the blinds have to be drawn afresh (the button or a blind was on a seat that goes), the orbit starts again from the new button, so that game can run long but not short. When the move itself changes the order round the table (the free seats left don't allow the old order), a game can still be a hand short or long: the order of play has changed, so there is no single right length, and we leave it at that.
  - **A deal that can't go ahead** (for example a game in the rotation that can't seat everyone) leaves the rotation where it was, so no game is skipped or cut short (#357).
  - **A cash hand the usual rules would deal to fewer than two players** (new players and missed blinds waiting for the button to pass, which it can't while no hand is dealt) deals everyone in free instead, as when a game starts (#357). Before, the table sat still until someone sat down, sat out or left; the nightly deep fuzz caught it too (#286).
- **Why:** each is what a card room does, or the plainest rule that keeps every game its full length. A big-blind ante of 300 at a full stud table of 8 puts about what 8 antes of 40 put in, and matches what the per-player presets give at that big blind.
- **Where:** `packages/engine/src/variants/antes.ts` (`studAnteForBigBlindAnte`, `anteForGame`), `levelDeal` in `packages/tournament/src/director.ts`, and in `apps/server/src/runtime/table.ts`: `fillStakes`, `cashHandStakes`, `nextRotation`, `dealHand`, `applyPendingSettings` and `moveIntoKeptSeats`.

## D32. A database engine that changes Postgres version moves in three releases

- **Decided:** 2026-11-06, while taking Dependabot's #259 (issue #367). The plan is Claude's; the coordinator asked for the PGlite update to be split from the test-tool security fix if it was risky.
- **Decision:** PGlite 0.2 runs Postgres 16 and PGlite 0.5 runs Postgres 18, and Postgres can't open another major version's data files. So the live site's folder (`/data/pglite`) moves across in three releases, each one full (D25) and each one able to roll back to the one before:
  1. **Both engines.** PGlite 0.5 ships next to 0.2 (installed as `pglite-0.2`). A Postgres 18 folder opens with 0.5; new folders, in-memory databases and Postgres 16 folders open with 0.2, as before. Nothing changes on the live site. 0.5 is started with 0.2's limit on kept write-ahead log (`max_wal_size` 64 MB, where 0.5's own is 1 GB), so a big write such as a restore doesn't leave that much on the 1 GB volume.
  2. **Move the data.** On start, a Postgres 16 folder is copied into a new Postgres 18 folder through the backup format (export with 0.2, restore with 0.5, every table's row count checked) and swapped in; the old folder stays beside it. New folders use 0.5 from then on.
  3. **Tidy up.** PGlite 0.2 and the move are removed once the live site runs on the moved folder. Nothing fails if one of these is missed, so remove them together: the `pglite-0.2` dependency and its Dependabot ignore, `LegacyPGlite` in `client.ts` and the tests, the `pglite-0.2` name in `apps/web/licenses.test.ts`, the "two versions ship" sentences in docs/CREDITS.md (the public /credits page) and docs/ARCHITECTURE.md, and the move's own code and its notes in docs/DEPLOY.md and docs/RUNBOOK.md.
- **Why:** #259 put 0.5 in place of 0.2 in one step. Deployed, the server couldn't have opened the live database, and nothing in CI would have said so: every CI check starts from an empty database, and the upgrade rehearsal (`upgrade.yml`) runs only on releases. The rehearsal also starts the release before on the upgraded data, as a rollback would; a single-step move fails that on purpose, because the release before can't read Postgres 18. Step 1 is what makes the move in step 2 reversible.
- **For next time:** Dependabot groups PGlite with Drizzle in a `database` group of its own (`.github/dependabot.yml`). A PGlite update that changes the Postgres major version (see `PGLITE_POSTGRES` in `apps/server/src/db/client.ts`, which `apps/server/test/pglite-versions.test.ts` checks) follows these three steps again.
- **Where:** `apps/server/src/db/client.ts`, `apps/server/test/pglite-versions.test.ts`, issue #367.

## D33. Dealer's choice

- **Decided:** 2026-11-06, by John (issue #341). He asked how Dealer's choice would work, read the plan, and took all nine of its recommendations on a decision card. The fine print below the nine is Claude's, settled while building it, and reversible.
- **Decision (John's nine):**
  1. A pick lasts one orbit: as many hands as players were dealt into its first hand. The host can set a fixed number of hands instead.
  2. A **Pick chip**, separate from the dealer button, says who picks next. It moves one seat to the left after each pick.
  3. The table keeps the seats the host chose. Games that seat fewer players than are sitting down are greyed out in the picker.
  4. If the chooser doesn't pick in time, the current game carries on for another orbit.
  5. The same game can be picked twice in a row. No "no repeats" setting unless the group asks.
  6. A bot holding the chip picks at random from the games that fit, using the site's secure random numbers (as random bomb pots do).
  7. Cash tables only, for now.
  8. HORSE and 8-Game fill the menu in one tap; they aren't a single pick.
  9. One set of stakes for every game on the menu, as for mixed games (D29): with a stud game on the menu, only the stud games ante.
- **The fine print (Claude):**
  - **The menu** has 2 to 20 entries, each a game with its betting, with no entry twice. Dealer's choice and a mixed-game rotation can't both be on.
  - **The first chooser:** when Dealer's choice starts at a table that hasn't dealt yet, a random player (the site's secure random numbers) gets the chip, and the first hand's button is drawn on them. At a table already playing, the chip starts with the player due the next button, and the game it was dealing (a rotation's game, if it was rotating) is the "current game" until the first pick, so the chooser can keep it. A table that hasn't dealt yet has no current game. Turned off and on again, it starts afresh: a pick from before is never resumed.
  - **When the clock runs:** once the last hand of an orbit is dealt, the chooser can pick at any time, with no clock. The pick clock (20 seconds by default; the host can set 10 to 60) starts when the next hand is due, and the table waits for the pick instead of dealing it. A pick made early is dealt with no wait. A paused table stops it, and so does a table that can't deal (the game stopped, or too few players): the chooser can still pick, and gets a fresh clock once a hand can be dealt. At a new table the first hand's button goes to whoever makes the first pick, including someone picking in the first chooser's place while there is no clock; if they aren't dealt in (sitting out, say), it goes to the next player round who is. That holds when the first game picked is a stud game too, where the button only sets the dealing order. While the table is paused the chip itself stays put: a chooser who sits out and back in during a pause keeps it. After a restart the chooser gets a fresh clock.
  - **Who can pick:** anyone seated who isn't sitting out, has chips and isn't offline past the table's offline grace time, including a newcomer waiting for the big blind. That is checked while they hold the chip and picking is open: if they stop being able to pick, the chip moves on for good (they don't take it back by sitting in again, and nor does someone who sits in their seat) and the next player gets a fresh clock. At a new table, the first hand's button goes with it. A pick that's made stands, even if the chooser then busts or leaves. If nobody can pick, the current game carries on and the chip stays.
  - **The default:** a missed pick keeps the current game if it is still on the menu and fits the table; otherwise the first game on the menu that fits. A fixed rule, so everyone knows what will happen.
  - **An orbit gets shorter** when players leave: it ends once it has had as many hands as were dealt into its first hand, or as the next hand would deal in if that is fewer (so when someone leaves before the last hand, the pick can be due at once). Someone sitting out a hand shortens it only while they are out: back in, the orbit is its full length again.
  - **A table made smaller** by the host: the Pick chip moves with its player into their new seat. If its seat is empty and goes, it passes to the next player round from it, who would have picked anyway. As for a move, if its holder is sitting out or away and the players moved would put the PICK tag on someone else, the chip goes for good to whoever had the tag.
  - **The host moves a player or shuffles the seats:** the Pick chip stays with the player who holds it, in their new seat. If its holder is sitting out or away and the change would put the PICK tag on someone else (whoever picks in their place depends on the seating), the chip goes for good to whoever had the tag. The host sets the menu, never the pick, so no seat change gives the next pick to someone else. Who picks after them follows the new seating. At a new table the first hand's button goes with the first chooser too, and with the chip when it goes for good to whoever had the tag; after the first hand, a shuffle draws the button afresh as usual.
  - **A chooser who leaves** gives up the Pick chip: it goes to the next player round from their seat, who would pick in their place anyway. Whoever sits down in that seat later, or a bot the host adds there, doesn't take it. If nobody is left at the table, the first player to sit down takes it, wherever they sit. At a new table the first hand's button goes the same way, to the next player round from their seat, even if they made the first pick before leaving. A new table that everyone leaves before its first hand starts afresh: a pick made before they left goes with them, and the next deal draws a new first chooser, with a whole pick clock as soon as two players are seated (the table doesn't wait out the old clock, paused or not). (While a holder sits out, whoever picks in their place is the first player round from them who can pick, so someone sitting down in between picks instead: the seating decides, as for any skip.)
  - **An all-in runout:** while the cards are dealt out, the PICK tag stays where it was, since once the server has the result it passes over anyone who busted. A chooser in that all-in picks once the result shows; their pick clock only starts after it. A chooser not in it can pick as usual, while the tag is still theirs; a pick made in their place (they left or sat out during it) waits for the result, since the server may have passed over someone who busted to get there. The players counted for which games fit, the seat limit, which empty seats are closed, and the game a missed pick would deal also stay as they were until the result (newcomers still count, and can close seats, at once), since a busted bot leaving or a pick made in a busted chooser's place would change them. At any table, the seats of the players in the runout stay taken until it has been dealt out: a busted player's seat isn't offered from the waitlist, drawn for a random seat or sat in early, and Dealer's choice still counts them. Anyone joining the waitlist then is queued either way, and a seat that comes free for another reason is offered as usual. A browser shows only the seat offers it had before the result until the result shows (#437).
  - **Seats while a smaller game is on:** from the moment a game is picked (or kept) until the next game starts, the table seats nobody beyond that game's limit, counting seats held for a waitlist offer or a seat request as taken. Someone taking a seat held for them (their waitlist offer, or their seat request the host approves) counts only the other counted waitlist offers, as the check that the game fits does, so a seat request never blocks an offer the game was picked with. Empty seats show as closed, and the waitlist, seat requests and new bots wait. A spectator watching on a delay who tries to sit in a closed seat is told only that it is closed, not which game was picked. A game "fits" when the seated players plus anyone offered a seat from the waitlist are no more than it seats. Seat requests don't count toward that, because only the host sees them; they wait while a smaller game is on. Nor does a waitlist offer to someone who still needs the host's OK at a table that approves newcomers: taking it only asks for the seat, and that request waits like any other. Otherwise a spectator the host hasn't let sit could keep a smaller game off the menu by joining the waitlist (#453). If an offer starts to count after the game was picked (the host turns approval off, or gives its holder the power to approve seats) and the game has no room for it, it is let go, the latest in the queue first, and its holder stays on the waitlist for the next seat, ahead of anyone behind them who is still waiting. (A seat request someone behind them has already made stays with the host, who approves requests in any order.) The host can't save a menu where no game fits, and the table has no more seats than the menu's biggest game.
  - **A host's change** to the menu applies from the next pick. Editing the menu never moves the chip or restarts the orbit, and a pick already made stands even if its game comes off the menu.
  - **A host's change during a hand** waits for the next hand, and picking follows it (#423, #425). A game coming off the menu can't be picked or kept going for the next hand, and isn't what a missed pick deals; if the whole menu changes, the chooser picks from the new one once the hand is over. A change to one game or a rotation ends Dealer's choice with that hand: picking closes, the PICK tag goes and the top bar says it's the last hand. A pick already made then isn't dealt, and the log says so (unless the host's new game is the one picked).
  - **What players see:** the chooser gets a "Pick the next game" panel; everyone sees the Pick chip, a "Sam is picking" line where "Next hand in" shows, and the game in the top bar. Picks go in the table log. There is no chat line: chat isn't held back for spectators on a delay, and a pick made as a hand ends would tell them it had ended.
  - **A bomb pot** counts as one hand of the orbit.
- **Why:** card rooms (the World Series of Poker, the Asian Poker Tour) run Dealer's Choice with a separate pick button and one orbit per pick, so nobody picks a game to suit their own seat. The stud games don't show a button, and after a full orbit the button is back where it started, so "the button picks" would give the same player every pick. PokerNow doesn't offer Dealer's choice. The plan John read is linked from issue #341.
- **Not done, on purpose:** tournaments (decision 7), a single pick that deals HORSE in turn (decision 8), separate stakes for each game (decision 9, D29), and a chat line for each pick.
- **Where:** `game.dealersChoice` in `packages/engine/src/settings/schema.ts`; the Pick chip and pick clock in `apps/server/src/runtime/choice.ts` and `dealHand` in `apps/server/src/runtime/table.ts`; the Pick tag, the felt line and the picker in `apps/web/src/components/table/Choice.tsx`; the menu editor in `apps/web/src/components/settings/DealersChoiceFields.tsx`.

## D34. Releases go out when they're ready, not at a quiet time

- **Decided:** 2026-11-07, 01:15 UTC, by John. A release was being held for a quiet time (after 04:00 UTC), as D05's conditions and D25 said. John: "Did I say to wait? is this a new policy of yours?" and "I've basically worked against that framing." The wait was Claude's own condition (D05), never his; on 2026-10-26 he had said "go ahead and push updates now. Don't worry about active tables".
- **Decision:** a release goes out as soon as it's ready, whether or not tables are open or a tournament is running. A release with any full change still gets its review passes and a play-test on a copy first, and a light-only release still skips the play-test (D25). Changes that are ready at the same time still go out together, so players see one short pause, not several.
- **Why:** a deploy restarts the server, but hands in progress resume and browsers reconnect by themselves, so players see a pause of a few seconds. John prefers that to finished work waiting.
- **Replaces** the quiet-time condition in D05 and the "release at a quiet time" in D25's full path. Nothing else in them changes.
- **Where:** [DEPLOY.md](DEPLOY.md#releasing), [CONTRIBUTING.md](../CONTRIBUTING.md#full-or-light-how-much-checking-a-change-needs), [CLAUDE.md](../CLAUDE.md), [CODE_TOUR.md](CODE_TOUR.md).

## D35. The site is called RSDP Live!

- **Decided:** 2026-11-07, 01:29 UTC, by John: "How hard would it be to change the name of the website and all mentions from RSDP Poker Live! To RSDP Live! The poker is redundant because RSDP is an acronym where the P stands for poker." A minute later: "I do really like the design and the style so I'd like to keep that". The name had been RSDP Poker Live! since he chose it on 2026-10-25.
- **Decision:** the site is called **RSDP Live!** everywhere it shows a name: page titles and link previews, the logo, the crest on the felt (its top arc now reads RSDP, above LIVE), the app name on a phone's home screen, the offline page, the public pages, downloaded hand histories and the docs. Only the words changed: the logo, the crest and the preview picture keep their fonts, sizes, colours and layout.
- **Not changed, on purpose:** the web address (`rsdp-poker-live.fly.dev`), the GitHub repository, the Fly app and the ids inside the code and data, which all say `rsdp-poker-live` or `rsdp`. Changing those would break saved links and touch Google sign-in, the signed build record and the backups. John dropped that at 01:36 UTC: "Yeah the Github and web address aren't a priority. We can just drop them as a concept for the time being. I'll bring it up again if I change my mind". So don't propose it again unless he raises it. Release notes already published keep the name they had. A phone that already has the site on its home screen may keep the old label until the site is added again.
- **Where:** issue [#391](https://github.com/jcolter11374/rsdp-poker-live/issues/391). `apps/server/test/site-name.test.ts` fails if the old name comes back. `scripts/upgrade/compare.mjs` lets a page title under the old name match the same title under the new one, so the release that renames the site passes the upgrade rehearsal.

## D36. A worked-out stud bring-in is a round amount

- **Decided:** 2026-11-07, by Claude, fixing the odd tournament bring-ins found in the play-test of release 2026.11.07 (issue #398). Reversible.
- **Decision:** when the site works out a stud bring-in itself (every tournament level that doesn't set its own, and a cash table whose bring-in is left at 0), it is a third of the small bet rounded down to a round amount: 1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a power of ten, the steps the tournament blinds use, and never less than 1. With Limit bets of 2,000/4,000 the bring-in is 600 (not 666), at 4,000/8,000 it is 1,000 (not 1,333), and at 1,000/2,000 it is 300. On the usual tournament levels that is between a quarter and a third of the small bet. A bring-in someone set themselves (a structure's own, or the Stakes tab's) is kept as it is, and the bring-in a new cash table fills in for the host (a third of the small bet, to the nearest nickel) doesn't change.
- **Why:** card rooms bring in for about a quarter to a third of the small bet, in chips that are in play; 666 is an amount no dealer would ask for. Rounding down keeps it at most a third, the size the Stakes tab has always described. A fixed quarter would also give round amounts at the usual levels, but at Limit bets of 1,000/2,000 it would be 250 rather than 300, smaller than the third players already know from the cash tables.
- **Where:** `bringInFor` in `packages/engine/src/variants/antes.ts`, used by `levelFor` in `packages/tournament/src/director.ts` and `fillStakes` in `apps/server/src/runtime/table.ts`.

## D37. The cash game recap

- **Decided:** 2026-11-07, while building issue #329. The details are Claude's; the roadmap had promised "a short recap ready to paste into the WhatsApp group" without saying what goes in it.
- **Decision:** the ledger's Copy recap button gives a few plain lines about the whole table, as the ledger and Settle up do: the date of the night played, the games, how many hands and for how long, everyone's result from biggest winner down, and the biggest pot.
  - The results are the ledger's `net`, the same figures Settle up pays from.
  - No house-fee line, because a host can hide the fee total from players.
  - Practice bots get one line of their own and stay out of the list.
  - No links (a table's link is its invite) and no cards.
  - A spectator on a delay sees the button only once the delay has passed after their browser first saw people playing each other, so it never runs ahead of the delayed table. A spectator the host has blocked from hands gets a recap with no games, hands or biggest pot, and is told why.
  - The hands come from the same filtered requests the Hands and Stats tabs use, and only when the recap is opened. Nothing new is sent by the server or stored.
- **Why:** the recap is for a group chat, so it says only what anyone at the table could already see, with nothing that lets someone outside the group join or learn cards.
- **Where:** `apps/web/src/recap.ts`, `apps/web/src/components/table/Recap.tsx`, issue #329.

## D38. Hand entries go into the public record after the spectator delay

- **Decided:** 2026-11-07, by John, in issue #435 (his comment of 18:20 UTC). The issue listed six ways a spectator on a delay could tell early that the live hand had ended or the next one had been dealt. One was the public record: it took each hand's entry the moment the hand ended, and anyone can read it (the entries, the newest entry, and the lookup "Check this hand" uses), so someone watching 2 minutes behind could see a hand end there first. John chose to fix all six, and asked for /transparency to say so in the same change. The details below are Claude's.
- **Decision:** at a table whose spectators watch on a delay, each hand's entry goes in no sooner than they see the hand end: the delay after it ends, at most 10 minutes. A card shown after the hand makes a second entry, which goes in that long after it is shown. A table's hands go in in the order they ended. After the host shortens the delay, spectators reach the next hand on the old delay (D39), so it goes in on the old delay too.
  - **Until it goes in,** the entry is outside the chain. It has no number and no hash, and none of what the record shows (the entries, the newest entry, a hand's lookup and whether the table has hands after it) includes it. It gets its number, time and hash when it goes in, so the chain never has a gap.
  - **Everything else goes in at once,** as before: buy-ins and cash-outs, admin actions, deleted tables and server starts. So do hands at a table without a delay. Practice tables follow the same rule, and so does a table whose host has turned watching off, because the host can turn it back on at any time.
  - **Not covered:** buy-ins and cash-outs that change as a hand ends (a player who leaves after the hand, a stack change the host set for after it, a Nit game shortfall) still go in at once, so they can show that a hand is over before spectators on a delay see it end. Whether to hold those back too is John's call (#471); /transparency and /fairness say so.
  - **Across a restart or crash:** the waiting entry (the fingerprint only) is saved as a row in the `jobs` table, kind `audit-hand`. Cash tables aren't loaded again at start, so it waits with the record, not with its table. Putting it in adds its record entry and removes the row in one database transaction, so after a crash it is either in the record or still waiting, never both or neither. The next server's start comes first in the record, then any hands that came due while it was down.
  - **A deleted table** puts its waiting hands in at once, just before the entry that says it was deleted. A table put away when idle, or moved on in a tournament, keeps them waiting.
- **Why:** a hand's entry that went in as the hand ended would undo the delay for anyone who reads the record. Leaving finished hands out of what the record shows instead would leave gaps in the chain, which GitHub's copy and every browser check, so the entry is held back whole.
- **Where:** `AuditLog.hand`, `start`, `stop` and `deleted` in `apps/server/src/audit.ts`; `spectatorsSeeAt` and `attach` in `apps/server/src/app.ts`; tests in `apps/server/test/audit.test.ts` and `cash-crash-restart.test.ts`. /transparency (`apps/web/src/fairness/TransparencyPage.tsx`), [/fairness](FAIRNESS.md#checking-john) and [/privacy](PRIVACY.md#the-public-record) say so. Issue #435.

## D39. What spectators on a delay are shown

- **Decided:** 2026-11-07, by John, in issue #435 (his comment of 18:20 UTC): fix every way a spectator on a delay could tell early that the live hand had ended or the next one had been dealt. The details below are Claude's.
- **Decision:** a spectator at a table with a delay is shown one moment of the table, taken that long ago, and everything they see or ask is worked out from that moment: the hand, the seats (how many, who sits where and their stacks), the settings and blind level, the waitlist and its offers, the table log, and whether downloads are closed. So are the server's answers to them: asking for a seat, a gesture, sharing a hand, the hand list and hand search (a card shown after a hand only once their view has it), the fair-dealing reveal time, a bot owner's changes to a bot their view still seats, and a link's preview. Their browser is sent an update only when what they are shown changes, or when they open the table.
  - **A change to the delay** applies at the live deal, as other settings do. Spectators stay on the old delay until their view reaches the first hand dealt under the new one. A longer delay makes the break before that hand longer by the difference. A shorter one starts at that hand, so the end of the hand before is never hidden, skipped or shown early. Turned off, the old delay runs out the same way before spectators see the table live. In the code, moment *k* is shown at `max(at_k + max(delay_k, delay_k-1), shown_k-1)`.
  - **Turning off "spectators see every card"** works at once: what is still to come plays on without the cards, so the view neither jumps nor stops.
  - **A spectator's own place on the waitlist** follows what they do at once. A seat offered to them shows once their view has the seat free, and lasts the delay longer, so they get the whole minute. One the live table lets go while they still wait (a smaller table or game, someone moved into the seat) shows as it was until their view gets there.
  - **What stays live:** chat, gestures between people their view has seated (or thrown from the rail), who has the table open (though someone their view still seats shows in the seat, not on the rail), the table's name and look, whether watching is allowed, and the warning that spectators see every card. That warning can only be turned on between hands, so it tells someone on a delay that the live table is between hands. Holding it back would let people sit down without seeing it, so it stays.
  - **Not covered yet:** after a server restart the view starts again from the table as it is then (#470); the leaderboard (#469); buy-in and cash-out entries in the public record (#471); and sitting down to see the live table (#472).
- **Why:** anything that came from the live table, or changed when it did, would tell someone watching on a delay what happened before they see it.
- **Where:** `SpectatorFeed` in `apps/server/src/runtime/feed.ts`; `behind`, `stateThen` and `shownKey` in `apps/server/src/runtime/view.ts`; `remember`, `sendView`, `shownTo` and `attach` in `apps/server/src/app.ts`; `shownTo` and `shownSeat` in `apps/server/src/runtime/table.ts`. Tests in `apps/server/test/spectator-delay-gaps.test.ts`, `spectator-delay-socket.test.ts` and `spectator-delay-answers.test.ts`. [/fairness](FAIRNESS.md) says so under "Watching on a delay". Issues #435 and #452.
