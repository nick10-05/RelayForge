// Engine invariants (design §4.10), exercised end to end against the chaos receiver.
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { deliveries, deliveryAttempts } from '../db/schema.ts';
import { startChaosReceiver } from '../testing/chaos-receiver.ts';
import type { ChaosReceiver } from '../testing/chaos-receiver.ts';
import { createEngineContext } from '../testing/engine-context.ts';
import { simpleSender } from '../testing/simple-sender.ts';
import { claimDue } from './claim.ts';
import type { DecideFn } from './worker.ts';
import { createWorker } from './worker.ts';

// Placeholder decision until Day 5's classification: 2xx ok, 3xx dead, else retry now.
const decide: DecideFn = (_claim, attempt) => {
  const s = attempt.statusCode;
  if (s !== undefined && s >= 200 && s < 300) return { kind: 'succeeded' };
  if (s !== undefined && s >= 300 && s < 400) return { kind: 'dead', reason: 'redirect' };
  return { kind: 'retry', delayMs: 0 };
};

describe('engine invariants', () => {
  const ctx = createEngineContext();
  let chaos: ChaosReceiver;

  beforeAll(async () => {
    chaos = await startChaosReceiver();
  });
  beforeEach(async () => {
    await ctx.reset();
    chaos.reset();
  });
  afterAll(async () => {
    await chaos.close();
    await ctx.close();
  });

  const statuses = async (ids: string[]) =>
    (await ctx.db.select().from(deliveries).where(inArray(deliveries.id, ids))).map(
      (r) => r.status,
    );

  test('#2: N concurrent workers, no crashes → every delivery sent exactly once', async () => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}/ok`, deliveries: 60 });
    const workers = Array.from({ length: 6 }, (_, i) =>
      createWorker({
        db: ctx.db,
        pool: ctx.pool,
        send: simpleSender,
        decide,
        workerId: `w${i}`,
        batchSize: 4,
      }),
    );

    await Promise.all(workers.map((w) => w.drain()));

    const sentIds = chaos.requests.map((r) => r.headers['x-relayforge-delivery-id']);
    expect(sentIds).toHaveLength(60);
    expect(new Set(sentIds)).toEqual(new Set(deliveryIds));
    expect(new Set(await statuses(deliveryIds))).toEqual(new Set(['succeeded']));
    const [{ count } = { count: -1 }] = await ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveryAttempts);
    expect(count).toBe(60);
  });

  test('#3: a delivery whose worker died mid-request is retried after lease expiry', async () => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}/ok` });

    // Worker A claims, then "dies": it never sends or completes.
    await claimDue(ctx.pool, { workerId: 'dead-worker', batchSize: 10 });
    const survivor = createWorker({
      db: ctx.db,
      pool: ctx.pool,
      send: simpleSender,
      decide,
      workerId: 'B',
    });
    expect((await survivor.runCycle()).claimed).toBe(0); // lease still held

    await ctx.expireLeases();
    const result = await survivor.drain();
    expect(result.applied).toBe(1);

    const [row] = await ctx.db.select().from(deliveries).where(eq(deliveries.id, deliveryIds[0]!));
    expect(row).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    expect(chaos.requests).toHaveLength(1);
  });

  test('#4: a stale worker cannot overwrite a newer result', async () => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}/ok` });
    const [stale] = await claimDue(ctx.pool, { workerId: 'slow', batchSize: 1 });
    await ctx.expireLeases();
    await createWorker({
      db: ctx.db,
      pool: ctx.pool,
      send: simpleSender,
      decide,
      workerId: 'fast',
    }).drain();

    const { completeDelivery } = await import('./complete.ts');
    const applied = await completeDelivery(
      ctx.db,
      stale!,
      { startedAt: new Date(), durationMs: 1, statusCode: 500 },
      { kind: 'retry', delayMs: 0 },
    );
    expect(applied).toBe(false);
    expect(await statuses(deliveryIds)).toEqual(['succeeded']);
  });

  test('#5: nothing stays in_flight beyond lease + one cycle', async () => {
    await ctx.seed({ destinationUrl: `${chaos.url}/ok`, deliveries: 5 });
    await claimDue(ctx.pool, { workerId: 'crashed', batchSize: 5 });
    await ctx.expireLeases();
    await createWorker({ db: ctx.db, pool: ctx.pool, send: simpleSender, decide }).runCycle();

    const stuck = await ctx.db
      .select()
      .from(deliveries)
      .where(sql`${deliveries.status} = 'in_flight' AND ${deliveries.nextAttemptAt} < now()`);
    expect(stuck).toHaveLength(0);
  });

  test('#6: a payload that crashes the worker every time ends dead, not looping', async () => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}/ok`, maxAttempts: 3 });

    // Each "crash" = claim and never complete. Attempts are counted at claim time.
    let claims = 0;
    for (let i = 0; i < 10; i++) {
      const got = await claimDue(ctx.pool, { workerId: `crash-${i}`, batchSize: 1 });
      claims += got.length;
      await ctx.expireLeases();
    }
    await createWorker({ db: ctx.db, pool: ctx.pool, send: simpleSender, decide }).runCycle();

    expect(claims).toBe(3);
    const [row] = await ctx.db.select().from(deliveries).where(eq(deliveries.id, deliveryIds[0]!));
    expect(row).toMatchObject({ status: 'dead', deadReason: 'exhausted', attemptCount: 3 });
    expect(chaos.requests).toHaveLength(0);
  });

  test('retries until the receiver recovers ("200 after N failures")', async () => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}/flaky/3` });
    await createWorker({ db: ctx.db, pool: ctx.pool, send: simpleSender, decide }).drain();
    const [row] = await ctx.db.select().from(deliveries).where(eq(deliveries.id, deliveryIds[0]!));
    expect(row).toMatchObject({ status: 'succeeded', attemptCount: 4 });
    expect(chaos.requests.map((r) => r.headers['x-relayforge-attempt'])).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  test('a receiver that never recovers exhausts the attempts', async () => {
    const { deliveryIds } = await ctx.seed({
      destinationUrl: `${chaos.url}/status/500`,
      maxAttempts: 4,
    });
    await createWorker({ db: ctx.db, pool: ctx.pool, send: simpleSender, decide }).drain();
    const [row] = await ctx.db.select().from(deliveries).where(eq(deliveries.id, deliveryIds[0]!));
    expect(row).toMatchObject({ status: 'dead', deadReason: 'exhausted', attemptCount: 4 });
    expect(chaos.requests).toHaveLength(4);
  });

  test.todo('#7: retry classification and backoff bounds match §4.5 (Day 5)');
  test.todo('#8: an invalid-signature event never produces a delivery or outbound request (Day 8)');
});
