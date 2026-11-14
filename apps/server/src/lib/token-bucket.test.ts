import { describe, expect, test } from 'vitest';
import { createRateLimiter, perMinute } from './token-bucket.ts';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('token bucket', () => {
  test('a burst up to capacity passes, then 429 with Retry-After', () => {
    const c = clock();
    const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 1, now: c.now });
    expect([1, 2, 3].map(() => limiter.take('a').ok)).toEqual([true, true, true]);
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  test('refills continuously with elapsed time, never above capacity', () => {
    const c = clock();
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 2, now: c.now });
    limiter.take('a');
    limiter.take('a');
    expect(limiter.take('a').ok).toBe(false);
    c.advance(500); // +1 token
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);
    c.advance(60_000); // long idle: back to capacity (2), not 120
    expect([1, 2, 3].map(() => limiter.take('a').ok)).toEqual([true, true, false]);
  });

  test('the long-run rate is the refill rate', () => {
    const c = clock();
    const limiter = createRateLimiter({ capacity: 5, refillPerSecond: 10, now: c.now });
    let allowed = 0;
    for (let ms = 0; ms < 10_000; ms += 10) {
      if (limiter.take('a').ok) allowed++;
      c.advance(10);
    }
    expect(allowed).toBeGreaterThanOrEqual(100); // 10/s × 10 s
    expect(allowed).toBeLessThanOrEqual(105); // + the initial burst of 5
  });

  test('keys are independent', () => {
    const c = clock();
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0.01, now: c.now });
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);
    expect(limiter.take('b').ok).toBe(true);
  });

  test('Retry-After reflects the time to the next whole token', () => {
    const c = clock();
    const limiter = perMinute(10, { now: c.now }); // one token per 6 s
    for (let i = 0; i < 10; i++) limiter.take('e');
    expect(limiter.take('e')).toEqual({ ok: false, retryAfterSeconds: 6 });
    c.advance(4_000);
    expect(limiter.take('e')).toEqual({ ok: false, retryAfterSeconds: 2 });
  });

  test('memory is bounded: least recently used keys are evicted', () => {
    const c = clock();
    const limiter = createRateLimiter({
      capacity: 1,
      refillPerSecond: 0.001,
      maxKeys: 3,
      now: c.now,
    });
    limiter.take('a');
    limiter.take('b');
    limiter.take('c');
    limiter.take('a'); // a is now most recent (and empty)
    limiter.take('d'); // evicts b
    expect(limiter.size).toBe(3);
    expect(limiter.take('a').ok).toBe(false); // still tracked
    expect(limiter.take('b').ok).toBe(true); // was evicted → fresh bucket
  });
});
