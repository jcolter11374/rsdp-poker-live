# RSDP Poker Live!

Browser-based, no-signup Texas Hold'em for friends. A host creates a table, shares the link, approves who sits down, and everyone plays in real time.

## Quick start

```bash
npm install
npm run dev        # server on :3001, web client on http://localhost:5173
npm test           # poker engine tests
npm run typecheck
```

Production: `npm run build && npm start` serves the built client and the game server together on `PORT` (default 3001).

## How it's built

```
packages/engine   Pure TypeScript poker engine, no I/O. Rules, hand ranking, side pots,
                  per-player views (hides other players' cards), and the socket protocol types.
apps/server       Node + Express + Socket.IO. Holds tables in memory, runs the host workflow,
                  turn clock, ledger and chat, and sends each viewer their own view.
apps/web          React + Vite client. Lobby, table, action bar, host panel, log/chat/ledger.
```

The server is authoritative: clients send intents (`player:action`, `seat:request`, …) and get back a fresh `RoomView` after every change. Players are identified by a random secret kept in `localStorage`; the server hashes it into a public player id, so the secret never reaches other players.

## MVP features

- Create a table with blinds and an optional turn clock; share the link
- Players request a seat with a name and stack; the host approves or rejects
- No-Limit Hold'em with correct blinds (including heads-up), minimum raises, incomplete all-in raises, uncalled-bet returns, side pots and split pots
- Host controls: start, pause/resume, change blinds and clock, edit stacks between hands, kick
- Sit out, stand up (mid-hand folds and frees the seat when the hand ends)
- Hand log, text chat, session ledger (buy-ins, stacks, net)

## Next up

Persistence (tables survive a restart), reconnect/away handling, Pot-Limit Omaha, straddles, run it twice, bomb pots, rabbit hunting, hand history export and replay, sounds and animations.

Play money only. This is an original app; it doesn't use any other site's branding, assets or code.
