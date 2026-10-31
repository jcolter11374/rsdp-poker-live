import { describe, expect, it } from 'vitest';
import type { LegalActions } from '@rsdp/engine/core';
import { preMoveAction } from './premoves';

const legal = (over: Partial<LegalActions> = {}): LegalActions => ({
  canFold: true,
  canCheck: false,
  callAmount: 0,
  canRaise: true,
  raiseKind: 'bet',
  minTo: 4,
  maxTo: 100,
  canBringIn: false,
  ...over,
});

describe('pre-moves', () => {
  it('check / fold checks when it is free and folds to a bet', () => {
    expect(preMoveAction({ kind: 'checkFold' }, legal({ canCheck: true }))).toEqual({ type: 'check' });
    expect(preMoveAction({ kind: 'checkFold' }, legal({ callAmount: 2 }))).toEqual({ type: 'fold' });
    expect(preMoveAction({ kind: 'fold' }, legal({ callAmount: 2 }))).toEqual({ type: 'fold' });
  });

  it('a check or a call of an amount that has since changed is dropped', () => {
    expect(preMoveAction({ kind: 'check' }, legal({ callAmount: 2 }))).toBeNull();
    expect(preMoveAction({ kind: 'call', amount: 2 }, legal({ callAmount: 6 }))).toBeNull();
    expect(preMoveAction({ kind: 'call', amount: 2 }, legal({ callAmount: 2 }))).toEqual({ type: 'call' });
    expect(preMoveAction({ kind: 'callAny' }, legal({ callAmount: 6 }))).toEqual({ type: 'call' });
  });

  it('the stud low card is never sent a fold it may not make: check / fold is dropped, call any brings in', () => {
    // A paused table hides the low card's turn, so it can tick a pre-move; the turn then comes owing the bring-in.
    const bringIn = legal({ canFold: false, canBringIn: true });
    expect(preMoveAction({ kind: 'checkFold' }, bringIn)).toBeNull();
    expect(preMoveAction({ kind: 'fold' }, bringIn)).toBeNull();
    expect(preMoveAction({ kind: 'check' }, bringIn)).toBeNull();
    expect(preMoveAction({ kind: 'callAny' }, bringIn)).toEqual({ type: 'bring-in' });
  });

  it('the seat that opens because the low card is all in from the ante keeps its fold pre-moves', () => {
    const opener = legal({ canFold: true, canBringIn: true });
    expect(preMoveAction({ kind: 'checkFold' }, opener)).toEqual({ type: 'fold' });
    expect(preMoveAction({ kind: 'fold' }, opener)).toEqual({ type: 'fold' });
    expect(preMoveAction({ kind: 'callAny' }, opener)).toEqual({ type: 'bring-in' });
  });
});
