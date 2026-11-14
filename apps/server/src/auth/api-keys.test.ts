import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { apiKeys } from '../db/schema.ts';
import { createEndpoint, createTestApp, signUp } from '../testing/helpers.ts';
import type { TestUser } from '../testing/helpers.ts';
import { generateApiKey, parseApiKey } from './api-keys.ts';

describe('API key format', () => {
  test('rf_live_<12 hex prefix>_<43-char secret>, parseable, hash = SHA-256(secret)', () => {
    const { key, prefix, secretHash } = generateApiKey();
    expect(key).toMatch(/^rf_live_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    const parsed = parseApiKey(key)!;
    expect(parsed.prefix).toBe(prefix);
    expect(createHash('sha256').update(parsed.secret).digest('hex')).toBe(secretHash);
    expect(generateApiKey().key).not.toBe(key);
  });

  test.each(['', 'rf_live_', 'rf_test_0123456789ab_' + 'a'.repeat(43), 'rf_live_XYZ_abc'])(
    'rejects %j',
    (key) => expect(parseApiKey(key)).toBeNull(),
  );
});

describe('API keys', () => {
  const t = createTestApp();
  const { app, db } = t;
  afterAll(() => t.close());

  async function createKey(user: TestUser, name = 'ci') {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      payload: { name },
      headers: { cookie: user.cookie },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ apiKey: { id: string; prefix: string }; key: string }>();
  }
  const withKey = (key: string, url = '/api/v1/endpoints') =>
    app.inject({ url, headers: { authorization: `Bearer ${key}` } });

  test('create: the key is returned once; only prefix + SHA-256(secret) are stored', async () => {
    const user = await signUp(app);
    const { apiKey, key } = await createKey(user);
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id));
    const secret = parseApiKey(key)!.secret;
    expect(row!.prefix).toBe(apiKey.prefix);
    expect(row!.secretHash).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(secret);

    const list = await app.inject({ url: '/api/v1/api-keys', headers: { cookie: user.cookie } });
    expect(list.body).not.toContain(secret);
    expect(list.json()).toMatchObject({
      apiKeys: [{ id: apiKey.id, name: 'ci', lastUsedAt: null, revokedAt: null }],
    });
  });

  test('a key authenticates API requests as its owner, and sets last_used_at', async () => {
    const user = await signUp(app);
    const endpoint = await createEndpoint(app, user, { name: 'mine' });
    const { apiKey, key } = await createKey(user);

    const response = await withKey(key);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ endpoints: [{ id: endpoint.id }] });
    const me = await withKey(key, '/api/v1/auth/me');
    expect(me.json()).toMatchObject({ user: { id: user.id } });

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id));
    expect(row!.lastUsedAt).not.toBeNull();
  });

  test('last_used_at is written at most once a minute', async () => {
    const user = await signUp(app);
    const { apiKey, key } = await createKey(user);
    await withKey(key);
    const old = new Date('2026-01-01T00:00:00Z');
    await db
      .update(apiKeys)
      .set({ lastUsedAt: sql`now() - interval '10 seconds'` })
      .where(eq(apiKeys.id, apiKey.id));
    const [before] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id));
    await withKey(key);
    const [after] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id));
    expect(after!.lastUsedAt).toEqual(before!.lastUsedAt); // within the minute: no write

    await db.update(apiKeys).set({ lastUsedAt: old }).where(eq(apiKeys.id, apiKey.id));
    await withKey(key);
    const [later] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id));
    expect(later!.lastUsedAt!.getTime()).toBeGreaterThan(old.getTime());
  });

  test('tenant isolation holds with API keys too', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);
    const bobs = await createEndpoint(app, bob, { name: 'bob' });
    const { key } = await createKey(alice);
    expect((await withKey(key, `/api/v1/endpoints/${bobs.id}`)).statusCode).toBe(404);
    expect((await withKey(key)).json()).toEqual({ endpoints: [] });
  });

  test('revoke: the key stops working at once; revoke is idempotent; list shows revokedAt', async () => {
    const user = await signUp(app);
    const { apiKey, key } = await createKey(user);
    expect((await withKey(key)).statusCode).toBe(200);

    const revoke = () =>
      app.inject({
        method: 'DELETE',
        url: `/api/v1/api-keys/${apiKey.id}`,
        headers: { cookie: user.cookie },
      });
    expect((await revoke()).statusCode).toBe(204);
    expect((await revoke()).statusCode).toBe(204);
    expect((await withKey(key)).statusCode).toBe(401);
    const list = await app.inject({ url: '/api/v1/api-keys', headers: { cookie: user.cookie } });
    expect(
      list.json<{ apiKeys: { revokedAt: string | null }[] }>().apiKeys[0]!.revokedAt,
    ).not.toBeNull();
  });

  test("another user's key id → 404 on revoke", async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);
    const { apiKey } = await createKey(bob);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/api-keys/${apiKey.id}`,
      headers: { cookie: alice.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  test.each([
    ['wrong secret', (k: string) => k.slice(0, -4) + (k.endsWith('AAAA') ? 'BBBB' : 'AAAA')],
    ['unknown prefix', () => generateApiKey().key],
    ['malformed', () => 'rf_live_nope'],
    ['not Bearer', (k: string) => k],
  ])('rejects a bad key (%s) with 401', async (label, mutate) => {
    const user = await signUp(app);
    const { key } = await createKey(user);
    const header = label === 'not Bearer' ? `Basic ${key}` : `Bearer ${mutate(key)}`;
    const response = await app.inject({
      url: '/api/v1/endpoints',
      headers: { authorization: header },
    });
    expect(response.statusCode).toBe(401);
  });

  test('a bad Authorization header is a 401 even with a valid session cookie', async () => {
    const user = await signUp(app);
    const response = await app.inject({
      url: '/api/v1/endpoints',
      headers: {
        cookie: user.cookie,
        authorization: 'Bearer rf_live_000000000000_' + 'x'.repeat(43),
      },
    });
    expect(response.statusCode).toBe(401);
  });

  test('API keys cannot manage API keys (session only)', async () => {
    const user = await signUp(app);
    const { key } = await createKey(user);
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      payload: { name: 'escalate' },
      headers: { authorization: `Bearer ${key}` },
    });
    expect(create.statusCode).toBe(401);
    expect((await withKey(key, '/api/v1/api-keys')).statusCode).toBe(401);
  });

  test('requires authentication; validates the name', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/api-keys', payload: { name: 'x' } }))
        .statusCode,
    ).toBe(401);
    const user = await signUp(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      payload: { name: '' },
      headers: { cookie: user.cookie },
    });
    expect(response.statusCode).toBe(400);
  });
});
