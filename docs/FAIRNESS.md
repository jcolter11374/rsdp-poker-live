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
- **Whoever runs the server can't pick the cards without getting caught.**
  While the previous hand is being played, every seated player's browser
  quietly sends its own random seed for the next hand. The deck depends on the
  server's secret *and* every player's seed. The server committed first, so it
  can't steer the result with its own secret; players never see that secret
  until later, so they can't predict the deck either. The only way left to
  steer it is to tamper with the players' seeds, and each browser watches its
  own (below).
- **Your browser keeps the server honest during play.** When a hand is dealt,
  everyone sees which seeds went into it. If your browser's seed was left out
  although it was sent in good time, or a seed your browser never sent is
  listed under your name, the table shows a warning straight away. Your browser
  also writes down what it saw during the hand: the button, who was dealt in,
  the board, and every card shown to you.
- **Anyone can check a hand afterwards.** Open a hand in the replayer and press
  **🔒 Check this hand**. Once the hand is revealed, your browser rebuilds the
  deck from the seeds and *deals the hand again* by the rules: hole cards one
  at a time clockwise from the left of the button, then the board, draws and
  reshuffles. Every card dealt, shown or won with must match, the record must
  match the hand's history, and it must agree with what your browser wrote
  down at the table. **Download proof** saves a file
  that `node scripts/verify-hand.mjs` checks on its own, using only Node's
  built-in OpenSSL SHA-256 and none of the app's code.
- **When hands are revealed** (decided 25 October 2026): when the host stops
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
   server's secret was fixed. One seed per player; a later one replaces it.
4. When the hand starts, the server takes the seeds of the players dealt in and
   computes
   `handSeed = SHA-256("rsdp-fair-v1|" + serverSeed + "|" + sortedClientSeeds.join(","))`.
   Nothing else goes in, so the server has no free input to vary. The hand's
   commitment and seeds are in every player's view (`hand.fair`), and a new
   secret is committed for the following hand straight away. After a restart
   the table commits to a fresh secret, so a deal lost in a crash is never
   dealt again.
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
7. Draw games: when the stub runs out, its last card and the muck (earlier
   discards and folded hands, in the order they went there) are reshuffled
   with the same method, using the label `reshuffle:<deck place>`. The checker
   replays this too.

Once a hand is revealed, its record carries every event with every card, so
the checker can deal it again. Shared hand links never carry the seeds.

The code: [`packages/engine/src/fairness.ts`](../packages/engine/src/fairness.ts)
(the scheme, a dependency-free SHA-256, and `verifyHand`), the runtime's
"provably fair dealing" section in
[`apps/server/src/runtime/table.ts`](../apps/server/src/runtime/table.ts), and
[`scripts/verify-hand.mjs`](../scripts/verify-hand.mjs). The tests check our
SHA-256 against OpenSSL on every input length from 0 to 300 bytes, pin the
deck for a known seed (so old hands stay checkable), and deal 3,000 random
hands in every game, reshuffles included, then check each one with both
checkers. They also check that a swapped card, cards handed out of turn and a
shown card nobody was dealt are all caught.

### Checking a hand by hand

With a copy of the code (`git clone https://github.com/jcolter11374/rsdp-poker-live`)
and Node 20 or later, take the file from **Download proof** and run:

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

Limits, stated plainly:

- A dishonest server could list a made-up seed under a player's name, or drop
  a real one, to steer the deck. Each browser checks its own entry, live and
  in "Check this hand". The server never deals sooner than 2.5 seconds after
  showing a hand's commitment, and browsers send their seed the moment they
  see it. A browser warns if a seed it never sent is listed under its name; if
  its seed was left out although sent more than 1.5 seconds before the deal
  (whatever the server answered: an honest server only turns down a seed that
  arrived after the deal); if its seed was left out of a hand dealt less than
  2 seconds after the commitment first appeared; and if the server uses a seed
  it said it turned down. So this is caught unless the affected player never
  looks (say they left right after the hand, or play with browser storage
  blocked), or sat down in the last moment before a deal.
  "Check this hand" also lists who sent no seed.
- The checker trusts the server's account of the betting. It doesn't
  re-evaluate who won each pot; everyone sees that live.
- Nothing can stop someone who runs the server from *reading* the deck of a
  live hand out of the server's memory or database. Every online poker site
  has this limit; only the operator can do it, and the code never exposes it.
- None of this stops players from sharing their cards with each other off the
  table.

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
| Practice bots | They decide from their own cards and cards dealt face up only (`situation()` in apps/server/src/bots/strategy.ts), never other hole cards or the deck. Their own random choices don't touch the deck. | OK |
| Independent review of this scheme | Found that the first checker only verified that each card's recorded place was used once, so a server could have handed places to the wrong players; that the list of seeds and the hand id were not bound to anything; that shown cards and draw-game reshuffles were not checked; that a "hide my cards" share link would carry the seeds; and that a crash could re-deal a deck. | **All fixed** as described above, each with a test. A second review then found that a server could still drop or invent seeds, and that the checker compared the server's revealed record with nothing players saw live: both closed with the browser's own records above. |

