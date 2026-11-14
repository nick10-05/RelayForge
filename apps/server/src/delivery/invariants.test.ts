// Engine invariants (design §4.10), exercised end to end against the chaos receiver.
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { deliveries, deliveryAttempts } from '../db/schema.ts';
import { startChaosReceiver } from '../testing/chaos-receiver.ts';
import type { ChaosReceiver } from '../testing/chaos-receiver.ts';
import { createEngineContext } from '../testing/engine-context.ts';
import { claimDue } from './claim.ts';
import { createDecider } from './classify.ts';
import { createHttpSender } from './http-client.ts';
import { createWorker } from './worker.ts';

// Real sender and classifier. Base 0 makes backoff 0 so retries are immediately due;
// the chaos receiver is on 127.0.0.1, hence allowPrivate.
const simpleSender = createHttpSender({ production: false, allowPrivate: true });
const decide = createDecider({ baseMs: 0, capMs: 3_600_000, random: Math.random });

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

  test.each([
    ['/status/404', 'non_retryable_status'],
    ['/status/410', 'non_retryable_status'],
    ['/redirect', 'redirect'],
  ])('#7: %s ends dead (%s) after one attempt, never retried', async (path, reason) => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}${path}` });
    await createWorker({ db: ctx.db, pool: ctx.pool, send: simpleSender, decide }).drain();
    const [row] = await ctx.db.select().from(deliveries).where(eq(deliveries.id, deliveryIds[0]!));
    expect(row).toMatchObject({ status: 'dead', deadReason: reason, attemptCount: 1 });
    expect(chaos.requests).toHaveLength(1);
    expect(chaos.requestsTo('/ok')).toHaveLength(0); // the redirect was not followed
  });

  test('#7: 429 with Retry-After schedules the retry at that delay', async () => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}/retry-after/120` });
    await createWorker({ db: ctx.db, pool: ctx.pool, send: simpleSender, decide }).runCycle();
    const [row] = await ctx.db.select().from(deliveries).where(eq(deliveries.id, deliveryIds[0]!));
    expect(row!.status).toBe('pending');
    const delayMs = row!.nextAttemptAt.getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(110_000);
    expect(delayMs).toBeLessThanOrEqual(121_000);
  });

  test('#7: a hung receiver times out and is retried, recorded as TIMEOUT', async () => {
    const { deliveryIds } = await ctx.seed({
      destinationUrl: `${chaos.url}/hang`,
      timeoutMs: 1000, // DB minimum
      maxAttempts: 2,
    });
    await createWorker({ db: ctx.db, pool: ctx.pool, send: simpleSender, decide }).drain();
    const [row] = await ctx.db.select().from(deliveries).where(eq(deliveries.id, deliveryIds[0]!));
    expect(row).toMatchObject({ status: 'dead', deadReason: 'exhausted', attemptCount: 2 });
    const attempts = await ctx.db
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, deliveryIds[0]!));
    expect(attempts.map((a) => a.errorCode)).toEqual(['TIMEOUT', 'TIMEOUT']);
  });

  test('chaos run: mixed receivers all reach the right terminal state', async () => {
    const cases = [
      ['/ok', 'succeeded'],
      ['/flaky/2', 'succeeded'],
      ['/slow/50', 'succeeded'],
      ['/status/503', 'dead'],
      ['/reset', 'dead'],
      ['/status/400', 'dead'],
      ['/redirect', 'dead'],
    ] as const;
    const seeded = await Promise.all(
      cases.map(([path]) =>
        ctx.seed({ destinationUrl: `${chaos.url}${path}`, deliveries: 3, maxAttempts: 3 }),
      ),
    );
    const workers = Array.from({ length: 4 }, (_, i) =>
      createWorker({ db: ctx.db, pool: ctx.pool, send: simpleSender, decide, workerId: `c${i}` }),
    );
    await Promise.all(workers.map((w) => w.drain()));
    for (const [i, [, expected]] of cases.entries()) {
      expect(new Set(await statuses(seeded[i]!.deliveryIds))).toEqual(new Set([expected]));
    }
  });

  test.todo('#8: an invalid-signature event never produces a delivery or outbound request (Day 8)');
});
