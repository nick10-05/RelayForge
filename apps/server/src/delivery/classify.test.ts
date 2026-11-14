// Invariant #7 (design §4.10): retry classification and backoff bounds match §4.5.
import { describe, expect, test } from 'vitest';
import { backoffDelay, classifyAttempt, createDecider, parseRetryAfter } from './classify.ts';
import type { BackoffPolicy } from './classify.ts';
import type { AttemptResult, ClaimedDelivery } from './types.ts';

const attempt = (extra: Partial<AttemptResult>): AttemptResult => ({
  startedAt: new Date(),
  durationMs: 1,
  ...extra,
});
const claim = (attemptCount: number) => ({ attemptCount }) as ClaimedDelivery;

describe('classifyAttempt', () => {
  test.each([
    [200, 'success'],
    [201, 'success'],
    [204, 'success'],
    [299, 'success'],
    [301, 'redirect'],
    [302, 'redirect'],
    [307, 'redirect'],
    [408, 'retryable'],
    [429, 'retryable'],
    [500, 'retryable'],
    [502, 'retryable'],
    [503, 'retryable'],
    [599, 'retryable'],
    [400, 'non_retryable_status'],
    [401, 'non_retryable_status'],
    [403, 'non_retryable_status'],
    [404, 'non_retryable_status'],
    [410, 'non_retryable_status'],
    [422, 'non_retryable_status'],
  ])('status %i → %s', (statusCode, expected) => {
    expect(classifyAttempt(attempt({ statusCode }))).toBe(expected);
  });

  test.each(['TIMEOUT', 'CONNECT_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND'])(
    'network error %s → retryable',
    (errorCode) => {
      expect(classifyAttempt(attempt({ errorCode }))).toBe('retryable');
    },
  );

  test('SSRF block → ssrf_blocked (never retried)', () => {
    expect(classifyAttempt(attempt({ errorCode: 'SSRF_BLOCKED' }))).toBe('ssrf_blocked');
  });
});

describe('backoffDelay (full jitter)', () => {
  const policy = (random: number): BackoffPolicy => ({
    baseMs: 30_000,
    capMs: 3_600_000,
    random: () => random,
  });

  test.each([
    [1, 30_000],
    [2, 60_000],
    [3, 120_000],
    [7, 1_920_000],
    [8, 3_600_000], // 3.84M capped
    [10, 3_600_000],
    [40, 3_600_000],
  ])('attempt %i ceiling is %i ms', (n, ceiling) => {
    expect(backoffDelay(n, policy(0))).toBe(0);
    expect(backoffDelay(n, policy(0.5))).toBe(Math.floor(ceiling * 0.5));
    expect(backoffDelay(n, policy(0.999999))).toBeLessThan(ceiling);
  });

  test('random samples stay inside [0, ceiling)', () => {
    const real = { baseMs: 30_000, capMs: 3_600_000, random: Math.random };
    for (let n = 1; n <= 10; n++) {
      const ceiling = Math.min(3_600_000, 30_000 * 2 ** (n - 1));
      for (let i = 0; i < 200; i++) {
        const d = backoffDelay(n, real);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(ceiling);
      }
    }
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  test.each([
    ['120', 120_000],
    [' 5 ', 5_000],
    ['0', 0],
    ['Thu, 01 Jan 2026 00:01:00 GMT', 60_000],
    ['Wed, 31 Dec 2025 23:00:00 GMT', 0], // past date → now
  ])('%j → %i ms', (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });

  test.each([undefined, '', 'soon', '-5', '1.5'])('%j → null', (value) => {
    expect(parseRetryAfter(value, now)).toBeNull();
  });

  test('first value of a repeated header wins', () => {
    expect(parseRetryAfter(['3', '10'], now)).toBe(3_000);
  });
});

describe('createDecider', () => {
  const policy: BackoffPolicy = { baseMs: 30_000, capMs: 3_600_000, random: () => 0.5 };
  const decide = createDecider(policy, () => 0);

  test('2xx → succeeded', () => {
    expect(decide(claim(1), attempt({ statusCode: 200 }))).toEqual({ kind: 'succeeded' });
  });

  test.each([
    [302, 'redirect'],
    [404, 'non_retryable_status'],
  ])('%i → dead (%s)', (statusCode, reason) => {
    expect(decide(claim(1), attempt({ statusCode }))).toEqual({ kind: 'dead', reason });
  });

  test('SSRF → dead', () => {
    expect(decide(claim(1), attempt({ errorCode: 'SSRF_BLOCKED' }))).toEqual({
      kind: 'dead',
      reason: 'ssrf_blocked',
    });
  });

  test('5xx without Retry-After → jittered backoff for that attempt number', () => {
    expect(decide(claim(3), attempt({ statusCode: 503 }))).toEqual({
      kind: 'retry',
      delayMs: 60_000,
    });
  });

  test('Retry-After is honoured', () => {
    const result = decide(
      claim(1),
      attempt({ statusCode: 429, responseHeaders: { 'retry-after': '90' } }),
    );
    expect(result).toEqual({ kind: 'retry', delayMs: 90_000 });
  });

  test('Retry-After is clamped to the cap', () => {
    const result = decide(
      claim(1),
      attempt({ statusCode: 503, responseHeaders: { 'retry-after': '86400' } }),
    );
    expect(result).toEqual({ kind: 'retry', delayMs: 3_600_000 });
  });

  test('timeouts retry with backoff', () => {
    expect(decide(claim(1), attempt({ errorCode: 'TIMEOUT' }))).toEqual({
      kind: 'retry',
      delayMs: 15_000,
    });
  });
});
