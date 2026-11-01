# Security policy

RSDP Poker Live! is a free hobby site for a group of friends, run by John. The code is public so that players can check it. If you find a way to break it, thank you: please tell John privately first.

## What counts

Please report anything that would let someone:

- see another player's cards, the deck, or the next hand's seed before they should
- act for another player, take their seat, or change their chips or results
- become a host or the admin without being given that role
- read or change data that isn't theirs, or take the site down with a few requests
- get at the keys the site and its GitHub workflows use

This covers the live site at https://rsdp-poker-live.fly.dev and the code in this repository.

Some things John could do as the operator are listed openly on [/fairness](https://rsdp-poker-live.fly.dev/fairness) under "How the developer could cheat you". Those are known limits, not bugs. A way for *someone else* to do any of them is a bug, though, and so is any gap between what that page says and what the code does.

## How to report

- **Best: GitHub's private report.** On this repository, open **Security → Report a vulnerability**. Only John sees it. (If the button isn't there yet, it hasn't been switched on. Use the next option.)
- **Or message John directly**, if you know him.
- **Don't post the details in a public issue, the table chat or the group chat.** If neither route works for you, open an issue that only says you found a security problem and would like John to get in touch, with no details.

Please say what you did, what happened, and what you expected. A few steps to repeat it help most. Test on your own copy of the site where you can (see the README). On the live site, don't read other players' data, don't disrupt games, and don't run automated traffic against it.

## What to expect

- John aims to reply within a few days. This is a hobby project, so there's no fixed timetable.
- Fixes are made quickly, as a small pull request with tests and a review pass we run ourselves, and released straight away. The details stay private until the fix is live. Then the release notes say what was fixed.
- There is no bounty, but you'll be thanked in the release notes if you'd like to be.
- Reports made in good faith that follow this page won't be treated as an attack on the site.
