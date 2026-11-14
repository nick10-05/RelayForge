// Database-level guarantees the delivery engine and ingest will rely on.
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { createTestApp, uniqueEmail } from '../testing/helpers.ts';
import { deliveries, destinations, endpoints, events, users } from './schema.ts';

describe('schema constraints', () => {
  const t = createTestApp();
  afterAll(() => t.close());

  async function seed() {
    const [user] = await t.db
      .insert(users)
      .values({ email: uniqueEmail(), passwordHash: 'x' })
      .returning();
    const [endpoint] = await t.db
      .insert(endpoints)
      .values({ userId: user!.id, name: 'e', slug: crypto.randomUUID() })
      .returning();
    const [destination] = await t.db
      .insert(destinations)
      .values({ endpointId: endpoint!.id, url: 'https://example.com' })
      .returning();
    const [event] = await t.db
      .insert(events)
      .values({
        endpointId: endpoint!.id,
        method: 'POST',
        path: '/',
        headers: {},
        body: Buffer.from([0x00, 0xff, 0x10]),
        sizeBytes: 3,
      })
      .returning();
    return { user: user!, endpoint: endpoint!, destination: destination!, event: event! };
  }

  test('bytea bodies round-trip byte for byte', async () => {
    const { event } = await seed();
    const [row] = await t.db.select().from(events).where(eq(events.id, event.id));
    expect(row?.body.equals(Buffer.from([0x00, 0xff, 0x10]))).toBe(true);
  });

  test('at most one active delivery per (event, destination)', async () => {
    const { event, destination } = await seed();
    const base = { eventId: event.id, destinationId: destination.id, maxAttempts: 10 };
    const [first] = await t.db.insert(deliveries).values(base).returning();
    await expect(t.db.insert(deliveries).values(base)).rejects.toThrow();

    // Once the first is terminal, a new (e.g. manual replay) delivery is allowed.
    await t.db
      .update(deliveries)
      .set({ status: 'dead', deadReason: 'exhausted' })
      .where(eq(deliveries.id, first!.id));
    await expect(
      t.db.insert(deliveries).values({ ...base, trigger: 'manual', replayOf: first!.id }),
    ).resolves.toBeDefined();
  });

  test('dead requires a dead_reason, and only dead may have one', async () => {
    const { event, destination } = await seed();
    const base = { eventId: event.id, destinationId: destination.id, maxAttempts: 10 };
    await expect(t.db.insert(deliveries).values({ ...base, status: 'dead' })).rejects.toThrow();
    await expect(
      t.db.insert(deliveries).values({ ...base, status: 'pending', deadReason: 'redirect' }),
    ).rejects.toThrow();
  });

  test('dedupe key is unique per endpoint only when present', async () => {
    const { endpoint } = await seed();
    const row = {
      endpointId: endpoint.id,
      method: 'POST',
      path: '/',
      headers: {},
      body: Buffer.alloc(0),
      sizeBytes: 0,
    };
    await t.db.insert(events).values({ ...row, dedupeKey: 'evt_1' });
    await expect(t.db.insert(events).values({ ...row, dedupeKey: 'evt_1' })).rejects.toThrow();
    await t.db.insert(events).values(row);
    await expect(t.db.insert(events).values(row)).resolves.toBeDefined(); // NULL keys never collide
  });

  test('emails must be stored lower-cased', async () => {
    await expect(
      t.db.insert(users).values({ email: 'Mixed@Example.test', passwordHash: 'x' }),
    ).rejects.toThrow();
  });

  test('deleting an endpoint cascades to destinations, events and deliveries', async () => {
    const { endpoint, event, destination } = await seed();
    await t.db
      .insert(deliveries)
      .values({ eventId: event.id, destinationId: destination.id, maxAttempts: 10 });
    await t.db.delete(endpoints).where(eq(endpoints.id, endpoint.id));
    expect(await t.db.select().from(events).where(eq(events.id, event.id))).toHaveLength(0);
    expect(
      await t.db.select().from(deliveries).where(eq(deliveries.eventId, event.id)),
    ).toHaveLength(0);
  });
});
