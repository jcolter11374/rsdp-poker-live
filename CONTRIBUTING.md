# How we track and ship work

This is how work on RSDP Live! is tracked, reviewed and released. It
is the ordinary GitHub way: **issues** for every piece of work, **pull
requests** that name their issue, and **tagged releases** with notes. John
owns the product and makes the product calls. Most of the code is written by
Claude (an AI coding assistant) in several parallel sessions, and the same
rules apply to everyone.

The one idea behind it: **the state of the work lives on GitHub, not in
anyone's notes or chat.** If it isn't an open issue, it isn't open work. If
an issue is open, the work isn't done.

## Where to see what's going on

| I want to see… | Link |
| --- | --- |
| Known bugs that aren't fixed | [Open bugs](https://github.com/jcolter11374/rsdp-poker-live/issues?q=is%3Aissue+is%3Aopen+label%3Abug) |
| What someone is working on right now | [In progress](https://github.com/jcolter11374/rsdp-poker-live/issues?q=is%3Aissue+is%3Aopen+label%3A%22status%3A+in+progress%22) |
| Finished, but not on the live site yet | [On develop](https://github.com/jcolter11374/rsdp-poker-live/issues?q=is%3Aissue+is%3Aopen+label%3A%22status%3A+on+develop%22) |
| What needs John | [Waiting on John](https://github.com/jcolter11374/rsdp-poker-live/issues?q=is%3Aissue+is%3Aopen+label%3A%22status%3A+waiting+on+John%22) |
| What needs someone else | [Waiting on others](https://github.com/jcolter11374/rsdp-poker-live/issues?q=is%3Aissue+is%3Aopen+label%3A%22status%3A+waiting+on+others%22) |
| Everything open | [All open issues](https://github.com/jcolter11374/rsdp-poker-live/issues) |
| What each release changed | [Releases](https://github.com/jcolter11374/rsdp-poker-live/releases), [CHANGELOG.md](CHANGELOG.md), or the site's [Changelog](https://rsdp-poker-live.fly.dev/changelog) |

Friends without a GitHub account can send ideas through the site's
[suggestion box](https://rsdp-poker-live.fly.dev/roadmap). When one is taken
up, it gets an issue too.

## The rules

1. **Every piece of work is an issue, opened the moment it comes up.** A bug
   someone found, a feature John agreed to, a follow-up someone promised,
   something waiting on John: each gets an issue straight away, even a
   small one. **The exception is anything private:** a security problem
   or a privacy request is never a public issue. Tell John privately
   instead (see the [security policy](.github/SECURITY.md), or
   [PRIVACY.md](docs/PRIVACY.md#your-rights) for privacy requests).
2. **An issue's labels say where it stands** (see [Labels](#labels)). Change
   them when the state changes, in the same sitting.
3. **Every pull request names its issue.** "Closes #123" when it finishes
   the work, "Part of #123" when it does some of it. A check fails until it
   does. A tiny change that needs no issue gets the `no issue needed` label.
4. **An issue closes only with proof.** Normally the Release workflow closes
   it when the change is live. Anyone closing one by hand links the pull
   request, release or message that settles it.
5. **Every release adds one changelog entry with a version.** The tag, the
   GitHub release and CHANGELOG.md all follow from it (see
   [Releases](#releases)).
6. **Status reports come from these lists, not from memory** (see
   [Reporting status](#reporting-status)).
7. **Work is done only when the whole ask is done** (see
   [Definition of done](#definition-of-done)).
8. **A change updates the docs that describe it, in the same pull request**
   (see [Keeping the docs current](#keeping-the-docs-current)).

## Definition of done

A piece of work is done only when **everything the person asked for is
finished and checked on the live site**. Part of it shipped, with the rest
in a new issue, is not done. Merged but not released yet is "on develop",
not done: say that plainly. Docs and tests have nothing to see on the
site, so check them where they show (on GitHub).

Before a session (or anyone) says "done" to John or stops work on it:

1. **Check the original ask, not just your change.** Read the request
   again and look at each part of it on the live site the way John would see
   it: every game, screen size or setting it covers, not only the ones the
   change touched. Only look, never play: no games, bots, tables or
   sign-ups there (D07, D24). What can't be seen just by looking (a hand
   being played, say) is tested on a local copy, and the message says so.
2. **Every follow-up issue has an owner.** If you opened an issue for part
   of the ask, it must either have someone actively working on it now
   (`status: in progress`, assigned, with a session or pull request behind
   it), or carry `status: waiting on John` or `status: waiting on others`
   with a comment saying what it's waiting for. An issue nobody is working
   on means the work isn't done.
3. **Say plainly what's left.** If something is waiting, the "done"
   message says so and links the issue. "Done" with a hidden leftover is
   the thing this rule is here to stop.

Until all three are true, the work is still in progress. Keep going, or
start the follow-up yourself. Why: [D30](docs/DECISIONS.md#d30-a-definition-of-done).

## Labels

Every issue gets a **type**, and usually an **area**. **Status** labels only
go on while they're true; an open issue with no status label simply hasn't
been started.

| Label | Means |
| --- | --- |
| `bug` | Something on the site is broken or wrong |
| `enhancement` | A new feature or a change to how something works |
| `chore` | Upkeep players won't see: cleanup, tests, tooling, hosting tasks |
| `documentation`, `security`, `dependencies`, `question` | What they say |
| `status: in progress` | Someone is working on it right now (a session, a pull request). Take it off if the work stops. |
| `status: on develop` | Done and merged into `develop`, not on the live site yet. Added and removed by the workflows. |
| `status: waiting on John` | Needs John: a decision, a setting, something only he can do |
| `status: waiting on others` | Waiting on someone outside the project |
| `priority: high` | Breaks games or stops people playing; do it first |
| `area: cash`, `area: tournaments`, `area: table`, `area: dealers choice`, `area: accounts`, `area: fairness`, `area: site`, `area: ops` | Which part of the site it's about (`ops` is hosting, deploys, backups, CI) |
| `no issue needed` | On a pull request only: it skips the linked-issue check |

The labels are defined in [`.github/labels.json`](.github/labels.json). Edit
that file to add a label or change its colour or description; a workflow
applies it. To rename one, rename it on GitHub first (Issues → Labels →
Edit) so its issues keep it, then change the file and any links that name
it: changing only the file makes a new, empty label.

## Full or light: how much checking a change needs

Not every change carries the same risk. A change to how cards are dealt can
spoil a real game; a typo fix can't. So a change takes one of two paths,
and its pull request says which (the
[template](.github/pull_request_template.md) asks). John agreed to the two
paths on 5 November 2026; the details below are Claude's
([D25](docs/DECISIONS.md#d25-full-and-light-changes)).

| | Full | Light |
| --- | --- | --- |
| What it covers | Anything that touches the game or players' data | Changes that can't affect a game, who is allowed to see what, or what's stored |
| The checks on GitHub (CI) | Must pass | Must pass |
| Review | A separate review pass with another AI session | A short review pass with another AI session |
| Play-test on a copy of the site | Yes, before the release | No |
| When it goes live | As soon as its play-test passes | As soon as it's ready |

**Full** if the change touches any of these, however little:

- **The game:** dealing, cards, betting and the buttons that send actions,
  chips and pots, timers and clocks, seating, practice bots, table and game
  settings.
- **Tournaments:** structures, payouts, breaks, rebuys, starting, moving
  players, ending.
- **Who sees what:** hole cards and the deck, and what spectators, replays,
  hand histories, chat and downloads show, to whom and when (including the
  no-HUD lock on downloads, D14).
- **Fairness and the public record:** seeds, hand proofs, the audit log,
  signed builds, the transparency watcher, and what /fairness,
  /transparency, /privacy and /terms promise.
- **Privacy:** anything new kept in the browser (cookies, local storage),
  and anything that makes the site or the browser contact another server.
- **Accounts:** sign-in, sessions, passwords, profiles.
- **Stored data:** the database and its migrations, backups, what's kept
  and for how long.
- **How the site runs:** the server's setup, the `Dockerfile`, `fly.toml`,
  the workflows that deploy, back up or check the live site, and any
  library update (`package.json` or `package-lock.json`) unless the
  library is only used by tests.
- **The safety checks themselves:** removing, skipping or loosening any
  test or CI check, and changes to `ci.yml`, `pr-checks.yml`,
  `upgrade.yml` or `scripts/release/`.

**Light** only if every part of the change is one of these:

- **Wording** that is only displayed: labels, messages, help text and
  how-to-play guides. Text that code compares or reads back (server error
  codes, hand-log lines) is full. On /fairness, /transparency, /privacy and
  /terms (`docs/FAIRNESS.md`, `docs/PRIVACY.md`, `docs/TERMS.md`), wording
  is light only when it says the same thing more clearly, or corrects the
  page to match what the code already does; a promise that changes with
  the code is full.
- **Layout and look:** spacing, sizes, colours, fonts, icons and
  animations served from the site itself, as long as nothing is shown or
  hidden that wasn't before. A change to the table's look still waits until
  John has seen before-and-after pictures (D21).
- **Download buttons** that offer only what the person can already
  download. A new download, or one that works while downloads are locked,
  is full.
- **Docs, code comments, and new or stronger tests** that don't change what
  the site runs.
- **Release notes**, What's new and the roadmap page.

**When unsure, it's full.** A pull request that doesn't say (a Dependabot
one, for example) is full. If the review finds that a light change touches
anything on the full list, it becomes full.

**A light review is shorter, not skipped.** It still runs in a separate AI
session and is posted on the pull request like any review (step 3 of
[The life of a change](#the-life-of-a-change)). It checks that:

1. every part of the change fits the light list;
2. the change does what its issue asks, with nothing else mixed in;
3. the wording is true and plain, and on the public trust pages each
   changed sentence matches the code;
4. every doc that describes what changed is updated in the same pull
   request ([Keeping the docs current](#keeping-the-docs-current));
5. anything people see has been looked at on a phone-sized and a
   desktop-sized screen, with screenshots in the pull request when the look
   changes. If shared styles or the table screen change, that includes a
   table where it's your turn, so the action buttons and clock still show.

**A release takes the path of its riskiest change.** If everything waiting
on `develop` is light, the release can go out as soon as it's ready, with no
play-test. If anything waiting is full, the whole release is full. Either
way it isn't held for a quiet time: it goes out once its checks are done,
with tables open or not (John, [D34](docs/DECISIONS.md#d34-releases-go-out-when-theyre-ready-not-at-a-quiet-time)). A release pull request's head is `develop`, so
anything merged there later joins it: just before merging a light release,
check every pull request merged into `develop` since the last release. If
any is full or doesn't say, the release is full.

A light change that can't wait for a full release (a broken download button,
say) can go straight into `main` as a fix (see the end of the next section).
Decide that before it's merged into `develop`, and make its branch from
`main`, so nothing else waiting goes with it.

## The life of a change

1. **Issue.** Open one with the bug or feature form (or a blank issue).
   Give it a type and an area label.
2. **Start.** Label it `status: in progress` and assign it. Make a branch
   from `develop`.
3. **Pull request into `develop`.** The description says "Closes #123" (the
   [template](.github/pull_request_template.md) has a place for it). The
   checks run: typecheck, every test, a production build, a browser smoke
   test against the real Docker image, a backup restore drill, and the PR
   check for the issue link and release notes. The description also says
   whether the change is
   [full or light](#full-or-light-how-much-checking-a-change-needs), and
   which docs it updated
   ([Keeping the docs current](#keeping-the-docs-current)). We
   also run a separate review pass with another AI session (a short one for
   a light change; see [Reviewing and merging](#reviewing-and-merging)). That pass is ours, not an outside audit. Its findings,
   and the commit it reviewed, go in a comment on the pull request, so the
   review leaves a trace on GitHub. Anything left for later gets its own
   issue, listed under "Left to do", and needs an owner or a "waiting on"
   label before the work counts as done
   ([Definition of done](#definition-of-done)).
4. **Merge into `develop`.** GitHub only closes issues for merges into the
   default branch (`main`), so a workflow labels each issue the pull request
   closes `status: on develop` and comments on it.
5. **Release.** On release day, make sure the waiting changelog entry's
   version is today's (see [Releases](#releases)), then open a pull request
   from `develop` into `main`. If the release holds any full change, we
   play-test it on a copy of the site first, never on the live one
   ([DEPLOY.md](docs/DEPLOY.md#releasing)). A release of only light changes
   skips that. Check that each pull request going out did what its "Docs"
   line says. Either way, merge it as soon as it's ready: don't wait for a
   quiet time (D34). Merging it runs the checks
   again and then deploys. After the deploy, the Release workflow tags the
   commit (`v2026.11.01`), publishes a GitHub release with its notes and
   the issues it closed, and closes those issues with a comment saying when
   they went live.

A fix that has to go straight into `main` follows the same rules: its pull
request says "Closes #123" (GitHub closes the issue when it merges), says
whether it's full or light, and adds its own changelog entry with today's
version. If the release waiting on `develop` already has today's version,
the fix takes the next one (`2026.11.01.2`); the PR check says which.
Merge `main` back into `develop` afterwards so the two don't drift, keeping
the fix's entry exactly as it is on `main`.

Two kinds of full change don't wait for a play-test: a
security fix ([RUNBOOK.md](docs/RUNBOOK.md#someone-reports-a-security-problem))
and the revert of a bad release
([RUNBOOK.md](docs/RUNBOOK.md#a-bad-release)). Each still needs CI and a
review pass.

GitHub also closes an issue by itself when "Closes #123" reaches `main` in a
release pull request's description or in a commit message. That's fine: the
Release workflow still lists it in the release notes and comments when it
went live.

## Reviewing and merging

**What a review pass is.** A second read of a change by a reviewer who
didn't write it, working from the change itself and its issue, not from the
author's account of it. So far the reviewer has been a fresh AI session. A
person can do it just as well: any developer who didn't write the change
may review it, the same way. The session (or person) that wrote a change
doesn't review it.

**Running one with an AI session.** Start a new session, not the one that
wrote the change. Give it the pull request's diff and its issue, tell it to
change nothing, and ask it to check the list below against the code and
report what it finds. Give it the code, not your conclusion: a reviewer
told what to find tends to find it.

**What a full review checks:**

1. The change does what its issue asks, with nothing else mixed in, and
   "full" or "light" is the right label for it.
2. The unusual paths around what changed, not only the usual one: a server
   restart in the middle, a player who is away or on two devices, a
   spectator watching, the last hand of a tournament, the same button
   pressed twice.
3. Hidden information: nothing new reaches a browser that its viewer may
   not see (other players' cards, the deck, a spectator's delay).
4. Stored data: tables, tournaments and hands saved by the version now
   live still load, and a migration follows the rules in
   [ARCHITECTURE.md](docs/ARCHITECTURE.md#database-migrations-appsserverdrizzle).
5. The new tests test what they say, and would fail without the change.
6. Every doc that describes what changed is updated
   ([Keeping the docs current](#keeping-the-docs-current)), and
   /fairness, /transparency, /privacy and /terms still say what the code
   does.

A light review checks the shorter list under
[Full or light](#full-or-light-how-much-checking-a-change-needs).

**What the review comment says.** It goes on the pull request, headed "a
separate review we ran ourselves" (never "independent": it isn't an outside
audit). It names the commit reviewed, what was checked, each finding and
how it was resolved (fixed, with the commit; accepted, with the reason; or
left for its own issue), and anything that couldn't be checked. If the
fixes are more than small, the reviewer looks again at the new commit.

**Who merges.** Today only John's GitHub account can change the
repository, and the AI sessions work through it. No approval click is
required ([D22](docs/DECISIONS.md#d22-how-work-is-tracked-and-checked)):
John gave a standing OK for a change to be merged into `develop` once the
checks are green and its review is posted, and for finished work to be
released without asking him each time
([D05](docs/DECISIONS.md#d05-branches-merges-and-releases),
[DEPLOY.md](docs/DEPLOY.md#releasing)). So whoever opened the pull request
merges it when both are done, as one squashed commit whose title keeps the
issue and pull request numbers. Ask John first about anything that costs
money, changes what the product is, or can't be undone.

**If you're new.** The code is MIT-licensed, so anyone may fork the
repository and open a pull request into `develop` from the fork. It follows
the same rules as any other: an issue, the checks, a review pass by someone
who didn't write it, and then John (or a session working through his
account) merges it. Whether someone else gets to change the repository
directly is John's call; ask him.

## Releases

Release notes are written once, in the site's own data:
[`apps/web/src/roadmap/changelog.json`](apps/web/src/roadmap/changelog.json)
(every release, with its small fixes) and
[`whatsnew.json`](apps/web/src/roadmap/whatsnew.json) (new features only).
From those come the site's Changelog and What's new pages, CHANGELOG.md
(`npm run changelog` writes it; a test fails if it's out of date) and the
notes on each GitHub release.

- **Version.** A release's id is its version: the day it goes live, as
  `2026.11.01`, and `2026.11.01.2`, `2026.11.01.3` for later releases that
  day (calendar versioning). Its git tag is `v` plus the version. Releases
  from before 1 November 2026 keep their old ids (`2026-10-31-d`) and have
  no tags.
- **One entry per release.** If the top entry in changelog.json isn't on
  `main` yet, it is the next release's: add your lines to it. If every
  entry is already on `main`, start a new one at the top with today's
  version. Never change an entry that is already on `main`; it's live. To
  tell which it is, compare the top entry's version with the newest
  [release](https://github.com/jcolter11374/rsdp-poker-live/releases), or
  run `git fetch origin main && git diff origin/main -- apps/web/src/roadmap/changelog.json`:
  an entry that shows up there as added (`+`) lines is still waiting, and
  no output means every entry is on `main`.
- **On release day,** if the waiting entry's version isn't today's, rename
  it to today's version (and its date, and its twin in whatsnew.json if it
  has one), run `npm run changelog`, and merge that into `develop` before
  opening the release. The release's version must also be newer than every
  release already live. The PR check enforces all of this and says what to
  rename it to.
- **Merge it the same day.** The check runs when the release pull request is
  opened or changed, not when it merges. If a release waits past the day
  its version names, rename it again before merging. (The Release workflow
  warns if a version and its deploy day are more than a day apart.)
- **Plain English.** The notes are for the players. Say what changed for
  them; no pull request numbers or code names.
- **What goes where.** What's new is for new features and changes people
  will notice; small fixes only go in the changelog (John's rule).
- **The roadmap page.** If the release ships or changes something on the
  public roadmap, update
  [`apps/web/src/roadmap/roadmap.json`](apps/web/src/roadmap/roadmap.json)
  and its `lastUpdated` in the same release.

If a Release run fails, fix the cause and run it again by hand from the
Actions tab (Release → Run workflow). It picks up whatever is missing and
never moves a tag.

## Keeping the docs current

The docs are only useful to the next person if they match the code. So a
pull request that changes how something works also changes every doc that
describes it, and says which under "Docs" in its description. The review
pass checks that list against the change. "None" is a fine answer when it's
true.

Each doc has one job. Put a fact in the doc whose job it is and link to it
from the others, so there is one place to update:

| If the change… | Update |
| --- | --- |
| Adds, moves or renames a folder, a main file, a workflow or a command | [docs/CODE_TOUR.md](docs/CODE_TOUR.md), and the README if it names it |
| Changes a rule the code follows, or how two parts talk to each other | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); for the tournament director, [packages/tournament/README.md](packages/tournament/README.md) too |
| Settles a question (John decides something, or a deliberate simplification is chosen) | A new entry in [docs/DECISIONS.md](docs/DECISIONS.md) |
| Changes dealing, who sees what and when, or the public record | [docs/FAIRNESS.md](docs/FAIRNESS.md) |
| Changes signed builds, the watcher, or what the Checking John page (`/transparency`) reports | [docs/FAIRNESS.md](docs/FAIRNESS.md), and the page's own words in `apps/web/src/fairness/TransparencyPage.tsx` |
| Stores something new, changes how long something is kept or how it's deleted, sets a cookie, or contacts another service | [docs/PRIVACY.md](docs/PRIVACY.md) |
| Changes what the site promises players or asks of them | [docs/TERMS.md](docs/TERMS.md) |
| Changes hosting, a setting or secret, backups, restarts, or the release steps | [docs/DEPLOY.md](docs/DEPLOY.md) |
| Changes what an alarm means, or how to recover from a failure | [docs/RUNBOOK.md](docs/RUNBOOK.md) |
| Changes the look or controls of the table or one of the site's main pages | [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md) |
| Adds or changes a play-test script | [e2e/playtest/README.md](e2e/playtest/README.md) |
| Changes how a game or a table option plays | Its How to play guide (`apps/web/src/rules/`) |
| Changes anything players will notice | The release notes, and the roadmap page if it lists it, by the release that ships it (see [Releases](#releases)) |
| Adds a library | [docs/CREDITS.md](docs/CREDITS.md) |
| Changes how work is tracked, reviewed or released | This page, and [CLAUDE.md](CLAUDE.md) if it's a rule sessions must follow |

Each release, whoever prepares it reads the list of pull requests going out
and checks that each one's "Docs" line was done. A doc found out of date
later is a bug in the docs: open an issue with the `documentation` label.

## Reporting status

Whoever reports to John (a person or a Claude session) reports straight from
the issue lists, every time, in this order:

1. **Known open bugs**, with links, or "no open bugs" with the
   [link](https://github.com/jcolter11374/rsdp-poker-live/issues?q=is%3Aissue+is%3Aopen+label%3Abug).
2. In progress.
3. Done but not live yet (`status: on develop`).
4. Waiting on John.
5. Waiting on others.

Link every issue so John can check it himself. "Done" means its issue is
closed with proof and the [definition of done](#definition-of-done) is
met. Before asking John for anything, search the issues
(open and closed) to see whether he has already given it.

## What we don't use, and why

- **Milestones.** They suit planned versions. We release small changes
  continuously, and each release is a tag with its own notes.
- **A project board.** GitHub Projects can show these issues as columns, but
  only the account owner can create one. The links above give the same
  view without it.

## Code, tests and running it

See [docs/CODE_TOUR.md](docs/CODE_TOUR.md) for how the code fits together,
how to run it, and how a commit reaches the live site. Before opening a pull
request, run `npm run typecheck` and `npm test`.
