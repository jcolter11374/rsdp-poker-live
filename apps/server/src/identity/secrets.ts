import { createHash, randomBytes } from 'node:crypto';

/**
 * Browser and session secrets are long random strings, so a plain sha256 is
 * enough to make a leaked table useless without slowing every connection down.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 256 random bits, URL-safe. Used for session tokens. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Same bounds the MVP used for browser tokens. */
export function isWellFormedSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && secret.length >= 16 && secret.length <= 128;
}
