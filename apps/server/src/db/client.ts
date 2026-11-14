import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
}

export function createDb(pool: pg.Pool) {
  return drizzle({ client: pool, schema });
}

export type Db = ReturnType<typeof createDb>;

/**
 * True if the database answers `SELECT 1` within `timeoutMs`. Never throws:
 * readiness checks need a yes/no answer, not an exception.
 */
export async function checkDatabase(pool: pg.Pool, timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const query = pool.query('SELECT 1').then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([query, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
