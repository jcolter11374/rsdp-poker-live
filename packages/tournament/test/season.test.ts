import { describe, expect, it } from 'vitest';
import { apply, createTournament, defaultSettings, payoutPreset, seasonBoard, seasonPoints, validateSettings, type TournamentSettings, type TournamentState } from '../src';

const T0 = Date.parse('2026-11-01T00:00:00Z');

/** Plays an event to the end: players bust in the order given (last one wins), each to the next player in the list. */
function event(id: string, players: string[], extra: Partial<TournamentSettings> = {}, at = T0): TournamentState {
  let s = createTournament({ id, hostId: 'host', settings: defaultSettings({ startingStack: 100, season: { id: 'S', name: 'Fall league' }, ...extra }), now: at, seed: 1 });
  const step = (c: Parameters<typeof apply>[1]) => (s = apply(s, c, at).state);
  for (const p of players) step({ type: 'register', playerId: p, displayName: p.toUpperCase() });
  step({ type: 'startNow', by: 'host' });
  for (let i = 0; i < players.length - 1; i++) {
    const loser = players[i];
    const winner = players[i + 1];
    const t = s.tables.find((x) => x.seats.some((e) => e && s.entries.find((y) => y.id === e)!.playerId === loser))!;
    const seated = t.seats.filter(Boolean).map((e) => s.entries.find((y) => y.id === e)!);
    if (!seated.some((e) => e.playerId === winner)) throw new Error('keep test events at one table');
    const start = Object.fromEntries(seated.map((e) => [e.playerId, e.stack]));
    const end = { ...start, [winner]: start[winner] + start[loser], [loser]: 0 };
    step({ type: 'handStarted', tableId: t.id, handNumber: t.lastHandNumber + 1 });
    step({ type: 'handResult', result: { tableId: t.id, handNumber: t.lastHandNumber + 1, startStacks: start, endStacks: end, knockedOutBy: { [loser]: [winner] } } });
  }
  expect(s.status).toBe('finished');
  return s;
}

describe('season leaderboard', () => {
  it('scores entrants minus place plus one', () => {
    expect(seasonPoints(12, 1)).toBe(12);
    expect(seasonPoints(12, 12)).toBe(1);
  });

  it('adds up finished events, ignores unfinished ones and other seasons', () => {
    const a = event('a', ['p1', 'p2', 'p3', 'p4']);
    const b = event('b', ['p4', 'p3', 'p1'], {}, T0 + 1000);
    const other = event('c', ['p1', 'p2'], { season: { id: 'X', name: 'Other' } });
    const open = createTournament({ id: 'd', hostId: 'host', settings: defaultSettings({ season: { id: 'S', name: 'Fall league 2' } }), now: T0 + 5000, seed: 1 });
    const board = seasonBoard('S', [a, b, other, open]);
    expect(board.name).toBe('Fall league 2');
    expect(board.events.map((e) => [e.id, e.entrants, e.winners])).toEqual([
      ['a', 4, ['P4']],
      ['b', 3, ['P1']],
    ]);
    const by = Object.fromEntries(board.rows.map((r) => [r.playerId, r]));
    // a: p4 4, p3 3, p2 2, p1 1. b: p1 3, p3 2, p4 1.
    expect(by.p4).toMatchObject({ points: 5, games: 2, wins: 1, bestPlace: 1 });
    expect(by.p1).toMatchObject({ points: 4, games: 2, wins: 1 });
    expect(by.p3).toMatchObject({ points: 5, games: 2, wins: 0, bestPlace: 2 });
    expect(by.p2).toMatchObject({ points: 2, games: 1 });
    expect(board.rows.map((r) => r.playerId)).toEqual(['p4', 'p3', 'p1', 'p2']);
    expect(by.p1.net).toBeNull();
  });

  it('nets display-only prizes and bounties against what each player paid', () => {
    const money = { buyIn: 1000, rebuy: 0, addOn: 0, feePercent: 0, added: 0 };
    const s = event('a', ['p1', 'p2', 'p3'], { payouts: { structure: payoutPreset('winner-take-all', 600), money }, bounty: { amount: 500, progressivePercent: 0 } });
    const by = Object.fromEntries(seasonBoard('S', [s]).rows.map((r) => [r.playerId, r]));
    // p3 wins the 3000 pool, one bounty (p2's), and keeps their own: 3000 + 1000 - 1500.
    expect(by.p3).toMatchObject({ cashes: 1, knockouts: 1, won: 4000, net: 2500 });
    expect(by.p1.net).toBe(-1500);
    expect(by.p2.net).toBe(500 - 1500);
  });

  it('validates the season setting and fills in a new season id', () => {
    expect(validateSettings({ ...defaultSettings(), season: { id: 'S', name: '' } })).toContain('The season name must be 1-40 characters');
    expect(validateSettings({ ...defaultSettings(), season: { id: 'bad id!', name: 'x' } })).toContain('Pick a season');
    const s = createTournament({ id: 'new1', hostId: 'h', settings: defaultSettings({ season: { id: '', name: 'Winter' } }), now: T0, seed: 1 });
    expect(s.settings.season).toEqual({ id: 'new1', name: 'Winter' });
    expect(() => apply(s, { type: 'updateSettings', by: 'h', settings: { season: { id: 'other', name: 'x' } } }, T0)).toThrow('The season is set when the tournament is created');
  });
});
