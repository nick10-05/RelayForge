import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { deliveries, deliveryAttempts } from '../db/schema.ts';
import { createEngineContext } from '../testing/engine-context.ts';
import { claimDue } from './claim.ts';
import { completeDelivery } from './complete.ts';
import type { AttemptResult } from './types.ts';

const ok = (statusCode = 200): AttemptResult => ({
  startedAt: new Date(),
  durationMs: 12,
  statusCode,
});

describe('completeDelivery (fenced)', () => {
  const ctx = createEngineContext();
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const row = async (id: string) => {
    const [r] = await ctx.db.select().from(deliveries).where(eq(deliveries.id, id));
    if (!r) throw new Error('missing');
    return r;
  };
  const attempts = (id: string) =>
    ctx.db
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, id))
      .orderBy(asc(deliveryAttempts.attemptNo));

  async function claimOne(workerId = 'w1') {
    const [claim] = await claimDue(ctx.pool, { workerId, batchSize: 1 });
    if (!claim) throw new Error('nothing claimed');
    return claim;
  }

  test('succeeded: terminal, lease cleared, attempt logged', async () => {
    await ctx.seed();
    const claim = await claimOne();
    expect(await completeDelivery(ctx.db, claim, ok(204), { kind: 'succeeded' })).toBe(true);

    expect(await row(claim.id)).toMatchObject({
      status: 'succeeded',
      leaseOwner: null,
      lastStatusCode: 204,
      lastError: null,
      deadReason: null,
    });
    expect((await row(claim.id)).completedAt).not.toBeNull();
    const [log] = await attempts(claim.id);
    expect(log).toMatchObject({ attemptNo: 1, workerId: 'w1', statusCode: 204, durationMs: 12 });
  });

  test('retry: back to pending, due after the delay', async () => {
    await ctx.seed();
    const claim = await claimOne();
    await completeDelivery(ctx.db, claim, ok(503), { kind: 'retry', delayMs: 30_000 });

    const r = await row(claim.id);
    expect(r).toMatchObject({
      status: 'pending',
      leaseOwner: null,
      lastStatusCode: 503,
      lastError: 'HTTP 503',
    });
    const due = await ctx.msUntilDue(claim.id); // DB clock on both sides
    expect(due).toBeGreaterThan(29_000);
    expect(due).toBeLessThanOrEqual(30_000);
  });

  test('dead: terminal with reason', async () => {
    await ctx.seed();
    const claim = await claimOne();
    await completeDelivery(ctx.db, claim, ok(302), { kind: 'dead', reason: 'redirect' });
    expect(await row(claim.id)).toMatchObject({ status: 'dead', deadReason: 'redirect' });
  });

  test('a retry on the final attempt becomes dead/exhausted', async () => {
    await ctx.seed({ maxAttempts: 1 });
    const claim = await claimOne();
    await completeDelivery(ctx.db, claim, ok(500), { kind: 'retry', delayMs: 1000 });
    expect(await row(claim.id)).toMatchObject({ status: 'dead', deadReason: 'exhausted' });
  });

  test('network errors are recorded as last_error and in the attempt log', async () => {
    await ctx.seed();
    const claim = await claimOne();
    await completeDelivery(
      ctx.db,
      claim,
      {
        startedAt: new Date(),
        durationMs: 5,
        errorCode: 'ECONNRESET',
        errorMessage: 'socket hang up',
      },
      { kind: 'retry', delayMs: 0 },
    );
    expect((await row(claim.id)).lastError).toBe('ECONNRESET: socket hang up');
    expect((await attempts(claim.id))[0]).toMatchObject({
      errorCode: 'ECONNRESET',
      statusCode: null,
    });
  });

  test('fenced: a stale worker cannot overwrite the newer claim (invariant #4)', async () => {
    await ctx.seed();
    const stale = await claimOne('w1');
    await ctx.expireLeases();
    const fresh = await claimOne('w2');
    expect(fresh.attemptCount).toBe(2);

    // The stale worker finishes late: discarded, but its attempt is still logged.
    expect(await completeDelivery(ctx.db, stale, ok(500), { kind: 'retry', delayMs: 0 })).toBe(
      false,
    );
    expect(await row(fresh.id)).toMatchObject({
      status: 'in_flight',
      leaseOwner: 'w2',
      attemptCount: 2,
    });

    expect(await completeDelivery(ctx.db, fresh, ok(200), { kind: 'succeeded' })).toBe(true);
    expect((await row(fresh.id)).status).toBe('succeeded');

    const log = await attempts(fresh.id);
    expect(log.map((a) => [a.attemptNo, a.workerId])).toEqual([
      [1, 'w1'],
      [2, 'w2'],
    ]);
  });

  test('fenced: a stale success after a newer terminal result changes nothing', async () => {
    await ctx.seed();
    const stale = await claimOne('w1');
    await ctx.expireLeases();
    const fresh = await claimOne('w2');
    await completeDelivery(ctx.db, fresh, ok(410), {
      kind: 'dead',
      reason: 'non_retryable_status',
    });

    expect(await completeDelivery(ctx.db, stale, ok(200), { kind: 'succeeded' })).toBe(false);
    expect(await row(fresh.id)).toMatchObject({
      status: 'dead',
      deadReason: 'non_retryable_status',
    });
  });

  test('completing twice is a no-op the second time', async () => {
    await ctx.seed();
    const claim = await claimOne();
    expect(await completeDelivery(ctx.db, claim, ok(), { kind: 'succeeded' })).toBe(true);
    expect(await completeDelivery(ctx.db, claim, ok(500), { kind: 'retry', delayMs: 0 })).toBe(
      false,
    );
    expect((await row(claim.id)).status).toBe('succeeded');
  });

  test('NUL bytes from the receiver (binary body, headers, errors) are stored, not fatal', async () => {
    await ctx.seed();
    const claim = await claimOne();
    const nul = String.fromCharCode(0);
    const attempt: AttemptResult = {
      ...ok(200),
      responseHeaders: { 'x-odd': `a${nul}b`, 'set-cookie': [`c${nul}`] },
      responseBodySnippet: `${nul}gzip${nul}`,
    };
    expect(await completeDelivery(ctx.db, claim, attempt, { kind: 'succeeded' })).toBe(true);
    const [log] = await attempts(claim.id);
    expect(log!.responseBodySnippet).toBe('�gzip�');
    expect(log!.responseHeaders).toEqual({ 'x-odd': 'a�b', 'set-cookie': ['c�'] });

    await ctx.seed();
    const failing = await claimOne();
    const err: AttemptResult = {
      ...ok(),
      statusCode: undefined,
      errorCode: 'X',
      errorMessage: nul,
    };
    expect(await completeDelivery(ctx.db, failing, err, { kind: 'retry', delayMs: 0 })).toBe(true);
    expect((await row(failing.id)).lastError).toBe('X: �');
  });
});
