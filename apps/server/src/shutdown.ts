import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

export type ShutdownDeps = {
  app: FastifyInstance;
  pool: pg.Pool;
  timeoutMs: number;
  /** The delivery worker: stops claiming, then waits for its in-flight sends. */
  worker?: { stop: (timeoutMs: number) => Promise<unknown> };
  exit?: (code: number) => void;
};

/**
 * Returns an idempotent shutdown function: stop accepting connections, let in-flight
 * requests finish, close the pool, exit 0. If that takes longer than `timeoutMs`, exit 1.
 * In parallel the delivery worker stops claiming and waits for its in-flight sends (with a
 * slightly shorter budget, so the pool can still close). Anything cut off keeps its lease
 * and is retried by another worker once the lease expires (design §4.8).
 */
export function createShutdown({
  app,
  pool,
  timeoutMs,
  worker,
  exit = (code) => process.exit(code),
}: ShutdownDeps) {
  let shuttingDown: Promise<void> | undefined;

  return (signal: string): Promise<void> => {
    shuttingDown ??= (async () => {
      app.log.info({ signal }, 'shutting down');
      const force = setTimeout(() => {
        app.log.error({ timeoutMs }, 'shutdown timed out, forcing exit');
        exit(1);
      }, timeoutMs);
      force.unref();
      try {
        await Promise.all([app.close(), worker?.stop(Math.floor(timeoutMs * 0.8))]);
        await pool.end();
        app.log.info('shutdown complete');
        exit(0);
      } catch (error) {
        app.log.error({ err: error }, 'shutdown failed');
        exit(1);
      } finally {
        clearTimeout(force);
      }
    })();
    return shuttingDown;
  };
}
