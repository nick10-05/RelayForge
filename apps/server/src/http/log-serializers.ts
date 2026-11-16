// Log serializers that keep capabilities and stored data out of the logs (design §7.4).
//
// 1. Request URLs. `/in/<slug>` is a capability URL: whoever knows the slug can post events to
//    that endpoint. Fastify logs every request's URL ("incoming request"), and on the host those
//    logs land in a web log viewer — so the slug and the query string (some providers put tokens
//    there) are replaced. The sub-path is kept: it helps debugging and grants nothing.
// 2. Database errors. Drizzle's DrizzleQueryError message is "Failed query: <sql>\nparams: <values>"
//    — the values are whatever was being written: event bodies and headers, password and token
//    hashes, sealed secrets. We log the SQL (placeholders only) and the cause, never the values.
//    Postgres's own `detail` ("Key (slug)=(...) already exists") goes for the same reason.
import { DrizzleQueryError } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { stdSerializers } from 'pino';

export const REDACTED = '[REDACTED]';

export function redactUrl(url: string): string {
  if (!url.startsWith('/in/')) return url;
  const rest = url.slice('/in/'.length);
  const queryAt = rest.indexOf('?');
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const slashAt = path.indexOf('/');
  const subPath = slashAt === -1 ? '' : path.slice(slashAt);
  return `/in/${REDACTED}${subPath}${queryAt === -1 ? '' : `?${REDACTED}`}`;
}

/** Fastify's default request serializer, with the URL redacted. */
export function serializeRequest(request: FastifyRequest) {
  const version = request.headers['accept-version'];
  return {
    method: request.method,
    url: redactUrl(request.url),
    version: typeof version === 'string' ? version : undefined,
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/** The same error without its bound parameters (message and stack both carry them). */
function withoutParams(error: DrizzleQueryError): Error {
  const safe = new Error(`Failed query: ${error.query}`, { cause: error.cause });
  // Keep the original stack frames: everything after the (parameter-carrying) message.
  const stack = error.stack ?? '';
  const end = stack.indexOf(error.message);
  const frames = end === -1 ? '' : stack.slice(end + error.message.length);
  safe.stack = `DrizzleQueryError: ${safe.message}${frames}`;
  return safe;
}

/** pino's standard error serializer, minus query parameters and Postgres `detail`. */
export function serializeError(error: unknown) {
  const isQueryError = error instanceof DrizzleQueryError;
  const serialized = stdSerializers.err((isQueryError ? withoutParams(error) : error) as Error);
  if (typeof serialized !== 'object' || serialized === null) return serialized;
  if (isQueryError) serialized.type = 'DrizzleQueryError';
  delete serialized.params;
  delete serialized.detail;
  return serialized;
}
