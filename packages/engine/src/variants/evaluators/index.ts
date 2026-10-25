import type { HighRule, LowRule } from '../types';
import { evaluateBadugi } from './badugi';
import { evaluateHigh, evaluateOmahaHigh } from './high';
import { evaluateDeuceToSeven, evaluateLowEight, evaluateOmahaLowEight, evaluateRazz } from './low';
import type { Evaluator } from './types';

export * from './types';
export { bestHigh, evaluateHigh, evaluateOmahaHigh } from './high';
export {
  bestLowAceToFive,
  bestLowDeuceToSeven,
  bestLowEight,
  evaluateDeuceToSeven,
  evaluateLowEight,
  evaluateOmahaLowEight,
  evaluateRazz,
} from './low';
export { bestBadugi, evaluateBadugi } from './badugi';

export const HIGH_EVALUATORS: Record<HighRule, Evaluator> = {
  'any-five': evaluateHigh,
  omaha: evaluateOmahaHigh,
};

export const LOW_EVALUATORS: Record<LowRule, Evaluator> = {
  'ace-to-five': evaluateRazz,
  'eight-or-better': evaluateLowEight,
  'omaha-eight-or-better': evaluateOmahaLowEight,
  'deuce-to-seven': evaluateDeuceToSeven,
  badugi: evaluateBadugi,
};
