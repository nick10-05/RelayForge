// Vitest global setup: bring the test database to the latest schema once per run.
import { createPool } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { TEST_DATABASE_URL } from './test-support.ts';

export default async function setup(): Promise<void> {
  const pool = createPool(TEST_DATABASE_URL);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
