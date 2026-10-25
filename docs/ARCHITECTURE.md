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
- Betting structures: no-limit, pot-limit and fixed-limit share one `LegalActions` shape. Fixed-limit uses `smallBet`/`bigBet` per street and a raise cap.

## Table runtime (apps/server)

- One runtime per table. It owns the seat state machine (requested, approved, active, away, busted, leaving), the between-hands pipeline, timers, and permissions.
- Between hands, in this order: apply queued changes (settings, stack edits, rebuys, removals, approvals, moves), handle busts, check stop or pause, check the gate (`tableGate` for tournament tables), plan forced bets, shuffle, start the hand.
- Settings are one typed, versioned schema (zod) shared with the web. Edits queue and apply at the next hand. Every change is logged as a diff with who made it.
- Storage: Postgres via Drizzle; PGlite in development and tests. A durable job table backs every timer that must survive a restart (tournament auto-start, recurring events, waitlist offers).
- Identity: a persistent guest id per browser; optional username and password accounts link guest ids. Tournament registration needs an account.

## Tournament integration (packages/tournament <-> apps/server)

- The director is pure: `apply(state, command, now)` and `tick(state, now)` return `{ state, events }`. `nextWakeAt(state)` tells the scheduler when to call `tick`.
- The server translates socket calls into commands, runs the hands, and reports each hand's `startStacks`, `endStacks` and knockouts per table.
- Before dealing on a tournament table, the runtime asks `tableGate(state, tableId, now)` and reads `levelFor(state, tableId)` for game and blinds.
- Director events such as `moveSeat` and `tableBroken` are applied between hands.

## Branches and ownership

- `main`: releases only, merged with John's approval. `develop`: integration; every workstream PR targets it and needs green CI.
- Ownership: W1 `packages/tournament`, `apps/server/src/tournament/*` and the tournament pages. W2 `packages/engine/src/modifiers/*` and the cash-table settings sections. W3 `packages/engine/src/variants/*`. W4 shared table components, styles and the records pages. Workstream 0 owns `core/`, the runtime, storage and identity.

## Changing contracts

Changes to `core/types.ts`, `core/api.ts`, the settings schema layout, the event list, or the runtime/tournament integration need a short note to the other workstream threads before merging, and a version bump of the snapshot format if stored state changes shape.
