import { MAX_CHIPS, SETTINGS_LIMITS, type BlindLevel, type RotationStep } from '@rsdp/engine/settings';

/** Whether "Add game" may add another step: the server takes at most SETTINGS_LIMITS.rotationSteps.max. */
export const canAddGame = (steps: readonly RotationStep[]) => steps.length < SETTINGS_LIMITS.rotationSteps.max;

/** Whether "Add level" may add another level: the server takes at most SETTINGS_LIMITS.blindLevels.max. */
export const canAddLevel = (levels: readonly BlindLevel[]) => levels.length < SETTINGS_LIMITS.blindLevels.max;

/** The level "Add level" adds after `last`: blinds and ante doubled, but never past MAX_CHIPS, which the server refuses. */
export function nextBlindLevel(last: BlindLevel): BlindLevel {
  const double = (v: number) => Math.min(v * 2, MAX_CHIPS);
  return { ...last, smallBlind: double(last.smallBlind), bigBlind: double(last.bigBlind), ante: double(last.ante) };
}
