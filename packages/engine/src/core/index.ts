/**
 * The engine core: `import { engine, variants, planForcedBets } from '@rsdp/engine/core'`.
 * The old MVP table (src/table.ts) stays exported from '@rsdp/engine' until the runtime moves over.
 */
import type { EngineApi } from './api';
import { act, draw, foldOutOfTurn, legalActions, pots, show, startHand, timeout, voteRunItTwice } from './hand';
import { visibleEvents } from './visibility';

export * from './types';
export * from './api';
export { modifierRegistry, variants } from './registry';
export { blindsPassed, planForcedBets } from './forced';
export { HOLDEM, registerHoldem } from './nlhe';
export { highAwardPortion, highRules } from './high';
export { computePots, uncalledBet } from './pots';
export { oddChipOrder, settle } from './settle';
export { computeLegal } from './betting';
export { visibleEvents };

export const engine: EngineApi = {
  startHand,
  legalActions,
  act,
  draw,
  voteRunItTwice,
  show,
  timeout,
  foldOutOfTurn,
  pots,
  visibleEvents,
};
