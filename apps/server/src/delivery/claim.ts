import type pg from 'pg';
import type { ClaimedDelivery } from './types.ts';

export const DEFAULT_LEASE_MS = 60_000; // must exceed the max request time (15 s), design §4.3

export type ClaimOptions = { workerId: string; batchSize: number; leaseMs?: number };

/**
 * Claims up to `batchSize` due deliveries for this worker (design §4.3).
 *
 * - `FOR UPDATE OF d SKIP LOCKED`: concurrent claimers lock disjoint rows and never wait
 *   on each other; a row another claimer is taking right now is simply skipped.
 * - The lease IS `next_attempt_at`: an `in_flight` row whose worker died becomes due
 *   again when the lease runs out — no sweeper job needed.
 * - `attempt_count` is incremented here, at claim time, so a payload that crashes the
 *   worker still uses up its attempts (poison-message protection).
 * - Paused endpoints and disabled destinations are skipped: their deliveries are held.
 * - Times come from the database clock (`now()`), so workers' clocks can't disagree.
 * - This is a single auto-committed statement: no lock is held after it returns,
 *   in particular not during the HTTP call.
 */
const CLAIM_SQL = `
WITH due AS (
  SELECT d.id
  FROM deliveries d
  JOIN destinations ds ON ds.id = d.destination_id AND ds.enabled
  JOIN endpoints e     ON e.id = ds.endpoint_id   AND NOT e.paused
  WHERE d.status IN ('pending', 'in_flight')
    AND d.next_attempt_at <= now()
    AND d.attempt_count < d.max_attempts
  ORDER BY d.next_attempt_at
  LIMIT $1
  FOR UPDATE OF d SKIP LOCKED
), claimed AS (
  UPDATE deliveries d
  SET status          = 'in_flight',
      attempt_count   = d.attempt_count + 1,
      lease_owner     = $2,
      next_attempt_at = now() + $3::int * interval '1 millisecond',
      updated_at      = now()
  FROM due
  WHERE d.id = due.id
  RETURNING d.id, d.event_id, d.destination_id, d.attempt_count, d.max_attempts,
            d.trigger, d.lease_owner, d.next_attempt_at AS lease_expires_at
)
SELECT c.*, ds.url, ds.timeout_ms, ev.endpoint_id, ev.method, ev.headers, ev.body, ev.content_type
FROM claimed c
JOIN destinations ds ON ds.id = c.destination_id
JOIN events ev       ON ev.id = c.event_id
ORDER BY c.lease_expires_at, c.id`;

/**
 * An `in_flight` row whose lease expired on its LAST allowed attempt can't be claimed
 * again (attempts exhausted), so it is finished here as dead/exhausted. This is how a
 * payload that keeps crashing the worker ends up dead instead of looping forever.
 */
const REAP_EXHAUSTED_SQL = `
UPDATE deliveries
SET status = 'dead', dead_reason = 'exhausted', lease_owner = NULL,
    completed_at = now(), updated_at = now(),
    last_error = 'lease expired on the final attempt (worker crashed or stalled)'
WHERE id IN (
  SELECT id FROM deliveries
  WHERE status = 'in_flight' AND next_attempt_at <= now() AND attempt_count >= max_attempts
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
RETURNING id`;

type ClaimRow = {
  id: string;
  event_id: string;
  destination_id: string;
  attempt_count: number;
  max_attempts: number;
  trigger: 'auto' | 'manual';
  lease_owner: string;
  lease_expires_at: Date;
  url: string;
  timeout_ms: number;
  endpoint_id: string;
  method: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
  content_type: string | null;
};

export async function reapExhausted(pool: pg.Pool, limit = 100): Promise<number> {
  const result = await pool.query(REAP_EXHAUSTED_SQL, [limit]);
  return result.rowCount ?? 0;
}

export async function claimDue(pool: pg.Pool, options: ClaimOptions): Promise<ClaimedDelivery[]> {
  const { workerId, batchSize, leaseMs = DEFAULT_LEASE_MS } = options;
  const result = await pool.query<ClaimRow>(CLAIM_SQL, [batchSize, workerId, leaseMs]);
  return result.rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    endpointId: r.endpoint_id,
    destinationId: r.destination_id,
    attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts,
    trigger: r.trigger,
    leaseOwner: r.lease_owner,
    leaseExpiresAt: r.lease_expires_at,
    url: r.url,
    timeoutMs: r.timeout_ms,
    method: r.method,
    headers: r.headers,
    body: r.body,
    contentType: r.content_type,
  }));
}
