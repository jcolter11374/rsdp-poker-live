"""Builds random showdowns and ranks them with pokerkit, an independent
open-source poker library, so our evaluators can be checked against it.

    pip install pokerkit==0.7.7
    python3 crosscheck.py [groups_per_kind] [out.json]

Defaults write crosscheck.json next to this file (checked in; the vitest suite
reads it, so CI needs no Python).
"""

import json
import os
import random
import sys
from functools import cmp_to_key

import pokerkit as pk

RANKS = '23456789TJQKA'
SUITS = 'cdhs'
DECK = [r + s for r in RANKS for s in SUITS]
# Every other group deals from only low ranks, so wheels, small straights,
# lows and badugis turn up far more often than in a full deck.
LOW_DECK = [r + s for r in 'A2345678T' for s in SUITS]

# kind: (pokerkit hand class, hole cards, board cards, players)
KINDS = {
    'high7': (pk.StandardHighHand, 2, 5, 6),
    'stud-high': (pk.StandardHighHand, 7, 0, 6),
    'omaha4-high': (pk.OmahaHoldemHand, 4, 5, 6),
    'omaha5-high': (pk.OmahaHoldemHand, 5, 5, 6),
    'omaha6-high': (pk.OmahaHoldemHand, 6, 5, 6),
    'omaha4-low8': (pk.OmahaEightOrBetterLowHand, 4, 5, 6),
    'omaha5-low8': (pk.OmahaEightOrBetterLowHand, 5, 5, 6),
    'omaha6-low8': (pk.OmahaEightOrBetterLowHand, 6, 5, 6),
    'stud-low8': (pk.EightOrBetterLowHand, 7, 0, 6),
    'razz': (pk.RegularLowHand, 7, 0, 6),
    'deuce-seven': (pk.StandardLowHand, 5, 0, 8),
    'badugi': (pk.BadugiHand, 4, 0, 8),
}


def evaluate(cls, hole, board):
    try:
        return cls.from_game(''.join(hole), ''.join(board))
    except ValueError:
        return None  # no qualifying hand


def strengths(hands):
    """Dense rank per hand, 0 = weakest; None for no qualifying hand."""
    real = sorted({i for i, h in enumerate(hands) if h is not None},
                  key=cmp_to_key(lambda a, b: -1 if hands[a] < hands[b] else (1 if hands[b] < hands[a] else 0)))
    out = [None] * len(hands)
    level = -1
    prev = None
    for i in real:
        if prev is None or hands[prev] < hands[i]:
            level += 1
        out[i] = level
        prev = i
    return out


def build(kind, groups, rng):
    cls, n_hole, n_board, players = KINDS[kind]
    cases = []
    for g in range(groups):
        deck = (DECK if g % 2 == 0 else LOW_DECK)[:]
        rng.shuffle(deck)
        players = min(KINDS[kind][3], (len(deck) - n_board) // n_hole)
        board = deck[:n_board]
        holes = [deck[n_board + i * n_hole:n_board + (i + 1) * n_hole] for i in range(players)]
        ranks = strengths([evaluate(cls, h, board) for h in holes])
        cases.append({'board': board, 'holes': holes, 'ranks': ranks})
    return cases


def main():
    groups = int(sys.argv[1]) if len(sys.argv) > 1 else 150
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), 'crosscheck.json')
    rng = random.Random(20261025)
    data = {'source': f'pokerkit {pk.__version__ if hasattr(pk, "__version__") else "0.7.7"}',
            'kinds': {k: build(k, groups, rng) for k in KINDS}}
    with open(out, 'w') as f:
        json.dump(data, f, separators=(',', ':'))


if __name__ == '__main__':
    main()