## Statistical tests

[`npx tsx scripts/fairness/stats.ts 2000000`](../scripts/fairness/stats.ts) shuffles two million decks with the
seeded scheme that deals every hand now, and two million with the direct
CSPRNG shuffle (what dealt hands before this change, and still shuffles seats),
and compares them with the exact theory. A p-value is the chance of seeing a deviation that large from a
perfect shuffle; values spread evenly between 0 and 1 are what a fair shuffle
produces, and only values below 0.0001 would be a red flag.

Results of 25 October 2026:

| Test | What was measured | Statistic | p-value |
|---|---|---|---|
| Direct CSPRNG shuffle: Card x position | Each of 52 cards at each of 52 positions, 2,000,000 decks (386s) | chi2=2526.0 df=2601 | 0.8511 |
| Direct CSPRNG shuffle: Five-card hands | high card 50.0491% (theory 50.1177%); one pair 42.2977% (theory 42.2569%); two pair 4.7686% (theory 4.7539%); three of a kind 2.1205% (theory 2.1128%); straight 0.3937% (theory 0.3925%); flush 0.1969% (theory 0.1965%); full house 0.1445% (theory 0.1441%); four of a kind 0.0271% (theory 0.0240%); straight flush 0.0017% (theory 0.0015%) | chi2=12.65 df=8 | 0.1245 |
| Direct CSPRNG shuffle: Pocket pairs | 5.8632% vs theory 5.8824% (first two cards) | chi2=1.33 df=1 | 0.2497 |
| Direct CSPRNG shuffle: Suited starting hands | 23.6057% vs theory 23.5294% (first two cards) | chi2=6.46 df=1 | 0.0110 |
| Direct CSPRNG shuffle: Neighbours same suit | 23.5363% vs theory 23.5294% (every adjacent pair of cards) | chi2=2.66 df=1 | 0.1029 |
| Direct CSPRNG shuffle: Neighbours same rank | 5.8871% vs theory 5.8824% (every adjacent pair of cards) | chi2=4.22 df=1 | 0.0400 |
| Direct CSPRNG shuffle: Deck to next deck | Top card of one deck against the top card of the next | chi2=2617.9 df=2703 | 0.8770 |
| Direct CSPRNG shuffle: All 24 orders of 4 cards | 24 of 24 orders seen, 2,000,000 shuffles | chi2=23.0 df=23 | 0.4604 |
| Direct CSPRNG shuffle: All 120 orders of 5 cards | 120 of 120 orders seen, 2,000,000 shuffles | chi2=106.0 df=119 | 0.7965 |
| Seeded deck (rsdp-fair-v1): Card x position | Each of 52 cards at each of 52 positions, 2,000,000 decks (296s) | chi2=2587.1 df=2601 | 0.5727 |
| Seeded deck (rsdp-fair-v1): Five-card hands | high card 50.1208% (theory 50.1177%); one pair 42.2274% (theory 42.2569%); two pair 4.7755% (theory 4.7539%); three of a kind 2.1208% (theory 2.1128%); straight 0.3927% (theory 0.3925%); flush 0.1948% (theory 0.1965%); full house 0.1414% (theory 0.1441%); four of a kind 0.0251% (theory 0.0240%); straight flush 0.0016% (theory 0.0015%) | chi2=5.29 df=8 | 0.7264 |
| Seeded deck (rsdp-fair-v1): Pocket pairs | 5.8982% vs theory 5.8824% (first two cards) | chi2=0.90 df=1 | 0.3424 |
| Seeded deck (rsdp-fair-v1): Suited starting hands | 23.5009% vs theory 23.5294% (first two cards) | chi2=0.90 df=1 | 0.3427 |
| Seeded deck (rsdp-fair-v1): Neighbours same suit | 23.5273% vs theory 23.5294% (every adjacent pair of cards) | chi2=0.25 df=1 | 0.6181 |
| Seeded deck (rsdp-fair-v1): Neighbours same rank | 5.8835% vs theory 5.8824% (every adjacent pair of cards) | chi2=0.24 df=1 | 0.6257 |
| Seeded deck (rsdp-fair-v1): Deck to next deck | Top card of one deck against the top card of the next | chi2=2805.1 df=2703 | 0.0838 |
| Seeded deck (rsdp-fair-v1): All 24 orders of 4 cards | 24 of 24 orders seen, 2,000,000 shuffles | chi2=34.5 df=23 | 0.0589 |
| Seeded deck (rsdp-fair-v1): All 120 orders of 5 cards | 120 of 120 orders seen, 2,000,000 shuffles | chi2=161.9 df=119 | 0.0055 |

18 tests; 0 with p < 0.0001

All 18 pass. The lowest, 0.0055 for the orders of five cards from the seeded
deck, is about what you expect to see once among 18 tests; three fresh runs of
three million shuffles each came out at chi-square 115.2, 131.9 and 105.8 (119
expected), well inside the normal range.
