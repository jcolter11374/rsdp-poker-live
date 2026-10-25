import { nanoid } from 'nanoid';

/** Default row id: 21 URL-safe characters, about 126 random bits. */
export function newId(): string {
  return nanoid();
}

/** Short id for shareable table links (same length as the MVP room codes). */
export function newTableId(): string {
  return nanoid(10);
}

/** Hand ids double as replay links, so they carry extra randomness. */
export function newHandId(): string {
  return nanoid(24);
}
