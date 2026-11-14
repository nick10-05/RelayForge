// Integration-test helpers. Tests isolate by data (a fresh user per test) instead of
// truncating tables, so test files can run in parallel against one database.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.ts';
import type { AppDeps } from '../app.ts';
import { SESSION_COOKIE } from '../auth/sessions.ts';
import { createDb, createPool } from '../db/client.ts';
import { TEST_DATABASE_URL } from './test-support.ts';

export const TEST_PASSWORD = 'correct horse battery staple';

export function createTestApp(config: Partial<AppDeps['config']> = {}) {
  const pool = createPool(TEST_DATABASE_URL);
  const db = createDb(pool);
  const app = buildApp({
    config: { LOG_LEVEL: 'silent', NODE_ENV: 'test', ...config },
    pool,
    db,
  });
  return {
    app,
    pool,
    db,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export function uniqueEmail(): string {
  return `user-${randomUUID()}@example.test`;
}

export type TestUser = { id: string; email: string; cookie: string };

/** Signs up a fresh user and returns a ready-to-send `cookie` header value. */
export async function signUp(app: FastifyInstance, email = uniqueEmail()): Promise<TestUser> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, password: TEST_PASSWORD },
  });
  if (response.statusCode !== 201) throw new Error(`signup failed: ${response.body}`);
  const session = response.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!session) throw new Error('no session cookie');
  const { user } = response.json<{ user: { id: string; email: string } }>();
  return { id: user.id, email: user.email, cookie: `${SESSION_COOKIE}=${session.value}` };
}
