// Inbound signature verification + the invalid-signature policy (design §7.2), end to end
// through the API: configure an endpoint, send signed / forged requests, inspect what was stored.
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { deliveries, endpoints, events } from '../db/schema.ts';
import { generateSigningSecret } from '../delivery/signing.ts';
import { createDestination, createEndpoint, createTestApp, signUp } from '../testing/helpers.ts';
import type { TestEndpoint, TestUser } from '../testing/helpers.ts';
import { INVALID_SIGNATURE } from './routes.ts';
import { INVALID_BODY_LIMIT } from './store.ts';

const HMAC_SECRET = 'github-style-secret-value';
const GITHUB = {
  scheme: 'hmac',
  header: 'X-Hub-Signature-256',
  prefix: 'sha256=',
  encoding: 'hex',
  secret: HMAC_SECRET,
};
const githubSig = (body: string | Buffer, secret = HMAC_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('inbound signature verification', () => {
  const t = createTestApp();
  const { app, db } = t;
  afterAll(() => t.close());
  beforeEach(() => t.wakeWorker.mockClear());

  async function setup(endpointBody: object): Promise<{ user: TestUser; endpoint: TestEndpoint }> {
    const user = await signUp(app);
    const endpoint = await createEndpoint(app, user, { name: 'verified', ...endpointBody });
    await createDestination(app, user, endpoint.id);
    return { user, endpoint };
  }

  const send = (slug: string, body: string | Buffer, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `/in/${slug}`,
      payload: body,
      headers: { 'content-type': 'application/json', ...headers },
    });

  const eventsOf = (endpointId: string) =>
    db.select().from(events).where(eq(events.endpointId, endpointId));
  const deliveriesOf = async (endpointId: string) => {
    const rows = await db
      .select({ id: deliveries.id })
      .from(deliveries)
      .innerJoin(events, eq(events.id, deliveries.eventId))
      .where(eq(events.endpointId, endpointId));
    return rows;
  };

  describe('configuration API', () => {
    test('the secret is write-only and stored sealed (AES-GCM), never in clear', async () => {
      const user = await signUp(app);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/endpoints',
        payload: { name: 'gh', verification: GITHUB },
        headers: { cookie: user.cookie },
      });
      expect(response.statusCode).toBe(201);
      expect(response.body).not.toContain(HMAC_SECRET);
      const { endpoint } = response.json<{ endpoint: { id: string; verification: unknown } }>();
      expect(endpoint.verification).toEqual({
        scheme: 'hmac',
        header: 'x-hub-signature-256', // normalised
        prefix: 'sha256=',
        encoding: 'hex',
        hasSecret: true,
      });

      const [row] = await db.select().from(endpoints).where(eq(endpoints.id, endpoint.id));
      expect(row!.verifySecretEnc).toMatch(/^v1:test1:/);
      expect(row!.verifySecretEnc).not.toContain(HMAC_SECRET);

      const read = await app.inject({
        url: `/api/v1/endpoints/${endpoint.id}`,
        headers: { cookie: user.cookie },
      });
      expect(read.body).not.toContain(HMAC_SECRET);
      expect(read.body).not.toContain(row!.verifySecretEnc!);
    });

    test.each([
      [{ scheme: 'hmac', header: 'bad header', encoding: 'hex', secret: 'x' }],
      [{ scheme: 'hmac', header: 'x-sig', encoding: 'base32', secret: 'x' }],
      [{ scheme: 'hmac', header: 'x-sig', encoding: 'hex', secret: '' }],
      [{ scheme: 'standard_webhooks', secret: 'not-a-whsec-secret' }],
      [{ scheme: 'rsa' }],
    ])('rejects invalid config %j with 400, without echoing the secret', async (verification) => {
      const user = await signUp(app);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/endpoints',
        payload: { name: 'bad', verification },
        headers: { cookie: user.cookie },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('not-a-whsec-secret');
    });

    test('PATCH replaces the config; "none" turns verification off', async () => {
      const { user, endpoint } = await setup({ verification: GITHUB });
      expect((await send(endpoint.slug, '{}')).statusCode).toBe(401);

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/endpoints/${endpoint.id}`,
        payload: { verification: { scheme: 'none' } },
        headers: { cookie: user.cookie },
      });
      expect(patched.json()).toMatchObject({
        endpoint: { verification: { scheme: 'none', hasSecret: false } },
      });
      const accepted = await send(endpoint.slug, '{}');
      expect(accepted.statusCode).toBe(202);
      const [row] = await db
        .select()
        .from(events)
        .where(eq(events.id, accepted.json<{ eventId: string }>().eventId));
      expect(row!.signatureStatus).toBe('not_checked');
    });
  });

  describe('hmac', () => {
    test('valid signature → 202, stored as valid, delivered as usual', async () => {
      const { endpoint } = await setup({ verification: GITHUB });
      const body = '{"action":"opened"}';
      const response = await send(endpoint.slug, body, { 'x-hub-signature-256': githubSig(body) });
      expect(response.statusCode).toBe(202);
      const [event] = await eventsOf(endpoint.id);
      expect(event).toMatchObject({ signatureStatus: 'valid', signatureFailureReason: null });
      expect(await deliveriesOf(endpoint.id)).toHaveLength(1);
      expect(t.wakeWorker).toHaveBeenCalledOnce();
    });

    test.each([
      ['missing_header', {}],
      ['malformed', { 'x-hub-signature-256': 'md5=abc' }],
      ['mismatch', { 'x-hub-signature-256': githubSig('{"other":true}') }],
      ['mismatch', { 'x-hub-signature-256': githubSig('{"action":"opened"}', 'wrong-secret') }],
    ])(
      'invalid (%s) → 401 with the same body; stored invalid; no delivery; worker not woken',
      async (reason, headers) => {
        const { endpoint } = await setup({ verification: GITHUB });
        const response = await send(endpoint.slug, '{"action":"opened"}', headers);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual(INVALID_SIGNATURE); // identical whatever the reason

        const stored = await eventsOf(endpoint.id);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({
          signatureStatus: 'invalid',
          signatureFailureReason: reason,
          dedupeKey: null,
          bodyTruncated: false,
        });
        expect(stored[0]!.body.toString()).toBe('{"action":"opened"}');
        expect(await deliveriesOf(endpoint.id)).toHaveLength(0); // invariant #8
        expect(t.wakeWorker).not.toHaveBeenCalled();
      },
    );

    test('an invalid body is cut to 64 KB; size_bytes keeps the real size', async () => {
      const { endpoint } = await setup({ verification: GITHUB });
      const big = Buffer.alloc(200 * 1024, 'a');
      expect(
        (await send(endpoint.slug, big, { 'x-hub-signature-256': 'sha256=00' })).statusCode,
      ).toBe(401);
      const [event] = await eventsOf(endpoint.id);
      expect(event!.body).toHaveLength(INVALID_BODY_LIMIT);
      expect(event).toMatchObject({ bodyTruncated: true, sizeBytes: 200 * 1024 });
    });

    test('a valid body over 64 KB is stored whole (truncation is for invalid events only)', async () => {
      const { endpoint } = await setup({ verification: GITHUB });
      const big = Buffer.alloc(200 * 1024, 'b');
      expect(
        (await send(endpoint.slug, big, { 'x-hub-signature-256': githubSig(big) })).statusCode,
      ).toBe(202);
      const [event] = await eventsOf(endpoint.id);
      expect(event!.body).toHaveLength(200 * 1024);
      expect(event!.bodyTruncated).toBe(false);
    });
  });

  describe('standard_webhooks', () => {
    const secret = generateSigningSecret();
    const signed = (body: string, ts = Math.floor(Date.now() / 1000), id = 'msg_1') => ({
      'webhook-id': id,
      'webhook-timestamp': String(ts),
      'webhook-signature': new Webhook(secret).sign(id, new Date(ts * 1000), body),
    });

    test('valid → 202; replayed after 300 s → 401 timestamp_out_of_tolerance', async () => {
      const { endpoint } = await setup({ verification: { scheme: 'standard_webhooks', secret } });
      expect((await send(endpoint.slug, '{"a":1}', signed('{"a":1}'))).statusCode).toBe(202);

      const old = Math.floor(Date.now() / 1000) - 301;
      expect((await send(endpoint.slug, '{"a":1}', signed('{"a":1}', old))).statusCode).toBe(401);
      const invalid = await db
        .select()
        .from(events)
        .where(and(eq(events.endpointId, endpoint.id), eq(events.signatureStatus, 'invalid')));
      expect(invalid.map((e) => e.signatureFailureReason)).toEqual(['timestamp_out_of_tolerance']);
    });
  });

  test('dedupe: a forged request cannot reserve a real event id', async () => {
    const { endpoint } = await setup({
      verification: GITHUB,
      dedupeSource: 'header',
      dedupeName: 'X-GitHub-Delivery',
    });
    const body = '{"action":"opened"}';
    // The attacker guesses the next delivery id and sends it first, unsigned.
    const forged = await send(endpoint.slug, body, { 'x-github-delivery': 'guid-1' });
    expect(forged.statusCode).toBe(401);
    // The genuine event with that id must NOT be treated as a duplicate.
    const genuine = await send(endpoint.slug, body, {
      'x-github-delivery': 'guid-1',
      'x-hub-signature-256': githubSig(body),
    });
    expect(genuine.statusCode).toBe(202);
    expect(genuine.json()).not.toHaveProperty('duplicate');
    expect(await deliveriesOf(endpoint.id)).toHaveLength(1);
    // A second genuine copy IS a duplicate.
    const again = await send(endpoint.slug, body, {
      'x-github-delivery': 'guid-1',
      'x-hub-signature-256': githubSig(body),
    });
    expect(again.json()).toMatchObject({ duplicate: true });
  });

  test('an invalid event can never be replayed or bulk-redelivered (422 / skipped)', async () => {
    const { user, endpoint } = await setup({ verification: GITHUB });
    await send(endpoint.slug, '{}', { 'x-hub-signature-256': githubSig('{"x":1}') });
    const [event] = await eventsOf(endpoint.id);

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${event!.id}/replay`,
      headers: { cookie: user.cookie },
    });
    expect(replay.statusCode).toBe(422);
    const bulk = await app.inject({
      method: 'POST',
      url: `/api/v1/endpoints/${endpoint.id}/redeliver-dead`,
      headers: { cookie: user.cookie },
    });
    expect(bulk.json()).toMatchObject({ created: 0 });
    expect(await deliveriesOf(endpoint.id)).toHaveLength(0);

    // The owner sees the reason in the event detail; the expected signature is never shown.
    const detail = await app.inject({
      url: `/api/v1/events/${event!.id}`,
      headers: { cookie: user.cookie },
    });
    expect(detail.json()).toMatchObject({
      event: { signatureStatus: 'invalid', signatureFailureReason: 'mismatch' },
    });
    expect(detail.body).not.toContain(githubSig('{}'));
  });

  test('AAD: a verify secret copied from another endpoint cannot be opened → 503, nothing stored', async () => {
    const a = await setup({ verification: GITHUB });
    const b = await setup({ verification: { ...GITHUB, secret: 'b-secret' } });
    const [rowA] = await db.select().from(endpoints).where(eq(endpoints.id, a.endpoint.id));
    // Someone with SQL access copies A's sealed secret onto B, hoping B now accepts A's MACs.
    await db
      .update(endpoints)
      .set({ verifySecretEnc: rowA!.verifySecretEnc })
      .where(eq(endpoints.id, b.endpoint.id));

    const body = '{"x":1}';
    const response = await send(b.endpoint.slug, body, { 'x-hub-signature-256': githubSig(body) });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'signature_check_unavailable' });
    expect(await eventsOf(b.endpoint.id)).toHaveLength(0);
  });
});
