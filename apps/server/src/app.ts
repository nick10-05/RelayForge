import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { checkDatabase } from './db/client.ts';
import type { Config } from './config.ts';

/** Log paths that must never be written in clear text. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-relayforge-signature"]',
  'req.headers["webhook-signature"]',
  'req.headers["x-hub-signature-256"]',
  '*.password',
  '*.secret',
  '*.token',
];

export type AppDeps = {
  config: Pick<Config, 'LOG_LEVEL'>;
  pool: pg.Pool;
};

export function buildApp({ config, pool }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    // Each request gets an id in the logs; honour an incoming one for tracing across hops.
    requestIdHeader: 'x-request-id',
  });

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

  return app;
}
