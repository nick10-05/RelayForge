import { describe, expect, test } from 'vitest';
import {
  KeyringError,
  createAesGcmBox,
  generateKeyEntry,
  parseKeyring,
  unconfiguredBox,
} from './secret-box.ts';

const K1 = generateKeyEntry('k1');
const K2 = generateKeyEntry('k2');
const REF = { table: 'destinations', column: 'signing_secret_enc', rowId: 'row-1' };

describe('AES-256-GCM secret box', () => {
  const box = createAesGcmBox(parseKeyring(K1, 'k1'));

  test('round-trip, v1 format, random IV per value', () => {
    const a = box.seal('whsec_hello', REF);
    const b = box.seal('whsec_hello', REF);
    expect(a).toMatch(/^v1:k1:[\w-]{16}:[\w-]+:[\w-]{22}$/);
    expect(a).not.toBe(b); // same plaintext, different IV → different ciphertext
    expect(a).not.toContain('whsec_hello');
    expect(box.open(a, REF)).toBe('whsec_hello');
    expect(box.open(b, REF)).toBe('whsec_hello');
  });

  test('AAD: a value moved to another row, column or table does not open', () => {
    const sealed = box.seal('s3cret', REF);
    expect(() => box.open(sealed, { ...REF, rowId: 'row-2' })).toThrow(/authentication/);
    expect(() => box.open(sealed, { ...REF, column: 'prev_signing_secret_enc' })).toThrow();
    expect(() => box.open(sealed, { ...REF, table: 'endpoints' })).toThrow();
  });

  test('tampering with any part is detected', () => {
    const sealed = box.seal('s3cret', REF);
    const parts = sealed.split(':');
    for (const i of [2, 3, 4]) {
      const bytes = Buffer.from(parts[i]!, 'base64url');
      bytes[0] = bytes[0]! ^ 0x01;
      const tampered = [...parts];
      tampered[i] = bytes.toString('base64url');
      expect(() => box.open(tampered.join(':'), REF)).toThrow();
    }
    expect(() => box.open('v0:c2VjcmV0', REF)).toThrow(/unsupported/);
    expect(() => box.open('v1:k1:x:y', REF)).toThrow(/unsupported/);
  });

  test('error messages never contain the plaintext or key material', () => {
    const sealed = box.seal('very-secret-value', REF);
    try {
      box.open(sealed, { ...REF, rowId: 'other' });
    } catch (error) {
      expect(String(error)).not.toContain('very-secret-value');
      expect(String(error)).not.toContain(K1.split(':')[1]);
    }
  });

  test('key rotation: new active key seals, old values still open; unknown key fails', () => {
    const old = box.seal('before-rotation', REF);
    const rotated = createAesGcmBox(parseKeyring(`${K2},${K1}`, 'k2'));
    const fresh = rotated.seal('after-rotation', REF);
    expect(fresh.startsWith('v1:k2:')).toBe(true);
    expect(rotated.open(old, REF)).toBe('before-rotation');
    expect(rotated.open(fresh, REF)).toBe('after-rotation');
    // Once k1 is retired, its values can no longer be opened (re-seal before retiring).
    const retired = createAesGcmBox(parseKeyring(K2, 'k2'));
    expect(() => retired.open(old, REF)).toThrow(/unknown key id "k1"/);
  });

  test('unconfiguredBox refuses everything', () => {
    expect(() => unconfiguredBox.seal('x', REF)).toThrow(/not configured/);
    expect(() => unconfiguredBox.open('v1:a:b:c:d', REF)).toThrow(/not configured/);
  });
});

describe('parseKeyring', () => {
  test('parses several keys and the active id', () => {
    const ring = parseKeyring(` ${K1} , ${K2} `, 'k2');
    expect([...ring.keys.keys()]).toEqual(['k1', 'k2']);
    expect(ring.activeKeyId).toBe('k2');
  });

  test.each([
    ['', 'k1', /no keys/],
    ['k1', 'k1', /entry 1/],
    ['k1:dG9vLXNob3J0', 'k1', /must be 32 bytes/],
    ['bad id!:AAAA', 'k1', /entry 1/],
    [`${K1},${K1}`, 'k1', /duplicate/],
    [K1, 'k9', /ACTIVE_KEY_ID/],
  ])('rejects %j (active %s)', (keys, active, message) => {
    expect(() => parseKeyring(keys, active)).toThrow(KeyringError);
    expect(() => parseKeyring(keys, active)).toThrow(message);
  });

  test('errors never echo key material', () => {
    const material = Buffer.alloc(31, 7).toString('base64');
    try {
      parseKeyring(`k1:${material}`, 'k1');
    } catch (error) {
      expect(String(error)).not.toContain(material);
    }
  });
});
