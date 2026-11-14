// Process entry point: config → pool → app + delivery worker → listen, plus signal handling.
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { plaintextBox } from './crypto/secret-box.ts';
import { createDb, createPool } from './db/client.ts';
import { createDecider } from './delivery/classify.ts';
import { createHttpSender } from './delivery/http-client.ts';
import { createScheduler } from './delivery/scheduler.ts';
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
const db = createDb(pool);
const secretBox = plaintextBox; // AES-256-GCM keyring from Day 8

// The worker is created first so the app can wake it; it starts after the server listens.
let wake = () => {};
const app = buildApp({ config, pool, db, secretBox, wakeWorker: () => wake() });
const worker = createScheduler({
  db,
  pool,
  send: createHttpSender({
    production: config.NODE_ENV === 'production',
    allowPrivate: config.ALLOW_PRIVATE_DESTINATIONS,
    secretBox,
  }),
  decide: createDecider(),
  concurrency: config.WORKER_CONCURRENCY,
  log: app.log.child({ component: 'worker' }),
});
wake = worker.wake;

pool.on('error', (error) => {
  // An idle client lost its connection (e.g. Neon scaled to zero). pg replaces it; just log.
  app.log.warn({ err: error }, 'idle database client error');
});

const shutdown = createShutdown({ app, pool, worker, timeoutMs: config.SHUTDOWN_TIMEOUT_MS });
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  worker.start(); // first iteration = catch-up claim for anything left from before a restart
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  await pool.end();
  process.exit(1);
}
