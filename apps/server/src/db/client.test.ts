import type pg from 'pg';
import { afterAll, describe, expect, test } from 'vitest';
import { checkDatabase, createPool } from './client.ts';
import { TEST_DATABASE_URL, UNREACHABLE_DATABASE_URL } from '../testing/test-support.ts';

describe('checkDatabase', () => {
  const up = createPool(TEST_DATABASE_URL);
  const down = createPool(UNREACHABLE_DATABASE_URL);

  afterAll(async () => {
    await Promise.all([up.end(), down.end()]);
  });

  test('returns true when the database answers', async () => {
    expect(await checkDatabase(up)).toBe(true);
  });

  test('returns false (does not throw) when the database is unreachable', async () => {
    expect(await checkDatabase(down)).toBe(false);
  });

  test('returns false when the check exceeds the timeout', async () => {
    // A pool whose query never settles (e.g. a hung connection).
    const hung = { query: () => new Promise(() => {}) } as unknown as pg.Pool;
    expect(await checkDatabase(hung, 50)).toBe(false);
  });
});
