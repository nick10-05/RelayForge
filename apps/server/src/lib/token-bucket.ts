// In-memory token-bucket rate limiter (design §7.5).
//
// Each key (an endpoint id, an IP, an email) has a bucket of `capacity` tokens that refills
// continuously at `refillPerSecond`. A request takes one token; an empty bucket means "429,
// retry in N seconds". Bursts up to `capacity` pass, the long-run rate is capped at the refill
// rate — unlike a fixed window, there is no double-burst at window edges.
//
// In memory = per process. Correct for our single instance (design §10); with several
// instances each would allow the full rate, and the buckets would have to move to a shared
// store (Redis, or a Postgres table) — at the cost of a round trip per request.
//
// Buckets are created lazily; refilling is computed from elapsed time on access (no timers).
// The map is bounded: beyond `maxKeys`, the least recently used keys are dropped, so an
// attacker cycling through IPs or emails can't grow memory without limit. (A dropped key
// just starts again with a full bucket.)

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export type RateLimiter = {
  take: (key: string) => RateLimitResult;
  readonly size: number;
};

export type RateLimiterOptions = {
  capacity: number;
  refillPerSecond: number;
  maxKeys?: number;
  /** Milliseconds clock (injectable for deterministic tests). */
  now?: () => number;
};

type Bucket = { tokens: number; updatedAt: number };

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { capacity, refillPerSecond, maxKeys = 10_000, now = Date.now } = options;
  if (capacity < 1 || refillPerSecond <= 0) throw new Error('invalid rate limiter options');
  const buckets = new Map<string, Bucket>();

  return {
    get size() {
      return buckets.size;
    },
    take(key) {
      const t = now();
      const existing = buckets.get(key);
      let bucket: Bucket;
      if (existing) {
        const elapsed = Math.max(0, t - existing.updatedAt) / 1000;
        bucket = {
          tokens: Math.min(capacity, existing.tokens + elapsed * refillPerSecond),
          updatedAt: t,
        };
        buckets.delete(key); // re-insert below: Map order = least recently used first
      } else {
        bucket = { tokens: capacity, updatedAt: t };
      }

      let result: RateLimitResult;
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        result = { ok: true };
      } else {
        const missing = 1 - bucket.tokens;
        result = {
          ok: false,
          // The epsilon keeps float noise (2.0000000004 s) from rounding up a whole second.
          retryAfterSeconds: Math.max(1, Math.ceil(missing / refillPerSecond - 1e-9)),
        };
      }

      buckets.set(key, bucket);
      while (buckets.size > maxKeys) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
      return result;
    },
  };
}

/** Per-minute convenience: `perMinute(10)` = burst 10, refilling 10 per minute. */
export function perMinute(
  count: number,
  extra: Omit<RateLimiterOptions, 'capacity' | 'refillPerSecond'> = {},
) {
  return createRateLimiter({ capacity: count, refillPerSecond: count / 60, ...extra });
}
