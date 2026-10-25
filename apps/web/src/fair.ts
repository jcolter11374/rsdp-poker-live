import type { TableView } from '@rsdp/engine/wire';
import { socket } from './socket';

// Provably fair dealing (docs/FAIRNESS.md): while seated, this browser adds its
// own random seed to every hand, answering the commitment the table published
// for it. The seeds are kept so "Check this hand" can say yours was used.

const KEY = 'rsdp.fairSeeds';
const KEEP = 300;

type Seeds = Record<string, string>;

function load(): Seeds {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Seeds;
  } catch {
    return {};
  }
}

/** The seed this browser sent against a commitment, if any. */
export function mySeedFor(commit: string): string | null {
  return load()[commit] ?? null;
}

let lastCommit = '';

/** Call with every table view: sends a fresh seed once per published commitment while seated. */
export function contributeSeed(view: TableView) {
  const commit = view.fair?.nextCommit;
  if (!commit || view.me.seat === null || commit === lastCommit) return;
  lastCommit = commit;
  const seed = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  socket.emit('fair:seed', { commit, seed }, (res) => {
    if (!res.ok) return;
    const seeds = load();
    seeds[commit] = seed;
    const keys = Object.keys(seeds);
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete seeds[k];
    try {
      localStorage.setItem(KEY, JSON.stringify(seeds));
    } catch {
      /* storage blocked: the seed still counts, we just can't point it out later */
    }
  });
}
