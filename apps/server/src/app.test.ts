import { afterAll, describe, expect, test } from 'vitest';
import { buildApp } from './app.ts';
import { createDb, createPool } from './db/client.ts';
import { TEST_DATABASE_URL, UNREACHABLE_DATABASE_URL } from './testing/test-support.ts';

const config = { LOG_LEVEL: 'silent', NODE_ENV: 'test' } as const;

describe('health endpoints', () => {
  const upPool = createPool(TEST_DATABASE_URL);
  const downPool = createPool(UNREACHABLE_DATABASE_URL);
  const up = buildApp({ config, pool: upPool, db: createDb(upPool) });
  const down = buildApp({ config, pool: downPool, db: createDb(downPool) });

  afterAll(async () => {
    await Promise.all([up.close(), down.close()]);
    await Promise.all([upPool.end(), downPool.end()]);
  });

  test('GET /healthz is 200 even when the database is down', async () => {
    const response = await down.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  test('GET /readyz is 200 when the database is reachable', async () => {
    const response = await up.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  test('GET /readyz is 503 when the database is down', async () => {
    const response = await down.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
  });

  test('unknown routes are 404 with the standard error shape', async () => {
    const response = await up.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found', message: 'Not found' });
  });

  test('malformed JSON is a 400 with the standard error shape', async () => {
    const response = await up.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: expect.any(String) as string,
      message: expect.any(String) as string,
    });
  });
});
