# RSDP Poker Live! architecture

This is the contract every workstream builds on. Change it only with a note to the other workstreams (see "Changing contracts").

## Layers

```
packages/engine        Pure TypeScript, no I/O. Plays one hand at a time.
  src/core/            Hand state machine, betting structures, forced-bet planner,
                       pots and settlement, events, visibility.      (Workstream 0)
  src/variants/        Game specs, evaluators, awardPortion, stud and draw helpers. (W3)
  src/modifiers/       Bomb pot, double board, 7-2 bounty, nit game, rake.        (W2)
packages/tournament    Pure tournament director: state + command + now -> state + events. (W1)
apps/server            Node + Socket.IO + Postgres. Table runtime, persistence,
                       identity, scheduler, tournament adapter.      (Workstream 0, W1 adapter)
apps/web               React client. Event-driven store, table, panels.  (Workstream 0 shell, W4 polish)
```

## Hard rules

- Chips are integers in the table's smallest unit. Cents mode is formatting only.
- Engine and tournament state is plain JSON. It is snapshotted to Postgres and must survive a restart.
- Cards are 2-character strings: rank `23456789TJQKA`, suit `cdhs` (e.g. `As`, `Td`).
- The server is authoritative. Clients send intents and get back views filtered per viewer.
- Hidden information never leaves the server unfiltered: every hole card goes through `visibleEvents`/views.
- Randomness: the runtime shuffles with a CSPRNG and passes the full deck order into the hand. Tests inject a seeded RNG.
- No PokerNow code, art, sounds or wording. Behaviour reference only.

## The hand engine (packages/engine/src/core)

Contracts: [`core/types.ts`](../packages/engine/src/core/types.ts) and [`core/api.ts`](../packages/engine/src/core/api.ts).

- The runtime builds a `HandInput` per hand: game spec, betting structure, stakes, seats dealt in, button (or dead button), planned forced bets, deck order and options (boards, bomb pot, run it twice).
- `startHand` returns a `HandState`. The runtime then calls `act`, `draw`, `voteRunItTwice`, `show`, `timeout` and `foldOutOfTurn`, and reads new `HandEvent`s from `state.events`.
- Settlement runs pot, then run (run it twice), then board (double board), then `awardPortion` from the variants package (high, low, hi-lo halves). Odd chips go to the first eligible seat clockwise from the button; in hi-lo the odd chip goes to the high half.
- `Modifier`s plug in before the hand (`beforeHand`), at pot award (`potFee`), after settlement (`afterSettle`), and after a post-hand show (`afterShow`, for claims such as the 7-2 bounty), so paid-feature modules never edit the core.
- `import '@rsdp/engine/modifiers'` registers every modifier's settings section and engine hooks. The server runtime and the web settings dialog both import it, so they parse the same `settings.modifiers` sections. Bomb pots have no engine hook: the runtime decides them between hands (`bombPotDue`), because their posts replace the blinds. A bomb pot takes no blinds: owed blinds stay owed, and the blind positions still move on one seat.
- Showdown: `HandOptions.showdown` is 'muck-losers' (last aggressor shows first, a hand shows only if it wins chips or beats or ties what is already shown) or 'show-all' (the table setting `play.revealAllAtShowdown`). Absent means show-all, so older stored hands replay unchanged.
- Betting structures: no-limit, pot-limit and fixed-limit share one `LegalActions` shape. Fixed-limit uses `smallBet`/`bigBet` per street and a raise cap.

## Table runtime (apps/server)

