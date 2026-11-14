// Process entry point: config → pool → app + delivery worker → listen, plus signal handling.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createAesGcmBox, parseKeyring } from './crypto/secret-box.ts';
import { createDb, createPool } from './db/client.ts';
import { createDecider } from './delivery/classify.ts';
import { createHttpSender } from './delivery/http-client.ts';
import { createScheduler } from './delivery/scheduler.ts';
import { createRetentionJob } from './ops/retention.ts';
import { createStorageGuard } from './ops/storage-guard.ts';
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
// loadConfig has validated the keyring; outside tests both variables are required.
const secretBox = createAesGcmBox(
  parseKeyring(config.ENCRYPTION_KEYS ?? '', config.ENCRYPTION_ACTIVE_KEY_ID ?? ''),
);

// The worker is created first so the app can wake it; it starts after the server listens.
let wake = () => {};
let warn: (obj: object, msg: string) => void = () => {};
const storageGuard = createStorageGuard({
  pool,
  capBytes: config.STORAGE_CAP_BYTES,
  onError: (err) => warn({ err }, 'storage size check failed'),
});
// The built dashboard (npm run build), if present: served on the same origin as the API.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const webRoot = existsSync(webDist) ? webDist : undefined;
const app = buildApp({
  config,
  pool,
  db,
  secretBox,
  storageGuard,
  wakeWorker: () => wake(),
  ...(webRoot && { webRoot }),
});
warn = (obj, msg) => app.log.warn(obj, msg);
const retention = createRetentionJob({ db, log: app.log.child({ component: 'retention' }) });
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
const stopAndShutdown = (signal: string) => {
  retention.stop();
  void shutdown(signal);
};
process.once('SIGTERM', () => stopAndShutdown('SIGTERM'));
process.once('SIGINT', () => stopAndShutdown('SIGINT'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  worker.start(); // first iteration = catch-up claim for anything left from before a restart
  void storageGuard.refresh(); // then re-measured lazily, at most hourly, when ingest asks
  retention.start(); // now, then every 24 h
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  await pool.end();
  process.exit(1);
}
