# Accessibility

How well RSDP Poker Live! works for people who use a screen reader, a
keyboard instead of a mouse or touch, larger text or zoom, or who need
stronger colour contrast: what was checked, what was fixed, and what is
known and left. The aim is WCAG 2.2 at level AA, the usual standard for
websites.

## What was checked (November 2026)

Checked by Claude on a local copy of the site, never the live one, with
[axe](https://github.com/dequelabs/axe-core) (an automated checker) in
Chrome, keyboard walks run by a script, and a read of the code. Nobody has
yet tried it with a real screen reader; see "Known and left".

- **Pages:** the table (seated on your turn, waiting for others, watching as
  a spectator, and the result of a hand), the home page, a tournament lobby
  (as the host, and as a player on a phone), sign-in and sign-up. Also the
  new tournament, fairness, How to play, leaderboard and About pages.
- **Sizes:** a computer (1280 by 860), a phone (390 by 844), 200% zoom (640
  wide) and 400% zoom (320 wide), and the browser's text size raised from 16
  to 24 pixels.
- **What:** everything reachable and usable from the keyboard, with focus
  visible and never stuck; names and announcements for screen readers;
  colour contrast (4.5:1 for text); pages that still fit when zoomed; and
  tap targets at least 24 by 24 pixels.

## What was fixed

- **Green buttons** (Create table, Sit down, Register, Sign in) had white
  words on a green of only 3:1. They are a darker green now, 5:1. The table
  keeps its brighter green until John has seen the change (below).
- **The tournament lobby's clock card** had pale green words at 4:1 and
  3.4:1 on the green; they are lighter now.
- **The table read aloud.** Nothing told a screen reader what was happening.
  Now a region only screen readers hear reads each new line of the hand
  ("Bo bets 40", "Turn: queen of spades", "Cy wins 240 with a pair of
  jacks"), says "Your turn" with what you can do and the pot ("Your turn:
  call 40, raise to 80 up to 1000 or fold. Pot 200."), says when the game
  pauses, and warns when 10 seconds are left on your clock. It reads only
  what your own screen already shows.
- **Seats in words.** Each nameplate says who is to act, who has folded and
  who has the dealer button. Empty seats' buttons say which seat ("Sit in
  seat 3", "Add a practice bot to seat 3").
- **Nameplates from the keyboard.** A player's menu (notes, gestures, the
  host's controls) opened only with a click or a tap. Tab now reaches each
  nameplate, with a white ring around it, and Enter opens the menu.
- **Dialogs and phone sheets** didn't take the keyboard with them: focus
  stayed behind, Tab wandered to the page underneath, and nothing put focus
  back when they closed. Now every dialog, phone sheet and the hand replayer
  (even its "can't be replayed" box) takes focus when it opens, keeps Tab
  inside, and hands focus back to the button that opened it, or to the menu
  button when it was opened from the phone's menu.
- **Boxes that scroll** (code and tables on the fairness, privacy and terms
  pages on a phone, and the table's log) couldn't be scrolled from the
  keyboard. Tab now stops on them while they scroll, so the arrow keys work.
- **Page structure:** the table page has a main region and a page heading
  (the table's name), and headings no longer skip a level (the fairness
  page's summary, How to play, the host controls). Empty column headings
  (leaderboard, lobby, invite codes) have words for screen readers.
- **Names and states:** the chips-or-big-blinds switch is named by the words
  on it; the open tab in the table's panel and its settings is announced;
  the move buttons and the bet box say their keyboard shortcuts (F, K, C,
  R); and the menu button on a phone says how many requests are waiting.
- **Messages:** errors on sign-in, sign-up, password reset, creating a
  table, sitting down, registering for a tournament and on the move buttons
  are read out when they appear, as are the table's notices (your
  tournament table is ready, you're no longer seated, the game stops after
  this hand, connection lost).

None of these change how the table looks, apart from the white ring that
shows where Tab is: before-and-after screenshots of the table match.

## Waiting for John's OK

Changes to the table's look wait until John has seen before-and-after
pictures ([D21](DECISIONS.md#d21-look-and-feel)). They are ready in their own
commit:

- **Colour contrast on the table:** the green buttons (Raise at 2.5:1 to
  3.9:1; Start game, Sit down and Invite at 3:1); the red behind white
  words (the "host" tag and the count of waiting requests at 3.4:1, Fold
  when it asks for a second press at 3.3:1); the purple "NIT" tag at 4.3:1;
  the red last seconds of a clock on a nameplate at 4.4:1; and the words on
  the cloth (the empty seats' Sit and + Bot, "Next hand in", the game's
  name, "Run 1", the total when there are side pots) at 2.7:1 to 3.9:1.
- **Small tap targets:** + Bot (14 to 17 pixels tall), the quick chat
  replies (21) and the Straddle and Wait for the big blind switches (23).

## Known and left

- **No real screen-reader test yet.** The checks above are automated and
  by reading the code. Someone should try a hand with VoiceOver on an
  iPhone and NVDA or VoiceOver on a computer.
- **Larger text:** raising the browser's text size grows the words on every
  page, but not the seats, cards and chips on the felt, which are sized to
  fit the window. Zoom (Ctrl and +, or pinch) grows everything, and pages
  fit without scrolling sideways at 200% and 400%. On a phone with large
  text a long table name is cut short in the top bar.
- **Turn clocks** are part of the game. At a cash table the host can give
  everyone more time per turn and a bigger time bank, or turn the clock off,
  in the table's settings.
- **Reading order on the felt** follows the seat numbers, not where seats
  sit around the table.
- **Tabs** in the table's panel and the lobby are buttons that say which is
  open; the arrow keys don't move between them.
- **In the hand replayer**, Space plays and pauses, even on a focused
  button; Enter still presses buttons.
- **The "requests are waiting" notice** on the table opens the host panel
  only with a click; the Host & log button and the phone's menu do the same
  from the keyboard.

## The automatic check

The browser smoke test (`e2e/smoke.mjs`, run by CI against the production
image on every pull request) checks the home, sign-in, sign-up and new
tournament pages on a computer and a phone, a tournament lobby, and the
table on your turn, while waiting and as a spectator, with axe's WCAG 2.2 AA
rules. Any serious or critical problem fails the run. It also checks that a
screen reader is told "Your turn". Until the table's colours are changed,
the colour-contrast rule is left out on the table only (`TABLE` in the
smoke test).

The upgrade rehearsal (`.github/workflows/upgrade.yml`) runs `main`'s copy
of the smoke test against `main`'s image, only to make data. It sets
`SMOKE_A11Y=report`, so accessibility problems there are printed, not failed
on: a newer axe in a release could flag what is already live, and that
release can't change it. CI's own run of the smoke test still fails on them.

To look at a page yourself on a local copy (`npm run build && npm start`):
open it in Chrome, and run axe from its browser extension, or Lighthouse's
accessibility check in the developer tools.
