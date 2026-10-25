/** Longest display name, in characters (an emoji counts as one). */
export const NAME_MAX = 20;

/**
 * A display name safe to show and to store: no control characters, no lone
 * UTF-16 surrogates (Postgres jsonb and text refuse them), trimmed, and cut
 * by whole characters so an emoji is never split. Empty when nothing is left.
 */
export function cleanName(raw: unknown, max = NAME_MAX): string {
  const text = String(raw ?? '')
    .replace(/\p{Cs}/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
    .trim();
  return Array.from(text).slice(0, max).join('').trim();
}
