// Redelivery API (design §4.9) and destination signing secrets (§7.2). The worker is not
// running here: deliveries are moved to `dead` directly to set up each case.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { deliveries, events } from '../db/schema.ts';
import { createDestination, createEndpoint, createTestApp, signUp } from '../testing/helpers.ts';
import type { TestUser } from '../testing/helpers.ts';

describe('redelivery API', () => {
  const { app, db, wakeWorker, close } = createTestApp();
  afterAll(close);
  beforeEach(() => wakeWorker.mockClear());

  const post = (user: TestUser, url: string, payload?: object) =>
    app.inject({
      method: 'POST',
      url,
      ...(payload && { payload }),
      headers: { cookie: user.cookie },
    });

  /** User → endpoint → N destinations → one ingested event with N pending deliveries. */
  async function setup(destinationCount = 1) {
    const user = await signUp(app);
    const endpoint = await createEndpoint(app, user);
    const destinationIds: string[] = [];
    for (let i = 0; i < destinationCount; i++) {
      destinationIds.push((await createDestination(app, user, endpoint.id)).id);
    }
    const ingest = await app.inject({
      method: 'POST',
      url: `/in/${endpoint.slug}`,
      payload: { hello: 'world' },
    });
    const { eventId } = ingest.json<{ eventId: string }>();
    const rows = await db.select().from(deliveries).where(eq(deliveries.eventId, eventId));
    wakeWorker.mockClear();
    return { user, endpoint, destinationIds, eventId, deliveryIds: rows.map((r) => r.id) };
  }

  const markDead = (id: string) =>
    db
      .update(deliveries)
      .set({ status: 'dead', deadReason: 'exhausted', completedAt: new Date() })
      .where(eq(deliveries.id, id));

  const markSucceeded = (id: string) =>
    db
      .update(deliveries)
      .set({ status: 'succeeded', completedAt: new Date() })
      .where(eq(deliveries.id, id));

  describe('POST /deliveries/:id/retry', () => {
    test('a dead delivery → 202 with a new manual delivery linked to the original', async () => {
      const { user, deliveryIds } = await setup();
      await markDead(deliveryIds[0]!);

      const response = await post(user, `/api/v1/deliveries/${deliveryIds[0]}/retry`);
      expect(response.statusCode).toBe(202);
      const { deliveryId } = response.json<{ deliveryId: string }>();
      expect(deliveryId).not.toBe(deliveryIds[0]);

      const [row] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
      expect(row).toMatchObject({
        status: 'pending',
        trigger: 'manual',
        replayOf: deliveryIds[0],
        attemptCount: 0,
      });
      expect(wakeWorker).toHaveBeenCalledTimes(1);
    });

    test('second click → 409 with the same active id', async () => {
      const { user, deliveryIds } = await setup();
      await markDead(deliveryIds[0]!);
      const first = await post(user, `/api/v1/deliveries/${deliveryIds[0]}/retry`);
      const second = await post(user, `/api/v1/deliveries/${deliveryIds[0]}/retry`);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({
        error: 'active_delivery_exists',
        deliveryId: first.json<{ deliveryId: string }>().deliveryId,
      });
    });

    test('concurrent double-click creates exactly one delivery', async () => {
      const { user, eventId, deliveryIds } = await setup();
      await markDead(deliveryIds[0]!);
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => post(user, `/api/v1/deliveries/${deliveryIds[0]}/retry`)),
      );
      const codes = responses.map((r) => r.statusCode).sort();
      expect(codes).toEqual([202, 409, 409, 409, 409, 409, 409, 409]);
      const ids = new Set(responses.map((r) => r.json<{ deliveryId: string }>().deliveryId));
      expect(ids.size).toBe(1);
      const active = await db
        .select()
        .from(deliveries)
        .where(and(eq(deliveries.eventId, eventId), eq(deliveries.status, 'pending')));
      expect(active).toHaveLength(1);
    });

    test('a still-pending delivery → 409 with its own id', async () => {
      const { user, deliveryIds } = await setup();
      const response = await post(user, `/api/v1/deliveries/${deliveryIds[0]}/retry`);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ deliveryId: deliveryIds[0] });
    });

    test('a succeeded delivery → 422 (replay the event instead)', async () => {
      const { user, deliveryIds } = await setup();
      await markSucceeded(deliveryIds[0]!);
      const response = await post(user, `/api/v1/deliveries/${deliveryIds[0]}/retry`);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: 'delivery_not_dead' });
    });

    test("another user's delivery → 404", async () => {
      const { deliveryIds } = await setup();
      await markDead(deliveryIds[0]!);
      const intruder = await signUp(app);
      const response = await post(intruder, `/api/v1/deliveries/${deliveryIds[0]}/retry`);
      expect(response.statusCode).toBe(404);
    });

    test('an invalid-signature event is never retried → 422', async () => {
      const { user, eventId, deliveryIds } = await setup();
      await markDead(deliveryIds[0]!);
      await db
        .update(events)
        .set({ signatureStatus: 'invalid', signatureFailureReason: 'mismatch' })
        .where(eq(events.id, eventId));
      const response = await post(user, `/api/v1/deliveries/${deliveryIds[0]}/retry`);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: 'invalid_signature_event' });
      expect(wakeWorker).not.toHaveBeenCalled();
    });
  });

  describe('POST /events/:id/replay', () => {
    test('replays to every enabled destination; repeated → 409', async () => {
      const { user, eventId, deliveryIds } = await setup(2);
      await markSucceeded(deliveryIds[0]!);
      await markSucceeded(deliveryIds[1]!);

      const first = await post(user, `/api/v1/events/${eventId}/replay`);
      expect(first.statusCode).toBe(202);
      const body = first.json<{ deliveries: { created: boolean; deliveryId: string }[] }>();
      expect(body.deliveries).toHaveLength(2);
      expect(body.deliveries.every((d) => d.created)).toBe(true);
      expect(wakeWorker).toHaveBeenCalledTimes(1);

      const second = await post(user, `/api/v1/events/${eventId}/replay`);
      expect(second.statusCode).toBe(409);
      expect(
        second.json<{ deliveries: { created: boolean }[] }>().deliveries.every((d) => !d.created),
      ).toBe(true);
    });

    test('partial: one destination busy, the other replayed → 202 with both reported', async () => {
      const { user, eventId, destinationIds, deliveryIds } = await setup(2);
      const busy = (
        await db.select().from(deliveries).where(eq(deliveries.id, deliveryIds[0]!))
      )[0]!;
      await markSucceeded(deliveryIds[1]!);
      const response = await post(user, `/api/v1/events/${eventId}/replay`);
      expect(response.statusCode).toBe(202);
      const results = response.json<{
        deliveries: { destinationId: string; deliveryId: string; created: boolean }[];
      }>().deliveries;
      const byDestination = Object.fromEntries(results.map((r) => [r.destinationId, r]));
      expect(byDestination[busy.destinationId]).toMatchObject({
        created: false,
        deliveryId: busy.id,
      });
      const other = destinationIds.find((id) => id !== busy.destinationId)!;
      expect(byDestination[other]).toMatchObject({ created: true });
    });

    test('a chosen subset of destinations', async () => {
      const { user, eventId, destinationIds, deliveryIds } = await setup(2);
      await markSucceeded(deliveryIds[0]!);
      await markSucceeded(deliveryIds[1]!);
      const response = await post(user, `/api/v1/events/${eventId}/replay`, {
        destinationIds: [destinationIds[1]],
      });
      expect(response.statusCode).toBe(202);
      expect(response.json<{ deliveries: unknown[] }>().deliveries).toEqual([
        expect.objectContaining({ destinationId: destinationIds[1], created: true }),
      ]);
    });

    test('invalid-signature event → 422; unknown or foreign event → 404', async () => {
      const { user, eventId } = await setup();
      await db.update(events).set({ signatureStatus: 'invalid' }).where(eq(events.id, eventId));
      expect((await post(user, `/api/v1/events/${eventId}/replay`)).statusCode).toBe(422);
      const intruder = await signUp(app);
      expect((await post(intruder, `/api/v1/events/${eventId}/replay`)).statusCode).toBe(404);
    });
  });

  describe('POST /endpoints/:id/redeliver-dead', () => {
    test('creates one delivery per latest dead (event, destination), in batches', async () => {
      const user = await signUp(app);
      const endpoint = await createEndpoint(app, user);
      await createDestination(app, user, endpoint.id);
      const eventIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await app.inject({ method: 'POST', url: `/in/${endpoint.slug}`, payload: { i } });
        eventIds.push(r.json<{ eventId: string }>().eventId);
      }
      const rows = await db.select().from(deliveries);
      const mine = rows.filter((r) => eventIds.includes(r.eventId));
      for (const r of mine) await markDead(r.id);
      // Event 0: already retried and succeeded since → must not be resent.
      const retried = await post(user, `/api/v1/deliveries/${mine[0]!.id}/retry`);
      await markSucceeded(retried.json<{ deliveryId: string }>().deliveryId);
      wakeWorker.mockClear();

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/endpoints/${endpoint.id}/redeliver-dead`,
        headers: { cookie: user.cookie },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ created: 4, skipped: 0 });
      expect(wakeWorker).toHaveBeenCalledTimes(1);

      // Repeating while those 4 are pending creates nothing new.
      const again = await post(user, `/api/v1/endpoints/${endpoint.id}/redeliver-dead`);
      expect(again.json()).toEqual({ created: 0, skipped: 0 });
    });

    test('small batch size still covers everything', async () => {
      const { redeliverDead } = await import('../delivery/redeliver.ts');
      const user = await signUp(app);
      const endpoint = await createEndpoint(app, user);
      await createDestination(app, user, endpoint.id);
      for (let i = 0; i < 7; i++) {
        await app.inject({ method: 'POST', url: `/in/${endpoint.slug}`, payload: { i } });
      }
      const pending = await db.select().from(deliveries).where(eq(deliveries.status, 'pending'));
      const own = await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.endpointId, endpoint.id));
      const ownIds = new Set(own.map((e) => e.id));
      for (const r of pending.filter((p) => ownIds.has(p.eventId))) await markDead(r.id);

      const result = await redeliverDead(db, user.id, endpoint.id, { batchSize: 3 });
      expect(result).toEqual({ kind: 'done', created: 7, skipped: 0 });
    });

    test("another user's endpoint → 404", async () => {
      const { endpoint } = await setup();
      const intruder = await signUp(app);
      expect(
        (await post(intruder, `/api/v1/endpoints/${endpoint.id}/redeliver-dead`)).statusCode,
      ).toBe(404);
    });
  });
});

describe('destination signing secrets and wake-ups', () => {
  const { app, wakeWorker, close } = createTestApp();
  afterAll(close);

  const call = (user: TestUser, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, ...(payload && { payload }), headers: { cookie: user.cookie } });

  async function setup() {
    const user = await signUp(app);
    const endpoint = await createEndpoint(app, user);
    const base = `/api/v1/endpoints/${endpoint.id}/destinations`;
    const created = await call(user, 'POST', base, { url: 'https://example.com/hook' });
    const body = created.json<{ destination: { id: string }; signingSecret: string }>();
    return { user, endpoint, base, id: body.destination.id, secret: body.signingSecret };
  }

  test('create returns a whsec_ secret once; the DTO never contains it', async () => {
    const { user, base, id, secret } = await setup();
    expect(secret).toMatch(/^whsec_/);
    const list = await call(user, 'GET', base);
    expect(list.body).not.toContain(secret);
    expect(list.body).not.toContain('signingSecretEnc');
    const shown = await call(user, 'GET', `${base}/${id}/secret`);
    expect(shown.json()).toEqual({
      signingSecret: secret,
      previousSigningSecret: null,
      previousExpiresAt: null,
    });
  });

  test('rotation keeps the previous secret for 24 h', async () => {
    const { user, base, id, secret } = await setup();
    const rotated = await call(user, 'POST', `${base}/${id}/rotate-secret`);
    expect(rotated.statusCode).toBe(200);
    const { signingSecret, previousExpiresAt } = rotated.json<{
      signingSecret: string;
      previousExpiresAt: string;
    }>();
    expect(signingSecret).toMatch(/^whsec_/);
    expect(signingSecret).not.toBe(secret);
    const hours = (new Date(previousExpiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    const shown = (await call(user, 'GET', `${base}/${id}/secret`)).json<Record<string, unknown>>();
    expect(shown).toMatchObject({ signingSecret, previousSigningSecret: secret });
  });

  test("another user can't read or rotate the secret", async () => {
    const { base, id } = await setup();
    const intruder = await signUp(app);
    expect((await call(intruder, 'GET', `${base}/${id}/secret`)).statusCode).toBe(404);
    expect((await call(intruder, 'POST', `${base}/${id}/rotate-secret`)).statusCode).toBe(404);
  });

  test('re-enabling a destination wakes the worker; disabling does not', async () => {
    const { user, base, id } = await setup();
    wakeWorker.mockClear();
    await call(user, 'PATCH', `${base}/${id}`, { enabled: false });
    expect(wakeWorker).not.toHaveBeenCalled();
    await call(user, 'PATCH', `${base}/${id}`, { enabled: true });
    expect(wakeWorker).toHaveBeenCalledTimes(1);
  });

  test('resuming a paused endpoint wakes the worker; pausing does not', async () => {
    const { user, endpoint } = await setup();
    wakeWorker.mockClear();
    await call(user, 'PATCH', `/api/v1/endpoints/${endpoint.id}`, { paused: true });
    expect(wakeWorker).not.toHaveBeenCalled();
    await call(user, 'PATCH', `/api/v1/endpoints/${endpoint.id}`, { paused: false });
    expect(wakeWorker).toHaveBeenCalledTimes(1);
  });
});
