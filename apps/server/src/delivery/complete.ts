import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { deliveries, deliveryAttempts } from '../db/schema.ts';
import type { AttemptResult, ClaimedDelivery, Outcome } from './types.ts';

const MAX_ERROR_LENGTH = 1000;

/**
 * Postgres `text` and `jsonb` reject U+0000. Receiver-controlled strings (a binary or gzip
 * response body, odd headers) can contain it; without this the attempt can never be
 * recorded, the completion throws every time, and the delivery is re-sent until exhausted.
 */
export const dbSafe = (s: string) => s.replaceAll('\u0000', '\uFFFD');
const clip = (s: string | undefined) =>
  s === undefined ? null : dbSafe(s.slice(0, MAX_ERROR_LENGTH));

function dbSafeHeaders(
  headers: Record<string, string | string[]> | undefined,
): Record<string, string | string[]> | null {
  if (headers === undefined) return null;
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[dbSafe(name)] = Array.isArray(value) ? value.map(dbSafe) : dbSafe(value);
  }
  return out;
}

/**
 * Records an attempt and applies its outcome, fenced (design §4.4).
 *
 * The UPDATE only matches if this worker still holds the lease it claimed:
 * `lease_owner = me AND attempt_count = my attempt AND status = 'in_flight'`.
 * If the lease expired and another worker re-claimed the row, attempt_count has moved
 * on, 0 rows match, and this stale result is discarded — it can never overwrite a newer
 * one. The attempt itself is logged either way (it really happened on the wire).
 *
 * Returns true if the outcome was applied, false if it was fenced off.
 */
export async function completeDelivery(
  db: Db,
  claim: ClaimedDelivery,
  attempt: AttemptResult,
  outcome: Outcome,
): Promise<boolean> {
  // A retry with no attempts left is final: dead/exhausted.
  const final: Outcome =
    outcome.kind === 'retry' && claim.attemptCount >= claim.maxAttempts
      ? { kind: 'dead', reason: 'exhausted' }
      : outcome;

  const lastError =
    attempt.errorMessage !== undefined
      ? clip(`${attempt.errorCode ?? 'error'}: ${attempt.errorMessage}`)
      : attempt.statusCode !== undefined && final.kind !== 'succeeded'
        ? `HTTP ${attempt.statusCode}`
        : null;

  const common = {
    lastStatusCode: attempt.statusCode ?? null,
    lastError,
    leaseOwner: null,
    updatedAt: sql`now()`,
  };

  let changes;
  switch (final.kind) {
    case 'succeeded':
      changes = {
        ...common,
        status: 'succeeded' as const,
        lastError: null,
        completedAt: sql`now()`,
      };
      break;
    case 'retry':
      changes = {
        ...common,
        status: 'pending' as const,
        nextAttemptAt: sql`now() + ${Math.max(0, Math.round(final.delayMs))}::int * interval '1 millisecond'`,
      };
      break;
    case 'dead':
      changes = {
        ...common,
        status: 'dead' as const,
        deadReason: final.reason,
        completedAt: sql`now()`,
      };
      break;
  }

  return db.transaction(async (tx) => {
    await tx.insert(deliveryAttempts).values({
      deliveryId: claim.id,
      attemptNo: claim.attemptCount,
      workerId: claim.leaseOwner,
      startedAt: attempt.startedAt,
      durationMs: Math.round(attempt.durationMs),
      statusCode: attempt.statusCode ?? null,
      responseHeaders: dbSafeHeaders(attempt.responseHeaders),
      responseBodySnippet:
        attempt.responseBodySnippet === undefined ? null : dbSafe(attempt.responseBodySnippet),
      errorCode: attempt.errorCode ?? null,
      errorMessage: clip(attempt.errorMessage),
    });

    const updated = await tx
      .update(deliveries)
      .set(changes)
      .where(
        and(
          eq(deliveries.id, claim.id),
          eq(deliveries.status, 'in_flight'),
          eq(deliveries.leaseOwner, claim.leaseOwner),
          eq(deliveries.attemptCount, claim.attemptCount),
        ),
      )
      .returning({ id: deliveries.id });
    return updated.length === 1;
  });
}
