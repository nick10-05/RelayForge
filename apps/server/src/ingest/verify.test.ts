import { createHmac } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { describe, expect, test } from 'vitest';
import { generateSigningSecret } from '../delivery/signing.ts';
import {
  isValidStandardWebhooksSecret,
  macEquals,
  verifyHmac,
  verifySignature,
  verifyStandardWebhooks,
} from './verify.ts';

const body = Buffer.from('{"action":"opened", "n": 1}\n');
const SECRET = 'gh-secret-123';
const hmacHex = (b: Buffer, secret = SECRET) =>
  createHmac('sha256', secret).update(b).digest('hex');
const hmacB64 = (b: Buffer, secret = SECRET) =>
  createHmac('sha256', secret).update(b).digest('base64');

describe('hmac scheme', () => {
  const github = {
    scheme: 'hmac',
    header: 'x-hub-signature-256',
    prefix: 'sha256=',
    encoding: 'hex',
    secret: SECRET,
  } as const;
  const shopify = {
    scheme: 'hmac',
    header: 'x-shopify-hmac-sha256',
    prefix: null,
    encoding: 'base64',
    secret: SECRET,
  } as const;

  test('hex with prefix (GitHub style) → ok; uppercase hex accepted', () => {
    expect(verifyHmac(github, { 'x-hub-signature-256': `sha256=${hmacHex(body)}` }, body)).toEqual({
      ok: true,
    });
    expect(
      verifyHmac(github, { 'x-hub-signature-256': `sha256=${hmacHex(body).toUpperCase()}` }, body),
    ).toEqual({ ok: true });
  });

  test('base64 without prefix (Shopify style) → ok', () => {
    expect(verifyHmac(shopify, { 'x-shopify-hmac-sha256': hmacB64(body) }, body)).toEqual({
      ok: true,
    });
  });

  test('raw bytes: one changed byte, re-serialised JSON or a wrong secret → mismatch', () => {
    const sig = `sha256=${hmacHex(body)}`;
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString())));
    expect(verifyHmac(github, { 'x-hub-signature-256': sig }, reserialised)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    const flipped = Buffer.from(body);
    flipped[0] = flipped[0]! ^ 1;
    expect(verifyHmac(github, { 'x-hub-signature-256': sig }, flipped)).toMatchObject({
      reason: 'mismatch',
    });
    expect(
      verifyHmac(github, { 'x-hub-signature-256': `sha256=${hmacHex(body, 'other')}` }, body),
    ).toMatchObject({ reason: 'mismatch' });
  });

  test('wrong length (truncated MAC) → mismatch, without throwing', () => {
    const short = `sha256=${hmacHex(body).slice(0, 40)}`;
    expect(verifyHmac(github, { 'x-hub-signature-256': short }, body)).toMatchObject({
      reason: 'mismatch',
    });
  });

  test.each([
    [{}, 'missing_header'],
    [{ 'x-hub-signature-256': '' }, 'missing_header'],
    [{ 'x-hub-signature-256': hmacHex(body) }, 'malformed'], // prefix missing
    [{ 'x-hub-signature-256': 'sha256=zzzz' }, 'malformed'], // not hex
    [{ 'x-hub-signature-256': 'sha256=abc' }, 'malformed'], // odd length
    [{ 'x-hub-signature-256': 'sha256=' }, 'malformed'],
    [{ 'x-hub-signature-256': ['sha256=aa', 'sha256=bb'] }, 'malformed'], // repeated header
  ])('%j → %s', (headers, reason) => {
    expect(verifyHmac(github, headers, body)).toEqual({ ok: false, reason });
  });

  test('base64 encoding rejects non-base64', () => {
    expect(verifyHmac(shopify, { 'x-shopify-hmac-sha256': 'not base64!' }, body)).toMatchObject({
      reason: 'malformed',
    });
  });
});

