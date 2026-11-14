// Storage guard (design §7.5): above 90 % of the database size cap, ingest answers 503 +
// Retry-After instead of failing writes once Neon's free-tier limit is hit.
//
// The size is measured at startup and then refreshed at most once an hour, LAZILY: only when
// an ingest request asks and the last measurement is stale, and in the background (the request
// uses the last known value and never waits for the query). A fixed hourly timer would wake an
// idle Neon database every hour just to measure it; this way an idle system makes no queries.
import type pg from 'pg';

export const DEFAULT_STORAGE_CAP_BYTES = 512 * 1024 * 1024; // Neon free tier: 0.5 GB
const THRESHOLD = 0.9;
const REFRESH_MS = 60 * 60 * 1000;

export type StorageGuard = {
  /** True when ingest should be refused. Cheap; may trigger a background refresh. */
  blocked: () => boolean;
  /** Measure now (startup, tests). Never throws: a failed check keeps the last state. */
  refresh: () => Promise<void>;
  readonly lastSizeBytes: number | null;
};

export type StorageGuardOptions = {
  pool: Pick<pg.Pool, 'query'>;
  capBytes?: number;
  refreshMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
};

export function createStorageGuard(options: StorageGuardOptions): StorageGuard {
  const {
    pool,
    capBytes = DEFAULT_STORAGE_CAP_BYTES,
    refreshMs = REFRESH_MS,
    now = Date.now,
    onError,
  } = options;
  let sizeBytes: number | null = null;
  let checkedAt = -Infinity;
  let inFlight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    inFlight ??= (async () => {
      try {
        const result = await pool.query<{ size: string }>(
          'SELECT pg_database_size(current_database())::bigint AS size',
        );
        sizeBytes = Number(result.rows[0]?.size ?? 0);
      } catch (error) {
        onError?.(error); // keep the last known state; retry after the next interval
      } finally {
        checkedAt = now();
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    get lastSizeBytes() {
      return sizeBytes;
    },
    refresh,
    blocked() {
      if (now() - checkedAt >= refreshMs) void refresh();
      return sizeBytes !== null && sizeBytes >= capBytes * THRESHOLD;
    },
  };
}
