import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/guard.ts';
import type { Db } from '../db/client.ts';
import { DEDUPE_SOURCES, endpoints } from '../db/schema.ts';
import type { DedupeSource } from '../db/schema.ts';
import { NOT_FOUND, validationError } from '../http/errors.ts';

// RFC 9110 header field-name characters.
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const name = z.string().trim().min(1).max(100);
const dedupeSource = z.enum(DEDUPE_SOURCES);
const dedupeName = z.string().trim().min(1).max(200).nullable();

const idParams = z.object({ id: z.uuid() });

/** Normalises the dedupe pair, or returns an error message. */
function resolveDedupe(
  source: DedupeSource,
  rawName: string | null | undefined,
): { source: DedupeSource; name: string | null } | string {
  if (source === 'none') return { source, name: null };
  if (!rawName) return `dedupeName is required when dedupeSource is "${source}"`;
  if (source === 'header') {
    if (!HEADER_NAME.test(rawName)) return 'dedupeName must be a valid HTTP header name';
    return { source, name: rawName.toLowerCase() };
  }
  return { source, name: rawName };
}

type EndpointRow = typeof endpoints.$inferSelect;
const toDto = (e: EndpointRow) => ({
  id: e.id,
  name: e.name,
  slug: e.slug,
  ingestPath: `/in/${e.slug}`,
  paused: e.paused,
  dedupeSource: e.dedupeSource,
  dedupeName: e.dedupeName,
  verifyScheme: e.verifyScheme,
  createdAt: e.createdAt,
});

export const endpointRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.addHook('preHandler', requireUser(db));

  const findOwned = async (userId: string, id: string) => {
    const [row] = await db
      .select()
      .from(endpoints)
      .where(and(eq(endpoints.id, id), eq(endpoints.userId, userId)))
      .limit(1);
    return row;
  };

  app.post(
    '/',
    {
      schema: {
        body: z.object({
          name,
          dedupeSource: dedupeSource.default('none'),
          dedupeName: dedupeName.optional(),
        }),
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const dedupe = resolveDedupe(request.body.dedupeSource, request.body.dedupeName);
      if (typeof dedupe === 'string') return reply.code(400).send(validationError(dedupe));

      const [row] = await db
        .insert(endpoints)
        .values({
          userId: user.id,
          name: request.body.name,
          // 128 random bits: the ingest URL is a capability, unguessable by design.
          slug: randomBytes(16).toString('base64url'),
          dedupeSource: dedupe.source,
          dedupeName: dedupe.name,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      return reply.code(201).send({ endpoint: toDto(row) });
    },
  );

  app.get('/', async (request) => {
    const user = currentUser(request);
    const rows = await db
      .select()
      .from(endpoints)
      .where(eq(endpoints.userId, user.id))
      .orderBy(desc(endpoints.createdAt), desc(endpoints.id));
    return { endpoints: rows.map(toDto) };
  });

  app.get('/:id', { schema: { params: idParams } }, async (request, reply) => {
    const row = await findOwned(currentUser(request).id, request.params.id);
    if (!row) return reply.code(404).send(NOT_FOUND);
    return { endpoint: toDto(row) };
  });

  app.patch(
    '/:id',
    {
      schema: {
        params: idParams,
        body: z
          .object({
            name: name.optional(),
            paused: z.boolean().optional(),
            dedupeSource: dedupeSource.optional(),
            dedupeName: dedupeName.optional(),
          })
          .refine((b) => Object.keys(b).length > 0, 'at least one field is required'),
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const existing = await findOwned(user.id, request.params.id);
      if (!existing) return reply.code(404).send(NOT_FOUND);

      const body = request.body;
      const dedupe = resolveDedupe(
        body.dedupeSource ?? existing.dedupeSource,
        body.dedupeName !== undefined ? body.dedupeName : existing.dedupeName,
      );
      if (typeof dedupe === 'string') return reply.code(400).send(validationError(dedupe));

      const [row] = await db
        .update(endpoints)
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.paused !== undefined && { paused: body.paused }),
          dedupeSource: dedupe.source,
          dedupeName: dedupe.name,
        })
        .where(and(eq(endpoints.id, existing.id), eq(endpoints.userId, user.id)))
        .returning();
      if (!row) return reply.code(404).send(NOT_FOUND);
      // Day 6: resuming a paused endpoint will wake the delivery worker here.
      return { endpoint: toDto(row) };
    },
  );

  app.delete('/:id', { schema: { params: idParams } }, async (request, reply) => {
    const deleted = await db
      .delete(endpoints)
      .where(
        and(eq(endpoints.id, request.params.id), eq(endpoints.userId, currentUser(request).id)),
      )
      .returning({ id: endpoints.id });
    if (deleted.length === 0) return reply.code(404).send(NOT_FOUND);
    return reply.code(204).send();
  });
};
