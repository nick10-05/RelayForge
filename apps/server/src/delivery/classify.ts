// Retry classification and backoff (design §4.5).
import type { AttemptResult, Outcome } from './types.ts';
import type { DecideFn } from './worker.ts';

export type BackoffPolicy = {
  baseMs: number;
  capMs: number;
  /** Returns [0, 1). Injectable so tests are deterministic. */
  random: () => number;
};

/** Locked defaults (D4): base 30 s, cap 1 h. With 10 attempts the worst case is ≈ 3 h. */
export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 30_000,
  capMs: 3_600_000,
  random: Math.random,
};

export type Classification =
  'success' | 'retryable' | 'redirect' | 'non_retryable_status' | 'ssrf_blocked';

export function classifyAttempt(attempt: AttemptResult): Classification {
  if (attempt.errorCode === 'SSRF_BLOCKED') return 'ssrf_blocked';
  const status = attempt.statusCode;
  // No status = timeout, DNS, connect, TLS or reset error: the receiver may be back later.
  if (status === undefined) return 'retryable';
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return 'redirect'; // never followed (could point inside)
  if (status === 408 || status === 429 || status >= 500) return 'retryable';
  return 'non_retryable_status'; // other 4xx: retrying the same request won't help
}

/**
 * Full jitter: delay = random(0, min(cap, base × 2^(attempt−1))).
 * Spreading retries uniformly avoids a thundering herd of synchronized retries hitting a
 * receiver that is just recovering (compared with plain exponential or "equal jitter").
 */
export function backoffDelay(attempt: number, policy: BackoffPolicy): number {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(policy.random() * ceiling);
}

/** Retry-After as delta-seconds or HTTP-date, in ms. Null if absent or unparseable. */
export function parseRetryAfter(
  value: string | string[] | undefined,
  now: number = Date.now(),
): number | null {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  if (!/^[a-z]{3},/i.test(raw)) return null; // an HTTP-date starts with a day name
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export function createDecider(
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  now: () => number = Date.now,
): DecideFn {
  return (claim, attempt): Outcome => {
    switch (classifyAttempt(attempt)) {
      case 'success':
        return { kind: 'succeeded' };
      case 'redirect':
        return { kind: 'dead', reason: 'redirect' };
      case 'non_retryable_status':
        return { kind: 'dead', reason: 'non_retryable_status' };
      case 'ssrf_blocked':
        return { kind: 'dead', reason: 'ssrf_blocked' };
      case 'retryable': {
        // Honour the receiver's Retry-After, clamped to the cap. (Exhaustion — no attempts
        // left — is applied in completeDelivery.)
        const retryAfter = parseRetryAfter(attempt.responseHeaders?.['retry-after'], now());
        const delayMs =
          retryAfter !== null
            ? Math.min(policy.capMs, retryAfter)
            : backoffDelay(claim.attemptCount, policy);
        return { kind: 'retry', delayMs };
      }
    }
  };
}