- One runtime per table. It owns the seat state machine (requested, approved, active, away, busted, leaving), the between-hands pipeline, timers, and permissions.
- Between hands, in this order: apply queued changes (settings, stack edits, rebuys, removals, approvals, moves), handle busts, check stop or pause, check the gate (`tableGate` for tournament tables), plan forced bets, shuffle, start the hand.
- Moves carry the turn they were pressed on (`TurnKey` in wire.ts): `hand:act`, `hand:draw` and `hand:timeBank` send `{ handNumber, at }`, where `at` is `view.hand.events.length` (the server's own `hand.events.length`: `visibleEvents` hides cards but never drops an event), and `hand:show` sends the hand number only. `TableRuntime.checkTurn` refuses a seated player's move whose turn has passed, before the move itself is checked, so a tap that arrives after its turn (on a slow connection, usually the second of two) is never played on a later street. It skips anyone without a seat: a spectator may watch the table running behind, and the answer must not tell them where the live hand is. Without them (an older page, tests, scripts) a move counts for the turn now.
- Settings are one typed, versioned schema (zod) shared with the web. Edits queue and apply at the next hand. Every change is logged as a diff with who made it.
- Storage: Postgres via Drizzle; PGlite in development and tests. A durable job table backs every timer that must survive a restart (tournament auto-start, recurring events, waitlist offers).
- Identity: a persistent guest id per browser (localStorage `rsdp.guestId`); guests need no account for anything, tournaments included. Optional username and password accounts (`apps/server/src/accounts.ts`, `/api/account/*`, pages `/signin` `/signup` `/reset` `/profile`):
  - Signing up turns the browser's guest player into the account's primary player, so nothing moves.
  - Signing in elsewhere sends a session token (localStorage `rsdp.session`, socket auth `session`, header `X-Session-Token`); that browser plays as the primary player. When the player ticks "this is my device" (on by default; untick on a friend's phone), its guest id is linked to the account (its tables and tournaments show in the profile history) and its notes and picture are copied over (`adoptGuest`). Signing in while signed in to another account is refused.
  - Signing out deletes the session and the browser's guest secret, so the browser starts over as a new guest.
  - Passwords are scrypt hashes; sign-in pauses after 10 wrong passwords per address (and per username from that address) in 15 minutes. A password change or reset ends the other sessions, forgets the browser secrets of the account's players (the changing device excepted) and drops their open connections; the web app reloads when the server drops it. No email: the ADMIN_KEY holder makes a one-time reset code on /roadmap/admin (24 hours, stored hashed), which ends every session when used.
  - Sign in with Google (`apps/server/src/google.ts`): OpenID Connect code flow with PKCE, scope `openid profile` (no email kept), tied to the browser that started it. `POST /api/auth/google/begin` (mode signin, link or confirm) returns Google's address and sets an HttpOnly cookie; `/auth/google/callback` needs that cookie, checks the ID token and sends the page to `/auth/done#ticket=…`; `POST /api/auth/google/finish` needs the cookie, the same guest secret and (link, confirm) the same signed-in account before it signs in, makes the account (playing as the browser's guest when it has no account) or links Google. `accounts.google_sub` (unique; never swapped while linked) and `accounts.has_password` (false for Google-made accounts until a password is set). A Google-only account confirms with Google (a fresh Google login, max_age 300; one change, within 5 minutes, on that browser) before setting its first password or deleting itself. Linking and unlinking Google need the password on accounts that have one; an admin password reset unlinks Google. On only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set (deploy.yml copies the repository secrets to Fly; the redirect address is PUBLIC_URL from fly.toml + `/auth/google/callback`); otherwise `/api/auth/config` says off and the buttons are hidden.
  - Saved setups (cash table presets and tournament structures, table `saved_setups`, socket `setups:*`) live on the account for signed-in players and in localStorage for guests (`rsdp.presets`, `rsdp.tournamentStructures`). When a browser is signed in, the web client sends its local ones with `setups:import` (a taken name gets " (2)") and clears them. Up to 100 of each kind.
  - Deleting an account wipes the name, picture, notes, saved setups, secrets and sessions of every player it owned; hands stay in history under the names used then.

## Players at the table (pictures, moods, gestures)

- A player's picture is per player, not per seat: `avatar:set` stores a library id (`AVATARS` in wire.ts) or a small uploaded data: URL in `player_avatars`. Seats show it as `SeatView.avatar`: `lib:<id>`, or `up:<version>` for an upload served at `GET /api/avatars/:playerId` (cacheable; a new upload is a new version). The server keeps a playerId → token map in memory and loads missing ones when a table is shown.
- `SeatView.mood` is an emoji kept on the seat (`seat:prefs { mood }`). Gestures are not stored: `table:gesture { to, kind }` is checked (host switch `chat.gestures`, target seated, a few per 10 s per tab) and relayed to everyone with the table open.
- Per-viewer choices (chips or big blinds on the felt, table sounds, chat beep, gesture visibility, hiding pictures and moods, keeping the screen on) live in `rsdp.prefs` with the look prefs.
- Practice bots (cash tables): `addBot`/`removeBot` on the runtime (`bot:add`, `bot:remove` sockets). A bot is a seat whose player id is in `state.bots` (owner, buy-in, look). Each bot takes the first of `BOT_LOOKS` (`@rsdp/engine/wire`: a short name, a colour and a robot face) that no other bot at the table has and whose name nobody there uses (seats, requests, waitlist, or anyone in the ledger), so bots are easy to tell apart. A person who sits down under a bot's name (a bot here, waiting, or gone but still in the ledger) keeps it, and the bot takes another (`giveWayTo`); only sitting down does this, so a seat request that is never approved renames nobody. A bot's ledger row keeps its owner and look, so hand records (`HandRecordView.seats[].bot`) still show its robot in replays after it leaves. Bots saved without a look get one when the table resumes. It counts as always online, can never be host, rebuys for its buy-in when it busts (or leaves when rebuys are off), and acts a moment after its turn starts through the `bot` timer. Its play lives in `apps/server/src/bots/strategy.ts`: Monte Carlo equity against random hands with the variant evaluators, using only what its seat can see, then pot-odds betting; draw games try every discard set. Each bot has a level (`BotInfo.level`, `BOT_LEVELS`: easy, normal, hard; missing means normal), picked with `bot:add`, `practice.level` or changed with `bot:level` (owner or staff with the players power). Easy calls small bets loosely, bets only good hands and small, and never bluffs. Hard thinks half again as long (twice as long about draws), deals an opponent who has bet, raised or called later streets extra random hands and plays the best of them (`handReads`, `readHands`), trusting those signals less for a player who bets most of the time. In 2-7 and Badugi it replays each opponent's draws, keeping what a player who threw that many cards would keep (`replayDraws`; a stand-pat the engine made for an away or timed-out player, `auto` on the draw event, says nothing), picks its own draw against the most dangerous opponents wherever they sit (`drawField`) and sizes up its bets with draws to come against all of them, and weighs only keeping its best few cards, plus the soundest set of that size when the lowest cards clash in Badugi or a straight or flush would spoil a 2-7 draw (`keepOptions`, `soundestKeep`): weighing every way to draw on a few deals each measured worse, since a lucky-looking bad draw wins more often. It learns each player's aggression and fold rate from the table's kept hands (`readPlayers` over `state.history`), bets thinner against callers, bluffs players who fold often, and calls wider in position. Bot ledger rows are flagged `bot`: the ledger shows them tagged, and settle-up pays only between people and says what the bots won or lost. A cash table with bots deals only while at least one person is dealt in. The host can stop players adding bots with `seating.allowPlayerBots`. `table:create` with `practice: { name, bots }` seats the creator and adds the bots; the first deal waits until the creator joins the table. Tournaments refuse bots (`addBot` throws).
- Coach tips and bot reasons (practice only): at the deal, `dealHand` sets `state.coach` (`{ handNumber, person, notes }`) when `soloPersonOf(hand)` finds exactly one person dealt in and every other dealt-in id in `state.bots` (membership, never the `bot-` prefix), on a cash table that has never dealt a hand between two people (`state.realGame`, set at the deal by `state.bots` membership too); otherwise it is null, and it fails closed (a forgotten bot counts as a person, a snapshot restored mid-hand without it gets nothing). `hand:tip { handNumber, at }` (`TableRuntime.coachTip`) checks all of that again, then the seat, the turn and the exact decision, and works the tip out in `apps/server/src/bots/coach.ts` from `seenBy(hand, seat)`: a `Seen` copy holding only what that seat can see (no deck, other hole cards, muck or seeds), the only type the coach accepts. It runs Normal's own `decide()` (exported as `normalDecide`) with dice that never bluff (`tipDice`) on its own random stream from the turn key, so the table's `rng`, the deal and the bots are untouched. It runs on the event loop, so it is time-boxed (equity by about 120 ms, the ways to draw by `coachTuning.drawMs`) and `tipLimits` in app.ts allows 10 worked-out tips per 20 s per player and 300 ms of tip work a second across the server (a cached repeat counts for neither). The tip goes back on the ack alone, is cached in memory for that turn, and is never broadcast, logged or saved; `TableView.tips` only shows or hides the button. Bots move through `explainMove`, which returns the move with its `MoveWhy`; while `state.coach` is set, `botMove` turns that into a `BotNote` after the move is in, outside its try (a fault there loses the note, never the move) (`apps/server/src/bots/reasons.ts`: numbers and closed word lists, no cards, no discard positions, nothing about another person) on `state.coach.notes`, never in `hand.events`, so `visibleEvents`, `verifyHand` and the audit digest don't change. `finishHand` copies them to `HandRecord.coach` (in memory and the table snapshot, the last 30 hands; never the `hands` table), and `handRecordView(..., { notes: true })` serves them as `botNotes` to that one person only, from `table:history` and `table:export`; share links, `table:fullLog` and hand search never ask for them.

## Tournament integration (packages/tournament <-> apps/server)

- The director is pure: `apply(state, command, now)` and `tick(state, now)` return `{ state, events }`. `nextWakeAt(state)` tells the scheduler when to call `tick`.
- The server translates socket calls into commands, runs the hands, and reports each hand's `startStacks`, `endStacks` and knockouts per table.
- Before dealing on a tournament table, the runtime asks `tableGate(state, tableId, now)` and reads `levelFor(state, tableId)` for game and blinds.
- Director events such as `moveSeat` and `tableBroken` are applied between hands.
- Host and co-hosts: `@rsdp/engine/roles` is the one co-host model for cash tables and tournaments. A host names co-hosts and gives each some powers (`approve`, `chips`, `run`, `players`, `settings`); managing co-hosts, handing over the host role and archiving stay with the host. Tournaments keep them in `state.coHosts`; the server checks every staff command with `mayCommand(state, playerId, command)` from `@rsdp/tournament` before the director sees it.
- Host tools in the director: `approve` takes an optional `stack` (a handicap), `setStack` (waits for the player's hand to end; not a rebuy), `movePlayer` (between hands; a taken seat swaps the two players), `archive` (`state.archivedAt`; before the start it also cancels). Lists should skip archived events. The server's hourly cleanup archives manual and Sit & Go events left untouched for 30 days and drops finished events from memory an hour after they end; results are never deleted.
- After a crash, a table saved behind its director is brought in line (`alignTables` in the manager): a hand the director already closed is dropped rather than played again, and a hand the director heard start but the table never saved is closed with no chips moving. The director also ignores a result for a hand it has already closed.

## Branches and ownership

- `main`: releases only, merged with John's approval. `develop`: integration; every workstream PR targets it and needs green CI.
- Ownership: W1 `packages/tournament`, `apps/server/src/tournament/*` and the tournament pages. W2 `packages/engine/src/modifiers/*` and the cash-table settings sections. W3 `packages/engine/src/variants/*`. W4 shared table components, styles and the records pages. Workstream 0 owns `core/`, the runtime, storage and identity.

## Changing contracts

Changes to `core/types.ts`, `core/api.ts`, the settings schema layout, the event list, or the runtime/tournament integration need a short note to the other workstream threads before merging, and a version bump of the snapshot format if stored state changes shape.

## Fair dealing

Decks come from `deckFromSeed(handSeed)` (`@rsdp/engine`, `fairness.ts`), never
from `shuffle(freshDeck(), …)`. The runtime commits to each hand's server seed a
hand ahead (`view.fair.nextCommit`), seated browsers add seeds with `fair:seed`,
and `HandInput.fair` carries the record into history. `fair.serverSeed` and
`fair.handSeed` give away the whole deck: only `handRecordView` may show them,
and only once `fairRevealed()` says so. Every card-dealing event carries `pos`.
See docs/FAIRNESS.md.
