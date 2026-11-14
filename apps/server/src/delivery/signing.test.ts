import { Webhook } from 'standardwebhooks';
import { describe, expect, test } from 'vitest';
import { generateSigningSecret, sign, signatureHeaders } from './signing.ts';

// Vector from the Standard Webhooks reference test-suite.
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: Buffer.from('{"test": 2432232314}'),
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

/** Feeds our X-RelayForge-* headers to the reference library under its webhook-* names. */
function verifyWithLibrary(
  secret: string,
  body: Buffer,
  headers: { id: string; timestamp: string; signature: string },
) {
  return new Webhook(secret).verify(body, {
    'webhook-id': headers.id,
    'webhook-timestamp': headers.timestamp,
    'webhook-signature': headers.signature,
  });
}

describe('outbound signing (Standard Webhooks)', () => {
  test('matches the reference vector', () => {
    expect(sign(VECTOR)).toBe(VECTOR.signature);
  });

  test('matches the reference library for non-ASCII JSON', () => {
    const secret = generateSigningSecret();
    // The library decodes bodies as UTF-8 text, so the cross-check uses valid UTF-8 here.
    const body = Buffer.from('{"price":"€5","emoji":"🚀"}');
    const at = new Date(1_700_000_000_000);
    const expected = new Webhook(secret).sign('evt_1', at, body);
    expect(sign({ id: 'evt_1', timestamp: 1_700_000_000, body, secret })).toBe(expected);
  });

  test('a receiver using the reference library verifies our headers', () => {
    const secret = generateSigningSecret();
    const body = Buffer.from('{"ok":true}');
    const timestamp = Math.floor(Date.now() / 1000);
    const h = signatureHeaders({ id: 'evt_42', timestamp, body, secrets: [secret] });
    expect(() =>
      verifyWithLibrary(secret, body, {
        id: 'evt_42',
        timestamp: h['x-relayforge-timestamp'],
        signature: h['x-relayforge-signature'],
      }),
    ).not.toThrow();
  });

  test('rotation window: two space-separated signatures, either secret verifies', () => {
    const current = generateSigningSecret();
    const previous = generateSigningSecret();
    const body = Buffer.from('{"n":1}');
    const timestamp = Math.floor(Date.now() / 1000);
    const h = signatureHeaders({ id: 'evt_9', timestamp, body, secrets: [current, previous] });
    const parts = h['x-relayforge-signature'].split(' ');
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.startsWith('v1,'))).toBe(true);
    for (const secret of [current, previous]) {
      expect(() =>
        verifyWithLibrary(secret, body, {
          id: 'evt_9',
          timestamp: h['x-relayforge-timestamp'],
          signature: h['x-relayforge-signature'],
        }),
      ).not.toThrow();
    }
    // A third, unrelated secret is rejected.
    expect(() =>
      verifyWithLibrary(generateSigningSecret(), body, {
        id: 'evt_9',
        timestamp: h['x-relayforge-timestamp'],
        signature: h['x-relayforge-signature'],
      }),
    ).toThrow();
  });

  test('a tampered body or id fails verification', () => {
    const secret = generateSigningSecret();
    const timestamp = Math.floor(Date.now() / 1000);
    const h = signatureHeaders({ id: 'a', timestamp, body: Buffer.from('x'), secrets: [secret] });
    const headers = {
      id: 'a',
      timestamp: h['x-relayforge-timestamp'],
      signature: h['x-relayforge-signature'],
    };
    expect(() => verifyWithLibrary(secret, Buffer.from('y'), headers)).toThrow();
    expect(() => verifyWithLibrary(secret, Buffer.from('x'), { ...headers, id: 'b' })).toThrow();
  });

  test('generated secrets are whsec_ + 24 random bytes', () => {
    const a = generateSigningSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(Buffer.from(a.slice(6), 'base64')).toHaveLength(24);
    expect(generateSigningSecret()).not.toBe(a);
  });

  test('rejects secrets without the whsec_ prefix', () => {
    expect(() =>
      sign({ id: 'x', timestamp: 1, body: Buffer.alloc(0), secret: 'not-a-secret' }),
    ).toThrow('whsec_');
  });
});
