import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.ts';
import { authenticateApiKey, looksLikeApiKey } from './api-keys.ts';
import { SESSION_COOKIE, validateSession } from './sessions.ts';
import type { AuthUser } from './sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    /** How `user` was authenticated. CSRF checks (Day 9) only apply to 'session'. */
    authMethod: 'session' | 'api_key' | null;
  }
}

export function sessionCookieOptions(expires: Date) {
  // `__Host-` prefix requires Secure, Path=/ and no Domain: the cookie can't be set by
  // or sent to subdomains. Browsers treat http://localhost as secure, so dev works too.
  return { path: '/', httpOnly: true, secure: true, sameSite: 'lax' as const, expires };
}

const UNAUTHORIZED = { error: 'unauthorized', message: 'Authentication required' } as const;

export type RequireUserOptions = {
  /** Accept `Authorization: Bearer rf_live_...` (default true). */
  allowApiKey?: boolean;
};

/**
 * preHandler: 401 unless the request carries a valid session cookie or (where allowed) a
 * valid API key. Sets `request.user` and `request.authMethod`.
 *
 * If an Authorization header is present it decides alone: a bad key is a 401 even when a
 * valid cookie is also sent, so a script never silently runs as whoever's browser it is in.
 */
export function requireUser(db: Db, { allowApiKey = true }: RequireUserOptions = {}) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      const [scheme, token] = authorization.split(' ', 2);
      if (!allowApiKey || scheme?.toLowerCase() !== 'bearer' || !token || !looksLikeApiKey(token)) {
        return reply.code(401).send(UNAUTHORIZED);
      }
      const user = await authenticateApiKey(db, token);
      if (!user) return reply.code(401).send(UNAUTHORIZED);
      request.user = user;
      request.authMethod = 'api_key';
      return;
    }

    const token = request.cookies[SESSION_COOKIE];
    const session = token ? await validateSession(db, token) : null;
    if (!session || !token) return reply.code(401).send(UNAUTHORIZED);
    request.user = session.user;
    request.authMethod = 'session';
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
