import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/guard.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import { ROTATION_WINDOW_MS, generateSigningSecret } from '../delivery/signing.ts';
import { uuidv7 } from '../lib/uuidv7.ts';
import type { Db } from '../db/client.ts';
import { destinations, endpoints } from '../db/schema.ts';
import { NOT_FOUND } from '../http/errors.ts';
import type { ResolveFn } from '../delivery/ssrf.ts';
import { validateDestinationUrl } from './url.ts';

const url = z.string().trim().min(1).max(2048);
const timeoutMs = z.number().int().min(1000).max(15000);
const maxAttempts = z.number().int().min(1).max(15);

const endpointParams = z.object({ endpointId: z.uuid() });
const destinationParams = z.object({ endpointId: z.uuid(), id: z.uuid() });

type DestinationRow = typeof destinations.$inferSelect;
// Secrets are never part of the DTO: they are returned once on create/rotate, and via /secret.
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

export type DestinationRouteOptions = {
  db: Db;
  production: boolean;
  allowPrivate: boolean;
  resolve?: ResolveFn;
  secretBox: SecretBox;
  wakeWorker: () => void;
};

export const destinationRoutes: FastifyPluginAsyncZod<DestinationRouteOptions> = async (
  app,
  { db, production, allowPrivate, resolve, secretBox, wakeWorker },
) => {
  const ref = (rowId: string, column: 'signing_secret_enc' | 'prev_signing_secret_enc') => ({
    table: 'destinations',
    column,
    rowId,
  });
  const validate = (raw: string) =>
    validateDestinationUrl(raw, { production, allowPrivate, ...(resolve && { resolve }) });
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
      const checked = await validate(request.body.url);
      if (!checked.ok) return reply.code(400).send(invalidUrl(checked.reason));

      // The id is generated first because it is part of the secret's AAD.
      const id = uuidv7();
      const signingSecret = generateSigningSecret();
      const [row] = await db
        .insert(destinations)
        .values({
          id,
          signingSecretEnc: secretBox.seal(signingSecret, ref(id, 'signing_secret_enc')),
          endpointId,
          url: checked.url,
          timeoutMs: request.body.timeoutMs,
          maxAttempts: request.body.maxAttempts,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      return reply.code(201).send({ destination: toDto(row), signingSecret });
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
        const checked = await validate(body.url);
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
      // Held deliveries become claimable again; the worker may be sleeping indefinitely.
      if (!existing.enabled && row.enabled) wakeWorker();
      return { destination: toDto(row) };
    },
  );

  /** Current signing secret (and the previous one while it still signs). */
  app.get('/:id/secret', { schema: { params: destinationParams } }, async (request, reply) => {
    const { endpointId, id } = request.params;
    const row = await findOwned(currentUser(request).id, endpointId, id);
    if (!row) return reply.code(404).send(NOT_FOUND);
    const previousActive =
      row.prevSigningSecretEnc !== null &&
      row.prevSecretExpiresAt !== null &&
      row.prevSecretExpiresAt.getTime() > Date.now();
    return {
      signingSecret: row.signingSecretEnc
        ? secretBox.open(row.signingSecretEnc, ref(row.id, 'signing_secret_enc'))
        : null,
      previousSigningSecret: previousActive
        ? secretBox.open(row.prevSigningSecretEnc!, ref(row.id, 'prev_signing_secret_enc'))
        : null,
      previousExpiresAt: previousActive ? row.prevSecretExpiresAt : null,
    };
  });

  /**
   * New signing secret. The old one keeps signing (second signature in the header) for 24 h
   * so receivers can switch without rejecting messages. Rotating again inside the window
   * drops the oldest secret.
   */
  app.post(
    '/:id/rotate-secret',
    { schema: { params: destinationParams } },
    async (request, reply) => {
      const { endpointId, id } = request.params;
      const row = await findOwned(currentUser(request).id, endpointId, id);
      if (!row) return reply.code(404).send(NOT_FOUND);

      const signingSecret = generateSigningSecret();
      const previous = row.signingSecretEnc
        ? secretBox.seal(
            secretBox.open(row.signingSecretEnc, ref(row.id, 'signing_secret_enc')),
            ref(row.id, 'prev_signing_secret_enc'), // re-sealed: the AAD names the column
          )
        : null;
      const previousExpiresAt = previous ? new Date(Date.now() + ROTATION_WINDOW_MS) : null;
      await db
        .update(destinations)
        .set({
          signingSecretEnc: secretBox.seal(signingSecret, ref(row.id, 'signing_secret_enc')),
          prevSigningSecretEnc: previous,
          prevSecretExpiresAt: previousExpiresAt,
        })
        .where(eq(destinations.id, row.id));
      return { signingSecret, previousExpiresAt };
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
