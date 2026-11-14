// Manual redelivery (design §4.9, §5.3).
//
// Retry/replay never resets an old row: it inserts a NEW delivery (`trigger='manual'`,
// `replay_of` → the row it came from), so the attempt history stays intact.
// Idempotency comes from the partial unique index `deliveries_one_active_uq`
// (event_id, destination_id) WHERE status IN ('pending','in_flight'): a double-click's
// second insert hits the index, does nothing, and the caller gets 409 with the active id.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { deliveries, destinations, endpoints, events } from '../db/schema.ts';

const ACTIVE = sql`${deliveries.status} IN ('pending', 'in_flight')`;

export type RedeliverResult =
  { kind: 'created'; deliveryId: string } | { kind: 'active_exists'; deliveryId: string };

/**
 * Inserts a manual delivery unless one is already active for (event, destination).
 * If the insert loses to an active row that then finishes before we can read it, try again.
 */
async function insertManual(
  db: Db,
  input: { eventId: string; destinationId: string; maxAttempts: number; replayOf: string | null },
): Promise<RedeliverResult> {
  for (let i = 0; i < 3; i++) {
    const [created] = await db
      .insert(deliveries)
      .values({ ...input, trigger: 'manual' })
      .onConflictDoNothing({
        target: [deliveries.eventId, deliveries.destinationId],
        where: ACTIVE,
      })
      .returning({ id: deliveries.id });
    if (created) return { kind: 'created', deliveryId: created.id };

    const [active] = await db
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.eventId, input.eventId),
          eq(deliveries.destinationId, input.destinationId),
          ACTIVE,
        ),
      )
      .limit(1);
    if (active) return { kind: 'active_exists', deliveryId: active.id };
  }
  throw new Error('could not create or find an active delivery');
}

export type RetryOutcome =
  RedeliverResult | { kind: 'not_found' } | { kind: 'not_dead' } | { kind: 'invalid_signature' };

/** Retry one delivery (normally a dead one). Tenant-scoped through the endpoint's owner. */
export async function retryDelivery(
  db: Db,
  userId: string,
  deliveryId: string,
): Promise<RetryOutcome> {
  const [row] = await db
    .select({
      id: deliveries.id,
      status: deliveries.status,
      eventId: deliveries.eventId,
      destinationId: deliveries.destinationId,
      maxAttempts: destinations.maxAttempts,
      signatureStatus: events.signatureStatus,
    })
    .from(deliveries)
    .innerJoin(events, eq(events.id, deliveries.eventId))
    .innerJoin(destinations, eq(destinations.id, deliveries.destinationId))
    .innerJoin(endpoints, eq(endpoints.id, destinations.endpointId))
    .where(and(eq(deliveries.id, deliveryId), eq(endpoints.userId, userId)))
    .limit(1);
  if (!row) return { kind: 'not_found' };
  if (row.signatureStatus === 'invalid') return { kind: 'invalid_signature' };
  if (row.status === 'pending' || row.status === 'in_flight') {
    return { kind: 'active_exists', deliveryId: row.id };
  }
  if (row.status !== 'dead') return { kind: 'not_dead' };

  return insertManual(db, {
    eventId: row.eventId,
    destinationId: row.destinationId,
    maxAttempts: row.maxAttempts, // current destination setting, not the old snapshot
    replayOf: row.id,
  });
}

export type ReplayOutcome =
  | { kind: 'not_found' }
  | { kind: 'invalid_signature' }
  | { kind: 'no_destinations' }
  | {
      kind: 'done';
      results: ({ destinationId: string } & RedeliverResult)[];
    };

/**
 * Replay an event to its endpoint's enabled destinations (or the given subset).
 * Each destination is independent: an active delivery there is reported, not an error.
 */
