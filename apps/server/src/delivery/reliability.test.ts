// Day 7 reliability tests: the engine under load, crashes and poison payloads (design §4.10).
// Time is never faked with sleeps-and-hope: leases are expired explicitly (expireLeases) or
// made short (leaseMs) and every wait is a condition with a timeout.
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { deliveries, deliveryAttempts } from '../db/schema.ts';
import { startChaosReceiver } from '../testing/chaos-receiver.ts';
import type { ChaosReceiver } from '../testing/chaos-receiver.ts';
import { createEngineContext } from '../testing/engine-context.ts';
import { claimDue } from './claim.ts';
import { createDecider } from './classify.ts';
import { completeDelivery } from './complete.ts';
import { createHttpSender } from './http-client.ts';
import { createScheduler } from './scheduler.ts';
import type { Scheduler, SchedulerOptions } from './scheduler.ts';
import { createWorker } from './worker.ts';

const send = createHttpSender({ production: false, allowPrivate: true });
const decide = createDecider({ baseMs: 0, capMs: 3_600_000, random: Math.random });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(25);
  }
}

describe('engine reliability', () => {
  const ctx = createEngineContext();
  let chaos: ChaosReceiver;
  const started: Scheduler[] = [];

  const scheduler = (extra: Partial<SchedulerOptions> = {}) => {
    const s = createScheduler({ db: ctx.db, pool: ctx.pool, send, decide, ...extra });
    started.push(s);
    s.start();
    return s;
  };

  beforeAll(async () => {
    chaos = await startChaosReceiver();
  });
  beforeEach(async () => {
    await ctx.reset();
    chaos.reset();
  });
  afterEach(async () => {
    await Promise.all(started.splice(0).map((s) => s.stop(2000)));
  });
  afterAll(async () => {
    await chaos.close();
    await ctx.close();
  });

  const count = async (where: ReturnType<typeof sql>) => {
    const [row] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(deliveries)
      .where(where);
    return row!.n;
  };
  const active = () => count(sql`${deliveries.status} IN ('pending', 'in_flight')`);
  /** Invariant #5: in_flight past its lease by more than one scheduling cycle (1 s here). */
  const overdueInFlight = () =>
    count(
      sql`${deliveries.status} = 'in_flight' AND ${deliveries.nextAttemptAt} < now() - interval '1 second'`,
    );
  const row = async (id: string) =>
    (await ctx.db.select().from(deliveries).where(eq(deliveries.id, id)))[0]!;

  test('load: 4 schedulers × 8 slots on one table → no double sends, nothing stuck', async () => {
    const groups = await Promise.all([
      ctx.seed({ destinationUrl: `${chaos.url}/ok`, deliveries: 80 }),
      ctx.seed({ destinationUrl: `${chaos.url}/flaky/1`, deliveries: 80 }),
      ctx.seed({ destinationUrl: `${chaos.url}/slow/20`, deliveries: 80 }),
    ]);
    const expectedAttempts = [1, 2, 1];
    for (let i = 0; i < 4; i++) scheduler({ workerId: `load-${i}`, concurrency: 8 });

    // Sample invariant #5 while the load runs.
    let overdueSeen = 0;
    await waitFor(async () => {
      overdueSeen += await overdueInFlight();
      return (await active()) === 0;
    }, 30_000);
    expect(overdueSeen).toBe(0);

    // Each (delivery, attempt) reached the receiver exactly once.
    const keys = chaos.requests.map(
      (r) =>
        `${String(r.headers['x-relayforge-delivery-id'])}#${String(r.headers['x-relayforge-attempt'])}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(80 * (1 + 2 + 1));

    for (const [i, group] of groups.entries()) {
      const rows = await ctx.db
        .select()
        .from(deliveries)
        .where(inArray(deliveries.id, group.deliveryIds));
      for (const r of rows) {
        expect(r).toMatchObject({
          status: 'succeeded',
          attemptCount: expectedAttempts[i],
          leaseOwner: null,
        });
      }
    }
    const [logged] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(deliveryAttempts);
    expect(logged!.n).toBe(keys.length); // every send logged once, no phantom attempts
  }, 40_000);

  test('load: 12 tight-batch workers racing the claim and the reaper → each sent once', async () => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}/ok`, deliveries: 150 });
    const workers = Array.from({ length: 12 }, (_, i) =>
      createWorker({ db: ctx.db, pool: ctx.pool, send, decide, workerId: `r${i}`, batchSize: 3 }),
    );
    const totals = await Promise.all(workers.map((w) => w.drain()));

    expect(totals.reduce((n, t) => n + t.claimed, 0)).toBe(150);
    expect(totals.reduce((n, t) => n + t.fenced, 0)).toBe(0);
    const sent = chaos.requests.map((r) => r.headers['x-relayforge-delivery-id']);
    expect(sent).toHaveLength(150);
    expect(new Set(sent)).toEqual(new Set(deliveryIds));
  });

  test('crash between send and completion: resent (at-least-once), late result fenced', async () => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}/ok` });
    const id = deliveryIds[0]!;

    // Worker "doomed" claims and sends; the receiver gets it; the process dies before
    // completeDelivery runs.
    const [claim] = await claimDue(ctx.pool, { workerId: 'doomed', batchSize: 1 });
    const attempt = await send(claim!);
    expect(attempt.statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'in_flight', leaseOwner: 'doomed' });

    // The lease runs out and a survivor delivers it again.
    await ctx.expireLeases();
    await createWorker({ db: ctx.db, pool: ctx.pool, send, decide, workerId: 'survivor' }).drain();

    // The doomed worker's completion turns up late (e.g. a stalled process resumed): fenced.
    expect(await completeDelivery(ctx.db, claim!, attempt, { kind: 'succeeded' })).toBe(false);

    expect(await row(id)).toMatchObject({ status: 'succeeded', attemptCount: 2, leaseOwner: null });
    // The receiver saw it twice: same event id (its dedupe key), different attempt numbers.
    expect(chaos.requests.map((r) => r.headers['x-relayforge-id'])).toEqual([
      claim!.eventId,
      claim!.eventId,
    ]);
    expect(chaos.requests.map((r) => r.headers['x-relayforge-attempt'])).toEqual(['1', '2']);
    // Both attempts are in the history (the late one is still logged: it really happened).
    const attempts = await ctx.db
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, id));
    expect(attempts.map((a) => [a.attemptNo, a.workerId]).sort()).toEqual([
      [1, 'doomed'],
      [2, 'survivor'],
    ]);
  });

  test('fencing uses the attempt number: the SAME worker id re-claiming is still fenced', async () => {
    await ctx.seed({ destinationUrl: `${chaos.url}/ok` });
    const [first] = await claimDue(ctx.pool, { workerId: 'w', batchSize: 1 });
    await ctx.expireLeases();
    const [second] = await claimDue(ctx.pool, { workerId: 'w', batchSize: 1 });
    expect(second!.attemptCount).toBe(2);

    const attempt = { startedAt: new Date(), durationMs: 1, statusCode: 200 };
    expect(await completeDelivery(ctx.db, first!, attempt, { kind: 'succeeded' })).toBe(false);
    expect(await completeDelivery(ctx.db, second!, attempt, { kind: 'succeeded' })).toBe(true);
  });

  test('#3 + #5: a running scheduler recovers a killed worker’s lease on its own', async () => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}/ok`, deliveries: 3 });
    const t0 = Date.now();
    // Another process claimed with a 400 ms lease and was killed mid-request.
    await claimDue(ctx.pool, { workerId: 'killed', batchSize: 3, leaseMs: 400 });

    scheduler({ workerId: 'survivor' }); // no wake(), no expireLeases(): only its own timer
    let overdueSeen = 0;
    await waitFor(async () => {
      overdueSeen += await overdueInFlight();
      return (await active()) === 0;
    }, 5000);

    expect(overdueSeen).toBe(0);
    for (const id of deliveryIds) {
      expect(await row(id)).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    }
    // Not before the lease ran out; within lease + one cycle after it.
    const first = Math.min(...chaos.requests.map((r) => r.at));
    expect(first - t0).toBeGreaterThanOrEqual(350);
    expect(first - t0).toBeLessThan(400 + 1000);
  });

  test('#6: send throws every time (worker bug on this payload) → dead/exhausted', async () => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}/ok`, maxAttempts: 3 });
    scheduler({
      send: () => Promise.reject(new Error('payload crashed the parser')),
    });
    await waitFor(async () => (await row(deliveryIds[0]!)).status === 'dead');

    expect(await row(deliveryIds[0]!)).toMatchObject({ deadReason: 'exhausted', attemptCount: 3 });
    const attempts = await ctx.db
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, deliveryIds[0]!));
    expect(attempts.map((a) => a.errorCode)).toEqual([
      'internal_error',
      'internal_error',
      'internal_error',
    ]);
    expect(chaos.requests).toHaveLength(0);
  });

  test('#6: completion fails every time → leases expire, attempts run out, reaped dead', async () => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}/ok`, maxAttempts: 3 });
    // The send happens, then the worker blows up before recording it — every time.
    scheduler({
      leaseMs: 300,
      decide: () => {
        throw new Error('crash after send');
      },
    });
    await waitFor(async () => (await row(deliveryIds[0]!)).status === 'dead', 8000);

    expect(await row(deliveryIds[0]!)).toMatchObject({
      deadReason: 'exhausted',
      attemptCount: 3,
      leaseOwner: null,
    });
    expect(chaos.requests).toHaveLength(3); // bounded: never more than maxAttempts sends
  });
});
