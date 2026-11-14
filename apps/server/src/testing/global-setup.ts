// Vitest global setup: bring the test databases to the latest schema once per run.
// Guarded by an advisory lock, so it is safe even if several test projects run it at once.
import { createPool } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import {
  ENGINE_DATABASE_NAME,
  ENGINE_TEST_DATABASE_URL,
  TEST_DATABASE_URL,
} from './test-support.ts';

const SETUP_LOCK = 724_001; // arbitrary constant key for pg_advisory_lock

export default async function setup(): Promise<void> {
  const pool = createPool(TEST_DATABASE_URL);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SETUP_LOCK]);

    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      ENGINE_DATABASE_NAME,
    ]);
    if (exists.rowCount === 0) {
      // Identifier is a fixed constant, never input.
      await client.query(`CREATE DATABASE ${ENGINE_DATABASE_NAME}`);
    }

    await runMigrations(pool);
    const enginePool = createPool(ENGINE_TEST_DATABASE_URL);
    try {
      await runMigrations(enginePool);
    } finally {
      await enginePool.end();
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [SETUP_LOCK]).catch(() => {});
    client.release();
    await pool.end();
  }
}
