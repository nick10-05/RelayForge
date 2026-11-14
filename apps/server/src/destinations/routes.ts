import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/guard.ts';
import type { Db } from '../db/client.ts';
import { destinations, endpoints } from '../db/schema.ts';
import { NOT_FOUND } from '../http/errors.ts';
import { checkDestinationUrl } from './url.ts';

const url = z.string().trim().min(1).max(2048);
const timeoutMs = z.number().int().min(1000).max(15000);
const maxAttempts = z.number().int().min(1).max(15);

const endpointParams = z.object({ endpointId: z.uuid() });
const destinationParams = z.object({ endpointId: z.uuid(), id: z.uuid() });

type DestinationRow = typeof destinations.$inferSelect;
// Secrets are never returned here (signing secrets get their own reveal flow on Day 6).
const toDto = (d: DestinationRow) => ({
  id: d.id,
  endpointId: d.endpointId,
  url: d.url,
  enabled: d.enabled,
  timeoutMs: d.timeoutMs,
  maxAttempts: d.maxAttempts,
  createdAt: d.createdAt,
});

const invalidUrl = (reason: string) => ({
  error: 'invalid_destination_url',
  message: `Destination URL rejected: ${reason}`,
});

export const destinationRoutes: FastifyPluginAsyncZod<{ db: Db; production: boolean }> = async (
  app,
  { db, production },
) => {
  app.addHook('preHandler', requireUser(db));

  /** Tenant check: the endpoint must belong to the current user, else 404. */
  const ownsEndpoint = async (userId: string, endpointId: string) => {
    const [row] = await db
      .select({ id: endpoints.id })
      .from(endpoints)
      .where(and(eq(endpoints.id, endpointId), eq(endpoints.userId, userId)))
      .limit(1);
    return row !== undefined;
  };

  const findOwned = async (userId: string, endpointId: string, id: string) => {
    if (!(await ownsEndpoint(userId, endpointId))) return undefined;
    const [row] = await db
      .select()
      .from(destinations)
      .where(and(eq(destinations.id, id), eq(destinations.endpointId, endpointId)))
      .limit(1);
    return row;
  };

  app.post(
    '/',
    {
      schema: {
        params: endpointParams,
        body: z.object({
          url,
          timeoutMs: timeoutMs.default(10000),
          maxAttempts: maxAttempts.default(10),
        }),
      },
    },
    async (request, reply) => {
      const { endpointId } = request.params;
      if (!(await ownsEndpoint(currentUser(request).id, endpointId))) {
        return reply.code(404).send(NOT_FOUND);
      }
      const checked = checkDestinationUrl(request.body.url, { production });
      if (!checked.ok) return reply.code(400).send(invalidUrl(checked.reason));

      const [row] = await db
        .insert(destinations)
        .values({
          endpointId,
          url: checked.url,
          timeoutMs: request.body.timeoutMs,
          maxAttempts: request.body.maxAttempts,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      return reply.code(201).send({ destination: toDto(row) });
    },
  );

  app.get('/', { schema: { params: endpointParams } }, async (request, reply) => {
    const { endpointId } = request.params;
    if (!(await ownsEndpoint(currentUser(request).id, endpointId))) {
      return reply.code(404).send(NOT_FOUND);
    }
    const rows = await db
      .select()
      .from(destinations)
      .where(eq(destinations.endpointId, endpointId))
      .orderBy(asc(destinations.createdAt), asc(destinations.id));
    return { destinations: rows.map(toDto) };
  });

  app.get('/:id', { schema: { params: destinationParams } }, async (request, reply) => {
    const { endpointId, id } = request.params;
    const row = await findOwned(currentUser(request).id, endpointId, id);
    if (!row) return reply.code(404).send(NOT_FOUND);
    return { destination: toDto(row) };
  });

  app.patch(
    '/:id',
    {
      schema: {
        params: destinationParams,
        body: z
          .object({
            url: url.optional(),
            enabled: z.boolean().optional(),
            timeoutMs: timeoutMs.optional(),
            maxAttempts: maxAttempts.optional(),
          })
          .refine((b) => Object.keys(b).length > 0, 'at least one field is required'),
      },
    },
    async (request, reply) => {
      const { endpointId, id } = request.params;
      const existing = await findOwned(currentUser(request).id, endpointId, id);
      if (!existing) return reply.code(404).send(NOT_FOUND);

      const body = request.body;
      let newUrl: string | undefined;
      if (body.url !== undefined) {
        const checked = checkDestinationUrl(body.url, { production });
        if (!checked.ok) return reply.code(400).send(invalidUrl(checked.reason));
        newUrl = checked.url;
      }

      const [row] = await db
        .update(destinations)
        .set({
          ...(newUrl !== undefined && { url: newUrl }),
          ...(body.enabled !== undefined && { enabled: body.enabled }),
          ...(body.timeoutMs !== undefined && { timeoutMs: body.timeoutMs }),
          ...(body.maxAttempts !== undefined && { maxAttempts: body.maxAttempts }),
        })
        .where(eq(destinations.id, existing.id))
        .returning();
      if (!row) return reply.code(404).send(NOT_FOUND);
      // Day 6: re-enabling a destination will wake the delivery worker here.
      return { destination: toDto(row) };
    },
  );

  app.delete('/:id', { schema: { params: destinationParams } }, async (request, reply) => {
    const { endpointId, id } = request.params;
    const existing = await findOwned(currentUser(request).id, endpointId, id);
    if (!existing) return reply.code(404).send(NOT_FOUND);
    await db.delete(destinations).where(eq(destinations.id, existing.id));
    return reply.code(204).send();
  });
};
