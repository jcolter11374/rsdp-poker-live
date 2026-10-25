/**
 * Optional table features (W2): `import '@rsdp/engine/modifiers'` registers
 * their settings sections and engine hooks. Server and web must both import
 * it before parsing settings, so they agree on the sections.
 */
import { modifierRegistry } from '../core/registry';
import type { Modifier } from '../core/types';
import { bounty72 } from './bounty-72';
import { doubleBoard } from './double-board';

export * from './bomb-pot';
export * from './double-board';
export * from './bounty-72';

/** Modifiers with engine hooks. Bomb pots have none: the runtime plans them. */
export const ENGINE_MODIFIERS: Modifier[] = [doubleBoard as Modifier, bounty72 as Modifier];

/** Registers every modifier's engine hooks. Safe to call more than once. */
export function registerAllModifiers(registry: Pick<typeof modifierRegistry, 'register'> = modifierRegistry) {
  for (const m of ENGINE_MODIFIERS) registry.register(m);
}

registerAllModifiers();
