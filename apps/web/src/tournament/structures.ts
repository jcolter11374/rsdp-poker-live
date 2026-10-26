import { readSavedStructure, structureToSave, type TournamentSettings } from '@rsdp/tournament';
import type { SavedSetup } from '@rsdp/engine/wire';
import { setupList } from '../savedSetups';

/** Tournament structures saved under a name: on the account when signed in, else in this browser. */
export const tournamentStructures = setupList('tournament', 'rsdp.tournamentStructures', (s) => s);

/** Saves a tournament's settings under a name, replacing one of the same name. */
export function saveStructure(name: string, settings: TournamentSettings) {
  return tournamentStructures.save(name, JSON.stringify(structureToSave(settings)));
}

/** A saved structure's settings, ready for the new-tournament form (a start that has passed moves forward). */
export function structureSettings(setup: SavedSetup): TournamentSettings {
  return readSavedStructure(setup.json, Date.now());
}
