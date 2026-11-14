import { afterAll, describe, expect, test } from 'vitest';
import { buildApp } from './app.ts';
import { createPool } from './db/client.ts';
import { TEST_DATABASE_URL, UNREACHABLE_DATABASE_URL } from './test-support.ts';

describe('health endpoints', () => {
  const upPool = createPool(TEST_DATABASE_URL);
  const downPool = createPool(UNREACHABLE_DATABASE_URL);
  const up = buildApp({ config: { LOG_LEVEL: 'silent' }, pool: upPool });
  const down = buildApp({ config: { LOG_LEVEL: 'silent' }, pool: downPool });

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

  test('unknown routes are 404', async () => {
    const response = await up.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
  });
});