describe('standard_webhooks scheme', () => {
  const secret = generateSigningSecret(); // whsec_<base64>
  const config = { scheme: 'standard_webhooks', secret } as const;
  const now = 1_800_000_000;
  const signed = (ts = now, id = 'msg_1', b = body) => {
    const sig = new Webhook(secret).sign(id, new Date(ts * 1000), b.toString());
    return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sig };
  };

  test('a signature from the reference library verifies', () => {
    expect(verifyStandardWebhooks(config, signed(), body, now)).toEqual({ ok: true });
  });

  test('several signatures (sender rotating keys): any valid one is enough', () => {
    const headers = signed();
    const other = new Webhook(generateSigningSecret()).sign('msg_1', new Date(now * 1000), '{}');
    headers['webhook-signature'] = `${other} v2,ignored ${headers['webhook-signature']}`;
    expect(verifyStandardWebhooks(config, headers, body, now)).toEqual({ ok: true });
  });

  test('300 s tolerance in both directions', () => {
    expect(verifyStandardWebhooks(config, signed(now - 300), body, now)).toEqual({ ok: true });
    expect(verifyStandardWebhooks(config, signed(now + 300), body, now)).toEqual({ ok: true });
    expect(verifyStandardWebhooks(config, signed(now - 301), body, now)).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
    expect(verifyStandardWebhooks(config, signed(now + 301), body, now)).toMatchObject({
      reason: 'timestamp_out_of_tolerance',
    });
  });

  test('id and timestamp are signed: changing either → mismatch', () => {
    const headers = signed();
    expect(
      verifyStandardWebhooks(config, { ...headers, 'webhook-id': 'msg_2' }, body, now),
    ).toMatchObject({ reason: 'mismatch' });
    expect(
      verifyStandardWebhooks(
        config,
        { ...headers, 'webhook-timestamp': String(now + 1) },
        body,
        now,
      ),
    ).toMatchObject({ reason: 'mismatch' });
    expect(
      verifyStandardWebhooks(config, headers, Buffer.concat([body, Buffer.from(' ')]), now),
    ).toMatchObject({ reason: 'mismatch' });
  });

  test.each([
    [{ 'webhook-timestamp': '1', 'webhook-signature': 'v1,AA==' }, 'missing_header'],
    [{ 'webhook-id': 'x', 'webhook-signature': 'v1,AA==' }, 'missing_header'],
    [{ 'webhook-id': 'x', 'webhook-timestamp': '1' }, 'missing_header'],
    [
      { 'webhook-id': 'x', 'webhook-timestamp': 'soon', 'webhook-signature': 'v1,AA==' },
      'malformed',
    ],
    [{ 'webhook-id': 'x', 'webhook-timestamp': '1', 'webhook-signature': 'abc' }, 'malformed'],
    [{ 'webhook-id': 'x', 'webhook-timestamp': '1', 'webhook-signature': 'v2,AA==' }, 'malformed'],
  ])('%j → %s', (headers, reason) => {
    expect(verifyStandardWebhooks(config, headers, body, now)).toEqual({ ok: false, reason });
  });

  test('the outbound signer and the inbound verifier agree (round trip)', async () => {
    const { signatureHeaders } = await import('../delivery/signing.ts');
    const out = signatureHeaders({ id: 'evt_1', timestamp: now, body, secrets: [secret] });
    const headers = {
      'webhook-id': 'evt_1',
      'webhook-timestamp': out['x-relayforge-timestamp'],
      'webhook-signature': out['x-relayforge-signature'],
    };
    expect(verifySignature(config, headers, body, now)).toEqual({ ok: true });
  });
});

describe('helpers', () => {
  test('macEquals: different lengths are unequal, not an exception', () => {
    expect(macEquals(Buffer.from('ab'), Buffer.from('abc'))).toBe(false);
    expect(macEquals(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
  });

  test('isValidStandardWebhooksSecret', () => {
    expect(isValidStandardWebhooksSecret(generateSigningSecret())).toBe(true);
    expect(isValidStandardWebhooksSecret('whsec_')).toBe(false);
    expect(isValidStandardWebhooksSecret('whsec_c2hvcnQ=')).toBe(false); // 5 bytes
    expect(isValidStandardWebhooksSecret('secret')).toBe(false);
  });
});
