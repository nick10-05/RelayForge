import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
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
import { DEV_ORIGINS, createOriginCheck, parseOrigins } from './http/csrf.ts';
import { registerErrorHandling } from './http/errors.ts';
import { createIngestCounters, createLimits } from './http/limits.ts';
import { serializeError, serializeRequest } from './http/log-serializers.ts';
import type { IngestCounters, Limits } from './http/limits.ts';
import { registerOpenApi } from './http/openapi.ts';
import { isSpaPage, sendSpaIndex, spaRoutes } from './http/spa.ts';
import { ingestRoutes } from './ingest/routes.ts';
import type { Config } from './config.ts';
import type { ResolveFn } from './delivery/ssrf.ts';
import type { StorageGuard } from './ops/storage-guard.ts';

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
    Partial<
      Pick<
        Config,
        | 'ALLOW_PRIVATE_DESTINATIONS'
        | 'APP_ORIGIN'
        | 'INGEST_RATE_PER_SECOND'
        | 'INGEST_BURST'
        | 'INVALID_SIGNATURE_PER_MINUTE'
        | 'TRUST_PROXY'
      >
    >;
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
  /** Rate limiters; defaults from config. Tests override individual ones. */
  limits?: Partial<Limits>;
  /** Refused-but-counted ingest requests. */
  counters?: IngestCounters;
  /** Database size guard for ingest (503 when nearly full). None = never blocks. */
  storageGuard?: Pick<StorageGuard, 'blocked'>;
  /** Built dashboard to serve (apps/web/dist). None = API only. */
  webRoot?: string;
};

export function buildApp({
  config,
  pool,
  db,
  wakeWorker = () => {},
  resolve,
  secretBox = unconfiguredBox,
  logStream,
  limits: limitOverrides = {},
  counters = createIngestCounters(),
  storageGuard = { blocked: () => false },
  webRoot,
}: AppDeps): FastifyInstance {
  const limits: Limits = {
    ...createLimits({
      ingestPerSecond: config.INGEST_RATE_PER_SECOND ?? 20,
      ingestBurst: config.INGEST_BURST ?? 100,
      invalidSignaturePerMinute: config.INVALID_SIGNATURE_PER_MINUTE ?? 10,
    }),
    ...limitOverrides,
  };
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      // Capability URLs (/in/<slug>) and query parameters in database errors (log-serializers.ts).
      serializers: { req: serializeRequest, err: serializeError },
      ...(logStream && { stream: logStream }),
    },
    // Each request gets an id in the logs; honour an incoming one for tracing across hops.
    requestIdHeader: 'x-request-id',
    // Trust exactly TRUST_PROXY hops (hop 0 = the socket peer). Never `true`, which would trust
    // the leftmost X-Forwarded-For entry — the one the client writes.
    trustProxy: (_address: string, hop: number) => hop < (config.TRUST_PROXY ?? 0),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(
    app,
    webRoot ? (request, reply) => isSpaPage(request) && sendSpaIndex(reply) : undefined,
  );
  app.decorateRequest('user', null);
  app.decorateRequest('authMethod', null);
  void app.register(cookie);
  // Security headers. The CSP defaults (default-src 'self', no inline scripts, no framing)
  // already fit the same-origin SPA served from this process (http/spa.ts).
  void app.register(helmet);
  app.addHook('onRequest', createOriginCheck(parseOrigins(config.APP_ORIGIN ?? DEV_ORIGINS)));
  // Before any route: the spec is built from the routes registered after it.
  registerOpenApi(app);

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

  // In a plugin (not directly on `app`) so the routes are added after swagger's onRoute hook.
  void app.register(async (health) => {
    // Liveness: the process is up. Never touches the database, so pings don't wake Neon.
    health.get('/healthz', () => ({ status: 'ok' }));

    // Readiness: the database is reachable. Not for keep-alive pings.
    health.get('/readyz', async (_request, reply) => {
      const ok = await checkDatabase(pool);
      return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'unavailable' });
    });
  });

  const production = config.NODE_ENV === 'production';
  void app.register(authRoutes, { prefix: '/api/v1/auth', db, limits });
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
  void app.register(ingestRoutes, {
    prefix: '/in',
    db,
    wakeWorker,
    secretBox,
    limits,
    counters,
    storageGuard,
  });
  if (webRoot) void app.register(spaRoutes, { root: webRoot });

  return app;
}
