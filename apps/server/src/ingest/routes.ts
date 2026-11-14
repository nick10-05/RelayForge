import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.ts';
import { endpoints } from '../db/schema.ts';
import { NOT_FOUND } from '../http/errors.ts';
import { extractDedupeKey } from './dedupe.ts';
import { storeEvent } from './store.ts';

export const INGEST_BODY_LIMIT = 1024 * 1024; // 1 MB (design §7.5)
const SLUG = /^[A-Za-z0-9_-]{22}$/;

export type IngestOptions = { db: Db; wakeWorker: () => void };

/**
 * `ANY /in/:slug[/*]` — receive a webhook. Registered in its own encapsulated plugin so
 * that every content type arrives as raw bytes here, while the JSON API keeps parsing JSON.
 */
export const ingestRoutes: FastifyPluginAsync<IngestOptions> = async (app, { db, wakeWorker }) => {
  // Raw bytes in, raw bytes out: never re-serialise, or provider signatures break.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  const handler = async (
    request: FastifyRequest<{ Params: { slug: string } }>,
    reply: FastifyReply,
  ) => {
    const receivedAt = new Date();
    const { slug } = request.params;
    if (!SLUG.test(slug)) return reply.code(404).send(NOT_FOUND);

    const [endpoint] = await db
      .select({
        id: endpoints.id,
        dedupeSource: endpoints.dedupeSource,
        dedupeName: endpoints.dedupeName,
      })
      .from(endpoints)
      .where(eq(endpoints.slug, slug))
      .limit(1);
    if (!endpoint) return reply.code(404).send(NOT_FOUND);

    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const headers = cleanHeaders(request.headers);
    const queryIndex = request.url.indexOf('?');

    const result = await storeEvent(db, {
      endpointId: endpoint.id,
      method: request.method,
      path: queryIndex === -1 ? request.url : request.url.slice(0, queryIndex),
      query: queryIndex === -1 ? null : request.url.slice(queryIndex + 1),
      headers,
      body,
      contentType: typeof headers['content-type'] === 'string' ? headers['content-type'] : null,
      sourceIp: request.ip,
      dedupeKey: extractDedupeKey(
        { source: endpoint.dedupeSource, name: endpoint.dedupeName },
        headers,
        body,
      ),
      receivedAt,
    });

    // Committed. Now it is safe to acknowledge, then nudge the worker (in-process).
    if (result.duplicate) {
      return reply.code(200).send({ eventId: result.eventId, duplicate: true });
    }
    void reply.code(202).send({ eventId: result.eventId });
    if (result.deliveriesCreated > 0) wakeWorker();
    return reply;
  };

  const options = { bodyLimit: INGEST_BODY_LIMIT };
  app.all('/:slug', options, handler);
  app.all('/:slug/*', options, handler);
};

function cleanHeaders(raw: FastifyRequest['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}
