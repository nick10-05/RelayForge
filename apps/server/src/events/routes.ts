import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/guard.ts';
import type { Db } from '../db/client.ts';
import { deliveries, deliveryAttempts, destinations, endpoints, events } from '../db/schema.ts';
import { NOT_FOUND, validationError } from '../http/errors.ts';

type Cursor = { receivedAt: Date; id: string };

/** Opaque keyset cursor: base64url("<ISO timestamp>|<uuid>"). */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.receivedAt.toISOString()}|${c.id}`).toString('base64url');
}

export function decodeCursor(raw: string): Cursor | null {
  const [iso, id, ...rest] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (!iso || !id || rest.length > 0) return null;
  const receivedAt = new Date(iso);
  if (Number.isNaN(receivedAt.getTime())) return null;
  if (!z.uuid().safeParse(id).success) return null;
  return { receivedAt, id };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Text bodies are shown as text; anything that isn't valid UTF-8 is base64. */
function encodeBody(body: Buffer): { encoding: 'utf8' | 'base64'; data: string } {
  try {
    return { encoding: 'utf8', data: utf8.decode(body) };
  } catch {
    return { encoding: 'base64', data: body.toString('base64') };
  }
}

const summaryColumns = {
  id: events.id,
  endpointId: events.endpointId,
  method: events.method,
  path: events.path,
  contentType: events.contentType,
  sizeBytes: events.sizeBytes,
  dedupeKey: events.dedupeKey,
  duplicateCount: events.duplicateCount,
  signatureStatus: events.signatureStatus,
  receivedAt: events.receivedAt,
};

export const eventRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.addHook('preHandler', requireUser(db));

  /** The event, only if its endpoint belongs to the user. */
  const findOwned = async (userId: string, id: string) => {
    const [row] = await db
      .select({ event: events })
      .from(events)
      .innerJoin(endpoints, eq(endpoints.id, events.endpointId))
      .where(and(eq(events.id, id), eq(endpoints.userId, userId)))
      .limit(1);
    return row?.event;
  };

  app.get(
    '/endpoints/:endpointId/events',
    {
      schema: {
        params: z.object({ endpointId: z.uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().max(200).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { endpointId } = request.params;
      const { limit, cursor } = request.query;

      const [owned] = await db
        .select({ id: endpoints.id })
        .from(endpoints)
        .where(and(eq(endpoints.id, endpointId), eq(endpoints.userId, currentUser(request).id)))
        .limit(1);
      if (!owned) return reply.code(404).send(NOT_FOUND);

      const after = cursor === undefined ? null : decodeCursor(cursor);
      if (cursor !== undefined && !after)
        return reply.code(400).send(validationError('invalid cursor'));

      // Keyset pagination on (received_at DESC, id DESC), served by
      // events_endpoint_received_idx. Unlike OFFSET, cost doesn't grow with page depth
      // and new events arriving between pages don't shift or duplicate rows.
      const rows = await db
        .select(summaryColumns)
        .from(events)
        .where(
          and(
            eq(events.endpointId, endpointId),
            after
              ? sql`(${events.receivedAt}, ${events.id}) < (${after.receivedAt}, ${after.id})`
              : undefined,
          ),
        )
        .orderBy(desc(events.receivedAt), desc(events.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        events: page,
        nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
      };
    },
  );

  app.get(
    '/events/:id',
    { schema: { params: z.object({ id: z.uuid() }) } },
    async (request, reply) => {
      const event = await findOwned(currentUser(request).id, request.params.id);
      if (!event) return reply.code(404).send(NOT_FOUND);

      const eventDeliveries = await db
        .select({
          id: deliveries.id,
          destinationId: deliveries.destinationId,
          destinationUrl: destinations.url,
          status: deliveries.status,
          deadReason: deliveries.deadReason,
          trigger: deliveries.trigger,
          replayOf: deliveries.replayOf,
          attemptCount: deliveries.attemptCount,
          maxAttempts: deliveries.maxAttempts,
          nextAttemptAt: deliveries.nextAttemptAt,
          lastStatusCode: deliveries.lastStatusCode,
          lastError: deliveries.lastError,
          createdAt: deliveries.createdAt,
          completedAt: deliveries.completedAt,
        })
        .from(deliveries)
        .innerJoin(destinations, eq(destinations.id, deliveries.destinationId))
        .where(eq(deliveries.eventId, event.id))
        .orderBy(asc(deliveries.createdAt), asc(deliveries.id));

      // The attempt timeline, in one query for all deliveries (bounded: max_attempts ≤ 15
      // per delivery). The worker id is an internal detail and stays out of the response.
      const attempts = eventDeliveries.length
        ? await db
            .select({
              deliveryId: deliveryAttempts.deliveryId,
              attemptNo: deliveryAttempts.attemptNo,
              startedAt: deliveryAttempts.startedAt,
              durationMs: deliveryAttempts.durationMs,
              statusCode: deliveryAttempts.statusCode,
              responseHeaders: deliveryAttempts.responseHeaders,
              responseBodySnippet: deliveryAttempts.responseBodySnippet,
              errorCode: deliveryAttempts.errorCode,
              errorMessage: deliveryAttempts.errorMessage,
            })
            .from(deliveryAttempts)
            .where(
              inArray(
                deliveryAttempts.deliveryId,
                eventDeliveries.map((d) => d.id),
              ),
            )
            .orderBy(asc(deliveryAttempts.attemptNo), asc(deliveryAttempts.startedAt))
        : [];
      const attemptsByDelivery = new Map<string, Omit<(typeof attempts)[number], 'deliveryId'>[]>();
      for (const { deliveryId, ...attempt } of attempts) {
        const list = attemptsByDelivery.get(deliveryId) ?? [];
        list.push(attempt);
        attemptsByDelivery.set(deliveryId, list);
      }

      return {
        event: {
          id: event.id,
          endpointId: event.endpointId,
          method: event.method,
          path: event.path,
          query: event.query,
          headers: event.headers,
          contentType: event.contentType,
          sizeBytes: event.sizeBytes,
          body: encodeBody(event.body),
          bodyTruncated: event.bodyTruncated,
          sourceIp: event.sourceIp,
          dedupeKey: event.dedupeKey,
          duplicateCount: event.duplicateCount,
          lastDuplicateAt: event.lastDuplicateAt,
          signatureStatus: event.signatureStatus,
          signatureFailureReason: event.signatureFailureReason,
          receivedAt: event.receivedAt,
          deliveries: eventDeliveries.map((d) => ({
            ...d,
            attempts: attemptsByDelivery.get(d.id) ?? [],
          })),
        },
      };
    },
  );

  // The exact stored bytes, as a download. Served as octet-stream + nosniff + attachment,
  // never with the sender's Content-Type: an attacker-supplied text/html body must not
  // render on our origin (that would be stored XSS next to the session cookie).
  app.get(
    '/events/:id/body',
    { schema: { params: z.object({ id: z.uuid() }) } },
    async (request, reply) => {
      const event = await findOwned(currentUser(request).id, request.params.id);
      if (!event) return reply.code(404).send(NOT_FOUND);
      return reply
        .header('content-type', 'application/octet-stream')
        .header('x-content-type-options', 'nosniff')
        .header('content-disposition', `attachment; filename="event-${event.id}.bin"`)
        .send(event.body);
    },
  );
};
