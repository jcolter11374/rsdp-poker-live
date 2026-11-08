/**
 * The Web Push protocol (push/webpush.ts) against the examples published in
 * the RFCs, so the encryption and the signed claim are what every browser and
 * push service expects, without a library.
 */

import { describe, expect, it } from 'vitest';
import { decrypt, verifies } from './push-helpers';
import { encryptPayload, MAX_PLAINTEXT, newVapidKeys, pushService, sendPush, validKeys, vapidAuthorization, vapidSigningKey, vapidToken } from '../src/push/webpush';

const unb64 = (s: string) => Buffer.from(s, 'base64url');

/** RFC 8291, Appendix A: "Intermediate Values for Encryption". */
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** RFC 8292, section 2.4: an example token and the public key it was signed with. */
const RFC8292 = {
  token:
    'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA',
  publicKey: 'BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs',
};

describe('message encryption (RFC 8291)', () => {
  it("gives the RFC's own example byte for byte", () => {
    const body = encryptPayload(Buffer.from(RFC8291.plaintext), { p256dh: RFC8291.uaPublic, auth: RFC8291.auth }, { salt: unb64(RFC8291.salt), privateKey: unb64(RFC8291.asPrivate) });
    expect(body.toString('base64url')).toBe(RFC8291.body);
  });

  it("opens the RFC's example with the browser's private key", () => {
    expect(decrypt(unb64(RFC8291.body), RFC8291.uaPrivate, RFC8291.auth)).toBe(RFC8291.plaintext);
  });

  it('uses a fresh key and salt for every message, which the browser can still open', () => {
    const target = { p256dh: RFC8291.uaPublic, auth: RFC8291.auth };
    const a = encryptPayload(Buffer.from('{"title":"Your turn"}'), target);
    const b = encryptPayload(Buffer.from('{"title":"Your turn"}'), target);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
    expect(decrypt(a, RFC8291.uaPrivate, RFC8291.auth)).toBe('{"title":"Your turn"}');
    expect(decrypt(b, RFC8291.uaPrivate, RFC8291.auth)).toBe('{"title":"Your turn"}');
  });

  it('refuses a message too long for one record', () => {
    const target = { p256dh: RFC8291.uaPublic, auth: RFC8291.auth };
    expect(encryptPayload(Buffer.alloc(MAX_PLAINTEXT, 'a'), target).length).toBe(4096);
    expect(() => encryptPayload(Buffer.alloc(MAX_PLAINTEXT + 1, 'a'), target)).toThrow(/at most/);
  });

  it("checks a browser's keys before they are kept", () => {
    expect(validKeys({ p256dh: RFC8291.uaPublic, auth: RFC8291.auth })).toBe(true);
    expect(validKeys({ p256dh: RFC8291.uaPublic, auth: 'c2hvcnQ' })).toBe(false);
    // The right length, but not a point on the curve.
    const off = unb64(RFC8291.uaPublic);
    off[64] ^= 1;
    expect(validKeys({ p256dh: off.toString('base64url'), auth: RFC8291.auth })).toBe(false);
    expect(validKeys({ p256dh: 'BAAA', auth: RFC8291.auth })).toBe(false);
  });
});

describe('the signed claim (VAPID, RFC 8292)', () => {
  it("checks out the RFC's example token, the way a push service does", () => {
    expect(verifies(RFC8292.token, RFC8292.publicKey)).toBe(true);
    const tampered = RFC8292.token.replace('.eyJ', '.eyK');
    expect(verifies(tampered, RFC8292.publicKey)).toBe(false);
  });

  it("writes the RFC's header and claims exactly, signed with the server's key", () => {
    const keys = newVapidKeys();
    const token = vapidToken('https://push.example.net', 'mailto:push@example.com', 1453523768, vapidSigningKey(keys));
    const [head, body] = token.split('.');
    const [rfcHead, rfcBody] = RFC8292.token.split('.');
    expect(head).toBe(rfcHead);
    expect(body).toBe(rfcBody);
    expect(verifies(token, keys.publicKey)).toBe(true);
    expect(verifies(token, RFC8292.publicKey)).toBe(false);
    expect(vapidAuthorization(token, keys.publicKey)).toBe(`vapid t=${token}, k=${keys.publicKey}`);
  });

  it('makes keys a browser accepts: an uncompressed P-256 point and a 32-byte private value', () => {
    for (let i = 0; i < 20; i++) {
      const keys = newVapidKeys();
      expect(unb64(keys.publicKey)).toHaveLength(65);
      expect(unb64(keys.publicKey)[0]).toBe(4);
      expect(unb64(keys.privateKey)).toHaveLength(32);
    }
  });
});

describe('push services', () => {
  it('sends only to the browsers’ own push services, over https', () => {
    expect(pushService('https://fcm.googleapis.com/fcm/send/abc')).toBe('fcm.googleapis.com');
    expect(pushService('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe('updates.push.services.mozilla.com');
    expect(pushService('https://web.push.apple.com/QK7abc')).toBe('web.push.apple.com');
    expect(pushService('https://wns2-par02p.notify.windows.com/w/?token=abc')).toBe('wns2-par02p.notify.windows.com');
    expect(pushService('http://fcm.googleapis.com/fcm/send/abc')).toBeNull();
    expect(pushService('https://fcm.googleapis.com:8443/fcm/send/abc')).toBeNull();
    expect(pushService('https://user:pw@fcm.googleapis.com/x')).toBeNull();
    expect(pushService('https://evil.example/fcm.googleapis.com')).toBeNull();
    expect(pushService('https://fcm.googleapis.com.evil.example/x')).toBeNull();
    expect(pushService('https://pushpush.apple.com/x')).toBeNull();
    expect(pushService('https://127.0.0.1/x')).toBeNull();
    expect(pushService('not a url')).toBeNull();
  });

  it('posts the encrypted message with the headers RFC 8030 asks for, and reads 404 and 410 as gone', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 201;
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: RFC8291.uaPublic, auth: RFC8291.auth };
    const opts = { ttl: 60, urgency: 'high' as const, authorization: 'vapid t=a.b.c, k=K', timeoutMs: 1000, fetch: fake };
    expect(await sendPush(target, Buffer.from('x'), opts)).toEqual({ result: 'sent', status: 201 });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe(target.endpoint);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.redirect).toBe('error');
    expect(headers).toMatchObject({ TTL: '60', Urgency: 'high', 'Content-Encoding': 'aes128gcm', Authorization: 'vapid t=a.b.c, k=K' });
    for (const [code, result] of [[404, 'gone'], [410, 'gone'], [400, 'failed'], [413, 'failed'], [429, 'failed'], [500, 'failed']] as const) {
      status = code;
      expect(await sendPush(target, Buffer.from('x'), opts)).toEqual({ result, status: code });
    }
  });

  it('gives up on a push service that does not answer in time', async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: RFC8291.uaPublic, auth: RFC8291.auth };
    const started = Date.now();
    expect(await sendPush(target, Buffer.from('x'), { ttl: 60, urgency: 'high', authorization: 'x', timeoutMs: 50, fetch: hang })).toEqual({ result: 'failed', status: 0 });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
