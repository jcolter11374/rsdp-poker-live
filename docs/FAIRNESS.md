# Fair dealing in RSDP Poker Live!

This page explains how the cards are shuffled, how anyone can check a hand
after the fact, and what an audit of the code found. Plain-language summary
first, details after.

## The short version

- **The shuffle is a real, unbiased random shuffle.** Every hand gets a brand
  new 256-bit secret from the server's cryptographic random number generator
  (the same kind used for passwords and encryption). The deck is shuffled
  from it with the standard Fisher-Yates method, using SHA-256 to turn the
  secret into numbers, with no rounding bias.
- **The deck is locked before the deal.** Before a hand is dealt, the table
  publishes a *commitment*: a SHA-256 fingerprint of that hand's secret. Once
  published, the secret can't be swapped without the fingerprint changing.
- **Nobody, not even whoever runs the server, can pick the cards.** While the
  previous hand is being played, every seated player's browser quietly sends
  its own random seed for the next hand. The deck depends on the server's
  secret *and* every player's seed. The server committed first, so it can't
  steer the result; players never see the server's secret until later, so they
  can't predict it either.
- **Anyone can check a hand afterwards.** Open a hand in the replayer and press
  **🔒 Check this hand**. Once the hand is revealed, your browser rebuilds the
  whole deck from the seeds and checks every card you saw against it, and that
  no card was skipped or used twice. **Download proof** saves a file that
  `node scripts/verify-hand.mjs` checks on its own, using only Node's built-in
  OpenSSL SHA-256 and none of the app's code.
- **When hands are revealed** (John's decision, 2026-10-25): when the host stops
  the game, or 12 hours after the hand, whichever comes first. The reveal shows
  the whole deck, including folded and mucked hands, so it waits until the
  game is over.
- **Your cards stay private during play.** The server sends each person only
  what they may see. Undealt cards, other players' hole cards and the secrets
  never leave the server during a hand.

## How a hand is dealt (rsdp-fair-v1)

1. The table keeps a secret `serverSeed` for the next hand: 32 bytes from the
   server's CSPRNG (`crypto.getRandomValues`), as 64 hex characters.
2. It publishes `commit = SHA-256(serverSeed)` (of the hex text) in every table
   view as `fair.nextCommit`.
3. Each seated player's browser answers with `fair:seed {commit, seed}`, a
   fresh 16-byte random hex seed. The server only accepts it against the
   commitment currently published, so a seed is always chosen *after* the
   server's secret was fixed.
4. When the hand starts, the server takes the seeds of the players dealt in and
   computes
   `handSeed = SHA-256("rsdp-fair-v1|" + serverSeed + "|" + handId + "|" + sortedClientSeeds.join(","))`.
   It commits a new secret for the following hand straight away.
5. The deck is a Fisher-Yates shuffle of `2c 2d 2h 2s 3c … As` (ranks
   `23456789TJQKA`, suits `cdhs`), going from the last card to the first, with
   `j = rng(i + 1)`. `rng(n)` reads SHA-256(`handSeed|deck|0`),
   SHA-256(`handSeed|deck|1`), … as big-endian 32-bit words and rejects any
   word at or above `floor(2^32 / n) * n`, so every outcome is exactly equally
   likely.
6. Cards are dealt from the top of the deck in order, with no burn cards:
   hole cards one at a time around the table starting left of the button, then
   the board. Run it twice, double board, bomb pots, stud's shared seventh-street
   card and rabbit hunting all use the next cards of the same deck. Each deal,
   board and draw event records `pos`, the deck place of each card.
7. Draw games: when the stub runs out, the muck is reshuffled with the same
   method, using the label `reshuffle:<deck place>`. Cards dealt after a
   reshuffle carry no `pos` and the checker reports them as not checked.

The code: [`packages/engine/src/fairness.ts`](../packages/engine/src/fairness.ts)
(the scheme, a dependency-free SHA-256, and `verifyHand`), the runtime's
"provably fair dealing" section in
[`apps/server/src/runtime/table.ts`](../apps/server/src/runtime/table.ts), and
[`scripts/verify-hand.mjs`](../scripts/verify-hand.mjs). The tests check our
SHA-256 against OpenSSL on every input length from 0 to 300 bytes, pin the
deck for a known seed (so old hands stay checkable), and verify 3,000 random
hands in every game against their seeds.

### Checking a hand by hand

```sh
printf %s <serverSeed> | sha256sum        # must equal the commitment
node scripts/verify-hand.mjs hand-12-proof.json
```

## What this proves, and what it doesn't

It proves the deck for each hand was fixed before anyone acted, came from a
fair shuffle of seeds no single person controlled, and that every card you saw
came from its place in that deck. It rules out a rigged shuffle, a card
swapped mid-hand, and "dealing seconds" (skipping a card to give someone a
better one).

It cannot stop someone who runs the server from *reading* the deck of a live
hand out of the server's memory or database. That is true of every online
poker site; the defence is that only the operator can do it, and the code does
not expose it. It also does nothing about players sharing their cards with
each other off the table.

## Audit findings (2026-10-25)

| Area | Finding | Status |
|---|---|---|
| Main shuffle | Fisher-Yates over `crypto.getRandomValues` with rejection sampling: sound. | Replaced by the seeded scheme above, which is equally strong and checkable. |
| Draw-game reshuffle | Used a non-cryptographic xorshift generator from a 31-bit seed, with a tiny modulo bias. Only about 2 billion possible reshuffles. | **Fixed**: now SHA-256 from the hand's 256-bit seed, unbiased. Hands in progress during the upgrade finish the old way. |
| Run it twice, double board, bomb pots, rabbit hunt, stud | All deal the next cards of the one pre-shuffled deck. Rabbit cards are the real next cards, shown only after the hand to whoever asks. | OK |
| Button draw, seat shuffle, bomb-pot timing | Use the CSPRNG. | OK |
| Tournament seat draw | A fast non-cryptographic generator (mulberry32) from a secret 32-bit CSPRNG seed that stays on the server. Seats only, never cards. | Acceptable; could move to the seeded scheme later. |
| All-in equity | Computed in the browser from cards already visible; its seeded sampling only affects the displayed percentages. | OK |
| `Math.random` | Only in the sound effects. | OK |
| What clients receive | Hole cards are filtered per viewer on the server (`visibleEvents`, the table view); undealt cards, the deck, and the seeds never go out during play. Hand history drops the deck. Tests check that no secret appears in any player's or spectator's view. | OK |
| After a restart | The deck, the next hand's secret and its commitment live in the server's saved table, never in anything sent to browsers; a restart keeps the same commitment. | OK |
| Host setting "Spectators see every hole card" | With no delay, anyone with the table link sees all hole cards live and could relay them. The host is warned and seated players see a banner. | Use it with a spectator delay. |
| Practice bots (not built yet) | Must decide from a player's own view, never from the hand state. | Requirement passed on. |

## Statistical tests

`npx tsx scripts/fairness/stats.ts 2000000` shuffles two million decks with the
live shuffle and two million with the seeded scheme and compares them with the
exact theory. A p-value is the chance of seeing a deviation that large from a
perfect shuffle; values spread evenly between 0 and 1 are what a fair shuffle
produces, and only values below 0.0001 would be a red flag.

RESULTS_PLACEHOLDER
