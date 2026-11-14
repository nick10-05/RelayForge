import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/client.ts';
import { endpoints } from '../db/schema.ts';
import type { VerifyEncoding, VerifyScheme } from '../db/schema.ts';
import { NOT_FOUND } from '../http/errors.ts';
import { extractDedupeKey } from './dedupe.ts';
import { storeEvent, storeInvalidEvent } from './store.ts';
import { verifySignature } from './verify.ts';
import type { VerifyConfig } from './verify.ts';

export const INGEST_BODY_LIMIT = 1024 * 1024; // 1 MB (design §7.5)
const SLUG = /^[A-Za-z0-9_-]{22}$/;

/** Same body for every failure reason: the reason is for the endpoint owner, not the sender. */
export const INVALID_SIGNATURE = {
  error: 'invalid_signature',
  message: 'Signature verification failed',
} as const;

export type IngestOptions = { db: Db; wakeWorker: () => void; secretBox: SecretBox };

/**
 * `ANY /in/:slug[/*]` — receive a webhook. Registered in its own encapsulated plugin so
 * that every content type arrives as raw bytes here, while the JSON API keeps parsing JSON.
 */
export const ingestRoutes: FastifyPluginAsync<IngestOptions> = async (
  app,
  { db, wakeWorker, secretBox },
) => {
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
        verifyScheme: endpoints.verifyScheme,
        verifyHeader: endpoints.verifyHeader,
        verifyPrefix: endpoints.verifyPrefix,
        verifyEncoding: endpoints.verifyEncoding,
        verifySecretEnc: endpoints.verifySecretEnc,
      })
      .from(endpoints)
      .where(eq(endpoints.slug, slug))
      .limit(1);
    if (!endpoint) return reply.code(404).send(NOT_FOUND);

    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const headers = cleanHeaders(request.headers);
    const queryIndex = request.url.indexOf('?');
    const incoming = {
      endpointId: endpoint.id,
      method: request.method,
      path: queryIndex === -1 ? request.url : request.url.slice(0, queryIndex),
      query: queryIndex === -1 ? null : request.url.slice(queryIndex + 1),
      headers,
      body,
      contentType: typeof headers['content-type'] === 'string' ? headers['content-type'] : null,
      sourceIp: request.ip,
      receivedAt,
    };

    let signatureStatus: 'not_checked' | 'valid' = 'not_checked';
    if (endpoint.verifyScheme !== 'none') {
      let config: VerifyConfig;
      try {
        config = verifyConfigOf(endpoint, secretBox);
      } catch (error) {
        // Can't check (key missing or retired, corrupt row). Neither store it as invalid nor
        // accept it: a 503 makes the provider retry once the problem is fixed.
        // The error names no secret value.
        request.log.error({ err: error, endpointId: endpoint.id }, 'cannot open verify secret');
        return reply.code(503).send({
          error: 'signature_check_unavailable',
          message: 'Signature verification is temporarily unavailable',
        });
      }
      const verdict = verifySignature(config, headers, body);
      if (!verdict.ok) {
        await storeInvalidEvent(db, incoming, verdict.reason);
        return reply.code(401).send(INVALID_SIGNATURE);
      }
      signatureStatus = 'valid';
    }

    const result = await storeEvent(db, {
      ...incoming,
      signatureStatus,
      dedupeKey: extractDedupeKey(
        { source: endpoint.dedupeSource, name: endpoint.dedupeName },
        headers,
        body,
      ),
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

type EndpointVerifyColumns = {
  id: string;
  verifyScheme: VerifyScheme;
  verifyHeader: string | null;
  verifyPrefix: string | null;
  verifyEncoding: VerifyEncoding | null;
  verifySecretEnc: string | null;
};

/** Builds the verifier config, opening the sealed secret. Throws if the row is unusable. */
function verifyConfigOf(e: EndpointVerifyColumns, box: SecretBox): VerifyConfig {
  if (!e.verifySecretEnc) throw new Error('endpoint has a verify scheme but no secret');
  const secret = box.open(e.verifySecretEnc, {
    table: 'endpoints',
    column: 'verify_secret_enc',
    rowId: e.id,
  });
  if (e.verifyScheme === 'standard_webhooks') return { scheme: 'standard_webhooks', secret };
  if (e.verifyScheme !== 'hmac' || !e.verifyHeader || !e.verifyEncoding) {
    throw new Error('endpoint verify config is incomplete');
  }
  return {
    scheme: 'hmac',
    header: e.verifyHeader,
    prefix: e.verifyPrefix,
    encoding: e.verifyEncoding,
    secret,
  };
}

function cleanHeaders(raw: FastifyRequest['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}
