import type { Action, LegalActions } from '@rsdp/engine/core';

/** A move ticked before your turn, played when the turn comes if it still applies. */
export type PreAction = { kind: 'checkFold' } | { kind: 'check' } | { kind: 'fold' } | { kind: 'call'; amount: number } | { kind: 'callAny' };

/**
 * The move a queued pre-move plays once it is your turn, or null when it no longer applies: a "check" that now
 * faces a bet, or a "call 20" that faces a raise, is dropped so you can decide again. So is a fold you may not
 * make: the stud low card, whose turn a paused table hides, must bring in.
 */
export function preMoveAction(pre: PreAction, legal: LegalActions): Action | null {
  const fold: Action | null = legal.canFold ? { type: 'fold' } : null;
  if (pre.kind === 'checkFold') return legal.canCheck ? { type: 'check' } : fold;
  if (pre.kind === 'fold') return fold;
  if (pre.kind === 'check') return legal.canCheck ? { type: 'check' } : null;
  // Owing the stud bring-in, staying in means bringing it in.
  if (pre.kind === 'callAny') return legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' };
  if (legal.canCheck) return { type: 'check' };
  return legal.callAmount === pre.amount ? { type: 'call' } : null;
}
