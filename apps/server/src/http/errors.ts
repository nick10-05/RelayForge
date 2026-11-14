import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

// One error shape for the whole API: { error: <machine code>, message: <human text>, ...extra }.

export const NOT_FOUND = { error: 'not_found', message: 'Not found' } as const;

export function validationError(message: string) {
  return { error: 'validation_error', message };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(NOT_FOUND));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'Request validation failed',
        issues: error.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ error: error.code ?? 'bad_request', message: error.message });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'Internal server error' });
  });
}
