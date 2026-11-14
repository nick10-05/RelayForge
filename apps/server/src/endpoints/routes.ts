import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/guard.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/client.ts';
import { DEDUPE_SOURCES, VERIFY_ENCODINGS, endpoints } from '../db/schema.ts';
import type { DedupeSource } from '../db/schema.ts';
import { NOT_FOUND, validationError } from '../http/errors.ts';
import { isValidStandardWebhooksSecret } from '../ingest/verify.ts';
import { uuidv7 } from '../lib/uuidv7.ts';

// RFC 9110 header field-name characters.
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const name = z.string().trim().min(1).max(100);
const dedupeSource = z.enum(DEDUPE_SOURCES);
const dedupeName = z.string().trim().min(1).max(200).nullable();

const idParams = z.object({ id: z.uuid() });

/**
 * Inbound signature verification (design §7.2). The secret is write-only: it is sealed
 * (AES-256-GCM, AAD bound to this endpoint row) and never returned by the API.
 * Changing any part of the config means sending the whole object again, secret included.
 */
const verification = z.discriminatedUnion('scheme', [
  z.object({ scheme: z.literal('none') }),
  z.object({
    scheme: z.literal('hmac'),
    header: z
      .string()
      .trim()
      .max(200)
      .regex(HEADER_NAME, 'must be a valid HTTP header name')
      .transform((h) => h.toLowerCase()),
    prefix: z.string().min(1).max(50).nullable().default(null),
    encoding: z.enum(VERIFY_ENCODINGS),
    secret: z.string().min(1).max(512),
  }),
  z.object({
    scheme: z.literal('standard_webhooks'),
    secret: z
      .string()
      .max(512)
      .refine(isValidStandardWebhooksSecret, 'must be "whsec_" + base64 (at least 16 bytes)'),
  }),
]);
type Verification = z.infer<typeof verification>;

const VERIFY_SECRET_COLUMN = 'verify_secret_enc';
const verifyRef = (rowId: string) => ({
  table: 'endpoints',
  column: VERIFY_SECRET_COLUMN,
  rowId,
});

function verifyColumns(v: Verification, rowId: string, box: SecretBox) {
  switch (v.scheme) {
    case 'none':
      return {
        verifyScheme: v.scheme,
        verifyHeader: null,
        verifyPrefix: null,
        verifyEncoding: null,
        verifySecretEnc: null,
      };
    case 'hmac':
      return {
        verifyScheme: v.scheme,
        verifyHeader: v.header,
        verifyPrefix: v.prefix,
        verifyEncoding: v.encoding,
        verifySecretEnc: box.seal(v.secret, verifyRef(rowId)),
      };
    case 'standard_webhooks':
      return {
        verifyScheme: v.scheme,
        verifyHeader: null,
        verifyPrefix: null,
        verifyEncoding: null,
        verifySecretEnc: box.seal(v.secret, verifyRef(rowId)),
      };
  }
}

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
  verification: {
    scheme: e.verifyScheme,
    header: e.verifyHeader,
    prefix: e.verifyPrefix,
    encoding: e.verifyEncoding,
    hasSecret: e.verifySecretEnc !== null, // the secret itself is never returned
  },
  createdAt: e.createdAt,
});

export type EndpointRoutesOptions = { db: Db; wakeWorker: () => void; secretBox: SecretBox };

export const endpointRoutes: FastifyPluginAsyncZod<EndpointRoutesOptions> = async (
  app,
  { db, wakeWorker, secretBox },
) => {
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
          verification: verification.default({ scheme: 'none' }),
        }),
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const dedupe = resolveDedupe(request.body.dedupeSource, request.body.dedupeName);
      if (typeof dedupe === 'string') return reply.code(400).send(validationError(dedupe));

      const id = uuidv7(); // known before insert: the sealed secret's AAD names this row
      const [row] = await db
        .insert(endpoints)
        .values({
          id,
          userId: user.id,
          name: request.body.name,
          // 128 random bits: the ingest URL is a capability, unguessable by design.
          slug: randomBytes(16).toString('base64url'),
          dedupeSource: dedupe.source,
          dedupeName: dedupe.name,
          ...verifyColumns(request.body.verification, id, secretBox),
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
            verification: verification.optional(),
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
          ...(body.verification && verifyColumns(body.verification, existing.id, secretBox)),
        })
        .where(and(eq(endpoints.id, existing.id), eq(endpoints.userId, user.id)))
        .returning();
      if (!row) return reply.code(404).send(NOT_FOUND);
      // Held deliveries become claimable again; the worker may be sleeping indefinitely.
      if (existing.paused && !row.paused) wakeWorker();
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
