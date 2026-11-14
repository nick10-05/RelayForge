import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { deliveries, destinations, events } from '../db/schema.ts';
import type { SignatureFailureReason } from './verify.ts';

/** Invalid-signature events keep only this much body: enough to debug a mismatch (§7.2). */
export const INVALID_BODY_LIMIT = 64 * 1024;

export type IncomingEvent = {
  endpointId: string;
  method: string;
  path: string;
  query: string | null;
  headers: Record<string, string | string[]>;
  body: Buffer;
  contentType: string | null;
  sourceIp: string | null;
  dedupeKey: string | null;
  receivedAt: Date;
  /** 'valid' when the endpoint verifies signatures and this one passed. */
  signatureStatus?: 'not_checked' | 'valid';
};

export type StoreResult = { eventId: string; duplicate: boolean; deliveriesCreated: number };

/**
 * Transactional outbox (design §4.2). In ONE transaction:
 *   1. insert the event — or, if its dedupe key was seen before, count the duplicate;
 *   2. for a new event, insert one pending delivery per destination enabled right now.
 * The caller responds only after this resolves (= committed). A crash before commit
 * loses nothing the provider won't retry; a crash after commit leaves delivery rows
 * the worker will find.
 */
export async function storeEvent(db: Db, incoming: IncomingEvent): Promise<StoreResult> {
  return db.transaction(async (tx) => {
    const values = {
      endpointId: incoming.endpointId,
      method: incoming.method,
      path: incoming.path,
      query: incoming.query,
      headers: incoming.headers,
      body: incoming.body,
      contentType: incoming.contentType,
      sizeBytes: incoming.body.length,
      sourceIp: incoming.sourceIp,
      dedupeKey: incoming.dedupeKey,
      receivedAt: incoming.receivedAt,
      signatureStatus: incoming.signatureStatus ?? 'not_checked',
    };

    let row: { id: string; inserted: boolean } | undefined;
    if (incoming.dedupeKey === null) {
      const [inserted] = await tx.insert(events).values(values).returning({ id: events.id });
      row = inserted && { id: inserted.id, inserted: true };
    } else {
      // Concurrent requests with the same key serialise on the unique index: the second
      // waits for the first to commit, then takes the DO UPDATE branch.
      // `xmax = 0` is true only for a freshly inserted row (an updated row has an xmax).
      [row] = await tx
        .insert(events)
        .values(values)
        .onConflictDoUpdate({
          target: [events.endpointId, events.dedupeKey],
          targetWhere: sql`${events.dedupeKey} IS NOT NULL`,
          set: {
            duplicateCount: sql`${events.duplicateCount} + 1`,
            lastDuplicateAt: incoming.receivedAt,
          },
        })
        .returning({ id: events.id, inserted: sql<boolean>`(xmax = 0)` });
    }
    if (!row) throw new Error('event insert returned no row');

    if (!row.inserted) return { eventId: row.id, duplicate: true, deliveriesCreated: 0 };

    const targets = await tx
      .select({ id: destinations.id, maxAttempts: destinations.maxAttempts })
      .from(destinations)
      .where(and(eq(destinations.endpointId, incoming.endpointId), eq(destinations.enabled, true)));

    if (targets.length > 0) {
      await tx.insert(deliveries).values(
        targets.map((d) => ({
          eventId: row.id,
          destinationId: d.id,
          maxAttempts: d.maxAttempts, // snapshot: later destination edits don't change it
          nextAttemptAt: incoming.receivedAt,
        })),
      );
    }
    return { eventId: row.id, duplicate: false, deliveriesCreated: targets.length };
  });
}

/**
 * Stores a request whose signature failed verification (design §7.2, locked policy):
 * kept for debugging, never forwarded.
 *   - only the first 64 KB of the body (`body_truncated`), `size_bytes` = the real size;
 *   - NO delivery rows, so nothing can ever send it (invariant #8);
 *   - NO dedupe key: a forged request must not "reserve" a real event's id, which would
 *     make the genuine event look like a duplicate and silently drop it.
 * A single INSERT, so no transaction is needed.
 */
export async function storeInvalidEvent(
  db: Db,
  incoming: Omit<IncomingEvent, 'dedupeKey' | 'signatureStatus'>,
  reason: SignatureFailureReason,
): Promise<{ eventId: string }> {
  const truncated = incoming.body.length > INVALID_BODY_LIMIT;
  const [row] = await db
    .insert(events)
    .values({
      endpointId: incoming.endpointId,
      method: incoming.method,
      path: incoming.path,
      query: incoming.query,
      headers: incoming.headers,
      body: truncated ? incoming.body.subarray(0, INVALID_BODY_LIMIT) : incoming.body,
      bodyTruncated: truncated,
      contentType: incoming.contentType,
      sizeBytes: incoming.body.length,
      sourceIp: incoming.sourceIp,
      dedupeKey: null,
      receivedAt: incoming.receivedAt,
      signatureStatus: 'invalid',
      signatureFailureReason: reason,
    })
    .returning({ id: events.id });
  if (!row) throw new Error('event insert returned no row');
  return { eventId: row.id };
}
