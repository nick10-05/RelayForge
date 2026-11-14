// Fixtures for delivery-engine tests, against the dedicated engine test database.
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, createPool } from '../db/client.ts';
import type { Db } from '../db/client.ts';
import { deliveries, destinations, endpoints, events, users } from '../db/schema.ts';
import { ENGINE_TEST_DATABASE_URL } from './test-support.ts';

export function createEngineContext() {
  const pool = createPool(ENGINE_TEST_DATABASE_URL);
  const db = createDb(pool);

  return {
    pool,
    db,
    /** Empties every table (users cascade to everything else). */
    reset: async () => {
      await db.execute(sql`TRUNCATE users, events, deliveries, delivery_attempts CASCADE`);
    },
    /** Pretend every active lease ran out (instead of sleeping in tests). */
    expireLeases: async () => {
      await db.execute(
        sql`UPDATE deliveries SET next_attempt_at = now() - interval '1 second' WHERE status = 'in_flight'`,
      );
    },
    seed: (opts?: SeedOptions) => seed(db, opts),
    close: () => pool.end(),
  };
}

export type SeedOptions = {
  destinationUrl?: string;
  deliveries?: number;
  maxAttempts?: number;
  paused?: boolean;
  enabled?: boolean;
  nextAttemptAt?: Date;
  timeoutMs?: number;
};

/** One user → endpoint → destination, and `deliveries` events each with a pending delivery. */
async function seed(db: Db, opts: SeedOptions = {}) {
  const [user] = await db
    .insert(users)
    .values({ email: `engine-${randomUUID()}@example.test`, passwordHash: 'x' })
    .returning();
  const [endpoint] = await db
    .insert(endpoints)
    .values({
      userId: user!.id,
      name: 'engine',
      slug: randomBytes(16).toString('base64url'),
      paused: opts.paused ?? false,
    })
    .returning();
  const [destination] = await db
    .insert(destinations)
    .values({
      endpointId: endpoint!.id,
      url: opts.destinationUrl ?? 'http://127.0.0.1:9/unused',
      enabled: opts.enabled ?? true,
      maxAttempts: opts.maxAttempts ?? 10,
      timeoutMs: opts.timeoutMs ?? 2000,
    })
    .returning();

  const count = opts.deliveries ?? 1;
  const deliveryIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const body = Buffer.from(JSON.stringify({ n: i }));
    const [event] = await db
      .insert(events)
      .values({
        endpointId: endpoint!.id,
        method: 'POST',
        path: `/in/${endpoint!.slug}`,
        headers: { 'content-type': 'application/json' },
        body,
        contentType: 'application/json',
        sizeBytes: body.length,
      })
      .returning();
    const [delivery] = await db
      .insert(deliveries)
      .values({
        eventId: event!.id,
        destinationId: destination!.id,
        maxAttempts: opts.maxAttempts ?? 10,
        ...(opts.nextAttemptAt && { nextAttemptAt: opts.nextAttemptAt }),
      })
      .returning();
    deliveryIds.push(delivery!.id);
  }
  return { user: user!, endpoint: endpoint!, destination: destination!, deliveryIds };
}
