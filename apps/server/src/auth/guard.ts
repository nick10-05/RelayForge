import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.ts';
import { SESSION_COOKIE, validateSession } from './sessions.ts';
import type { AuthUser } from './sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export function sessionCookieOptions(expires: Date) {
  // `__Host-` prefix requires Secure, Path=/ and no Domain: the cookie can't be set by
  // or sent to subdomains. Browsers treat http://localhost as secure, so dev works too.
  return { path: '/', httpOnly: true, secure: true, sameSite: 'lax' as const, expires };
}

/** preHandler: 401 unless the request carries a valid session cookie. Sets `request.user`. */
export function requireUser(db: Db) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    const session = token ? await validateSession(db, token) : null;
    if (!session || !token) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
    }
    request.user = session.user;
    if (session.renewed) {
      void reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(session.expiresAt));
    }
  };
}

/** The authenticated user inside a route protected by `requireUser`. */
export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw new Error('currentUser() used on a route without requireUser');
  return request.user;
}
