import { NOTE_COLORS, NOTE_MAX, type NoteColor, type PlayerNote } from '@rsdp/engine/wire';
import { listNotes, setNote, type Db } from './db';
import { ActionError } from '@rsdp/engine/core';

/** Where private player notes are kept. The default keeps them in memory. */
export interface NotesStore {
  list(owner: string): Promise<PlayerNote[]>;
  /** Saves the note, or deletes it when it has no text and no colour (then returns null). */
  set(owner: string, note: PlayerNote): Promise<PlayerNote | null>;
}

/** Checks and tidies a note from a client. */
export function cleanNote(raw: unknown): PlayerNote {
  const input = (raw ?? {}) as Partial<Record<keyof PlayerNote, unknown>>;
  const targetPlayerId = typeof input.targetPlayerId === 'string' ? input.targetPlayerId.trim() : '';
  if (!targetPlayerId || targetPlayerId.length > 64) throw new ActionError('pick a player');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text.length > NOTE_MAX) throw new ActionError(`notes can be up to ${NOTE_MAX} characters`);
  const color = (input.color ?? 'none') as NoteColor;
  if (!NOTE_COLORS.includes(color)) throw new ActionError('unknown note colour');
  return { targetPlayerId, text, color };
}

const isEmpty = (n: PlayerNote) => !n.text && n.color === 'none';

export function memoryNotes(): NotesStore {
  const byOwner = new Map<string, Map<string, PlayerNote>>();
  return {
    async list(owner) {
      return [...(byOwner.get(owner)?.values() ?? [])].sort((a, b) => a.targetPlayerId.localeCompare(b.targetPlayerId));
    },
    async set(owner, note) {
      const notes = byOwner.get(owner) ?? new Map<string, PlayerNote>();
      byOwner.set(owner, notes);
      if (isEmpty(note)) {
        notes.delete(note.targetPlayerId);
        return null;
      }
      notes.set(note.targetPlayerId, { ...note });
      return { ...note };
    },
  };
}

export function dbNotes(db: Db): NotesStore {
  const view = (r: { targetPlayerId: string; text: string; color: string }): PlayerNote => ({
    targetPlayerId: r.targetPlayerId,
    text: r.text,
    color: r.color as NoteColor,
  });
  return {
    async list(owner) {
      return (await listNotes(db, owner)).map(view);
    },
    async set(owner, note) {
      const row = await setNote(db, { ownerPlayerId: owner, ...note });
      return row ? view(row) : null;
    },
  };
}
