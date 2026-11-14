// Retention (design §8.3) against the engine test database (it deletes across tenants).
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { deliveries, deliveryAttempts, events } from '../db/schema.ts';
import type { DeliveryStatus } from '../db/schema.ts';
import { createEngineContext } from '../testing/engine-context.ts';
import { createRetentionJob, runRetention } from './retention.ts';

describe('retention', () => {
  const ctx = createEngineContext();
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  /** One event with one delivery in `status`, received `ageHours` ago. */
  async function eventAged(
    ageHours: number,
    opts: { status?: DeliveryStatus; invalid?: boolean; deliveries?: boolean } = {},
  ) {
    const { deliveryIds } = await ctx.seed();
    const [delivery] = await ctx.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.id, deliveryIds[0]!));
    const eventId = delivery!.eventId;
    await ctx.db
      .update(events)
      .set({
        receivedAt: sql`now() - ${ageHours} * interval '1 hour'`,
        ...(opts.invalid && { signatureStatus: 'invalid', signatureFailureReason: 'mismatch' }),
      })
      .where(eq(events.id, eventId));
    if (opts.deliveries === false || opts.invalid) {
      await ctx.db.delete(deliveries).where(eq(deliveries.eventId, eventId));
    } else {
      const status = opts.status ?? 'succeeded';
      await ctx.db
        .update(deliveries)
        .set({
          status,
          ...(status === 'dead' && { deadReason: 'exhausted' }),
          ...(status === 'in_flight' && { leaseOwner: 'w', attemptCount: 1 }),
        })
        .where(eq(deliveries.eventId, eventId));
    }
    return eventId;
  }
  const remaining = async (ids: string[]) =>
    (await ctx.db.select({ id: events.id }).from(events).where(inArray(events.id, ids))).map(
      (r) => r.id,
    );

  test('valid events: deleted after 7 days once every delivery is terminal', async () => {
    const fresh = await eventAged(24 * 6);
    const oldSucceeded = await eventAged(24 * 8, { status: 'succeeded' });
    const oldDead = await eventAged(24 * 8, { status: 'dead' });
    const oldNoDestinations = await eventAged(24 * 8, { deliveries: false });

    expect(await runRetention(ctx.db)).toEqual({ deleted: 3 });
    expect(await remaining([fresh, oldSucceeded, oldDead, oldNoDestinations])).toEqual([fresh]);
  });

  test('never deletes an event with an active (pending or in-flight) delivery', async () => {
    const pending = await eventAged(24 * 30, { status: 'pending' });
    const inFlight = await eventAged(24 * 30, { status: 'in_flight' });
    expect(await runRetention(ctx.db)).toEqual({ deleted: 0 });
    expect((await remaining([pending, inFlight])).sort()).toEqual([pending, inFlight].sort());

    // Once it finishes, the next run removes it.
    await ctx.db
      .update(deliveries)
      .set({ status: 'succeeded', leaseOwner: null })
      .where(eq(deliveries.eventId, pending));
    expect(await runRetention(ctx.db)).toEqual({ deleted: 1 });
    expect(await remaining([pending, inFlight])).toEqual([inFlight]);
  });

  test('an old event with one terminal and one active delivery (manual replay) is kept', async () => {
    const eventId = await eventAged(24 * 8, { status: 'dead' });
    const [old] = await ctx.db.select().from(deliveries).where(eq(deliveries.eventId, eventId));
    await ctx.db.insert(deliveries).values({
      eventId,
      destinationId: old!.destinationId,
      trigger: 'manual',
      replayOf: old!.id,
      maxAttempts: 10,
    });
    expect(await runRetention(ctx.db)).toEqual({ deleted: 0 });
  });

  test('invalid-signature events: deleted after 24 hours', async () => {
    const recent = await eventAged(23, { invalid: true });
    const old = await eventAged(25, { invalid: true });
    const validSameAge = await eventAged(25);
    expect(await runRetention(ctx.db)).toEqual({ deleted: 1 });
    expect((await remaining([recent, old, validSameAge])).sort()).toEqual(
      [recent, validSameAge].sort(),
    );
  });

  test('deletes deliveries and attempt history with the event (cascade)', async () => {
    const eventId = await eventAged(24 * 8);
    const [delivery] = await ctx.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.eventId, eventId));
    await ctx.db.insert(deliveryAttempts).values({
      deliveryId: delivery!.id,
      attemptNo: 1,
      workerId: 'w',
      startedAt: new Date(),
      durationMs: 5,
      statusCode: 200,
    });
    await runRetention(ctx.db);
    expect(await ctx.db.select().from(deliveries).where(eq(deliveries.id, delivery!.id))).toEqual(
      [],
    );
    expect(
      await ctx.db
        .select()
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.deliveryId, delivery!.id)),
    ).toEqual([]);
  });

  test('works in batches until done', async () => {
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push(await eventAged(24 * 8));
    expect(await runRetention(ctx.db, { batchSize: 3 })).toEqual({ deleted: 7 });
    expect(await remaining(ids)).toEqual([]);
  });

  test('the job runs at start, logs, and never throws out of the timer', async () => {
    await eventAged(24 * 8);
    const logs: string[] = [];
    const job = createRetentionJob({
      db: ctx.db,
      log: { info: (_o, m) => void logs.push(m), error: (_o, m) => void logs.push(m) },
    });
    job.start();
    const start = Date.now();
    while (!logs.length && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    job.stop();
    expect(logs).toEqual(['retention run finished']);
    expect(await ctx.db.select().from(events)).toHaveLength(0);
  });
});
