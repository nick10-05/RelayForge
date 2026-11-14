// Redelivery API (design §4.9): retry a delivery, replay an event, bulk-redeliver dead.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/guard.ts';
import type { Db } from '../db/client.ts';
import { NOT_FOUND } from '../http/errors.ts';
import { redeliverDead, replayEvent, retryDelivery } from './redeliver.ts';

const INVALID_SIGNATURE = {
  error: 'invalid_signature_event',
  message: 'Events that failed signature verification are never forwarded or replayed',
};

export type RedeliveryRouteOptions = { db: Db; wakeWorker: () => void };

export const redeliveryRoutes: FastifyPluginAsyncZod<RedeliveryRouteOptions> = async (
  app,
  { db, wakeWorker },
) => {
  app.addHook('preHandler', requireUser(db));

  app.post(
    '/deliveries/:id/retry',
    { schema: { params: z.object({ id: z.uuid() }) } },
    async (request, reply) => {
      const result = await retryDelivery(db, currentUser(request).id, request.params.id);
      switch (result.kind) {
        case 'not_found':
          return reply.code(404).send(NOT_FOUND);
        case 'invalid_signature':
          return reply.code(422).send(INVALID_SIGNATURE);
        case 'not_dead':
          return reply.code(422).send({
            error: 'delivery_not_dead',
            message: 'Only dead deliveries can be retried; replay the event to resend it',
          });
        case 'active_exists':
          return reply.code(409).send({
            error: 'active_delivery_exists',
            message: 'A delivery for this event and destination is already pending',
            deliveryId: result.deliveryId,
          });
        case 'created':
          wakeWorker();
          return reply.code(202).send({ deliveryId: result.deliveryId });
      }
    },
  );

  app.post(
    '/events/:id/replay',
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ destinationIds: z.array(z.uuid()).min(1).max(50).optional() }).nullish(),
      },
    },
    async (request, reply) => {
      const result = await replayEvent(
        db,
        currentUser(request).id,
        request.params.id,
        request.body?.destinationIds,
      );
      switch (result.kind) {
        case 'not_found':
          return reply.code(404).send(NOT_FOUND);
        case 'invalid_signature':
          return reply.code(422).send(INVALID_SIGNATURE);
        case 'no_destinations':
          return reply.code(422).send({
            error: 'no_destinations',
            message: 'The endpoint has no matching enabled destinations',
          });
        case 'done': {
          const deliveries = result.results.map((r) => ({
            destinationId: r.destinationId,
            deliveryId: r.deliveryId,
            created: r.kind === 'created',
          }));
          if (deliveries.some((d) => d.created)) {
            wakeWorker();
            return reply.code(202).send({ deliveries });
          }
          return reply.code(409).send({
            error: 'active_delivery_exists',
            message: 'Every destination already has a pending delivery for this event',
            deliveries,
          });
        }
      }
    },
  );

  app.post(
    '/endpoints/:endpointId/redeliver-dead',
    {
      schema: {
        params: z.object({ endpointId: z.uuid() }),
        body: z.object({ destinationId: z.uuid().optional() }).nullish(),
      },
    },
    async (request, reply) => {
      const destinationId = request.body?.destinationId;
      const result = await redeliverDead(
        db,
        currentUser(request).id,
        request.params.endpointId,
        destinationId ? { destinationId } : {},
      );
      if (result.kind === 'not_found') return reply.code(404).send(NOT_FOUND);
      if (result.created > 0) wakeWorker();
      return reply.code(202).send({ created: result.created, skipped: result.skipped });
    },
  );
};
