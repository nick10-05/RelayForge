import { describe, expect, test, vi } from 'vitest';
import { describeError, migrateWithRetry } from './migrate.ts';

const noSleep = () => Promise.resolve();

describe('migrateWithRetry', () => {
  test('retries until it succeeds, waiting the given delays', async () => {
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockResolvedValue();
    const sleep = vi.fn(noSleep);
    const log = vi.fn();

    await migrateWithRetry(run, { delaysMs: [10, 20, 30], sleep, log });

    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toMatch(
      /attempt 1 failed \(connection timeout\); retrying in 10 ms/,
    );
  });

  test('gives up after the last delay and rethrows the last error', async () => {
    const last = new Error('still down');
    const run = vi.fn<() => Promise<void>>().mockRejectedValue(last);

    await expect(
      migrateWithRetry(run, { delaysMs: [1, 1], sleep: noSleep, log: () => {} }),
    ).rejects.toBe(last);
    expect(run).toHaveBeenCalledTimes(3);
  });
});

describe('describeError', () => {
  test('adds the driver cause and its code (Drizzle hides them in `cause`)', () => {
    const cause = Object.assign(new Error('Connection terminated due to connection timeout'), {
      code: 'ETIMEDOUT',
    });
    const wrapped = new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"', { cause });
    expect(describeError(wrapped)).toBe(
      'Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle": Connection terminated due to connection timeout [ETIMEDOUT]',
    );
  });

  test('drops the "params:" part Drizzle appends (bound values never reach the logs)', () => {
    const wrapped = new Error('Failed query: select $1\nparams: secret-value', {
      cause: new Error('boom'),
    });
    expect(describeError(wrapped)).toBe('Failed query: select $1: boom');
  });

  test('plain errors and non-errors', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('text')).toBe('text');
  });
});
