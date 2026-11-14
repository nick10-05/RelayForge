// Outbound signatures (design §7.2): the Standard Webhooks algorithm under X-RelayForge-* names.
//   signed content = "{id}.{timestamp}.{raw body}"
//   signature      = "v1," + base64(HMAC-SHA256(key, signed content))
//   key            = base64-decoded part of the "whsec_..." secret
// During a rotation window the header carries one signature per secret, space-separated,
// so receivers can switch secrets without dropping messages.
import { createHmac, randomBytes } from 'node:crypto';

const PREFIX = 'whsec_';
/** How long the previous secret keeps signing after a rotation. */
export const ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export function generateSigningSecret(): string {
  return `${PREFIX}${randomBytes(24).toString('base64')}`;
}

function keyBytes(secret: string): Buffer {
  if (!secret.startsWith(PREFIX)) throw new Error('signing secret must start with whsec_');
  return Buffer.from(secret.slice(PREFIX.length), 'base64');
}

export function sign(input: {
  id: string;
  timestamp: number;
  body: Buffer;
  secret: string;
}): string {
  const mac = createHmac('sha256', keyBytes(input.secret));
  mac.update(`${input.id}.${input.timestamp}.`);
  mac.update(input.body); // raw bytes, never re-serialised
  return `v1,${mac.digest('base64')}`;
}

/** Header values for one attempt. `timestamp` is unix seconds, set per attempt. */
export function signatureHeaders(input: {
  id: string;
  timestamp: number;
  body: Buffer;
  secrets: string[];
}): { 'x-relayforge-timestamp': string; 'x-relayforge-signature': string } {
  const signatures = input.secrets.map((secret) => sign({ ...input, secret }));
  return {
    'x-relayforge-timestamp': String(input.timestamp),
    'x-relayforge-signature': signatures.join(' '),
  };
}
