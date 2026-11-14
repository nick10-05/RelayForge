// Sealing for secrets stored in the database (design §7.4).
//
// TEMPORARY (Day 6): `plaintextBox` only encodes, it does NOT encrypt. Day 8 replaces it
// with AES-256-GCM (`v1:<keyId>:<iv>:<ciphertext>:<tag>`, AAD = table + column + row id).
// Every caller already passes the AAD reference, so the swap is local to this file.

/** Identifies where a sealed value lives; becomes the AAD so values can't be moved between rows. */
export type SecretRef = { table: string; column: string; rowId: string };

export type SecretBox = {
  seal: (plaintext: string, ref: SecretRef) => string;
  open: (sealed: string, ref: SecretRef) => string;
};

const V0 = 'v0:';

export const plaintextBox: SecretBox = {
  seal: (plaintext) => `${V0}${Buffer.from(plaintext, 'utf8').toString('base64')}`,
  open: (sealed) => {
    if (!sealed.startsWith(V0)) throw new Error('unsupported sealed secret format');
    return Buffer.from(sealed.slice(V0.length), 'base64').toString('utf8');
  },
};
