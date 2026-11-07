/**
 * Web Push with nothing but node:crypto: the message encryption browsers
 * expect (RFC 8291, the aes128gcm content coding of RFC 8188) and the server's
 * signed claim of who is sending (VAPID, RFC 8292). test/push.test.ts checks
 * both against the examples published in those RFCs.
 *
 * The push service (Google's for Chrome, Apple's for Safari, Mozilla's for
 * Firefox, Microsoft's for Edge) gets the subscription's address and the
 * ciphertext. Only the browser that made the subscription holds the private
 * key that opens the message.
 */

import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/** The server's VAPID key pair, base64url: the uncompressed P-256 point browsers take, and the 32-byte private value. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Where one browser takes its messages, and its keys for them (PushSubscription.toJSON() in the browser). */
export interface PushTarget {
  endpoint: string;
  /** The browser's P-256 public key, base64url. */
  p256dh: string;
  /** The browser's 16-byte authentication secret, base64url. */
  auth: string;
}

export type Urgency = 'very-low' | 'low' | 'normal' | 'high';

/** What a send came to: delivered to the push service, the subscription is gone (404 or 410), or anything else. */
export type SendResult = 'sent' | 'gone' | 'failed';

/** Records are one size: the whole message is a single record of at most this many bytes. */
const RECORD_SIZE = 4096;
/** salt (16) + record size (4) + key id length (1) + the server's one-off public key (65). */
const HEADER_SIZE = 86;
/** The most a message can say: one record, less its header, the delimiter byte and the 16-byte tag (RFC 8291, section 4). */
export const MAX_PLAINTEXT = RECORD_SIZE - HEADER_SIZE - 1 - 16;

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

/** Pads a big-endian number to `size` bytes (a private value with leading zero bytes can come back short). */
function padded(b: Buffer, size: number): Buffer {
  return b.length >= size ? b : Buffer.concat([Buffer.alloc(size - b.length), b]);
}

/** A new VAPID key pair. */
export function newVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(padded(ecdh.getPrivateKey(), 32)) };
}

/** The signing key for a VAPID key pair. */
export function vapidSigningKey(keys: VapidKeys): KeyObject {
  const pub = unb64(keys.publicKey);
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) }, format: 'jwk' });
}

/**
 * The signed claim (a JWT, ES256) that this server sends to `audience`, the
 * push service's origin, until `expires` (seconds since 1970; at most a day
 * ahead). `subject` is how the push service can reach whoever runs the server:
 * a mailto: or https: address.
 */
export function vapidToken(audience: string, subject: string, expires: number, key: KeyObject): string {
  const head = b64(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64(Buffer.from(JSON.stringify({ aud: audience, exp: expires, sub: subject })));
  // JWTs carry the two 32-byte numbers of an ECDSA signature side by side, not wrapped in DER.
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64(signature)}`;
}

/** The Authorization header that carries a VAPID token (RFC 8292, section 3). */
export const vapidAuthorization = (token: string, publicKey: string) => `vapid t=${token}, k=${publicKey}`;

/** True when the browser's keys are the right size and its public key is a point on the curve. */
export function validKeys(target: Pick<PushTarget, 'p256dh' | 'auth'>): boolean {
  const pub = unb64(target.p256dh);
  if (pub.length !== 65 || pub[0] !== 4 || unb64(target.auth).length !== 16) return false;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(pub);
    return true;
  } catch {
    return false;
  }
}

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer | string, length: number) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

/**
 * Encrypts a message for one browser (RFC 8291). A fresh key pair and salt
 * are made for every message; `fixed` gives them instead, for the RFC's own
 * example.
 */
export function encryptPayload(plaintext: Buffer, target: Pick<PushTarget, 'p256dh' | 'auth'>, fixed?: { salt: Buffer; privateKey: Buffer }): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`a push message holds at most ${MAX_PLAINTEXT} bytes`);
  const uaPublic = unb64(target.p256dh);
  const authSecret = unb64(target.auth);
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixed?.salt ?? randomBytes(16);
  // RFC 8291, section 3.4: the shared secret, mixed with the browser's auth secret and both public keys, then
  // RFC 8188, section 2.2: the content key and nonce from the salt.
  const ikm = hkdf(authSecret, ecdh.computeSecret(uaPublic), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const key = hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  // One record, so it is the last: the delimiter is 2, with no padding after it.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

/**
 * The push services alerts are sent to: Google (Chrome, Android and most
 * other Chromium browsers), Mozilla (Firefox), Apple (Safari) and Microsoft
 * (Edge). A subscription anywhere else is refused, so the server never posts
 * to an address someone typed in.
 */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com'];
const PUSH_DOMAINS = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];

/** The push service's host for a subscription address, or null when it is not one of the services above. */
export function pushService(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.includes(host) || PUSH_DOMAINS.some((d) => host.endsWith(d)) ? host : null;
}

export interface SendOptions {
  /** How long the push service may hold the message for a device that is off, in seconds. */
  ttl: number;
  urgency: Urgency;
  /** The Authorization header (vapidAuthorization). */
  authorization: string;
  /** A push service that hasn't answered by then is given up on. */
  timeoutMs: number;
  fetch?: typeof fetch;
}

/** Posts an encrypted message to one browser's push service (RFC 8030). Never throws. */
export async function sendPush(target: PushTarget, body: Buffer, opts: SendOptions): Promise<{ result: SendResult; status: number }> {
  try {
    const res = await (opts.fetch ?? fetch)(target.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(Math.max(0, Math.floor(opts.ttl))),
        Urgency: opts.urgency,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: opts.authorization,
      },
      body: new Uint8Array(body),
      // A push service answers itself; a redirect could point anywhere.
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    // The answer's body says nothing we use; reading it frees the connection.
    await res.arrayBuffer().catch(() => {});
    if (res.ok) return { result: 'sent', status: res.status };
    return { result: res.status === 404 || res.status === 410 ? 'gone' : 'failed', status: res.status };
  } catch {
    return { result: 'failed', status: 0 };
  }
}
