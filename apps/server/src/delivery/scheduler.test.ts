// Scheduler behaviour (design §4.6–4.8) against the chaos receiver and the engine test DB.
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { deliveries } from '../db/schema.ts';
import { startChaosReceiver } from '../testing/chaos-receiver.ts';
import type { ChaosReceiver } from '../testing/chaos-receiver.ts';
import { createEngineContext } from '../testing/engine-context.ts';
import { createDecider } from './classify.ts';
import { createHttpSender } from './http-client.ts';
import { createScheduler, nextDueDelay } from './scheduler.ts';
import type { Scheduler, SchedulerOptions } from './scheduler.ts';

const send = createHttpSender({ production: false, allowPrivate: true });
const decide = createDecider({ baseMs: 0, capMs: 3_600_000, random: Math.random });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(20);
  }
}

describe('delivery scheduler', () => {
  const ctx = createEngineContext();
  let chaos: ChaosReceiver;
  const started: Scheduler[] = [];

  const scheduler = (extra: Partial<SchedulerOptions> = {}) => {
    const s = createScheduler({ db: ctx.db, pool: ctx.pool, send, decide, ...extra });
    started.push(s);
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
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await chaos.close();
    await ctx.close();
  });

  const statusOf = async (id: string) =>
    (await ctx.db.select().from(deliveries).where(eq(deliveries.id, id)))[0]!.status;

  test('startup catch-up: deliveries left from before a restart are sent at start', async () => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}/ok`, deliveries: 3 });
    scheduler().start();
    await waitFor(() => chaos.requests.length === 3);
    await waitFor(async () => (await statusOf(deliveryIds[2]!)) === 'succeeded');
  });

  test('idle with nothing scheduled: sleeps with zero DB queries; wake() sends at once', async () => {
    const s = scheduler();
    const query = vi.spyOn(ctx.pool, 'query');
    s.start();
    // Startup = reap + catch-up claim + next-due check (3 queries), then indefinite sleep.
    // Wait for the third to settle instead of guessing a fixed delay.
    await waitFor(() => query.mock.calls.length >= 3);
    await query.mock.results[2]!.value;
    await sleep(20);
    query.mockClear();
    const connect = vi.spyOn(ctx.pool, 'connect');
    await sleep(500);
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();

    // A delivery appears (as ingest would create it) but nobody signals: still asleep.
    await ctx.seed({ destinationUrl: `${chaos.url}/ok` });
    await sleep(300);
    expect(chaos.requests).toHaveLength(0);

    s.wake();
    await waitFor(() => chaos.requests.length === 1, 2000);
  });

  test('sleeps until the earliest next_attempt_at, then sends', async () => {
    const startedAt = Date.now(); // before the seed, so the due time is ≥ startedAt + 700
    await ctx.seed({ destinationUrl: `${chaos.url}/ok`, dueInMs: 700 });
    const s = scheduler();
    s.start();
    await sleep(300);
    expect(chaos.requests).toHaveLength(0);
    await waitFor(() => chaos.requests.length === 1, 3000);
    expect(chaos.requests[0]!.at - startedAt).toBeGreaterThanOrEqual(600);
  });

  test('nextDueDelay ignores held deliveries (paused endpoint)', async () => {
    await ctx.seed({ destinationUrl: `${chaos.url}/ok`, paused: true });
    expect(await nextDueDelay(ctx.pool)).toBeNull();
    await ctx.seed({
      destinationUrl: `${chaos.url}/ok`,
      dueInMs: 60_000,
    });
    const delay = await nextDueDelay(ctx.pool);
    expect(delay).toBeGreaterThan(55_000);
    expect(delay).toBeLessThanOrEqual(60_000);
  });

  test('bounded concurrency: never more than N sends at once', async () => {
    await ctx.seed({ destinationUrl: `${chaos.url}/slow/150`, deliveries: 10 });
    let active = 0;
    let peak = 0;
    const s = scheduler({
      concurrency: 3,
      send: async (claim) => {
        active++;
        peak = Math.max(peak, active);
        try {
          return await send(claim);
        } finally {
          active--;
        }
      },
    });
    s.start();
    await waitFor(() => chaos.requests.length === 10, 5000);
    expect(peak).toBe(3);
  });

  test('retries are picked up when they come due, without a wake-up', async () => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}/flaky/2` });
    scheduler({
      decide: (claim, attempt) => {
        const d = decide(claim, attempt);
        return d.kind === 'retry' ? { kind: 'retry', delayMs: 300 } : d;
      },
    }).start();
    await waitFor(async () => (await statusOf(deliveryIds[0]!)) === 'succeeded', 5000);
    expect(chaos.requests).toHaveLength(3);
  });

  test('graceful stop: no new claims, in-flight sends finish', async () => {
    await ctx.seed({ destinationUrl: `${chaos.url}/slow/300`, deliveries: 2 });
    const s = scheduler({ concurrency: 2 });
    s.start();
    await waitFor(() => s.inFlight === 2);
    await ctx.seed({ destinationUrl: `${chaos.url}/ok`, deliveries: 2 });

    const result = await s.stop(3000);
    expect(result).toEqual({ drained: true, abandoned: 0 });
    s.wake(); // ignored after stop
    await sleep(200);
    expect(chaos.requestsTo('/slow')).toHaveLength(2);
    expect(chaos.requestsTo('/ok')).toHaveLength(0);
  });

  test('#3: stop times out mid-request → another worker retries after lease expiry', async () => {
    const { deliveryIds } = await ctx.seed({
      destinationUrl: `${chaos.url}/hang`,
      timeoutMs: 15000,
    });
    const first = scheduler({ workerId: 'killed' });
    first.start();
    await waitFor(() => first.inFlight === 1);
    expect(await first.stop(100)).toEqual({ drained: false, abandoned: 1 });

    const [row] = await ctx.db.select().from(deliveries).where(eq(deliveries.id, deliveryIds[0]!));
    expect(row).toMatchObject({ status: 'in_flight', leaseOwner: 'killed', attemptCount: 1 });

    // Point the destination at a healthy path and let the lease run out.
    const { destinations } = await import('../db/schema.ts');
    await ctx.db.update(destinations).set({ url: `${chaos.url}/ok` });
    await ctx.expireLeases();

    scheduler({ workerId: 'survivor' }).start();
    await waitFor(async () => (await statusOf(deliveryIds[0]!)) === 'succeeded');
    const [done] = await ctx.db
      .select()
      .from(deliveries)
      .where(inArray(deliveries.id, deliveryIds));
    expect(done).toMatchObject({ attemptCount: 2 });
  });

  test('stop() arriving during the reap query claims nothing new', async () => {
    await ctx.seed({ destinationUrl: `${chaos.url}/ok` });
    const s = scheduler();
    let stopping: Promise<unknown> | undefined;
    const original = ctx.pool.query.bind(ctx.pool);
    const spy = vi.spyOn(ctx.pool, 'query') as unknown as {
      mockImplementation: (fn: (text: unknown, values?: unknown) => Promise<unknown>) => void;
    };
    spy.mockImplementation((text, values) => {
      if (!stopping && typeof text === 'string' && text.includes('lease expired on the final')) {
        stopping = s.stop(1000); // SIGTERM lands while the reap is running
      }
      return original(text as string, values as unknown[]);
    });
    s.start();
    await waitFor(() => stopping !== undefined);
    expect(await stopping).toEqual({ drained: true, abandoned: 0 });
    vi.restoreAllMocks();

    expect(chaos.requests).toHaveLength(0);
    const [r] = await ctx.db.select().from(deliveries);
    expect(r).toMatchObject({ status: 'pending', attemptCount: 0 });
  });

  test('a database error in the loop is logged, backed off, and the loop recovers', async () => {
    const { deliveryIds } = await ctx.seed({ destinationUrl: `${chaos.url}/ok` });
    const original = ctx.pool.query.bind(ctx.pool);
    let failures = 0;
    const spy = vi.spyOn(ctx.pool, 'query') as unknown as {
      mockImplementation: (fn: (text: unknown, values?: unknown) => Promise<unknown>) => void;
    };
    spy.mockImplementation((text, values) => {
      if (failures === 0) {
        failures++;
        return Promise.reject(new Error('connection terminated unexpectedly'));
      }
      return original(text as string, values as unknown[]);
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    scheduler({ log }).start();

    await waitFor(async () => (await statusOf(deliveryIds[0]!)) === 'succeeded');
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ retryInMs: 1000 }),
      'delivery loop error',
    );
    expect(chaos.requests).toHaveLength(1);
  });
});
