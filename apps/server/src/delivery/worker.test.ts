// Worker robustness: a bug in one step must not strand a delivery or hide the others' results.
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { deliveries, deliveryAttempts } from '../db/schema.ts';
import { createEngineContext } from '../testing/engine-context.ts';
import { createDecider } from './classify.ts';
import type { AttemptResult } from './types.ts';
import { createWorker } from './worker.ts';
import type { DecideFn, SendFn } from './worker.ts';

const decide = createDecider({ baseMs: 0, capMs: 3_600_000, random: Math.random });
const ok: SendFn = () =>
  Promise.resolve<AttemptResult>({ startedAt: new Date(), durationMs: 1, statusCode: 200 });

describe('worker', () => {
  const ctx = createEngineContext();
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const worker = (send: SendFn, decideFn: DecideFn = decide) =>
    createWorker({ db: ctx.db, pool: ctx.pool, send, decide: decideFn });

  test('a sender that throws is recorded as internal_error and retried, not left in flight', async () => {
    const { deliveryIds } = await ctx.seed();
    const throwing: SendFn = () => Promise.reject(new Error('bug in the sender'));

    const result = await worker(throwing).runCycle();

    expect(result).toMatchObject({ claimed: 1, applied: 1, fenced: 0 });
    const [row] = await ctx.db.select().from(deliveries).where(eq(deliveries.id, deliveryIds[0]!));
    expect(row).toMatchObject({ status: 'pending', attemptCount: 1, leaseOwner: null });
    const [attempt] = await ctx.db
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, deliveryIds[0]!));
    expect(attempt).toMatchObject({ errorCode: 'internal_error' });
    expect(attempt!.errorMessage).toContain('bug in the sender');
  });

  test('a failing completion for one delivery does not stop the others being recorded', async () => {
    const { deliveryIds } = await ctx.seed({ deliveries: 3 });
    const [poisoned] = deliveryIds;
    const flaky: DecideFn = (claim, attempt) => {
      if (claim.id === poisoned) throw new Error('bug while deciding');
      return decide(claim, attempt);
    };

    const result = await worker(ok, flaky).runCycle();

    expect(result).toMatchObject({ claimed: 3, applied: 2, fenced: 1 });
    const rows = await ctx.db
      .select({ id: deliveries.id, status: deliveries.status })
      .from(deliveries)
      .where(inArray(deliveries.id, deliveryIds));
    const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    // The poisoned one keeps its lease and is retried when the lease expires (or reaped).
    expect(status[poisoned!]).toBe('in_flight');
    expect(deliveryIds.slice(1).map((id) => status[id])).toEqual(['succeeded', 'succeeded']);
  });
});
