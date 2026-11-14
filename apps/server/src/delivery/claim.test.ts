import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { deliveries } from '../db/schema.ts';
import { createEngineContext } from '../testing/engine-context.ts';
import { claimDue, reapExhausted } from './claim.ts';

describe('claimDue', () => {
  const ctx = createEngineContext();
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const rows = (ids: string[]) =>
    ctx.db.select().from(deliveries).where(inArray(deliveries.id, ids));

  test('claims due rows: in_flight, attempt+1, lease owner, lease in the future', async () => {
    const { deliveryIds, destination } = await ctx.seed({ deliveries: 2 });
    const claimed = await claimDue(ctx.pool, { workerId: 'w1', batchSize: 10, leaseMs: 60_000 });

    expect(claimed.map((c) => c.id).sort()).toEqual([...deliveryIds].sort());
    for (const c of claimed) {
      expect(c).toMatchObject({
        attemptCount: 1,
        leaseOwner: 'w1',
        url: destination.url,
        method: 'POST',
      });
      expect(c.body.toString()).toMatch(/^\{"n":\d\}$/);
      expect(c.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
    }
    for (const r of await rows(deliveryIds)) {
      expect(r).toMatchObject({ status: 'in_flight', attemptCount: 1, leaseOwner: 'w1' });
    }
  });

  test('respects the batch size', async () => {
    await ctx.seed({ deliveries: 5 });
    expect(await claimDue(ctx.pool, { workerId: 'w1', batchSize: 2 })).toHaveLength(2);
  });

  test('an active lease is not claimable by anyone', async () => {
    await ctx.seed();
    expect(await claimDue(ctx.pool, { workerId: 'w1', batchSize: 10 })).toHaveLength(1);
    expect(await claimDue(ctx.pool, { workerId: 'w2', batchSize: 10 })).toHaveLength(0);
  });

  test('skips rows not yet due', async () => {
    await ctx.seed({ dueInMs: 60_000 });
    expect(await claimDue(ctx.pool, { workerId: 'w1', batchSize: 10 })).toHaveLength(0);
  });

  test('paused endpoints and disabled destinations are held, not claimed', async () => {
    await ctx.seed({ paused: true });
    await ctx.seed({ enabled: false });
    expect(await claimDue(ctx.pool, { workerId: 'w1', batchSize: 10 })).toHaveLength(0);
  });

  test('held deliveries flow once the endpoint is resumed', async () => {
    const { endpoint } = await ctx.seed({ paused: true });
    const { endpoints } = await import('../db/schema.ts');
    await ctx.db.update(endpoints).set({ paused: false }).where(eq(endpoints.id, endpoint.id));
    expect(await claimDue(ctx.pool, { workerId: 'w1', batchSize: 10 })).toHaveLength(1);
  });

  test('oldest due first', async () => {
    const late = await ctx.seed({ dueInMs: -1_000 });
    const early = await ctx.seed({ dueInMs: -10_000 });
    const [first] = await claimDue(ctx.pool, { workerId: 'w1', batchSize: 1 });
    expect(first?.id).toBe(early.deliveryIds[0]);
    expect(late.deliveryIds).toHaveLength(1);
  });

  test('concurrent claimers get disjoint sets (SKIP LOCKED)', async () => {
    const { deliveryIds } = await ctx.seed({ deliveries: 40 });
    const batches = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimDue(ctx.pool, { workerId: `w${i}`, batchSize: 10 })),
    );
    const ids = batches.flat().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // no row claimed twice
    expect(ids.length).toBe(40); // and none left behind
    expect(new Set(ids)).toEqual(new Set(deliveryIds));
  });

  test('an expired lease makes the row claimable again, with the next attempt number', async () => {
    const { deliveryIds } = await ctx.seed();
    await claimDue(ctx.pool, { workerId: 'w1', batchSize: 10 });
    await ctx.expireLeases();
    const [again] = await claimDue(ctx.pool, { workerId: 'w2', batchSize: 10 });
    expect(again).toMatchObject({ id: deliveryIds[0], attemptCount: 2, leaseOwner: 'w2' });
  });

  test('reapExhausted: expired lease on the final attempt → dead/exhausted', async () => {
    const { deliveryIds } = await ctx.seed({ maxAttempts: 1 });
    await claimDue(ctx.pool, { workerId: 'w1', batchSize: 10 });
    expect(await reapExhausted(ctx.pool)).toBe(0); // lease still active
    await ctx.expireLeases();
    expect(await claimDue(ctx.pool, { workerId: 'w2', batchSize: 10 })).toHaveLength(0);
    expect(await reapExhausted(ctx.pool)).toBe(1);
    const [row] = await rows(deliveryIds);
    expect(row).toMatchObject({ status: 'dead', deadReason: 'exhausted', leaseOwner: null });
    expect(row?.completedAt).not.toBeNull();
  });
});
