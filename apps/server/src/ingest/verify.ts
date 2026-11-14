// Inbound signature verification (design §7.2), always over the RAW request bytes.
//
// Two schemes, configured per endpoint:
//   hmac               HMAC-SHA256(secret, body) in a header, hex or base64, optional prefix
//                      (GitHub: header x-hub-signature-256, prefix "sha256=", hex).
//   standard_webhooks  webhook-id / webhook-timestamp / webhook-signature headers,
//                      signed content "{id}.{timestamp}.{body}", whsec_ secret, 300 s tolerance.
//
// Comparisons use crypto.timingSafeEqual, which takes the same time wherever the first
// differing byte is, so an attacker can't recover the expected MAC byte by byte from response
// timing. It throws on buffers of different lengths, hence the explicit length check first
// (the length of a SHA-256 MAC is public anyway: 32 bytes).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VerifyEncoding } from '../db/schema.ts';

export const SIGNATURE_FAILURE_REASONS = [
  'missing_header',
  'malformed',
  'mismatch',
  'timestamp_out_of_tolerance',
] as const;
export type SignatureFailureReason = (typeof SIGNATURE_FAILURE_REASONS)[number];

export type VerifyResult = { ok: true } | { ok: false; reason: SignatureFailureReason };

export type VerifyConfig =
  | {
      scheme: 'hmac';
      header: string;
      prefix: string | null;
      encoding: VerifyEncoding;
      secret: string;
    }
  | { scheme: 'standard_webhooks'; secret: string };

type Headers = Record<string, string | string[] | undefined>;

export const STANDARD_WEBHOOKS_TOLERANCE_S = 300;
const MAC_BYTES = 32; // SHA-256
const HEX = /^[0-9a-fA-F]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const WHSEC = 'whsec_';

const fail = (reason: SignatureFailureReason): VerifyResult => ({ ok: false, reason });

/** Constant-time comparison of two MACs; different lengths are simply "not equal". */
export function macEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** One header value. Repeated headers are ambiguous for a signature → treated as malformed. */
function single(headers: Headers, name: string): string | undefined | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return null;
  return value === undefined || value === '' ? undefined : value;
}

function decode(value: string, encoding: VerifyEncoding): Buffer | null {
  if (encoding === 'hex') {
    return HEX.test(value) && value.length % 2 === 0 ? Buffer.from(value, 'hex') : null;
  }
  return BASE64.test(value) ? Buffer.from(value, 'base64') : null;
}

export function verifyHmac(
  config: Extract<VerifyConfig, { scheme: 'hmac' }>,
  headers: Headers,
  body: Buffer,
): VerifyResult {
  const raw = single(headers, config.header);
  if (raw === undefined) return fail('missing_header');
  if (raw === null) return fail('malformed');
  const value = raw.trim();
  if (config.prefix && !value.startsWith(config.prefix)) return fail('malformed');
  const given = decode(value.slice(config.prefix?.length ?? 0), config.encoding);
  if (!given || given.length === 0) return fail('malformed');

  const expected = createHmac('sha256', config.secret).update(body).digest();
  return macEquals(given, expected) ? { ok: true } : fail('mismatch');
}

export function verifyStandardWebhooks(
  config: Extract<VerifyConfig, { scheme: 'standard_webhooks' }>,
  headers: Headers,
  body: Buffer,
  nowSeconds: number,
): VerifyResult {
  const id = single(headers, 'webhook-id');
  const timestamp = single(headers, 'webhook-timestamp');
  const signatures = single(headers, 'webhook-signature');
  if (id === undefined || timestamp === undefined || signatures === undefined) {
    return fail('missing_header');
  }
  if (id === null || timestamp === null || signatures === null) return fail('malformed');
  if (!/^\d{1,12}$/.test(timestamp)) return fail('malformed');

  // Space-separated "v1,<base64>" entries (several during the sender's key rotation).
  // Unknown versions are skipped, as the spec allows; none usable → malformed.
  const candidates: Buffer[] = [];
  for (const entry of signatures.split(' ')) {
    const [version, sig] = entry.split(',', 2);
    if (version !== 'v1' || !sig || !BASE64.test(sig)) continue;
    candidates.push(Buffer.from(sig, 'base64'));
  }
  if (candidates.length === 0) return fail('malformed');

  // Replay protection: an old (captured) request is rejected even with a valid signature.
  if (Math.abs(nowSeconds - Number(timestamp)) > STANDARD_WEBHOOKS_TOLERANCE_S) {
    return fail('timestamp_out_of_tolerance');
  }

  const key = Buffer.from(config.secret.slice(WHSEC.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest();
  // Check every candidate (no early exit) so timing doesn't reveal which one matched.
  let matched = false;
  for (const candidate of candidates) {
    if (candidate.length === MAC_BYTES && macEquals(candidate, expected)) matched = true;
  }
  return matched ? { ok: true } : fail('mismatch');
}

export function verifySignature(
  config: VerifyConfig,
  headers: Headers,
  body: Buffer,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  return config.scheme === 'hmac'
    ? verifyHmac(config, headers, body)
    : verifyStandardWebhooks(config, headers, body, nowSeconds);
}

/** Validates a standard_webhooks secret: "whsec_" + base64 of at least 16 bytes. */
export function isValidStandardWebhooksSecret(secret: string): boolean {
  if (!secret.startsWith(WHSEC)) return false;
  const rest = secret.slice(WHSEC.length);
  return BASE64.test(rest) && Buffer.from(rest, 'base64').length >= 16;
}
