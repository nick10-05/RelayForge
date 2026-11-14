import { afterAll, describe, expect, test } from 'vitest';
import { createTestApp, signUp } from '../testing/helpers.ts';
import type { TestUser } from '../testing/helpers.ts';

type EndpointDto = {
  id: string;
  name: string;
  slug: string;
  ingestPath: string;
  paused: boolean;
  dedupeSource: string;
  dedupeName: string | null;
};

describe('endpoints API', () => {
  const { app, close } = createTestApp();
  afterAll(close);

  const call = (
    user: TestUser | null,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/v1/endpoints${url}`,
      ...(payload && { payload }),
      ...(user && { headers: { cookie: user.cookie } }),
    });

  const create = async (user: TestUser, payload: object = { name: 'Stripe' }) => {
    const response = await call(user, 'POST', '/', payload);
    expect(response.statusCode).toBe(201);
    return response.json<{ endpoint: EndpointDto }>().endpoint;
  };

  test('all routes require authentication', async () => {
    expect((await call(null, 'GET', '/')).statusCode).toBe(401);
    expect((await call(null, 'POST', '/', { name: 'x' })).statusCode).toBe(401);
  });

  test('create returns a 128-bit random slug and defaults', async () => {
    const user = await signUp(app);
    const endpoint = await create(user);
    expect(endpoint).toMatchObject({
      name: 'Stripe',
      paused: false,
      dedupeSource: 'none',
      dedupeName: null,
    });
    expect(Buffer.from(endpoint.slug, 'base64url')).toHaveLength(16);
    expect(endpoint.ingestPath).toBe(`/in/${endpoint.slug}`);
    const other = await create(user);
    expect(other.slug).not.toBe(endpoint.slug);
  });

  test('header dedupe source stores a lower-cased header name', async () => {
    const user = await signUp(app);
    const endpoint = await create(user, {
      name: 'GitHub',
      dedupeSource: 'header',
      dedupeName: 'X-GitHub-Delivery',
    });
    expect(endpoint).toMatchObject({ dedupeSource: 'header', dedupeName: 'x-github-delivery' });
  });

  test.each([
    ['missing name', { dedupeSource: 'none' }],
    ['empty name', { name: '   ' }],
    ['dedupe source without name', { name: 'x', dedupeSource: 'header' }],
    ['invalid header name', { name: 'x', dedupeSource: 'header', dedupeName: 'bad header' }],
    ['unknown dedupe source', { name: 'x', dedupeSource: 'body_hash' }],
  ])('create validates input: %s', async (_case, payload) => {
    const user = await signUp(app);
    const response = await call(user, 'POST', '/', payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation_error' });
  });

  test('list returns only my endpoints, newest first', async () => {
    const me = await signUp(app);
    const other = await signUp(app);
    const first = await create(me, { name: 'first' });
    const second = await create(me, { name: 'second' });
    await create(other, { name: 'not mine' });

    const response = await call(me, 'GET', '/');
    const ids = response.json<{ endpoints: EndpointDto[] }>().endpoints.map((e) => e.id);
    expect(ids).toEqual([second.id, first.id]);
  });

  test('update: rename, pause/resume, change and clear dedupe', async () => {
    const user = await signUp(app);
    const endpoint = await create(user);

    const paused = await call(user, 'PATCH', `/${endpoint.id}`, { name: 'Renamed', paused: true });
    expect(paused.json()).toMatchObject({ endpoint: { name: 'Renamed', paused: true } });

    const dedupe = await call(user, 'PATCH', `/${endpoint.id}`, {
      dedupeSource: 'json_field',
      dedupeName: 'id',
    });
    expect(dedupe.json()).toMatchObject({
      endpoint: { dedupeSource: 'json_field', dedupeName: 'id' },
    });

    const cleared = await call(user, 'PATCH', `/${endpoint.id}`, { dedupeSource: 'none' });
    expect(cleared.json()).toMatchObject({ endpoint: { dedupeSource: 'none', dedupeName: null } });

    const resumed = await call(user, 'PATCH', `/${endpoint.id}`, { paused: false });
    expect(resumed.json()).toMatchObject({ endpoint: { paused: false, name: 'Renamed' } });
  });

  test('update rejects an empty body and invalid dedupe combinations', async () => {
    const user = await signUp(app);
    const endpoint = await create(user);
    expect((await call(user, 'PATCH', `/${endpoint.id}`, {})).statusCode).toBe(400);
    expect(
      (await call(user, 'PATCH', `/${endpoint.id}`, { dedupeSource: 'header' })).statusCode,
    ).toBe(400);
  });

  test('delete removes the endpoint', async () => {
    const user = await signUp(app);
    const endpoint = await create(user);
    expect((await call(user, 'DELETE', `/${endpoint.id}`)).statusCode).toBe(204);
    expect((await call(user, 'GET', `/${endpoint.id}`)).statusCode).toBe(404);
  });

  test('tenant isolation: another user gets 404 on every route', async () => {
    const owner = await signUp(app);
    const intruder = await signUp(app);
    const endpoint = await create(owner);

    expect((await call(intruder, 'GET', `/${endpoint.id}`)).statusCode).toBe(404);
    expect((await call(intruder, 'PATCH', `/${endpoint.id}`, { name: 'pwned' })).statusCode).toBe(
      404,
    );
    expect((await call(intruder, 'DELETE', `/${endpoint.id}`)).statusCode).toBe(404);

    const still = await call(owner, 'GET', `/${endpoint.id}`);
    expect(still.json()).toMatchObject({ endpoint: { name: 'Stripe' } });
  });

  test('a malformed id is a 400, an unknown id a 404', async () => {
    const user = await signUp(app);
    expect((await call(user, 'GET', '/not-a-uuid')).statusCode).toBe(400);
    expect((await call(user, 'GET', '/01960000-0000-7000-8000-000000000000')).statusCode).toBe(404);
  });
});
