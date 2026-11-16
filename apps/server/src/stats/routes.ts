// GET /api/v1/stats (design §8.2): an at-a-glance health view of the caller's own endpoints.
//
// Scoped to the authenticated user (optionally one endpoint): it's a tenant API, so nothing
// here may reveal another tenant's traffic or the worker's global state. Everything is computed
// from the tables with aggregate queries over data that retention already bounds (7 days, 24 h
// for invalid-signature events), so no counters have to be kept in sync with the truth.
// The one exception is invalid-signature requests dropped by their rate limit: they are never
// stored, so they only exist as an in-memory counter ("since the process started").
import { and, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/guard.ts';
import type { Db } from '../db/client.ts';
import { DEAD_REASONS, endpoints } from '../db/schema.ts';
import type { DeadReason } from '../db/schema.ts';
import { NOT_FOUND } from '../http/errors.ts';
import type { IngestCounters } from '../http/limits.ts';

export type StatsRouteOptions = { db: Db; counters: IngestCounters };

type EventRow = { total: number; last_24h: number; invalid_signature: number; duplicates: number };
type DeliveryRow = { status: string; dead_reason: DeadReason | null; n: number; due: number };
type AttemptRow = { total: number; succeeded: number; p50: number | null; p95: number | null };

export const statsRoutes: FastifyPluginAsyncZod<StatsRouteOptions> = async (
  app,
  { db, counters },
) => {
  app.addHook('preHandler', requireUser(db));

  app.get(
    '/stats',
    { schema: { querystring: z.object({ endpointId: z.uuid().optional() }) } },
    async (request, reply) => {
      const userId = currentUser(request).id;
      const { endpointId } = request.query;

      const owned = await db
        .select({ id: endpoints.id })
        .from(endpoints)
        .where(
          and(eq(endpoints.userId, userId), endpointId ? eq(endpoints.id, endpointId) : undefined),
        );
      if (endpointId && owned.length === 0) return reply.code(404).send(NOT_FOUND);

      // Every query filters on the endpoint alias `e`, so tenancy is enforced in SQL.
      const scope: SQL = endpointId
        ? sql`e.user_id = ${userId} AND e.id = ${endpointId}`
        : sql`e.user_id = ${userId}`;

      const [eventResult, deliveryResult, attemptResult] = await Promise.all([
        db.execute<EventRow>(sql`
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE ev.received_at > now() - interval '24 hours')::int AS last_24h,
                 count(*) FILTER (WHERE ev.signature_status = 'invalid')::int AS invalid_signature,
                 coalesce(sum(ev.duplicate_count), 0)::int AS duplicates
          FROM events ev JOIN endpoints e ON e.id = ev.endpoint_id
          WHERE ${scope}`),
        // "due" = claimable right now (same conditions as the claim query): the backlog.
        // Rows of paused endpoints or disabled destinations are held, not backlog.
        db.execute<DeliveryRow>(sql`
          SELECT d.status, d.dead_reason, count(*)::int AS n,
                 count(*) FILTER (
                   WHERE d.status IN ('pending', 'in_flight') AND d.next_attempt_at <= now()
                     AND ds.enabled AND NOT e.paused
                 )::int AS due
          FROM deliveries d
          JOIN destinations ds ON ds.id = d.destination_id
          JOIN endpoints e     ON e.id = ds.endpoint_id
          WHERE ${scope}
          GROUP BY d.status, d.dead_reason`),
        db.execute<AttemptRow>(sql`
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE a.status_code BETWEEN 200 AND 299)::int AS succeeded,
                 percentile_cont(0.5)  WITHIN GROUP (ORDER BY a.duration_ms) AS p50,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY a.duration_ms) AS p95
          FROM delivery_attempts a
          JOIN deliveries d    ON d.id = a.delivery_id
          JOIN destinations ds ON ds.id = d.destination_id
          JOIN endpoints e     ON e.id = ds.endpoint_id
          WHERE ${scope} AND a.started_at > now() - interval '24 hours'`),
      ]);

      const ev = eventResult.rows[0]!;
      const deliveries = { pending: 0, inFlight: 0, succeeded: 0, dead: 0, due: 0 };
      const deadByReason = Object.fromEntries(DEAD_REASONS.map((r) => [r, 0])) as Record<
        DeadReason,
        number
      >;
      for (const row of deliveryResult.rows) {
        if (row.status === 'pending') deliveries.pending += row.n;
        if (row.status === 'in_flight') deliveries.inFlight += row.n;
        if (row.status === 'succeeded') deliveries.succeeded += row.n;
        if (row.status === 'dead') {
          deliveries.dead += row.n;
          if (row.dead_reason) deadByReason[row.dead_reason] += row.n;
        }
        deliveries.due += row.due;
      }
      const at = attemptResult.rows[0]!;
      const dropped = owned.reduce(
        (sum, { id }) => sum + (counters.invalidSignatureDropped.get(id) ?? 0),
        0,
      );
      const ms = (v: number | null) => (v === null ? null : Math.round(Number(v)));

      return {
        generatedAt: new Date(),
        endpointId: endpointId ?? null,
        endpoints: owned.length,
        events: {
          stored: ev.total,
          last24h: ev.last_24h,
          duplicatesReceived: ev.duplicates,
          invalidSignature: ev.invalid_signature,
          invalidSignatureDroppedSinceStart: dropped,
        },
        deliveries: { ...deliveries, deadByReason },
        attemptsLast24h: {
          total: at.total,
          succeeded: at.succeeded,
          successRate: at.total === 0 ? null : Math.round((at.succeeded / at.total) * 1000) / 1000,
          latencyMs: { p50: ms(at.p50), p95: ms(at.p95) },
        },
      };
    },
  );
};
