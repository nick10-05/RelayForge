import { afterAll, describe, expect, test } from 'vitest';
import { createTestApp, signUp } from '../testing/helpers.ts';
import type { TestUser } from '../testing/helpers.ts';

type DestinationDto = {
  id: string;
  endpointId: string;
  url: string;
  enabled: boolean;
  timeoutMs: number;
  maxAttempts: number;
};

describe('destinations API', () => {
  const { app, close } = createTestApp();
  afterAll(close);

  const call = (
    user: TestUser,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => app.inject({ method, url, ...(payload && { payload }), headers: { cookie: user.cookie } });

  async function setup() {
    const user = await signUp(app);
    const response = await call(user, 'POST', '/api/v1/endpoints', { name: 'ep' });
    const endpointId = response.json<{ endpoint: { id: string } }>().endpoint.id;
    return { user, base: `/api/v1/endpoints/${endpointId}/destinations`, endpointId };
  }

  test('create with defaults', async () => {
    const { user, base, endpointId } = await setup();
    const response = await call(user, 'POST', base, { url: 'https://example.com/hook' });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ destination: DestinationDto }>().destination).toMatchObject({
      endpointId,
      url: 'https://example.com/hook',
      enabled: true,
      timeoutMs: 10000,
      maxAttempts: 10,
    });
    expect(response.body).not.toContain('Secret');
  });

  test.each([
    ['not a URL', 'nope'],
    ['ftp scheme', 'ftp://example.com/x'],
    ['credentials', 'https://user:pass@example.com/x'],
    ['low port', 'https://example.com:22/x'],
    ['implicit http port 80', 'http://example.com/x'],
  ])('rejects bad URLs: %s', async (_case, url) => {
    const { user, base } = await setup();
    const response = await call(user, 'POST', base, { url });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_destination_url' });
  });

  test.each([
    ['timeout too low', { timeoutMs: 500 }],
    ['timeout too high', { timeoutMs: 20000 }],
    ['max attempts too high', { maxAttempts: 16 }],
  ])('validates limits: %s', async (_case, extra) => {
    const { user, base } = await setup();
    const response = await call(user, 'POST', base, { url: 'https://example.com', ...extra });
    expect(response.statusCode).toBe(400);
  });

  test('list, update (disable, limits, url) and delete', async () => {
    const { user, base } = await setup();
    const created = (await call(user, 'POST', base, { url: 'https://a.example.com' })).json<{
      destination: DestinationDto;
    }>().destination;
    await call(user, 'POST', base, { url: 'https://b.example.com' });

    const list = (await call(user, 'GET', base)).json<{ destinations: DestinationDto[] }>();
    expect(list.destinations.map((d) => d.url)).toEqual([
      'https://a.example.com/',
      'https://b.example.com/',
    ]);

    const updated = await call(user, 'PATCH', `${base}/${created.id}`, {
      enabled: false,
      timeoutMs: 5000,
      maxAttempts: 3,
      url: 'https://c.example.com:8443/in',
    });
    expect(updated.json()).toMatchObject({
      destination: {
        enabled: false,
        timeoutMs: 5000,
        maxAttempts: 3,
        url: 'https://c.example.com:8443/in',
      },
    });

    expect(
      (await call(user, 'PATCH', `${base}/${created.id}`, { url: 'ftp://x' })).statusCode,
    ).toBe(400);
    expect((await call(user, 'DELETE', `${base}/${created.id}`)).statusCode).toBe(204);
    expect((await call(user, 'GET', `${base}/${created.id}`)).statusCode).toBe(404);
  });

  test('tenant isolation: another user gets 404 through my endpoint', async () => {
    const owner = await setup();
    const intruder = await signUp(app);
    const created = (
      await call(owner.user, 'POST', owner.base, { url: 'https://example.com' })
    ).json<{ destination: DestinationDto }>().destination;

    expect((await call(intruder, 'GET', owner.base)).statusCode).toBe(404);
    expect(
      (await call(intruder, 'POST', owner.base, { url: 'https://evil.example' })).statusCode,
    ).toBe(404);
    expect((await call(intruder, 'GET', `${owner.base}/${created.id}`)).statusCode).toBe(404);
    expect(
      (await call(intruder, 'PATCH', `${owner.base}/${created.id}`, { enabled: false })).statusCode,
    ).toBe(404);
    expect((await call(intruder, 'DELETE', `${owner.base}/${created.id}`)).statusCode).toBe(404);
  });

  test('a destination id under the wrong endpoint is 404', async () => {
    const { user, base } = await setup();
    const created = (await call(user, 'POST', base, { url: 'https://example.com' })).json<{
      destination: DestinationDto;
    }>().destination;
    const otherEndpoint = (await call(user, 'POST', '/api/v1/endpoints', { name: 'other' })).json<{
      endpoint: { id: string };
    }>().endpoint.id;
    const response = await call(
      user,
      'GET',
      `/api/v1/endpoints/${otherEndpoint}/destinations/${created.id}`,
    );
    expect(response.statusCode).toBe(404);
  });

  test('production requires https', async () => {
    const prod = createTestApp({ NODE_ENV: 'production' });
    try {
      const user = await signUp(prod.app);
      const ep = (
        await prod.app.inject({
          method: 'POST',
          url: '/api/v1/endpoints',
          payload: { name: 'x' },
          headers: { cookie: user.cookie },
        })
      ).json<{ endpoint: { id: string } }>().endpoint.id;
      const response = await prod.app.inject({
        method: 'POST',
        url: `/api/v1/endpoints/${ep}/destinations`,
        payload: { url: 'http://example.com:8080/x' },
        headers: { cookie: user.cookie },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await prod.close();
    }
  });
});
