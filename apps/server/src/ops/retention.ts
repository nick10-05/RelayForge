// Retention (design §8.3): valid events older than 7 days, invalid-signature events older than
// 24 hours — but only once every delivery of the event is terminal (succeeded/dead). An event
// with a pending or in-flight delivery is never deleted: the worker still needs its body, and
// deleting it would silently drop a webhook that hasn't been delivered yet.
//
// Deleting an event cascades to its deliveries and their attempt history.
// Batches of 500 keep each statement (and its locks) short; `SKIP LOCKED` steps around rows
// another transaction is touching right now instead of waiting on them.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';

export const RETENTION_BATCH_SIZE = 500;
export const VALID_RETENTION = '7 days';
export const INVALID_RETENTION = '24 hours';
const DAY_MS = 24 * 60 * 60 * 1000;

export async function runRetention(
  db: Db,
  { batchSize = RETENTION_BATCH_SIZE, maxBatches = 1000 } = {},
): Promise<{ deleted: number }> {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const result = await db.execute<{ id: string }>(sql`
      DELETE FROM events
      WHERE id IN (
        SELECT e.id FROM events e
        WHERE (
            (e.signature_status <> 'invalid' AND e.received_at < now() - ${VALID_RETENTION}::interval)
            OR (e.signature_status = 'invalid' AND e.received_at < now() - ${INVALID_RETENTION}::interval)
          )
          AND NOT EXISTS (
            SELECT 1 FROM deliveries d
            WHERE d.event_id = e.id AND d.status IN ('pending', 'in_flight')
          )
        LIMIT ${batchSize}
        FOR UPDATE OF e SKIP LOCKED
      )
      RETURNING id`);
    deleted += result.rows.length;
    if (result.rows.length < batchSize) break;
  }
  return { deleted };
}

export type RetentionJob = { start: () => void; stop: () => void };

/** Runs at startup, then every 24 h. The timer is unref'd: it never keeps the process alive. */
export function createRetentionJob(options: {
  db: Db;
  intervalMs?: number;
  log?: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
}): RetentionJob {
  const { db, intervalMs = DAY_MS, log } = options;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function tick() {
    if (running) return; // a slow run is never overlapped by the next one
    running = true;
    try {
      const { deleted } = await runRetention(db);
      log?.info({ deleted }, 'retention run finished');
    } catch (error) {
      log?.error({ err: error }, 'retention run failed'); // next run tries again
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
