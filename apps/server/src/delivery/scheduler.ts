// The long-running delivery worker (design §4.6–4.8).
//
// It sleeps until the earliest of:
//   - an in-process wake-up (ingest, redelivery, endpoint resumed, destination re-enabled,
//     or one of its own sends finishing and freeing a slot), or
//   - the earliest `next_attempt_at` among deliveries it could claim.
// With nothing scheduled it sleeps with no timer at all, so an idle worker makes zero
// database queries and Neon can scale to zero. LISTEN/NOTIFY is not used: it needs a
// session-level connection, which Neon's pooled (PgBouncer, transaction mode) URL can't hold.
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { Db } from '../db/client.ts';
import { DEFAULT_LEASE_MS, claimDue, reapExhausted } from './claim.ts';
import { completeDelivery } from './complete.ts';
import type { AttemptResult, ClaimedDelivery } from './types.ts';
import type { DecideFn, SendFn } from './worker.ts';
import { newWorkerId } from './worker.ts';

export const DEFAULT_CONCURRENCY = 8;
/** Floor between polls when rows are due but couldn't be claimed (locked by another worker). */
const MIN_RECHECK_MS = 200;
/** setTimeout's maximum delay (~24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;
const ERROR_BACKOFF_START_MS = 1000;
const ERROR_BACKOFF_MAX_MS = 60_000;

/**
 * Milliseconds until the earliest claimable (or reapable) delivery is due, computed on the
 * database clock. Null when nothing is scheduled. Held rows (paused endpoint, disabled
 * destination) are ignored: resuming them sends a wake-up instead.
 */
// (GREATEST ignores NULLs, so the CASE is what keeps "nothing scheduled" NULL instead of 0.)
const NEXT_DUE_SQL = `
SELECT CASE WHEN min(d.next_attempt_at) IS NULL THEN NULL
            ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (min(d.next_attempt_at) - now())) * 1000))
       END::bigint AS delay_ms
FROM deliveries d
JOIN destinations ds ON ds.id = d.destination_id AND ds.enabled
JOIN endpoints e     ON e.id = ds.endpoint_id   AND NOT e.paused
WHERE d.status IN ('pending', 'in_flight')`;

export async function nextDueDelay(pool: pg.Pool): Promise<number | null> {
  const result = await pool.query<{ delay_ms: string | null }>(NEXT_DUE_SQL);
  const raw = result.rows[0]?.delay_ms;
  return raw === null || raw === undefined ? null : Number(raw);
}

export type SchedulerOptions = {
  db: Db;
  pool: pg.Pool;
  send: SendFn;
  decide: DecideFn;
  log?: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  workerId?: string;
  concurrency?: number;
  leaseMs?: number;
};

export type Scheduler = {
  readonly workerId: string;
  /** Starts the loop; the first iteration is the startup catch-up claim. */
  start: () => void;
  /** In-process signal: something may be due now. Cheap and safe to call often. */
  wake: () => void;
  /** Stop claiming, then wait up to `timeoutMs` for in-flight sends. */
  stop: (timeoutMs: number) => Promise<{ drained: boolean; abandoned: number }>;
  readonly inFlight: number;
};

export function createScheduler(options: SchedulerOptions): Scheduler {
  const {
    db,
    pool,
    send,
    decide,
    log,
    workerId = newWorkerId(),
    concurrency = DEFAULT_CONCURRENCY,
    leaseMs = DEFAULT_LEASE_MS,
  } = options;

  const inFlight = new Set<Promise<void>>();
  let running = false;
  let loopDone: Promise<void> = Promise.resolve();
  let wakePending = false;
  let interruptSleep: (() => void) | undefined;

  function wake() {
    wakePending = true;
    interruptSleep?.();
  }

  /** Resolves after `ms` (null = no timer, only a wake-up ends it) or on wake(). */
  function sleep(ms: number | null): Promise<void> {
    if (wakePending || !running) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = ms === null ? undefined : setTimeout(done, Math.min(ms, MAX_TIMER_MS));
      function done() {
        clearTimeout(timer);
        interruptSleep = undefined;
        resolve();
      }
      interruptSleep = done;
    });
  }

  async function processOne(claim: ClaimedDelivery): Promise<void> {
    const startedAt = new Date();
    let attempt: AttemptResult;
    try {
      attempt = await send(claim);
    } catch (error) {
      attempt = {
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        errorCode: 'internal_error',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const applied = await completeDelivery(db, claim, attempt, decide(claim, attempt));
      if (!applied) log?.warn({ deliveryId: claim.id }, 'completion fenced off (lease lost)');
    } catch (error) {
      // The lease will expire and the delivery will be retried; nothing is lost.
      log?.error({ err: error, deliveryId: claim.id }, 'failed to record delivery attempt');
    }
  }

  function track(claim: ClaimedDelivery) {
    const task = processOne(claim).finally(() => {
      inFlight.delete(task);
      wake(); // a slot is free; also re-evaluates the next due time
    });
    inFlight.add(task);
  }

  async function loop() {
    let errorBackoff = ERROR_BACKOFF_START_MS;
    while (running) {
      wakePending = false;
      try {
        const free = concurrency - inFlight.size;
        if (free <= 0) {
          await sleep(null); // a finishing send wakes us
          continue;
        }
        await reapExhausted(pool);
        const claims = await claimDue(pool, { workerId, batchSize: free, leaseMs });
        if (!running) {
          // Stopped while claiming: still send what we hold (stop() waits for it).
          for (const claim of claims) track(claim);
          break;
        }
        for (const claim of claims) track(claim);
        errorBackoff = ERROR_BACKOFF_START_MS;
        if (claims.length === free) continue; // probably more due right now
        if (wakePending) continue;

        const delay = await nextDueDelay(pool);
        if (wakePending) continue;
        // Due rows we couldn't claim are locked by another worker: re-check shortly.
        await sleep(delay === null ? null : Math.max(delay, MIN_RECHECK_MS));
      } catch (error) {
        log?.error({ err: error, retryInMs: errorBackoff }, 'delivery loop error');
        await sleep(errorBackoff);
        errorBackoff = Math.min(errorBackoff * 2, ERROR_BACKOFF_MAX_MS);
      }
    }
  }

  return {
    workerId,
    get inFlight() {
      return inFlight.size;
    },
    start() {
      if (running) return;
      running = true;
      wakePending = false;
      log?.info({ workerId, concurrency }, 'delivery worker started');
      loopDone = loop();
    },
    wake,
    async stop(timeoutMs) {
      running = false;
      interruptSleep?.();
      await loopDone; // no claims after this point
      if (inFlight.size === 0) return { drained: true, abandoned: 0 };

      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      const drained = await Promise.race([
        Promise.allSettled([...inFlight]).then(() => true as const),
        timedOut,
      ]);
      clearTimeout(timer);
      const abandoned = inFlight.size;
      // Abandoned sends keep their lease; another worker retries them once it expires.
      if (!drained) log?.warn({ abandoned }, 'stopped with deliveries still in flight');
      return { drained, abandoned };
    },
  };
}