export async function replayEvent(
  db: Db,
  userId: string,
  eventId: string,
  destinationIds?: string[],
): Promise<ReplayOutcome> {
  const [event] = await db
    .select({
      id: events.id,
      endpointId: events.endpointId,
      signatureStatus: events.signatureStatus,
    })
    .from(events)
    .innerJoin(endpoints, eq(endpoints.id, events.endpointId))
    .where(and(eq(events.id, eventId), eq(endpoints.userId, userId)))
    .limit(1);
  if (!event) return { kind: 'not_found' };
  if (event.signatureStatus === 'invalid') return { kind: 'invalid_signature' };

  const targets = await db
    .select({ id: destinations.id, maxAttempts: destinations.maxAttempts })
    .from(destinations)
    .where(
      and(
        eq(destinations.endpointId, event.endpointId),
        destinationIds ? inArray(destinations.id, destinationIds) : eq(destinations.enabled, true),
      ),
    );
  if (targets.length === 0) return { kind: 'no_destinations' };

  const results: ({ destinationId: string } & RedeliverResult)[] = [];
  for (const target of targets) {
    const [latest] = await db
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(and(eq(deliveries.eventId, event.id), eq(deliveries.destinationId, target.id)))
      .orderBy(desc(deliveries.id)) // UUIDv7: newest last-created row
      .limit(1);
    const result = await insertManual(db, {
      eventId: event.id,
      destinationId: target.id,
      maxAttempts: target.maxAttempts,
      replayOf: latest?.id ?? null,
    });
    results.push({ destinationId: target.id, ...result });
  }
  return { kind: 'done', results };
}

export const BULK_BATCH_SIZE = 200;

/**
 * Redeliver every dead delivery of an endpoint (optionally one destination), in batches.
 * Only the LATEST delivery per (event, destination) counts — a dead row whose later replay
 * succeeded is not resent. Invalid-signature events are never included.
 */
export async function redeliverDead(
  db: Db,
  userId: string,
  endpointId: string,
  opts: { destinationId?: string; batchSize?: number } = {},
): Promise<{ kind: 'not_found' } | { kind: 'done'; created: number; skipped: number }> {
  const [endpoint] = await db
    .select({ id: endpoints.id })
    .from(endpoints)
    .where(and(eq(endpoints.id, endpointId), eq(endpoints.userId, userId)))
    .limit(1);
  if (!endpoint) return { kind: 'not_found' };

  const batchSize = opts.batchSize ?? BULK_BATCH_SIZE;
  let created = 0;
  let skipped = 0;
  let after = '00000000-0000-0000-0000-000000000000';

  for (;;) {
    // Keyset over delivery id so each batch is a short query and a short insert.
    const batch = await db.execute<{
      id: string;
      event_id: string;
      destination_id: string;
      max_attempts: number;
    }>(sql`
      SELECT d.id, d.event_id, d.destination_id, ds.max_attempts
      FROM deliveries d
      JOIN destinations ds ON ds.id = d.destination_id
      JOIN events ev       ON ev.id = d.event_id
      WHERE ds.endpoint_id = ${endpoint.id}
        AND d.status = 'dead'
        AND ev.signature_status <> 'invalid'
        AND d.id > ${after}
        ${opts.destinationId ? sql`AND d.destination_id = ${opts.destinationId}` : sql``}
        AND NOT EXISTS (
          SELECT 1 FROM deliveries later
          WHERE later.event_id = d.event_id
            AND later.destination_id = d.destination_id
            AND later.id > d.id
        )
      ORDER BY d.id
      LIMIT ${batchSize}`);
    const rows = batch.rows;
    if (rows.length === 0) break;

    const inserted = await db
      .insert(deliveries)
      .values(
        rows.map((r) => ({
          eventId: r.event_id,
          destinationId: r.destination_id,
          maxAttempts: r.max_attempts,
          trigger: 'manual' as const,
          replayOf: r.id,
        })),
      )
      .onConflictDoNothing({
        target: [deliveries.eventId, deliveries.destinationId],
        where: ACTIVE,
      })
      .returning({ id: deliveries.id });
    created += inserted.length;
    skipped += rows.length - inserted.length;
    after = rows[rows.length - 1]!.id;
    if (rows.length < batchSize) break;
  }
  return { kind: 'done', created, skipped };
}
