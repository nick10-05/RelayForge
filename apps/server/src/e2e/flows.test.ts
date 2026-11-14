// End-to-end: the real app over real HTTP, the real delivery worker, the chaos receiver.
// Every request goes through fetch → Fastify → Postgres → scheduler → outbound HTTP.
// Runs in the engine project (own database, one file at a time) because a live worker
// claims every due delivery in its database.
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../app.ts';
import { createDb, createPool } from '../db/client.ts';
import { createDecider } from '../delivery/classify.ts';
import { createHttpSender } from '../delivery/http-client.ts';
import { createScheduler } from '../delivery/scheduler.ts';
import { createRateLimiter } from '../lib/token-bucket.ts';
import { startChaosReceiver } from '../testing/chaos-receiver.ts';
import type { ChaosReceiver } from '../testing/chaos-receiver.ts';
import { createEngineContext } from '../testing/engine-context.ts';
import { fakeResolve } from '../testing/fake-dns.ts';
import { TEST_ORIGIN, TEST_PASSWORD, uniqueEmail } from '../testing/helpers.ts';
import { testSecretBox } from '../testing/test-keys.ts';
import { ENGINE_TEST_DATABASE_URL } from '../testing/test-support.ts';

type Json = Record<string, unknown>;
type Delivery = {
  id: string;
  status: string;
  deadReason: string | null;
  attemptCount: number;
  trigger: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(50);
  }
}
const tag = () => Math.random().toString(36).slice(2, 10);

