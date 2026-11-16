// `npm run db:migrate`. Runtime-only dependencies, so it also works inside the Docker image.
// Uses the direct (non-pooled) URL: Neon's pooler is unsafe for DDL sessions.
import { ConfigError, loadConfig } from '../config.ts';
import { createPool } from './client.ts';
import { describeError, migrateWithRetry, runMigrations } from './migrate.ts';

let url: string;
try {
  url = loadConfig().DATABASE_DIRECT_URL;
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const pool = createPool(url);
try {
  await migrateWithRetry(() => runMigrations(pool));
  console.log('migrations applied');
} catch (error) {
  console.error(`migration failed: ${describeError(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
