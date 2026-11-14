import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { apiKeyRoutes } from './auth/api-keys.ts';
import { authRoutes } from './auth/routes.ts';
import { checkDatabase } from './db/client.ts';
import type { Db } from './db/client.ts';
import { unconfiguredBox } from './crypto/secret-box.ts';
import type { SecretBox } from './crypto/secret-box.ts';
import { redeliveryRoutes } from './delivery/routes.ts';
import { destinationRoutes } from './destinations/routes.ts';
import { endpointRoutes } from './endpoints/routes.ts';
import { eventRoutes } from './events/routes.ts';
import { registerErrorHandling } from './http/errors.ts';
import { ingestRoutes } from './ingest/routes.ts';
import type { Config } from './config.ts';
import type { ResolveFn } from './delivery/ssrf.ts';

/**
 * Log paths that must never be written in clear text (design §7.4). Fastify's request
 * serializer doesn't log headers or bodies, so these guard against code that logs them
 * explicitly (`log.info({ headers })`, an error carrying a config object, ...).
 */
const SECRET_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-relayforge-signature',
  'webhook-signature',
  'x-hub-signature',
  'x-hub-signature-256',
  'x-shopify-hmac-sha256',
  'stripe-signature',
];
const SECRET_FIELDS = [
  'password',
  'passwordHash',
  'secret',
  'secretHash',
  'signingSecret',
  'previousSigningSecret',
  'verifySecret',
  'token',
  'key',
  'apiKey',
];
export const REDACT_PATHS = [
  // Hyphenated names need pino's bracket syntax: headers["x-hub-signature-256"].
  ...SECRET_HEADERS.map((h) => (/^[a-z]+$/.test(h) ? `.${h}` : `["${h}"]`)).flatMap((h) => [
    `req.headers${h}`,
    `headers${h}`,
    `*.headers${h}`,
  ]),
  ...SECRET_FIELDS.flatMap((f) => [f, `*.${f}`, `*.*.${f}`]),
];

export type AppDeps = {
  config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'> &
    Partial<Pick<Config, 'ALLOW_PRIVATE_DESTINATIONS'>>;
  pool: pg.Pool;
  db: Db;
  /** Wakes the delivery worker (new deliveries, redelivery, endpoint resumed, destination re-enabled). */
  wakeWorker?: () => void;
  /** Seals stored secrets (AES-256-GCM keyring). Without one, secret features fail closed. */
  secretBox?: SecretBox;
  /** DNS resolver for destination validation (injectable for tests). */
  resolve?: ResolveFn;
  /** Where logs go (default stdout). Tests capture it to prove secrets are redacted. */
  logStream?: { write: (line: string) => void };
};

export function buildApp({
  config,
  pool,
  db,
  wakeWorker = () => {},
  resolve,
  secretBox = unconfiguredBox,
  logStream,
}: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      ...(logStream && { stream: logStream }),
    },
    // Each request gets an id in the logs; honour an incoming one for tracing across hops.
    requestIdHeader: 'x-request-id',
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  app.decorateRequest('user', null);
  app.decorateRequest('authMethod', null);
  void app.register(cookie);

  // Graceful shutdown: once closing, tell clients not to reuse the connection, so
  // keep-alive sockets close after their in-flight response instead of holding shutdown open.
  let closing = false;
  app.addHook('preClose', (done) => {
    closing = true;
    done();
  });
  app.addHook('onSend', (_request, reply, payload, done) => {
    if (closing) void reply.header('connection', 'close');
    done(null, payload);
  });

  // Liveness: the process is up. Never touches the database, so pings don't wake Neon.
  app.get('/healthz', () => ({ status: 'ok' }));

  // Readiness: the database is reachable. Not for keep-alive pings.
  app.get('/readyz', async (_request, reply) => {
    const ok = await checkDatabase(pool);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'unavailable' });
  });

  const production = config.NODE_ENV === 'production';
  void app.register(authRoutes, { prefix: '/api/v1/auth', db });
  void app.register(apiKeyRoutes, { prefix: '/api/v1/api-keys', db });
  void app.register(endpointRoutes, { prefix: '/api/v1/endpoints', db, wakeWorker, secretBox });
  void app.register(destinationRoutes, {
    prefix: '/api/v1/endpoints/:endpointId/destinations',
    db,
    production,
    allowPrivate: config.ALLOW_PRIVATE_DESTINATIONS ?? false,
    ...(resolve && { resolve }),
    secretBox,
    wakeWorker,
  });
  void app.register(eventRoutes, { prefix: '/api/v1', db });
  void app.register(redeliveryRoutes, { prefix: '/api/v1', db, wakeWorker });
  void app.register(ingestRoutes, { prefix: '/in', db, wakeWorker, secretBox });

  return app;
}
