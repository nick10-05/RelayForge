import { createHmac } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { deliveries, deliveryAttempts, events } from '../db/schema.ts';
import { createIngestCounters } from '../http/limits.ts';
import { createDestination, createEndpoint, createTestApp, signUp } from '../testing/helpers.ts';
import type { TestUser } from '../testing/helpers.ts';

type Stats = {
  endpointId: string | null;
  endpoints: number;
  events: {
    stored: number;
    last24h: number;
    duplicatesReceived: number;
    invalidSignature: number;
    invalidSignatureDroppedSinceStart: number;
  };
  deliveries: {
    pending: number;
    inFlight: number;
    succeeded: number;
    dead: number;
    due: number;
    deadByReason: Record<string, number>;
  };
  attemptsLast24h: {
    total: number;
    succeeded: number;
    successRate: number | null;
    latencyMs: { p50: number | null; p95: number | null };
  };
};

describe('GET /api/v1/stats', () => {
  const counters = createIngestCounters();
  const t = createTestApp({}, { counters });
  const { app, db } = t;
  afterAll(() => t.close());

  const stats = (user: TestUser, query = '') =>
    app.inject({ method: 'GET', url: `/api/v1/stats${query}`, headers: { cookie: user.cookie } });
  const ingest = async (slug: string, headers: Record<string, string> = {}, body = '{"a":1}') => {
    const response = await app.inject({
      method: 'POST',
      url: `/in/${slug}`,
      payload: body,
      headers: { 'content-type': 'application/json', ...headers },
    });
    return response.json<{ eventId?: string }>().eventId;
  };

  test('a new account: all zeros, no rate or latency yet', async () => {
    const response = await stats(await signUp(app));
    expect(response.statusCode).toBe(200);
    expect(response.json<Stats>()).toMatchObject({
      endpointId: null,
      endpoints: 0,
      events: { stored: 0, last24h: 0, duplicatesReceived: 0, invalidSignature: 0 },
      deliveries: { pending: 0, inFlight: 0, succeeded: 0, dead: 0, due: 0 },
      attemptsLast24h: { total: 0, succeeded: 0, successRate: null, latencyMs: { p50: null } },
    });
  });

  test('counts events, deliveries by status, backlog and 24 h attempt health', async () => {
    const user = await signUp(app);

    // A: dedupe on a header, one destination, four distinct events + one duplicate.
    const a = await createEndpoint(app, user, {
      name: 'a',
      dedupeSource: 'header',
      dedupeName: 'x-id',
    });
    await createDestination(app, user, a.id);
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4]) ids.push((await ingest(a.slug, { 'x-id': `evt-${n}` }))!);
    await ingest(a.slug, { 'x-id': 'evt-1' }); // duplicate: counted, no new delivery

    // B: HMAC verification; an unsigned request is stored as invalid, never delivered.
    const b = await createEndpoint(app, user, {
      name: 'b',
      verification: { scheme: 'hmac', header: 'x-sig', encoding: 'hex', secret: 's3cret' },
    });
    await createDestination(app, user, b.id);
    await ingest(b.slug);
    const signed = createHmac('sha256', 's3cret').update('{"a":1}').digest('hex');
    await ingest(b.slug, { 'x-sig': signed });
    counters.invalidSignatureDropped.set(b.id, 3);

    // C: paused, so its pending delivery is held, not backlog.
    const c = await createEndpoint(app, user, { name: 'c' });
    await createDestination(app, user, c.id);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/endpoints/${c.id}`,
      payload: { paused: true },
      headers: { cookie: user.cookie },
    });
    await ingest(c.slug);

    // A's deliveries: succeeded, dead (exhausted), dead (4xx), still pending.
    const rows = await db
      .select({ id: deliveries.id, eventId: deliveries.eventId })
      .from(deliveries)
      .where(inArray(deliveries.eventId, ids));
    const byEvent = Object.fromEntries(rows.map((r) => [r.eventId, r.id]));
    const [ok, exhausted, rejected] = ids.map((id) => byEvent[id]!);
    await db.update(deliveries).set({ status: 'succeeded' }).where(eq(deliveries.id, ok!));
    await db
      .update(deliveries)
      .set({ status: 'dead', deadReason: 'exhausted' })
      .where(eq(deliveries.id, exhausted!));
    await db
      .update(deliveries)
      .set({ status: 'dead', deadReason: 'non_retryable_status' })
      .where(eq(deliveries.id, rejected!));

    const now = Date.now();
    const attempt = (
      deliveryId: string,
      durationMs: number,
      statusCode: number | null,
      ago = 0,
    ) => ({
      deliveryId,
      attemptNo: 1,
      workerId: 'w',
      startedAt: new Date(now - ago),
      durationMs,
      statusCode,
      ...(statusCode === null && { errorCode: 'ECONNRESET' }),
    });
    await db.insert(deliveryAttempts).values([
      attempt(ok!, 100, 200),
      attempt(exhausted!, 200, 500),
      attempt(exhausted!, 300, null),
      attempt(rejected!, 400, 201),
      attempt(rejected!, 9999, 200, 25 * 60 * 60 * 1000), // older than 24 h: not counted
    ]);

    const response = await stats(user);
    expect(response.statusCode).toBe(200);
    expect(response.json<Stats>()).toMatchObject({
      endpoints: 3,
      events: {
        stored: 7, // A: 4, B: 2 (one invalid), C: 1
        last24h: 7,
        duplicatesReceived: 1,
        invalidSignature: 1,
        invalidSignatureDroppedSinceStart: 3,
      },
      deliveries: {
        pending: 3, // A's 4th, B's signed one, C's held one
        inFlight: 0,
        succeeded: 1,
        dead: 2,
        due: 2, // not C's: its endpoint is paused
        deadByReason: { exhausted: 1, non_retryable_status: 1, redirect: 0 },
      },
      attemptsLast24h: {
        total: 4,
        succeeded: 2,
        successRate: 0.5,
        latencyMs: { p50: 250, p95: 385 }, // percentile_cont over 100, 200, 300, 400
      },
    });

    // Narrowed to one endpoint.
    const onlyB = (await stats(user, `?endpointId=${b.id}`)).json<Stats>();
    expect(onlyB).toMatchObject({
      endpointId: b.id,
      endpoints: 1,
      events: { stored: 2, invalidSignature: 1, invalidSignatureDroppedSinceStart: 3 },
      deliveries: { pending: 1, succeeded: 0, dead: 0, due: 1 },
      attemptsLast24h: { total: 0 },
    });
  });

  test("another user's endpoint is a 404, and nobody sees anyone else's traffic", async () => {
    const owner = await signUp(app);
    const endpoint = await createEndpoint(app, owner);
    await ingest(endpoint.slug);
    const stranger = await signUp(app);

    expect((await stats(stranger, `?endpointId=${endpoint.id}`)).statusCode).toBe(404);
    expect((await stats(stranger)).json<Stats>().events.stored).toBe(0);
    const [stored] = await db.select().from(events).where(eq(events.endpointId, endpoint.id));
    expect(stored).toBeDefined(); // the event really exists
  });

  test('requires authentication; validates endpointId', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/stats' })).statusCode).toBe(401);
    const user = await signUp(app);
    expect((await stats(user, '?endpointId=nope')).statusCode).toBe(400);
  });
});
