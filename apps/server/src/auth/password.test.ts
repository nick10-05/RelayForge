import { describe, expect, test } from 'vitest';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password.ts';

describe('password hashing', () => {
  test('uses argon2id with the OWASP minimum parameters', async () => {
    const hash = await hashPassword('a long enough password');
    expect(hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
  });

  test('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('a long enough password');
    expect(await verifyPassword(hash, 'a long enough password')).toBe(true);
    expect(await verifyPassword(hash, 'a long enough passworD')).toBe(false);
  });

  test('salts: the same password hashes differently each time', async () => {
    expect(await hashPassword('same password here')).not.toBe(
      await hashPassword('same password here'),
    );
  });

  test('returns false instead of throwing for a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  test('dummy hash is a real argon2id hash and is computed once', async () => {
    const first = await dummyPasswordHash();
    expect(first.startsWith('$argon2id$')).toBe(true);
    expect(await dummyPasswordHash()).toBe(first);
  });
});
