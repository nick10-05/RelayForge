import { describe, expect, test } from 'vitest';
import {
  dedupePayload,
  describeVerification,
  verificationForm,
  verificationPayload,
} from './inbound-settings.ts';
import type { VerificationForm } from './inbound-settings.ts';

const form = (patch: Partial<VerificationForm>): VerificationForm => ({
  scheme: 'hmac',
  header: 'X-Hub-Signature-256',
  prefix: 'sha256=',
  encoding: 'hex',
  secret: ' s3cret ',
  ...patch,
});

describe('verificationPayload', () => {
  test('off needs nothing else (no secret)', () => {
    expect(verificationPayload(form({ scheme: 'none', secret: '' }))).toEqual({ scheme: 'none' });
  });

  test('HMAC: header lower-cased, secret trimmed, empty prefix becomes null', () => {
    expect(verificationPayload(form({}))).toEqual({
      scheme: 'hmac',
      header: 'x-hub-signature-256',
      prefix: 'sha256=',
      encoding: 'hex',
      secret: 's3cret',
    });
    expect(verificationPayload(form({ prefix: '' }))).toMatchObject({ prefix: null });
  });

  test('HMAC: secret and a valid header are required', () => {
    expect(verificationPayload(form({ secret: '  ' }))).toMatch(/signing secret/);
    expect(verificationPayload(form({ header: '' }))).toMatch(/header/);
    expect(verificationPayload(form({ header: 'bad header' }))).toMatch(/not a valid/);
  });

  test('Standard Webhooks: whsec_ secret only', () => {
    expect(verificationPayload(form({ scheme: 'standard_webhooks', secret: 'whsec_abc' }))).toEqual(
      { scheme: 'standard_webhooks', secret: 'whsec_abc' },
    );
    expect(verificationPayload(form({ scheme: 'standard_webhooks', secret: 'abc' }))).toMatch(
      /whsec_/,
    );
  });
});

describe('verificationForm / describeVerification', () => {
  const current = {
    scheme: 'hmac' as const,
    header: 'x-hub-signature-256',
    prefix: 'sha256=',
    encoding: 'hex' as const,
    hasSecret: true,
  };

  test('the form starts from the saved config, with an empty secret', () => {
    expect(verificationForm(current)).toEqual({
      scheme: 'hmac',
      header: 'x-hub-signature-256',
      prefix: 'sha256=',
      encoding: 'hex',
      secret: '',
    });
    const off = {
      scheme: 'none' as const,
      header: null,
      prefix: null,
      encoding: null,
      hasSecret: false,
    };
    expect(verificationForm(off)).toMatchObject({ header: '', prefix: '', encoding: 'hex' });
  });

  test('describes each scheme without revealing anything secret', () => {
    expect(describeVerification(current)).toBe(
      'HMAC-SHA256 in "x-hub-signature-256", prefix "sha256=", hex · secret set',
    );
    expect(
      describeVerification({
        scheme: 'none',
        header: null,
        prefix: null,
        encoding: null,
        hasSecret: false,
      }),
    ).toMatch(/^Off/);
  });
});

describe('dedupePayload', () => {
  test('off clears the name; header is lower-cased; JSON field kept as typed', () => {
    expect(dedupePayload({ source: 'none', name: 'x' })).toEqual({
      dedupeSource: 'none',
      dedupeName: null,
    });
    expect(dedupePayload({ source: 'header', name: ' X-GitHub-Delivery ' })).toEqual({
      dedupeSource: 'header',
      dedupeName: 'x-github-delivery',
    });
    expect(dedupePayload({ source: 'json_field', name: 'eventId' })).toEqual({
      dedupeSource: 'json_field',
      dedupeName: 'eventId',
    });
  });

  test('a name is required, and a header name must be valid', () => {
    expect(dedupePayload({ source: 'header', name: '' })).toMatch(/header/);
    expect(dedupePayload({ source: 'json_field', name: ' ' })).toMatch(/JSON field/);
    expect(dedupePayload({ source: 'header', name: 'a b' })).toMatch(/not a valid/);
  });
});
