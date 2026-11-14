import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type pg from 'pg';
import type { Db } from '../db/client.ts';
import { DEFAULT_LEASE_MS, claimDue, reapExhausted } from './claim.ts';
import { completeDelivery } from './complete.ts';
import type { AttemptResult, ClaimedDelivery, Outcome } from './types.ts';

/** Performs the HTTP attempt. Must not throw; failures are reported in the result. */
export type SendFn = (claim: ClaimedDelivery) => Promise<AttemptResult>;
/** Turns an attempt into a decision (retry classification + backoff arrive on Day 5). */
export type DecideFn = (claim: ClaimedDelivery, attempt: AttemptResult) => Outcome;

export type WorkerOptions = {
  db: Db;
  pool: pg.Pool;
  send: SendFn;
  decide: DecideFn;
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
};

export type CycleResult = { claimed: number; applied: number; fenced: number; reaped: number };

export function newWorkerId(): string {
  return `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
}

/**
 * Minimal worker: one cycle = reap exhausted leases → claim a batch → send each
 * (no DB lock held) → fenced completion. The scheduler that decides WHEN to run a
 * cycle (wake-up signal, sleep until next due) is added on Day 6.
 */
export function createWorker(options: WorkerOptions) {
  const {
    db,
    pool,
    send,
    decide,
    workerId = newWorkerId(),
    batchSize = 8,
    leaseMs = DEFAULT_LEASE_MS,
  } = options;

  async function process(claim: ClaimedDelivery): Promise<boolean> {
    let attempt: AttemptResult;
    const startedAt = new Date();
    try {
      attempt = await send(claim);
    } catch (error) {
      // A SendFn should never throw, but a bug must not leave the row to lease expiry silently.
      attempt = {
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        errorCode: 'internal_error',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    return completeDelivery(db, claim, attempt, decide(claim, attempt));
  }

  async function runCycle(): Promise<CycleResult> {
    const reaped = await reapExhausted(pool);
    const claims = await claimDue(pool, { workerId, batchSize, leaseMs });
    const results = await Promise.all(claims.map(process));
    const applied = results.filter(Boolean).length;
    return { claimed: claims.length, applied, fenced: claims.length - applied, reaped };
  }

  /** Runs cycles until nothing is due. Returns the totals. (Test/maintenance helper.) */
  async function drain(maxCycles = 1000): Promise<CycleResult> {
    const total: CycleResult = { claimed: 0, applied: 0, fenced: 0, reaped: 0 };
    for (let i = 0; i < maxCycles; i++) {
      const r = await runCycle();
      total.claimed += r.claimed;
      total.applied += r.applied;
      total.fenced += r.fenced;
      total.reaped += r.reaped;
      if (r.claimed === 0 && r.reaped === 0) break;
    }
    return total;
  }

  return { workerId, runCycle, drain };
}
