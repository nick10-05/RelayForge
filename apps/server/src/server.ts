// Process entry point: config → pool → app → listen, plus signal handling.
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createDb, createPool } from './db/client.ts';
import { createShutdown } from './shutdown.ts';

function readConfig() {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
const pool = createPool(config.DATABASE_URL);
const app = buildApp({ config, pool, db: createDb(pool) });

pool.on('error', (error) => {
  // An idle client lost its connection (e.g. Neon scaled to zero). pg replaces it; just log.
  app.log.warn({ err: error }, 'idle database client error');
});

const shutdown = createShutdown({ app, pool, timeoutMs: config.SHUTDOWN_TIMEOUT_MS });
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  await pool.end();
  process.exit(1);
}
