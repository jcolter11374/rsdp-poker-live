import type { TableView } from '@rsdp/engine/wire';
import { socket } from './socket';

// Provably fair dealing (docs/FAIRNESS.md): while seated, this browser adds its
// own random seed to every hand, answering the commitment the table published
// for it. It remembers the seeds the server accepted, and the hole cards it was
// dealt, so it can tell later if either was tampered with.

const SEEDS = 'rsdp.fairSeeds';
const SENT = 'rsdp.fairSent';
const LIVE = 'rsdp.fairLive';
const KEEP = 300;
/** A seed sent this long before the deal had plenty of time to arrive; leaving it out is not an accident. */
const IN_TIME_MS = 3000;

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

/** A seed this browser sent against a commitment, and when, whether or not the server answered. */
interface Sent {
  seed: string;
  at: number;
  /** The server turned it down. */
  rejected?: {
    /** How long after sending. */
    after: number;
    /** The commitment was still the one the table showed as next: an honest server only turns down seeds that came after the deal. */
    whileCurrent: boolean;
  };
}

function sentFor(commit: string): Sent | null {
  const raw = load(SENT)[commit];
  return raw ? (JSON.parse(raw) as Sent) : null;
}

/** What this browser saw at the table during the hand dealt from a commitment. */
export interface LiveRecord {
  /** First seen dealt, by this browser's clock. */
  at: number;
  button: number;
  /** Seats dealt in. */
  seats: number[];
  /** Board cards, every run and board. */
  board: string[];
  /** Face-up and shown cards by seat, my own hole cards included. */
  cards: Record<number, string[]>;
}

export function liveRecordFor(commit: string): LiveRecord | null {
  const raw = load(LIVE)[commit];
  return raw ? (JSON.parse(raw) as LiveRecord) : null;
}

function recordLive(view: TableView) {
  const hand = view.hand;
  if (!hand?.fair || view.spectator) return;
  const old = liveRecordFor(hand.fair.commit);
  const cards: Record<number, string[]> = { ...old?.cards };
  for (const seat of view.seats) {
    if (!seat?.inHand) continue;
    const seen = seat.cards.map((c) => c.card).filter((c) => c !== '??');
    // Cards only accumulate: a draw replaces some, a mucked hand turns them over.
    cards[seat.seat] = [...new Set([...(cards[seat.seat] ?? []), ...seen])];
  }
  const record: LiveRecord = {
    at: old?.at ?? Date.now(),
    button: hand.button,
    seats: Object.keys(hand.names).map(Number),
    board: [...new Set([...(old?.board ?? []), ...hand.boards.flat(2)])],
    cards,
  };
  save(LIVE, hand.fair.commit, JSON.stringify(record));
}

let sent = '';
let sending = '';
/** The commitment the table shows as next, as of the latest view. */
let current = '';

/** Call with every table view: sends a fresh seed once per published commitment while seated, and notes what the hand showed. */
export function contributeSeed(view: TableView) {
  recordLive(view);
  const commit = view.fair?.nextCommit;
  current = commit ?? '';
  // Offline, the seed would go out late on reconnecting and could miss its hand through no one's fault.
  if (!commit || view.me.seat === null || commit === sent || commit === sending || !socket.connected) return;
  sending = commit;
  const seed = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  // Noted before the answer: a server that holds back its answer and then drops the seed still gets caught.
  const at = Date.now();
  save(SENT, commit, JSON.stringify({ seed, at } satisfies Sent));
  socket.emit('fair:seed', { commit, seed }, (res) => {
    if (sending === commit) sending = '';
    // One seed per commitment, accepted or not: a fresh one after a refusal would let a server pick and choose.
    sent = commit;
    if (!res.ok) {
      // Only "already dealt" claims the commitment moved on; other refusals (say, standing up meanwhile) aren't about the deal.
      const whileCurrent = current === commit && /already been dealt/.test(res.error);
      save(SENT, commit, JSON.stringify({ seed, at, rejected: { after: Date.now() - at, whileCurrent } } satisfies Sent));
      return;
    }
    save(SEEDS, commit, seed);
  });
}

/**
 * What's wrong with the seed listed under my name for a hand, if anything: a
 * seed this browser sent in good time was left out, or one it never sent was
 * listed (either would let a server steer the deck). Null when all is well.
 * `dealtAt` is when the hand was dealt, by this browser's clock if known.
 */
export function seedProblem(commit: string, listed: { playerId: string; seed: string }[], myId: string, dealtIn: boolean, dealtAt: number | null): string | null {
  const accepted = mySeedFor(commit);
  const sentSeed = sentFor(commit);
  const under = listed.find((c) => c.playerId === myId)?.seed;
  const rejected = sentSeed?.rejected;
  if (under && under !== accepted && under !== sentSeed?.seed) {
    return `a seed (${under}) was listed under your name that this browser didn't send. Unless you were also playing from another device, the deck may have been steered`;
  }
  if (rejected && under === sentSeed!.seed) return `the server turned down your browser's seed (${under}) but used it anyway`;
  if (rejected?.whileCurrent && dealtIn) return `the server turned down your browser's seed (${sentSeed!.seed}) before this hand was dealt`;
  // A seed turned down at once was honestly too late; one left hanging, or turned down slowly, was not.
  const heldBack = !!sentSeed && dealtAt !== null && dealtAt - sentSeed.at > IN_TIME_MS && !(rejected && rejected.after < 1000);
  if (!under && dealtIn && (accepted || heldBack)) {
    return `your browser sent its seed (${accepted ?? sentSeed!.seed}) in good time, but the hand was dealt without it`;
  }
  return null;
}

/** The live warning for the hand in progress, if the seeds listed for it don't add up for me. */
export function liveSeedProblem(view: TableView): string | null {
  const fair = view.hand?.fair;
  if (!fair || view.me.seat === null) return null;
  return seedProblem(fair.commit, fair.clientSeeds, view.me.playerId, view.me.seat in view.hand!.names, liveRecordFor(fair.commit)?.at ?? Date.now());
}
