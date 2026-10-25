import type { TableView } from '@rsdp/engine/wire';
import { socket } from './socket';

// Provably fair dealing (docs/FAIRNESS.md): while seated, this browser adds its
// own random seed to every hand, answering the commitment the table published
// for it. It remembers the seeds the server accepted, and the hole cards it was
// dealt, so it can tell later if either was tampered with.

const SEEDS = 'rsdp.fairSeeds';
const CARDS = 'rsdp.fairCards';
const KEEP = 300;

type Store = Record<string, string>;

function load(key: string): Store {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Store;
  } catch {
    return {};
  }
}

function save(key: string, commit: string, value: string) {
  const all = load(key);
  if (all[commit] === value) return;
  all[commit] = value;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete all[k];
  try {
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    /* storage blocked: the seed still counts, we just can't point it out later */
  }
}

/** The seed the server accepted from this browser against a commitment, if any. */
export function mySeedFor(commit: string): string | null {
  return load(SEEDS)[commit] ?? null;
}

/** My hole cards as the table showed them during the hand dealt from this commitment. */
export function myCardsFor(commit: string): string[] {
  return load(CARDS)[commit]?.split(' ').filter(Boolean) ?? [];
}

let sent = '';
let sending = '';

/** Call with every table view: sends a fresh seed once per published commitment while seated, and notes my cards. */
export function contributeSeed(view: TableView) {
  const fair = view.hand?.fair;
  const me = view.me.seat !== null ? view.seats[view.me.seat] : null;
  const cards = me?.cards.map((c) => c.card).filter((c) => c !== '??') ?? [];
  if (fair && cards.length) save(CARDS, fair.commit, cards.join(' '));

  const commit = view.fair?.nextCommit;
  if (!commit || view.me.seat === null || commit === sent || commit === sending) return;
  sending = commit;
  const seed = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  socket.emit('fair:seed', { commit, seed }, (res) => {
    if (sending === commit) sending = '';
    if (!res.ok) return;
    sent = commit;
    save(SEEDS, commit, seed);
  });
}

/**
 * What's wrong with the seed listed under my name for a hand, if anything:
 * the server accepted mine and left it out, or listed one this browser never
 * sent (which would let a server steer the deck). Null when all is well.
 */
export function seedProblem(commit: string, listed: { playerId: string; seed: string }[], myId: string, dealtIn: boolean): string | null {
  const mine = mySeedFor(commit);
  const under = listed.find((c) => c.playerId === myId)?.seed;
  if (under && under !== mine) return `a seed (${under}) was listed under your name that this browser didn't send. That's fine only if you played this hand on another device`;
  if (mine && dealtIn && !under) return `the server accepted your browser's seed (${mine}) but left it out`;
  return null;
}

/** The live warning for the hand in progress, if the seeds listed for it don't add up for me. */
export function liveSeedProblem(view: TableView): string | null {
  const fair = view.hand?.fair;
  if (!fair || view.me.seat === null) return null;
  return seedProblem(fair.commit, fair.clientSeeds, view.me.playerId, view.me.seat in view.hand!.names);
}