describe('end to end (real HTTP + worker + chaos receiver)', () => {
  const ctx = createEngineContext();
  const pool = createPool(ENGINE_TEST_DATABASE_URL);
  const db = createDb(pool);
  let chaos: ChaosReceiver;
  let base = '';
  let wake = () => {};
  const app = buildApp({
    config: {
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      ALLOW_PRIVATE_DESTINATIONS: true,
      INGEST_BURST: 5,
      INGEST_RATE_PER_SECOND: 0.01, // ~no refill during the test: the 6th request is limited
    },
    pool,
    db,
    secretBox: testSecretBox,
    resolve: fakeResolve,
    wakeWorker: () => wake(),
    limits: {
      authIp: createRateLimiter({ capacity: 1e6, refillPerSecond: 1e6 }),
      loginEmail: createRateLimiter({ capacity: 1e6, refillPerSecond: 1e6 }),
    },
  });
  const worker = createScheduler({
    db,
    pool,
    send: createHttpSender({ production: false, allowPrivate: true, secretBox: testSecretBox }),
    decide: createDecider({ baseMs: 50, capMs: 3_600_000, random: Math.random }),
  });
  wake = worker.wake;

  beforeAll(async () => {
    await ctx.reset();
    chaos = await startChaosReceiver();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    worker.start();
  });
  afterAll(async () => {
    await worker.stop(2000);
    await app.close();
    await chaos.close();
    await pool.end();
    await ctx.close();
  });

  /** A browser-like client: keeps the session cookie, sends our Origin. */
  async function newUser() {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown, headers: Json = {}) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          origin: TEST_ORIGIN,
          ...(cookie && { cookie }),
          ...(body !== undefined && { 'content-type': 'application/json' }),
          ...(headers as Record<string, string>),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const setCookie = response.headers
        .getSetCookie()
        .find((c) => c.startsWith('__Host-rf_session='));
      if (setCookie) cookie = setCookie.split(';')[0]!;
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        json: (text ? JSON.parse(text) : {}) as Json,
      };
    };
    const email = uniqueEmail();
    expect(
      (await call('POST', '/api/v1/auth/signup', { email, password: TEST_PASSWORD })).status,
    ).toBe(201);
    return { call, email };
  }
  type User = Awaited<ReturnType<typeof newUser>>;

  async function endpointWithDestination(user: User, destPath: string, endpointBody: Json = {}) {
    const ep = await user.call('POST', '/api/v1/endpoints', { name: 'e2e', ...endpointBody });
    expect(ep.status).toBe(201);
    const endpoint = ep.json['endpoint'] as { id: string; slug: string };
    const dest = await user.call('POST', `/api/v1/endpoints/${endpoint.id}/destinations`, {
      url: `${chaos.url}${destPath}`,
      timeoutMs: 2000,
      maxAttempts: 3,
    });
    expect(dest.status).toBe(201);
    return {
      endpoint,
      destination: dest.json['destination'] as { id: string },
      signingSecret: dest.json['signingSecret'] as string,
    };
  }

  const ingest = (slug: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/in/${slug}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }).then(async (r) => ({
      status: r.status,
      headers: r.headers,
      json: (await r.json()) as Json,
    }));

  const deliveriesOf = async (user: User, eventId: string) =>
    (
      (await user.call('GET', `/api/v1/events/${eventId}`)).json['event'] as {
        deliveries: Delivery[];
      }
    ).deliveries;
  const waitTerminal = (user: User, eventId: string) =>
    waitFor(async () => {
      const ds = await deliveriesOf(user, eventId);
      return ds.length > 0 && ds.every((d) => d.status === 'succeeded' || d.status === 'dead')
        ? ds
        : undefined;
    });

  test('F1/F3/F5: ingest → deliver → fail → retry → succeed, signed, same event id', async () => {
    const user = await newUser();
    const path = `/flaky/2/${tag()}`;
    const { endpoint, signingSecret } = await endpointWithDestination(user, path);
    const body = '{"type":"payment.succeeded",  "amount": 42}';

    const accepted = await ingest(endpoint.slug, body);
    expect(accepted.status).toBe(202);
    const eventId = accepted.json['eventId'] as string;

    const [delivery] = await waitTerminal(user, eventId);
    expect(delivery).toMatchObject({ status: 'succeeded', attemptCount: 3 });

    const received = chaos.requestsTo(path);
    expect(received.map((r) => r.headers['x-relayforge-attempt'])).toEqual(['1', '2', '3']);
    for (const r of received) {
      expect(r.body.toString()).toBe(body); // raw bytes, never re-serialised
      expect(r.headers['x-relayforge-id']).toBe(eventId); // receiver dedupe key
      expect(() =>
        new Webhook(signingSecret).verify(r.body, {
          'webhook-id': r.headers['x-relayforge-id'] as string,
          'webhook-timestamp': r.headers['x-relayforge-timestamp'] as string,
          'webhook-signature': r.headers['x-relayforge-signature'] as string,
        }),
      ).not.toThrow();
    }
  });

  test('F4: ingest → dead → fix the destination → manual retry → succeed; double-click safe', async () => {
    const user = await newUser();
    const t = tag();
    const { endpoint, destination } = await endpointWithDestination(user, `/status/404/${t}`);
    const eventId = (await ingest(endpoint.slug, '{"n":1}')).json['eventId'] as string;
    const [dead] = await waitTerminal(user, eventId);
    expect(dead).toMatchObject({
      status: 'dead',
      deadReason: 'non_retryable_status',
      attemptCount: 1,
    });

    const patch = await user.call(
      'PATCH',
      `/api/v1/endpoints/${endpoint.id}/destinations/${destination.id}`,
      { url: `${chaos.url}/ok/${t}` },
    );
    expect(patch.status).toBe(200);

    // Two clicks at once: exactly one new delivery.
    const clicks = await Promise.all([
      user.call('POST', `/api/v1/deliveries/${dead!.id}/retry`),
      user.call('POST', `/api/v1/deliveries/${dead!.id}/retry`),
    ]);
    const statuses = clicks.map((c) => c.status).sort();
    expect(statuses[0]).toBe(202);
    // 409 normally. Both 202 only if the first retry was already delivered when the second
    // click arrived — two sequential deliveries, never two active at once.
    expect([202, 409]).toContain(statuses[1]);
    const final = await waitFor(async () => {
      const ds = await deliveriesOf(user, eventId);
      const manual = ds.filter((d) => d.trigger === 'manual');
      return manual.length > 0 && manual.every((d) => d.status === 'succeeded') ? ds : undefined;
    });
    expect(final.filter((d) => d.trigger === 'manual').length).toBeLessThanOrEqual(2);
    expect(chaos.requestsTo(`/ok/${t}`).length).toBe(
      final.filter((d) => d.trigger === 'manual').length,
    );
  });

  test('F8: forged requests → 401, stored, never forwarded; signed ones are delivered', async () => {
    const user = await newUser();
    const path = `/ok/${tag()}`;
    const secret = 'e2e-hmac-secret';
    const { endpoint } = await endpointWithDestination(user, path, {
      verification: { scheme: 'hmac', header: 'x-signature', encoding: 'hex', secret },
    });
    const body = '{"order":7}';
    const forged = await ingest(endpoint.slug, body, { 'x-signature': 'deadbeef' });
    expect(forged.status).toBe(401);
    const signed = await ingest(endpoint.slug, body, {
      'x-signature': createHmac('sha256', secret).update(body).digest('hex'),
    });
    expect(signed.status).toBe(202);
    await waitTerminal(user, signed.json['eventId'] as string);
    await sleep(300); // give a (wrong) delivery of the forged event time to show up
    expect(chaos.requestsTo(path)).toHaveLength(1);

    const list = await user.call('GET', `/api/v1/endpoints/${endpoint.id}/events`);
    const statuses = (list.json['events'] as { signatureStatus: string }[])
      .map((e) => e.signatureStatus)
      .sort();
    expect(statuses).toEqual(['invalid', 'valid']);
  });

  test('F2: a duplicate (same dedupe key) is counted, not forwarded again', async () => {
    const user = await newUser();
    const path = `/ok/${tag()}`;
    const { endpoint } = await endpointWithDestination(user, path, {
      dedupeSource: 'header',
      dedupeName: 'X-Delivery-Id',
    });
    const first = await ingest(endpoint.slug, '{}', { 'x-delivery-id': 'abc-1' });
    const second = await ingest(endpoint.slug, '{}', { 'x-delivery-id': 'abc-1' });
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.json).toEqual({ eventId: first.json['eventId'], duplicate: true });
    await waitTerminal(user, first.json['eventId'] as string);
    await sleep(300);
    expect(chaos.requestsTo(path)).toHaveLength(1);
  });

  test('pause holds deliveries (never drops); resume releases them', async () => {
    const user = await newUser();
    const path = `/ok/${tag()}`;
    const { endpoint } = await endpointWithDestination(user, path);
    await user.call('PATCH', `/api/v1/endpoints/${endpoint.id}`, { paused: true });
    const eventId = (await ingest(endpoint.slug, '{}')).json['eventId'] as string;
    await sleep(500);
    expect(chaos.requestsTo(path)).toHaveLength(0);
    expect((await deliveriesOf(user, eventId))[0]!.status).toBe('pending');

    await user.call('PATCH', `/api/v1/endpoints/${endpoint.id}`, { paused: false });
    expect((await waitTerminal(user, eventId))[0]!.status).toBe('succeeded');
    expect(chaos.requestsTo(path)).toHaveLength(1);
  });

  test('F7: an API key works over HTTP without cookies or Origin', async () => {
    const user = await newUser();
    const key = (await user.call('POST', '/api/v1/api-keys', { name: 'ci' })).json['key'] as string;
    const response = await fetch(`${base}/api/v1/endpoints`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'made-by-ci' }),
    });
    expect(response.status).toBe(201);
  });

  test('F9: ingest rate limit → 429 + Retry-After; body cap → 413; CSRF → 403', async () => {
    const user = await newUser();
    const { endpoint } = await endpointWithDestination(user, `/ok/${tag()}`);
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await ingest(endpoint.slug, '{}')).status);
    expect(codes).toEqual([202, 202, 202, 202, 202, 429]);

    const limited = await ingest(endpoint.slug, '{}');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    const other = await endpointWithDestination(user, `/ok/${tag()}`);
    const tooBig = await fetch(`${base}/in/${other.endpoint.slug}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(1024 * 1024 + 1),
    });
    expect(tooBig.status).toBe(413);

    const csrf = await user.call(
      'POST',
      '/api/v1/endpoints',
      { name: 'x' },
      { origin: 'https://evil.example' },
    );
    expect(csrf.status).toBe(403);
  });
});
