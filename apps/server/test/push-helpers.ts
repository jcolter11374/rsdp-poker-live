import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { expect } from 'vitest';

const unb64 = (s: string) => Buffer.from(s, 'base64url');

/** What the browser does with a message: the reverse of RFC 8291, written from the RFC, not from the code under test. */
export function decrypt(body: Buffer, uaPrivate: string, auth: string): string {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body[20];
  const asPublic = body.subarray(21, 21 + idLength);
  const sealed = body.subarray(21 + idLength);
  expect(recordSize).toBeGreaterThanOrEqual(sealed.length);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(unb64(uaPrivate));
  const uaPublic = ecdh.getPublicKey();
  const prkInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(asPublic), unb64(auth), prkInfo, 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const record = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  // The last record ends with 2 and then only zero padding.
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  expect(record[end]).toBe(2);
  return record.subarray(0, end).toString();
}

/** Checks an ES256 JWT against a raw (uncompressed point) public key. */
export function verifies(token: string, publicKey: string): boolean {
  const raw = unb64(publicKey);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  const [head, body, signature] = token.split('.');
  return verify('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }, unb64(signature));
}

/** A browser's push subscription (as PushSubscription.toJSON() gives it), with the private key only the browser has. */
export function browser(host = 'fcm.googleapis.com') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const subscription = { endpoint: `https://${host}/fcm/send/${randomBytes(12).toString('hex')}`, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
  return { subscription, privateKey: ecdh.getPrivateKey().toString('base64url') };
}

export interface Delivered {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** A pretend push service: keeps every request, and answers each address with the status set for it (201 by default). */
export function fakePushService() {
  const delivered: Delivered[] = [];
  const answers = new Map<string, number>();
  const fetch = (async (url: string, init: RequestInit) => {
    delivered.push({ endpoint: url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
    return new Response(null, { status: answers.get(url) ?? 201 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, delivered, answers };
}

/** What a browser would show for each request to it. */
export function opened(service: ReturnType<typeof fakePushService>, b: ReturnType<typeof browser>) {
  return service.delivered.filter((d) => d.endpoint === b.subscription.endpoint).map((d) => JSON.parse(decrypt(d.body, b.privateKey, b.subscription.keys.auth)) as Record<string, string>);
}
