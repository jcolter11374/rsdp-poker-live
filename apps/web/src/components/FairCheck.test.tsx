// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handDigest, type AuditEntry } from '@rsdp/engine';
import { visibleEvents, type HandState } from '@rsdp/engine/core';
import type { HandRecordView } from '@rsdp/engine/wire';
import { FairCheck } from './FairCheck';

// The deck itself is checked in the engine's own tests: here every card matches, so only the public record decides.
vi.mock('@rsdp/engine', async (load) => ({ ...(await load<typeof import('@rsdp/engine')>()), verifyHand: () => ({ ok: true, checks: [], matched: 2 }) }));

const seats = [{ seat: 0, playerId: 'p1', stack: 100 }];
const dealt = [{ t: 'deal', seat: 0, cards: [{ card: 'As', up: false }, { card: 'Kd', up: false }] }, { t: 'hand-end', stacks: { 0: 100 } }];
const show = (card: string) => ({ t: 'show', seat: 0, cards: [card] });

/** Hand 3, revealed, with these events. */
function hand(events: unknown[]): HandRecordView {
  return {
    handNumber: 3,
    startedAt: 0,
    endedAt: 0,
    gameName: "No-Limit Hold'em",
    betting: 'no-limit',
    stakes: { smallBlind: 1, bigBlind: 2 },
    button: 0,
    seats: [{ seat: 0, playerId: 'p1', name: 'Ann', stack: 100 }],
    events: visibleEvents({ events } as HandState, { seat: null, seeAll: false }),
    fair: { version: 1, handId: 'h3', commit: 'c', clientSeeds: [], serverSeed: 's', handSeed: 'hs', revealsAt: null, events },
  } as unknown as HandRecordView;
}
const digest = (events: unknown[]) => handDigest({ handId: 'h3', commit: 'c', serverSeed: 's', button: 0, seats, events: events as never });
const entry = (seq: number, d: string): AuditEntry => ({ seq, at: 0, kind: 'hand', data: { table: 't', hand: 3, digest: d }, prev: '', hash: '' });

/** What the public record answers, one reply per ask: entries, an error status, or no answer yet ('hang'). */
let replies: (AuditEntry[] | number | 'hang')[] = [];
let asked = 0;
beforeEach(() => {
  vi.useFakeTimers();
  replies = [];
  asked = 0;
  vi.stubGlobal('fetch', async () => {
    const r = replies[Math.min(asked++, replies.length - 1)];
    if (r === 'hang') return new Promise(() => {});
    return typeof r === 'number' ? { ok: false, status: r, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ entries: r, before: false, after: false }) };
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const minutes = async (n: number) => {
  for (let i = 0; i < n; i++) await act(() => vi.advanceTimersByTimeAsync(60_000));
};
const headline = () => document.querySelector('.fair-check > p')!.textContent!;

describe('Check this hand, while a card shown after the hand waits for the public record', () => {
  it('goes on waiting through a refetch that fails, and passes once the entry is in', async () => {
    const shown = [...dealt, show('As')];
    replies = [[entry(5, digest(dealt))], 502, [entry(5, digest(dealt))], [entry(5, digest(dealt)), entry(6, digest(shown))]];
    render(<FairCheck hand={hand(shown)} myId={null} tableId="t" />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(headline()).toMatch(/So far this hand checks out/);
    await minutes(1);
    // The record couldn't be reached: still waiting, never a pass.
    expect(headline()).toMatch(/So far this hand checks out/);
    expect(screen.getByText(/It is in the public record/).closest('li')!.textContent).toMatch(/⏳/);
    await minutes(2);
    expect(headline()).toMatch(/This hand checks out/);
    expect(headline()).not.toMatch(/So far/);
  });

  it('gives a card shown later its own fifteen minutes, and fails only on a record fetched on the last try', async () => {
    const first = [...dealt, show('As')];
    const both = [...first, show('Kd')];
    replies = [[entry(5, digest(dealt))]];
    const { rerender } = render(<FairCheck hand={hand(first)} myId={null} tableId="t" />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await minutes(10);
    expect(headline()).toMatch(/So far/);
    // The first show goes in; a second card is shown, so the hand has a new fingerprint and waits again.
    replies = [[entry(5, digest(dealt)), entry(6, digest(first))]];
    asked = 0;
    rerender(<FairCheck hand={hand(both)} myId={null} tableId="t" />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await minutes(14);
    expect(headline()).toMatch(/So far/);
    await minutes(1);
    expect(headline()).toMatch(/does not check out/);
    expect(screen.getByText(/It is in the public record/).closest('li')!.textContent).toMatch(/15 minutes later/);
  });

  it('asks again when the last try can\u2019t reach the record, and fails on the next record fetched', async () => {
    const shown = [...dealt, show('As')];
    const waiting = [entry(5, digest(dealt))];
    // The first look and tries 1 to 14 find it waiting; try 15 can't reach the record; try 16 finds it still waiting.
    replies = [...Array(15).fill(waiting), 502, waiting];
    render(<FairCheck hand={hand(shown)} myId={null} tableId="t" />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await minutes(15);
    // The last try failed: neither passed nor failed yet, and it isn't left there for good.
    expect(headline()).toMatch(/So far/);
    await minutes(1);
    expect(headline()).toMatch(/does not check out/);
    expect(asked).toBe(17);
  });

  it('waits, never passes, while a card shown since is looked up', async () => {
    const first = [...dealt, show('As')];
    const both = [...first, show('Kd')];
    replies = [[entry(5, digest(dealt)), entry(6, digest(first))]];
    const { rerender } = render(<FairCheck hand={hand(first)} myId={null} tableId="t" />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(headline()).toMatch(/This hand checks out/);
    // Another card is shown, and the record doesn't answer yet: what it had before shows the new card still to go in.
    replies = ['hang'];
    asked = 0;
    rerender(<FairCheck hand={hand(both)} myId={null} tableId="t" />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(headline()).toMatch(/So far this hand checks out/);
    expect(screen.getByText(/It is in the public record/).closest('li')!.textContent).toMatch(/⏳/);
  });
});
