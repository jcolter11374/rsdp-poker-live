# Privacy

RSDP Poker Live! is a free, non-commercial site for one group of friends. It is
run by John, who also runs the server. This page says, in plain words, what
the site keeps about you, who can see it, how long it stays and how to remove
it. It is written from what the code actually does, and the code is public on
GitHub, so anyone can check it. It is not legal advice, and nobody here is a
lawyer.

Last updated: 27 October 2026. Every change to this page is in its
[history on GitHub](https://github.com/jcolter11374/rsdp-poker-live/commits/main/docs/PRIVACY.md).

## The short version

- **Nothing is sold, rented or shared for marketing.** There are no ads, no
  analytics, no trackers and no third-party scripts on the site.
- **You don't need an account.** As a guest, the site knows you only by a
  random id kept in your browser and the name you type at a table.
- **With an account** the site also keeps a username and a password (scrambled,
  never stored as typed), or the id Google gives you if you sign in with
  Google. The site never asks Google for your email address and doesn't have it.
- **Poker hands and table results are kept for good**, because the group likes
  its history, leaderboards and hand search. Deleting your account removes
  your name, picture, notes and sign-in, but the hands you played stay in the
  other players' history under the name you used at the time.
- **John can read everything in the database**, as whoever runs a server can.
  That includes table chat and private notes. See [Fair dealing](/fairness) and
  [Checking John](/transparency) for what he can and can't do at a table.

## What the site keeps

| What | Where it comes from | Who can see it |
| --- | --- | --- |
| A random player id for your browser, and a secret that proves it's you | Made the first time you open the site | Only the site. The secret is stored only as a fingerprint (a SHA-256 hash). |
| The name you use at tables, when you were first and last seen | You type the name | Everyone at your tables, and on the leaderboard |
| Your picture | You pick one from the library or upload a small image | Everyone at your tables |
| Username and scrambled password | You, when you make an account | Only the site. The password is scrambled with scrypt and can't be read back. |
| Google's id for you (a long number) | Google, if you sign in with Google | Only the site. Google also shares your name, used once to make your starting username and table name. No email, no contacts, nothing else. |
| Signed-in sessions (30 days) and one-time password reset codes | Made when you sign in or John gives you a code | Only the site, stored as fingerprints |
| Hands: who was dealt in, the cards, every action, the board, who won | The game | Players at that table see what poker rules allow them to see. Shown and mucked cards follow the table's settings. |
| Table chat (the last 200 messages of each table) and the table log | You and the game | Everyone at that table, and spectators if the host allows them |
| Each table's ledger: buy-ins, rebuys, cash-outs | The game | Everyone at that table. Totals from real games also feed the public leaderboard and your profit graph. |
| Private notes and colour tags you keep on other players | You | Only you (and John, who can read the database) |
| Saved table presets and tournament structures | You, when signed in. Guests keep theirs in their own browser. | Only you |
| Tables you hid, practice games you deleted, when you reset your practice graph | You | Only you |
| Shared hand links | You, when you press Share on a hand | Anyone with the link, until you delete it |
| Roadmap suggestions | You, with the name you type | Everyone, on the [roadmap](/roadmap) |

## The public record

To make cheating by John easy to spot, the site keeps a public, append-only
record of fingerprints of every hand and ledger, admin actions and server
starts, and copies it to GitHub every hour. It holds **no names, no cards and
no table links**: a table appears only as a fingerprint that someone who
already has the table's link can match up. See [Checking John](/transparency)
for how it works.

## Your browser

- The site keeps a few things in your browser's local storage: your guest id
  and secret, your signed-in session, your table name, sound and volume,
  players you muted, tips you've dismissed, guest presets, and what your
  browser saw during hands (so it can check the dealing later). Clearing the
  site's data in your browser removes them, and makes you a new guest.
- The only cookie is a short one (10 minutes) set while you sign in with
  Google, to make sure the sign-in finishes in the browser that started it.
- Your browser fetches a small public file from GitHub
  (raw.githubusercontent.com) to compare the public record with GitHub's copy.
  GitHub sees that request, as it would for any page.

## Other services involved

- **Fly.io** hosts the site and its database in the USA (Virginia). Like any web host it
  sees your IP address when you connect. The site uses IP addresses only in
  memory, for a few minutes, to slow down people guessing passwords or the
  admin key, and doesn't save them. The server's own logs record errors, not
  visitors, and Fly keeps them only for a short time.
- **GitHub** holds the code, the hourly copy of the public record and the
  nightly backups (below).
- **Google**, only if you choose to sign in with Google. Google's own privacy
  policy covers what Google does.

## Backups

Every night a GitHub job takes a full copy of the database, locks it with a
key only John holds, and keeps it for 90 days so the site can be restored
after a disaster. The locked copy can't be opened without that key. Each
backup also shows up on [Checking John](/transparency).

## How long things are kept

- Hands, ledgers, chat and table results: for as long as the site runs, so the
  history, leaderboard and hand search keep working.
- Practice tables you made and only you and bots played at: until you delete
  them from your profile.
- Signed-in sessions: 30 days. Password reset codes: until used or expired.
  The Google sign-in cookie: 10 minutes.
- Backups: 90 days each.

## Deleting your data

- **With an account:** open [your profile](/profile) and use **Delete account**.
  That removes your username, password, Google link, sessions, name, picture,
  notes, saved setups and hidden tables straight away. Hands you already
  played stay in other players' history and ledgers under the name you used
  at the time, because they are part of their games too. Copies in backups
  disappear as the backups expire, within 90 days.
- **As a guest:** clear the site's data in your browser to start fresh. To
  have anything removed from the server, ask John.
- **Anything else** (a chat message, a name in an old hand, a suggestion): ask
  John. He'll tell you honestly what can be removed and what can't, for
  example the public record, which is built so that nothing in it can be
  changed.

## Questions

Ask John directly, or in the group chat.
