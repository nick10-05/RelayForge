// Tenant isolation across EVERY route that takes an id (design §7.3): another user's
// resources answer 404 — never 403 (which would confirm they exist) — and stay unchanged.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { deliveries, destinations, endpoints, events } from '../db/schema.ts';
import { createDestination, createEndpoint, createTestApp, signUp } from '../testing/helpers.ts';
import type { TestUser } from '../testing/helpers.ts';

describe('tenant isolation', () => {
  const t = createTestApp();
  const { app, db } = t;
  afterAll(() => t.close());

  let alice: TestUser;
  let bob: TestUser;
  let bobKey: string;
  const ids = { endpoint: '', destination: '', event: '', delivery: '', apiKey: '' };

  beforeAll(async () => {
    alice = await signUp(app);
    bob = await signUp(app);
    const endpoint = await createEndpoint(app, alice, { name: 'alice' });
    const destination = await createDestination(app, alice, endpoint.id);
    const ingest = await app.inject({ method: 'POST', url: `/in/${endpoint.slug}`, payload: '{}' });
    const { eventId } = ingest.json<{ eventId: string }>();
    const [delivery] = await db.select().from(deliveries).where(eq(deliveries.eventId, eventId));
    // Make it dead so retry would otherwise be allowed.
    await db
      .update(deliveries)
      .set({ status: 'dead', deadReason: 'exhausted' })
      .where(eq(deliveries.id, delivery!.id));
    const key = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      payload: { name: 'alice-ci' },
      headers: { cookie: alice.cookie },
    });
    const bobKeyResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      payload: { name: 'bob-ci' },
      headers: { cookie: bob.cookie },
    });
    bobKey = bobKeyResponse.json<{ key: string }>().key;
    Object.assign(ids, {
      endpoint: endpoint.id,
      destination: destination.id,
      event: eventId,
      delivery: delivery!.id,
      apiKey: key.json<{ apiKey: { id: string } }>().apiKey.id,
    });
  });

  const routes = (): [string, string, object?][] => {
    const e = `/api/v1/endpoints/${ids.endpoint}`;
    const d = `${e}/destinations/${ids.destination}`;
    return [
      ['GET', e],
      ['PATCH', e, { name: 'stolen' }],
      ['DELETE', e],
      ['GET', `${e}/destinations`],
      ['POST', `${e}/destinations`, { url: 'https://example.com/steal' }],
      ['GET', d],
      ['PATCH', d, { enabled: false }],
      ['GET', `${d}/secret`],
      ['POST', `${d}/rotate-secret`],
      ['DELETE', d],
      ['GET', `${e}/events`],
      ['GET', `/api/v1/events/${ids.event}`],
      ['GET', `/api/v1/events/${ids.event}/body`],
      ['POST', `/api/v1/events/${ids.event}/replay`, {}],
      ['POST', `/api/v1/deliveries/${ids.delivery}/retry`],
      ['POST', `${e}/redeliver-dead`, {}],
      ['DELETE', `/api/v1/api-keys/${ids.apiKey}`],
    ];
  };

  test.each(['session', 'api key'])(
    "bob (%s) gets 404 on every one of alice's resources",
    async (via) => {
      for (const [method, url, payload] of routes()) {
        if (via === 'api key' && url.startsWith('/api/v1/api-keys')) continue; // session-only route
        const response = await app.inject({
          method: method as 'GET',
          url,
          ...(payload && { payload }),
          headers:
            via === 'session' ? { cookie: bob.cookie } : { authorization: `Bearer ${bobKey}` },
        });
        expect({ method, url, status: response.statusCode }).toEqual({ method, url, status: 404 });
      }
    },
  );

  test("lists never include another tenant's rows", async () => {
    const list = await app.inject({ url: '/api/v1/endpoints', headers: { cookie: bob.cookie } });
    expect(list.json()).toEqual({ endpoints: [] });
    const keys = await app.inject({ url: '/api/v1/api-keys', headers: { cookie: bob.cookie } });
    expect(keys.json<{ apiKeys: { name: string }[] }>().apiKeys.map((k) => k.name)).toEqual([
      'bob-ci',
    ]);
  });

  test("alice's data is unchanged after all of bob's attempts", async () => {
    const [endpoint] = await db.select().from(endpoints).where(eq(endpoints.id, ids.endpoint));
    expect(endpoint!.name).toBe('alice');
    const [destination] = await db
      .select()
      .from(destinations)
      .where(eq(destinations.id, ids.destination));
    expect(destination).toMatchObject({ enabled: true, prevSigningSecretEnc: null });
    expect(
      await db.select().from(destinations).where(eq(destinations.endpointId, ids.endpoint)),
    ).toHaveLength(1);
    expect(await db.select().from(events).where(eq(events.endpointId, ids.endpoint))).toHaveLength(
      1,
    );
    expect(
      await db.select().from(deliveries).where(eq(deliveries.eventId, ids.event)),
    ).toHaveLength(1);
    const keys = await app.inject({ url: '/api/v1/api-keys', headers: { cookie: alice.cookie } });
    expect(
      keys.json<{ apiKeys: { revokedAt: string | null }[] }>().apiKeys[0]!.revokedAt,
    ).toBeNull();
  });
});
