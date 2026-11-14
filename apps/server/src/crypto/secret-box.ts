// Encryption at rest for secrets the app must read back (design §7.4): inbound verification
// secrets and outbound signing secrets. (Passwords, session tokens and API key secrets are
// HASHED instead — they are only ever compared, never read back.)
//
// AES-256-GCM, a random 12-byte IV per value, stored as
//   v1:<keyId>:<iv>:<ciphertext>:<tag>            (base64url parts)
// AAD = "<table>.<column>.<rowId>": the ciphertext is bound to the cell it was written to.
// Copying a sealed value into another row or column (e.g. with SQL access) makes open()
// fail instead of handing that secret to a different tenant's endpoint.
//
// Keyring for rotation: ENCRYPTION_KEYS="k2:<base64 32 bytes>,k1:<base64 32 bytes>" and
// ENCRYPTION_ACTIVE_KEY_ID=k2. New values use the active key; old values still open with the
// key named in their own prefix, so keys can be rotated without a big-bang re-encryption.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Identifies where a sealed value lives; becomes the AAD so values can't be moved between rows. */
export type SecretRef = { table: string; column: string; rowId: string };

export type SecretBox = {
  seal: (plaintext: string, ref: SecretRef) => string;
  open: (sealed: string, ref: SecretRef) => string;
};

export type Keyring = { keys: ReadonlyMap<string, Buffer>; activeKeyId: string };

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // the GCM standard nonce size
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class KeyringError extends Error {
  override name = 'KeyringError';
}

/**
 * Parses ENCRYPTION_KEYS / ENCRYPTION_ACTIVE_KEY_ID. Errors name the key id or position,
 * never the key material.
 */
export function parseKeyring(keysVar: string, activeKeyId: string): Keyring {
  const keys = new Map<string, Buffer>();
  const entries = keysVar
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new KeyringError('ENCRYPTION_KEYS has no keys');
  for (const [index, entry] of entries.entries()) {
    const colon = entry.indexOf(':');
    const id = colon === -1 ? '' : entry.slice(0, colon);
    const material = colon === -1 ? '' : entry.slice(colon + 1);
    if (!KEY_ID.test(id)) {
      throw new KeyringError(`ENCRYPTION_KEYS entry ${index + 1}: expected "<keyId>:<base64 key>"`);
    }
    const key = BASE64.test(material) ? Buffer.from(material, 'base64') : Buffer.alloc(0);
    if (key.length !== KEY_BYTES) {
      throw new KeyringError(`ENCRYPTION_KEYS key "${id}": must be ${KEY_BYTES} bytes, base64`);
    }
    if (keys.has(id)) throw new KeyringError(`ENCRYPTION_KEYS key "${id}": duplicate id`);
    keys.set(id, key);
  }
  if (!keys.has(activeKeyId)) {
    throw new KeyringError('ENCRYPTION_ACTIVE_KEY_ID must name a key in ENCRYPTION_KEYS');
  }
  return { keys, activeKeyId };
}

/** A new random key in ENCRYPTION_KEYS format (for setup scripts and tests). */
export function generateKeyEntry(id: string): string {
  return `${id}:${randomBytes(KEY_BYTES).toString('base64')}`;
}

const aad = (ref: SecretRef) => Buffer.from(`${ref.table}.${ref.column}.${ref.rowId}`, 'utf8');
const b64u = (b: Buffer) => b.toString('base64url');

export function createAesGcmBox(keyring: Keyring): SecretBox {
  return {
    seal(plaintext, ref) {
      const key = keyring.keys.get(keyring.activeKeyId)!;
      const iv = randomBytes(IV_BYTES); // never reused with the same key: random per value
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad(ref));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ['v1', keyring.activeKeyId, b64u(iv), b64u(ciphertext), b64u(tag)].join(':');
    },
    open(sealed, ref) {
      const parts = sealed.split(':');
      if (parts.length !== 5 || parts[0] !== 'v1') {
        throw new Error('unsupported sealed secret format');
      }
      const [, keyId = '', ivPart = '', ctPart = '', tagPart = ''] = parts;
      const key = keyring.keys.get(keyId);
      if (!key) throw new Error(`sealed secret uses unknown key id "${keyId}"`);
      const iv = Buffer.from(ivPart, 'base64url');
      const tag = Buffer.from(tagPart, 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new Error('sealed secret is malformed');
      }
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(ref));
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([
          decipher.update(Buffer.from(ctPart, 'base64url')),
          decipher.final(), // throws if the tag doesn't match: tampered, moved, or wrong key
        ]).toString('utf8');
      } catch {
        throw new Error('sealed secret failed authentication');
      }
    },
  };
}

/** Placeholder until a real box is configured: refuses to seal or open anything. */
export const unconfiguredBox: SecretBox = {
  seal: () => {
    throw new Error('secret encryption is not configured');
  },
  open: () => {
    throw new Error('secret encryption is not configured');
  },
};
