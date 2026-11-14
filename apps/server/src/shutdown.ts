import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

export type ShutdownDeps = {
  app: FastifyInstance;
  pool: pg.Pool;
  timeoutMs: number;
  exit?: (code: number) => void;
};

/**
 * Returns an idempotent shutdown function: stop accepting connections, let in-flight
 * requests finish, close the pool, exit 0. If that takes longer than `timeoutMs`, exit 1.
 * (From Day 6 the delivery worker stops claiming here too; anything cut off is
 * recovered by lease expiry.)
 */
export function createShutdown({
  app,
  pool,
  timeoutMs,
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
        await app.close();
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
