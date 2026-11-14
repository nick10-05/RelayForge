// The app's rate limiters and ingest counters (design §7.5), created once per process.
import type { FastifyReply } from 'fastify';
import { createRateLimiter, perMinute } from '../lib/token-bucket.ts';
import type { RateLimitResult, RateLimiter } from '../lib/token-bucket.ts';

export type Limits = {
  /** Every ingest request, per endpoint. */
  ingest: RateLimiter;
  /** Requests that FAILED signature verification, per endpoint. Stricter: they cost storage. */
  invalidSignature: RateLimiter;
  /** Login + signup per client IP (argon2id makes each attempt expensive for us too). */
  authIp: RateLimiter;
  /** Login per email address: slows password guessing against one account from many IPs. */
  loginEmail: RateLimiter;
};

export type LimitSettings = {
  ingestPerSecond: number;
  ingestBurst: number;
  invalidSignaturePerMinute: number;
};

export function createLimits(settings: LimitSettings): Limits {
  return {
    ingest: createRateLimiter({
      capacity: settings.ingestBurst,
      refillPerSecond: settings.ingestPerSecond,
    }),
    invalidSignature: perMinute(settings.invalidSignaturePerMinute),
    authIp: perMinute(20),
    // 10 attempts, then one more every 90 s (= 10 per 15 minutes).
    loginEmail: createRateLimiter({ capacity: 10, refillPerSecond: 10 / 900 }),
  };
}

/** Counters for requests that were refused without being stored (read by /stats later). */
export type IngestCounters = {
  /** Invalid-signature requests over their limit: 401, not stored, only counted here. */
  invalidSignatureDropped: Map<string, number>;
};

export const createIngestCounters = (): IngestCounters => ({
  invalidSignatureDropped: new Map(),
});

export const RATE_LIMITED = { error: 'rate_limited', message: 'Too many requests' } as const;

export function sendRateLimited(
  reply: FastifyReply,
  result: Extract<RateLimitResult, { ok: false }>,
) {
  return reply.code(429).header('retry-after', String(result.retryAfterSeconds)).send(RATE_LIMITED);
}
