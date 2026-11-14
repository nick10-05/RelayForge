// Integration-test helpers. Tests isolate by data (a fresh user per test) instead of
// truncating tables, so test files can run in parallel against one database.
import { randomUUID } from 'node:crypto';
import type { InjectOptions } from 'fastify';
import { createRateLimiter } from '../lib/token-bucket.ts';
import { vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.ts';
import type { AppDeps } from '../app.ts';
import { SESSION_COOKIE } from '../auth/sessions.ts';
import { createDb, createPool } from '../db/client.ts';
import { fakeResolve } from './fake-dns.ts';
import { testSecretBox } from './test-keys.ts';
import { TEST_DATABASE_URL } from './test-support.ts';

export const TEST_PASSWORD = 'correct horse battery staple';

/** The Origin the test app accepts for state-changing API calls (CSRF check). */
export const TEST_ORIGIN = 'http://localhost:3000';

/** Effectively unlimited, so hundreds of signups from 127.0.0.1 in one file don't trip limits. */
const unlimited = () => createRateLimiter({ capacity: 1e9, refillPerSecond: 1e9 });

export function createTestApp(
  config: Partial<AppDeps['config']> = {},
  extra: Pick<AppDeps, 'logStream' | 'limits' | 'counters' | 'storageGuard'> & {
    /** Don't add the Origin header automatically (CSRF tests). */
    noOrigin?: boolean;
  } = {},
) {
  const { noOrigin = false, ...deps } = extra;
  const pool = createPool(TEST_DATABASE_URL);
  const db = createDb(pool);
  const wakeWorker = vi.fn();
  const app = buildApp({
    config: { LOG_LEVEL: 'silent', NODE_ENV: 'test', ...config },
    pool,
    db,
    wakeWorker,
    resolve: fakeResolve,
    secretBox: testSecretBox,
    ...deps,
    limits: { authIp: unlimited(), loginEmail: unlimited(), ...deps.limits },
  });
  if (!noOrigin) {
    // Every injected request carries the dashboard's Origin, like a browser on our page would,
    // unless a test sets its own (or opts out).
    const inject = app.inject.bind(app) as (opts: InjectOptions) => ReturnType<typeof app.inject>;
    app.inject = ((opts: InjectOptions) =>
      inject({ ...opts, headers: { origin: TEST_ORIGIN, ...opts.headers } })) as typeof app.inject;
  }
  return {
    app,
    pool,
    db,
    wakeWorker,
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

export type TestEndpoint = { id: string; slug: string };

export async function createEndpoint(
  app: FastifyInstance,
  user: TestUser,
  payload: object = { name: 'test endpoint' },
): Promise<TestEndpoint> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/endpoints',
    payload,
    headers: { cookie: user.cookie },
  });
  if (response.statusCode !== 201) throw new Error(`create endpoint failed: ${response.body}`);
  return response.json<{ endpoint: TestEndpoint }>().endpoint;
}

export async function createDestination(
  app: FastifyInstance,
  user: TestUser,
  endpointId: string,
  payload: object = { url: 'https://example.com/hook' },
): Promise<{ id: string; maxAttempts: number }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/endpoints/${endpointId}/destinations`,
    payload,
    headers: { cookie: user.cookie },
  });
  if (response.statusCode !== 201) throw new Error(`create destination failed: ${response.body}`);
  return response.json<{ destination: { id: string; maxAttempts: number } }>().destination;
}
