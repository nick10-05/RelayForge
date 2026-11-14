import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { deliveries, events } from '../db/schema.ts';
import { createDestination, createEndpoint, createTestApp, signUp } from '../testing/helpers.ts';
import type { TestEndpoint, TestUser } from '../testing/helpers.ts';
import { INGEST_BODY_LIMIT } from './routes.ts';

describe('ingest', () => {
  const t = createTestApp();
  const { app, db } = t;
  afterAll(() => t.close());
  beforeEach(() => t.wakeWorker.mockClear());

  async function setup(endpointBody?: object): Promise<{ user: TestUser; endpoint: TestEndpoint }> {
    const user = await signUp(app);
    const endpoint = await createEndpoint(app, user, endpointBody);
    return { user, endpoint };
  }

  const send = (
    slug: string,
    opts: {
      method?: 'POST' | 'PUT' | 'GET' | 'DELETE' | 'PATCH';
      body?: string | Buffer;
      headers?: Record<string, string>;
      suffix?: string;
    } = {},
  ) =>
    app.inject({
      method: opts.method ?? 'POST',
      url: `/in/${slug}${opts.suffix ?? ''}`,
      ...(opts.body !== undefined && { payload: opts.body }),
      headers: { 'content-type': 'application/json', ...opts.headers },
    });

  const eventRow = async (id: string) => {
    const [row] = await db.select().from(events).where(eq(events.id, id));
    if (!row) throw new Error('event not stored');
    return row;
  };

  const deliveryRows = (eventId: string) =>
    db.select().from(deliveries).where(eq(deliveries.eventId, eventId));

  test('stores the request and answers 202 with the event id', async () => {
    const { endpoint } = await setup();
    const response = await send(endpoint.slug, {
      body: '{"type":"payment.succeeded"}',
      headers: { 'x-custom': 'yes' },
      suffix: '/sub/path?a=1&b=2',
    });
    expect(response.statusCode).toBe(202);
    const { eventId } = response.json<{ eventId: string }>();

    const row = await eventRow(eventId);
    expect(row).toMatchObject({
      endpointId: endpoint.id,
      method: 'POST',
      path: `/in/${endpoint.slug}/sub/path`,
      query: 'a=1&b=2',
      contentType: 'application/json',
      sizeBytes: 28,
      signatureStatus: 'not_checked',
      duplicateCount: 0,
    });
    expect(row.headers['x-custom']).toBe('yes');
    expect(row.body.toString()).toBe('{"type":"payment.succeeded"}');
  });

  test('raw bytes are stored exactly: whitespace, key order and invalid UTF-8 survive', async () => {
    const { endpoint } = await setup();
    const odd = Buffer.concat([
      Buffer.from('{ "b": 1,\n\t"a" : 2 }  \r\n'),
      Buffer.from([0x00, 0xc3, 0x28, 0xff, 0xfe]), // NUL + invalid UTF-8 sequences
    ]);
    const response = await send(endpoint.slug, {
      body: odd,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const row = await eventRow(response.json<{ eventId: string }>().eventId);
    expect(row.body.equals(odd)).toBe(true);
  });

  test('accepts any method and any (or no) content type', async () => {
    const { endpoint } = await setup();
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      expect(
        (
          await send(endpoint.slug, {
            method,
            body: 'x',
            headers: { 'content-type': 'text/plain' },
          })
        ).statusCode,
      ).toBe(202);
    }
    const get = await send(endpoint.slug, { method: 'GET', headers: {} });
    expect(get.statusCode).toBe(202);
    expect((await eventRow(get.json<{ eventId: string }>().eventId)).sizeBytes).toBe(0);

    const form = await send(endpoint.slug, {
      body: 'a=1&b=2',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect((await eventRow(form.json<{ eventId: string }>().eventId)).body.toString()).toBe(
      'a=1&b=2',
    );

    const noType = await app.inject({
      method: 'POST',
      url: `/in/${endpoint.slug}`,
      payload: 'plain bytes',
    });
    expect(noType.statusCode).toBe(202);
    expect((await eventRow(noType.json<{ eventId: string }>().eventId)).body.toString()).toBe(
      'plain bytes',
    );
  });

  test('unknown or malformed slug → 404', async () => {
    expect((await send('A'.repeat(22), { body: '{}' })).statusCode).toBe(404);
    expect((await send('short', { body: '{}' })).statusCode).toBe(404);
    expect((await send("'; DROP TABLE events;--".padEnd(22, 'x'), { body: '{}' })).statusCode).toBe(
      404,
    );
  });

  test('body cap: exactly 1 MB is accepted, 1 MB + 1 byte is 413', async () => {
    const { endpoint } = await setup();
    const headers = { 'content-type': 'application/octet-stream' };
    expect(
      (await send(endpoint.slug, { body: Buffer.alloc(INGEST_BODY_LIMIT, 1), headers })).statusCode,
    ).toBe(202);
    const tooBig = await send(endpoint.slug, {
      body: Buffer.alloc(INGEST_BODY_LIMIT + 1, 1),
      headers,
    });
    expect(tooBig.statusCode).toBe(413);
  });

  test('zero destinations: stored for inspection, no deliveries, worker not woken', async () => {
    const { endpoint } = await setup();
    const response = await send(endpoint.slug, { body: '{}' });
    expect(response.statusCode).toBe(202);
    expect(await deliveryRows(response.json<{ eventId: string }>().eventId)).toHaveLength(0);
    expect(t.wakeWorker).not.toHaveBeenCalled();
  });

  test('invariant #1: one pending delivery per destination enabled at ingest time', async () => {
    const { user, endpoint } = await setup();
    const a = await createDestination(app, user, endpoint.id, {
      url: 'https://a.example.com',
      maxAttempts: 3,
    });
    const b = await createDestination(app, user, endpoint.id, { url: 'https://b.example.com' });
    const disabled = await createDestination(app, user, endpoint.id, {
      url: 'https://c.example.com',
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/endpoints/${endpoint.id}/destinations/${disabled.id}`,
      payload: { enabled: false },
      headers: { cookie: user.cookie },
    });

    const before = Date.now();
    const response = await send(endpoint.slug, { body: '{}' });
    const rows = await deliveryRows(response.json<{ eventId: string }>().eventId);

    expect(rows.map((r) => r.destinationId).sort()).toEqual([a.id, b.id].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        status: 'pending',
        trigger: 'auto',
        attemptCount: 0,
        leaseOwner: null,
      });
      expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    }
    expect(rows.find((r) => r.destinationId === a.id)?.maxAttempts).toBe(3); // snapshot
    expect(t.wakeWorker).toHaveBeenCalledTimes(1);
  });

  test('paused endpoint still stores and creates deliveries (held, not dropped)', async () => {
    const { user, endpoint } = await setup();
    await createDestination(app, user, endpoint.id);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/endpoints/${endpoint.id}`,
      payload: { paused: true },
      headers: { cookie: user.cookie },
    });
    const response = await send(endpoint.slug, { body: '{}' });
    expect(response.statusCode).toBe(202);
    expect(await deliveryRows(response.json<{ eventId: string }>().eventId)).toHaveLength(1);
  });

  describe('dedupe', () => {
    test('header: duplicate → 200 with the same id, counted, no new deliveries', async () => {
      const { user, endpoint } = await setup({
        name: 'gh',
        dedupeSource: 'header',
        dedupeName: 'X-GitHub-Delivery',
      });
      await createDestination(app, user, endpoint.id);
      const headers = { 'x-github-delivery': 'delivery-1' };

      const first = await send(endpoint.slug, { body: '{"n":1}', headers });
      expect(first.statusCode).toBe(202);
      const { eventId } = first.json<{ eventId: string }>();
      t.wakeWorker.mockClear();

      const second = await send(endpoint.slug, { body: '{"n":2}', headers });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ eventId, duplicate: true });

      const row = await eventRow(eventId);
      expect(row.duplicateCount).toBe(1);
      expect(row.lastDuplicateAt).not.toBeNull();
      expect(row.body.toString()).toBe('{"n":1}'); // original kept
      expect(await deliveryRows(eventId)).toHaveLength(1);
      expect(t.wakeWorker).not.toHaveBeenCalled();
    });

    test('json_field dedupe; non-JSON bodies are never deduplicated', async () => {
      const { endpoint } = await setup({
        name: 'stripe',
        dedupeSource: 'json_field',
        dedupeName: 'id',
      });
      const a = await send(endpoint.slug, { body: '{"id":"evt_1"}' });
      const b = await send(endpoint.slug, { body: '{"id":"evt_1","retry":true}' });
      expect(b.json<{ eventId: string }>().eventId).toBe(a.json<{ eventId: string }>().eventId);

      const c = await send(endpoint.slug, {
        body: 'not json',
        headers: { 'content-type': 'text/plain' },
      });
      const d = await send(endpoint.slug, {
        body: 'not json',
        headers: { 'content-type': 'text/plain' },
      });
      expect(c.statusCode).toBe(202);
      expect(d.statusCode).toBe(202);
      expect(c.json<{ eventId: string }>().eventId).not.toBe(d.json<{ eventId: string }>().eventId);
    });

    test('requests without the dedupe header are all new events', async () => {
      const { endpoint } = await setup({ name: 'gh', dedupeSource: 'header', dedupeName: 'x-id' });
      const a = await send(endpoint.slug, { body: '{}' });
      const b = await send(endpoint.slug, { body: '{}' });
      expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    });

    test('keys are scoped per endpoint', async () => {
      const cfg = { name: 'gh', dedupeSource: 'header', dedupeName: 'x-id' };
      const one = await setup(cfg);
      const two = await setup(cfg);
      const headers = { 'x-id': 'same-key' };
      expect((await send(one.endpoint.slug, { body: '{}', headers })).statusCode).toBe(202);
      expect((await send(two.endpoint.slug, { body: '{}', headers })).statusCode).toBe(202);
    });

    test('concurrent requests with the same key create exactly one event', async () => {
      const { user, endpoint } = await setup({
        name: 'gh',
        dedupeSource: 'header',
        dedupeName: 'x-id',
      });
      await createDestination(app, user, endpoint.id);
      await createDestination(app, user, endpoint.id, { url: 'https://other.example.com' });

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          send(endpoint.slug, { body: '{}', headers: { 'x-id': 'race' } }),
        ),
      );
      const statuses = responses.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 202]);
      const ids = new Set(responses.map((r) => r.json<{ eventId: string }>().eventId));
      expect(ids.size).toBe(1);

      const [eventId] = [...ids];
      const stored = await db.select().from(events).where(eq(events.endpointId, endpoint.id));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.duplicateCount).toBe(9);
      expect(await deliveryRows(eventId!)).toHaveLength(2);
    });
  });
});
