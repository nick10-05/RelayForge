import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../app.ts';
import { createDb, createPool } from '../db/client.ts';
import { UNREACHABLE_DATABASE_URL } from '../testing/test-support.ts';
import { DOCS_PREFIX, ROUTE_DOCS } from './openapi.ts';

type Operation = {
  tags?: string[];
  summary?: string;
  security?: Record<string, string[]>[];
  requestBody?: { content: Record<string, { schema: { properties?: Record<string, unknown> } }> };
};
type Spec = { openapi: string; paths: Record<string, Record<string, Operation>> };

// The spec is built from route definitions only; no database is needed.
const pool = createPool(UNREACHABLE_DATABASE_URL);
const app = buildApp({
  config: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
  pool,
  db: createDb(pool),
});
let spec: Spec;
const operations = () =>
  Object.entries(spec.paths).flatMap(([path, ops]) =>
    Object.entries(ops).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, op })),
  );

beforeAll(async () => {
  const response = await app.inject({ method: 'GET', url: `${DOCS_PREFIX}/json` });
  expect(response.statusCode).toBe(200);
  spec = response.json<Spec>();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('OpenAPI document', () => {
  test('is OpenAPI 3.1', () => {
    expect(spec.openapi).toBe('3.1.0');
  });

  test('every documented route exists, and every route is documented', () => {
    const keys = operations().map((o) => o.key);
    expect(keys.filter((k) => k !== 'POST /in/{slug}').sort()).toEqual(
      Object.keys(ROUTE_DOCS).sort(),
    );
  });

  test('every operation has a tag and a summary', () => {
    for (const { key, op } of operations()) {
      expect(op.tags, key).toHaveLength(1);
      expect(op.summary, key).toBeTruthy();
    }
  });

  test('no paths with a trailing slash, no docs or dashboard routes', () => {
    for (const path of Object.keys(spec.paths)) {
      expect(path === '/' || !path.endsWith('/'), path).toBe(true);
      expect(path.startsWith(DOCS_PREFIX), path).toBe(false);
    }
  });

  test('request bodies come from the Zod schemas', () => {
    const body = spec.paths['/api/v1/endpoints']?.post?.requestBody;
    const schema = body?.content['application/json']?.schema;
    expect(Object.keys(schema?.properties ?? {})).toEqual(
      expect.arrayContaining(['name', 'dedupeSource', 'verification']),
    );
  });

  test('security: public routes need nothing, API-key management is session only', () => {
    expect(spec.paths['/in/{slug}']?.post?.security).toEqual([]);
    expect(spec.paths['/api/v1/auth/login']?.post?.security).toEqual([]);
    expect(spec.paths['/api/v1/api-keys']?.post?.security).toEqual([{ session: [] }]);
    expect(spec.paths['/api/v1/endpoints']?.get?.security).toEqual([
      { session: [] },
      { apiKey: [] },
    ]);
  });
});

describe('Swagger UI', () => {
  test('is served under /api with the default (strict) CSP', async () => {
    const response = await app.inject({ method: 'GET', url: `${DOCS_PREFIX}/` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(String(response.headers['content-security-policy'])).toContain("script-src 'self'");
  });
});
