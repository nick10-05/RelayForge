import { hash, verify } from '@node-rs/argon2';

// argon2id (the library default) with the OWASP minimum: 19 MiB memory, 2 iterations, 1 lane.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** False for a wrong password or an unparseable hash; never throws. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

/**
 * A real hash to verify against when the email is unknown, so "no such user" takes as long
 * as "wrong password" and response timing doesn't reveal which emails are registered.
 */
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword('relayforge-dummy-password-for-timing');
  return dummy;
}
