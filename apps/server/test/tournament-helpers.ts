import { expect } from 'vitest';
import { engine, type Action, type PlayerId } from '@rsdp/engine/core';
import { tableAddress } from '@rsdp/tournament';
import { TableRuntime } from '../src/runtime/table';
import type { RuntimeState } from '../src/runtime/types';
import { TournamentManager, type TableHost } from '../src/tournament/manager';
import { memoryTournamentStore } from '../src/tournament/store';
import { FakeClock, seeded } from './fake-clock';

/** A manager with in-memory storage, plus the tables it has open. */
export function setup(shared?: { store: ReturnType<typeof memoryTournamentStore>; snapshots: Map<string, string>; clock: FakeClock }) {
  const clock = shared?.clock ?? new FakeClock();
  const store = shared?.store ?? memoryTournamentStore();
  const snapshots = shared?.snapshots ?? new Map<string, string>();
  const tables = new Map<string, TableRuntime>();
  const moves: { playerId: string; from: string; to: string }[] = [];
  const errors: unknown[] = [];
  const host: TableHost = {
    async createTable(state: RuntimeState) {
      snapshots.set(state.id, JSON.stringify(state));
    },
    async loadTable(id) {
      const json = snapshots.get(id);
      return json ? (JSON.parse(json) as RuntimeState) : null;
    },
    attach(rt) {
      tables.set(rt.state.id, rt);
      rt.onChange = () => snapshots.set(rt.state.id, JSON.stringify(rt.state));
    },
    detach(rt) {
      tables.delete(rt.state.id);
    },
  };
  const manager = new TournamentManager({
    clock,
    store,
    tables: host,
    rng: seeded(11),
    onState: () => {},
    onMoved: (playerId, from, to) => moves.push({ playerId, from, to }),
    log: (m, e) => errors.push([m, e]),
  });
  return { clock, store, snapshots, tables, moves, errors, manager };
}

export const players = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}` }));

/** Everyone at every table plays: mostly check or call, sometimes shove or fold, taking `thinkMs` per round of decisions. */
export function playUntil(env: ReturnType<typeof setup>, done: () => boolean, opts: { shove?: number; thinkMs?: number } = {}, maxSteps = 200_000) {
  const shove = opts.shove ?? 12;
  const rand = seeded(5);
  const online = new Set<string>();
  for (let i = 0; i < maxSteps && !done(); i++) {
    let acted = false;
    for (const rt of env.tables.values()) {
      // Everyone is at their browser (offline players would be blinded out).
      for (const seat of rt.state.seats) {
        if (seat && !online.has(`${rt.state.id}/${seat.playerId}`)) {
          online.add(`${rt.state.id}/${seat.playerId}`);
          rt.connect(seat.playerId);
        }
      }
      const hand = rt.state.hand;
      if (!hand || hand.phase !== 'betting' || hand.toAct === null || rt.state.paused) continue;
      const seat = hand.seats.find((x) => x.seat === hand.toAct)!;
      const legal = engine.legalActions(hand, seat.seat)!;
      const r = rand(100);
      let action: Action;
      // Facing a big bet, most players let it go.
      const big = legal.callAmount * 4 > seat.stack + seat.bet;
      if (legal.canRaise && r < shove) action = { type: legal.raiseKind, to: legal.maxTo };
      else if (!legal.canCheck && (r < shove + 13 || (big && r < 70))) action = { type: 'fold' };
      else action = legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' };
      rt.act(seat.playerId, action);
      acted = true;
    }
    if (!acted) env.clock.advance(1000);
    else if (opts.thinkMs) env.clock.advance(opts.thinkMs);
  }
}

export type Env = ReturnType<typeof setup>;

export async function registerAll(env: Env, id: string, n: number) {
  for (const p of players(n)) await env.manager.command(id, p.id, p.name, { type: 'register', playerId: p.id, displayName: p.name });
}

/** Chips at every table; a live hand counts what its players started it with. */
export function chipsInPlay(env: Env) {
  let total = 0;
  for (const rt of env.tables.values()) {
    const hand = rt.state.hand?.phase === 'complete' ? null : rt.state.hand;
    for (const seat of rt.state.seats) if (seat) total += seat.pendingChips + (hand?.seats.some((x) => x.playerId === seat.playerId) ? 0 : seat.stack);
    for (const x of hand?.seats ?? []) total += x.startStack;
  }
  return total;
}

/** Every player sits at one table at most, and where the director says they sit. */
export function seatsAgree(env: Env, id: string) {
  const at = new Map<PlayerId, string[]>();
  for (const rt of env.tables.values()) {
    for (const seat of rt.state.seats) if (seat) at.set(seat.playerId, [...(at.get(seat.playerId) ?? []), rt.state.id]);
  }
  const state = env.manager.view(id)!.state;
  for (const e of state.entries) {
    if (e.status !== 'seated' && e.status !== 'rebuy-offer') continue;
    expect(at.get(e.playerId), e.playerId).toEqual([tableAddress(e.tableId!)]);
  }
  for (const [playerId, tables] of at) expect(tables, playerId).toHaveLength(1);
}
