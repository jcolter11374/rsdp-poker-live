import { ActionError } from '@rsdp/engine/core';
import { AVATAR_MAX_CHARS, AVATARS } from '@rsdp/engine/wire';
import { getAvatar, setAvatar, type Db } from './db';

/** A player's picture as kept: a library id, or an uploaded image as a data: URL. */
export type Avatar = { kind: 'library'; value: string; updatedAt: number } | { kind: 'upload'; value: string; updatedAt: number };

/** Where player pictures are kept. The default keeps them in memory. */
export interface AvatarStore {
  get(playerId: string): Promise<Avatar | null>;
  set(playerId: string, avatar: Omit<Avatar, 'updatedAt'> | null): Promise<Avatar | null>;
}

const IMAGE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Checks a picture from a client: a library id, a small image, or null to clear it. */
export function cleanAvatar(raw: unknown): Omit<Avatar, 'updatedAt'> | null {
  if (raw === null || raw === undefined) return null;
  const input = raw as { library?: unknown; image?: unknown };
  if (typeof input.library === 'string') {
    if (!Object.hasOwn(AVATARS, input.library)) throw new ActionError('unknown avatar');
    return { kind: 'library', value: input.library };
  }
  if (typeof input.image === 'string') {
    if (input.image.length > AVATAR_MAX_CHARS) throw new ActionError('that picture is too big; try a smaller one');
    if (!IMAGE.test(input.image)) throw new ActionError('pictures must be JPEG, PNG or WebP');
    return { kind: 'upload', value: input.image };
  }
  throw new ActionError('pick an avatar');
}

/** What tables show for a picture: 'lib:<id>', or 'up:<version>' for an upload served at /api/avatars/<playerId>. */
export const avatarToken = (a: Avatar | null): string | null => (!a ? null : a.kind === 'library' ? `lib:${a.value}` : `up:${a.updatedAt.toString(36)}`);

/** The bytes and type of an uploaded picture. */
export function avatarImage(a: Avatar | null): { type: string; data: Buffer } | null {
  if (!a || a.kind !== 'upload') return null;
  const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(a.value);
  return m ? { type: m[1], data: Buffer.from(m[2], 'base64') } : null;
}

export function memoryAvatars(): AvatarStore {
  const byPlayer = new Map<string, Avatar>();
  let last = 0;
  return {
    async get(playerId) {
      return byPlayer.get(playerId) ?? null;
    },
    async set(playerId, avatar) {
      if (!avatar) {
        byPlayer.delete(playerId);
        return null;
      }
      // Each change gets a new version, even two in one millisecond, so browsers fetch the new picture.
      last = Math.max(Date.now(), last + 1);
      const saved = { ...avatar, updatedAt: last } as Avatar;
      byPlayer.set(playerId, saved);
      return saved;
    },
  };
}

export function dbAvatars(db: Db): AvatarStore {
  const view = (r: { kind: string; value: string; updatedAt: Date }): Avatar => ({ kind: r.kind as Avatar['kind'], value: r.value, updatedAt: r.updatedAt.getTime() });
  return {
    async get(playerId) {
      const row = await getAvatar(db, playerId);
      return row ? view(row) : null;
    },
    async set(playerId, avatar) {
      const row = await setAvatar(db, playerId, avatar);
      return row ? view(row) : null;
    },
  };
}
