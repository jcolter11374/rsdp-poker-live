import type { GameSpec, Modifier, VariantRules } from './types';
import type { ModifierRegistry, VariantRegistry } from './api';

/** Process-wide registries. Games and modifiers register once at startup. */

const games = new Map<string, { spec: GameSpec; rules: VariantRules }>();
const modifiers = new Map<string, Modifier>();

export const variants: VariantRegistry = {
  register(spec, rules) {
    games.set(spec.id, { spec, rules });
  },
  get(id) {
    const g = games.get(id);
    if (!g) throw new Error(`unknown game: ${id}`);
    return g;
  },
  list() {
    return [...games.values()].map((g) => g.spec);
  },
};

export const modifierRegistry: ModifierRegistry = {
  register(modifier) {
    modifiers.set(modifier.id, modifier);
  },
  get(id) {
    return modifiers.get(id);
  },
};
